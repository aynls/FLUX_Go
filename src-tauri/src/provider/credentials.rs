//! 密钥来源和系统凭据存储，独立于模型与传输适配器。
use super::ProviderError;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{OnceLock, RwLock},
};
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSettings {
    pub source: String,
    pub env_name: String,
}

static KEY_SETTINGS: OnceLock<RwLock<HashMap<String, CredentialSettings>>> = OnceLock::new();
static KEY_SETTINGS_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn default_env_name(provider: &str) -> &'static str {
    crate::models::default_env_name(provider)
}

fn default_key_settings() -> HashMap<String, CredentialSettings> {
    crate::models::provider_ids()
        .into_iter()
        .map(|p| {
            (
                p.to_string(),
                CredentialSettings {
                    source: if stored_key(p).is_some() {
                        "manual"
                    } else {
                        "environment"
                    }
                    .into(),
                    env_name: default_env_name(p).into(),
                },
            )
        })
        .collect()
}

pub fn init_key_settings(dir: &Path) -> Result<(), String> {
    let path = dir.join("key-sources.json");
    let mut settings = default_key_settings();
    if path.exists() {
        let saved: HashMap<String, CredentialSettings> =
            serde_json::from_slice(&std::fs::read(&path).map_err(|_| {
                ProviderError::coded(
                    "backend_key_settings_read_failed",
                    "Couldn't read the key source settings",
                )
            })?)
            .map_err(|_| {
                ProviderError::coded(
                    "backend_key_settings_corrupt",
                    "The key source settings are corrupt",
                )
            })?;
        for (p, config) in saved {
            validate_key_settings(&p, &config)?;
            settings.insert(p, config);
        }
    }
    let reinitialized = || {
        ProviderError::coded(
            "backend_key_settings_reinitialized",
            "The key source settings were initialized twice",
        )
    };
    KEY_SETTINGS_PATH.set(path).map_err(|_| reinitialized())?;
    KEY_SETTINGS
        .set(RwLock::new(settings))
        .map_err(|_| reinitialized())?;
    Ok(())
}

pub fn key_settings(provider: &str) -> CredentialSettings {
    KEY_SETTINGS
        .get_or_init(|| RwLock::new(default_key_settings()))
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .get(provider)
        .cloned()
        .unwrap_or_else(|| CredentialSettings {
            source: "environment".into(),
            env_name: default_env_name(provider).into(),
        })
}

fn validate_key_settings(provider: &str, config: &CredentialSettings) -> Result<(), String> {
    if !crate::models::known_provider(provider) {
        return Err(unknown_provider(provider));
    }
    if !matches!(config.source.as_str(), "environment" | "manual") {
        return Err(
            ProviderError::coded("backend_key_source_invalid", "Invalid key source").into(),
        );
    }
    let name = &config.env_name;
    if name.is_empty() || name.contains(['=', '\0', '\r', '\n']) {
        return Err(ProviderError::coded(
            "backend_env_name_invalid",
            "Enter a valid environment variable name (no equals sign or line breaks)",
        )
        .into());
    }
    Ok(())
}
pub fn unknown_provider(provider: &str) -> String {
    ProviderError::coded(
        "backend_unknown_provider",
        format!("Unknown provider: {provider}"),
    )
    .with_param("name", provider)
    .into()
}

pub fn save_key_settings(provider: &str, config: CredentialSettings) -> Result<(), String> {
    validate_key_settings(provider, &config)?;
    let uninitialized = || {
        ProviderError::coded(
            "backend_key_settings_uninitialized",
            "The key source storage isn't initialized yet",
        )
    };
    let path = KEY_SETTINGS_PATH.get().ok_or_else(uninitialized)?;
    let mut guard = KEY_SETTINGS
        .get()
        .ok_or_else(uninitialized)?
        .write()
        .map_err(|_| {
            ProviderError::coded(
                "backend_key_settings_unavailable",
                "The key source settings are temporarily unavailable",
            )
        })?;
    let mut next = guard.clone();
    next.insert(provider.into(), config);
    let save_failed = || {
        ProviderError::coded(
            "backend_key_settings_save_failed",
            "Couldn't save the key source settings",
        )
    };
    let bytes = serde_json::to_vec_pretty(&next).map_err(|_| {
        ProviderError::coded(
            "backend_key_settings_serialize_failed",
            "Couldn't serialize the key source settings",
        )
    })?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|_| save_failed())?;
    std::fs::rename(tmp, path).map_err(|_| save_failed())?;
    *guard = next;
    Ok(())
}

pub fn credential_entry(provider: &str) -> Result<keyring::Entry, String> {
    if !crate::models::known_provider(provider) {
        return Err(unknown_provider(provider));
    }
    keyring::Entry::new("app.lutriui.desktop", provider).map_err(|_| {
        ProviderError::coded(
            "backend_credential_store_unavailable",
            "Couldn't access the system credential store",
        )
        .into()
    })
}

pub fn stored_key(provider: &str) -> Option<String> {
    credential_entry(provider)
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|s| !s.trim().is_empty())
}

pub fn configured_key(provider: &str) -> Option<String> {
    if !crate::models::known_provider(provider) {
        return None;
    }
    let config = key_settings(provider);
    match config.source.as_str() {
        "manual" => stored_key(provider),
        "environment" => environment_key(&config.env_name),
        _ => None,
    }
}

/// 优先读取 Windows 用户级环境变量，避免桌面宿主继承旧环境。
/// 非 Windows 或未配置用户变量时回退到进程环境；密钥不写入磁盘或返回前端。
pub fn environment_key(name: &str) -> Option<String> {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        if let Ok(env) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Environment") {
            if let Ok(value) = env.get_value::<String, _>(name) {
                let value = value.trim().to_string();
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }
    }
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}
