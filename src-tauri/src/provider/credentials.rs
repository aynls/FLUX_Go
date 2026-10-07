//! 密钥来源和系统凭据存储，独立于模型与传输适配器。
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
    match provider {
        "bfl" => "BFL_API_KEY",
        "comfy" => "COMFY_API_KEY",
        "runware" => "RUNWARE_API_KEY",
        "google" => "GEMINI_API_KEY",
        "ark" => "ARK_API_KEY",
        "byteplus" => "BYTEPLUS_API_KEY",
        "xai" => "XAI_API_KEY",
        _ => "OPENROUTER_API_KEY",
    }
}

fn default_key_settings() -> HashMap<String, CredentialSettings> {
    [
        "openrouter",
        "bfl",
        "comfy",
        "runware",
        "google",
        "ark",
        "byteplus",
        "xai",
    ]
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
            serde_json::from_slice(&std::fs::read(&path).map_err(|_| "密钥来源配置读取失败")?)
                .map_err(|_| "密钥来源配置损坏")?;
        for (p, config) in saved {
            validate_key_settings(&p, &config)?;
            settings.insert(p, config);
        }
    }
    KEY_SETTINGS_PATH
        .set(path)
        .map_err(|_| "密钥来源配置重复初始化")?;
    KEY_SETTINGS
        .set(RwLock::new(settings))
        .map_err(|_| "密钥来源配置重复初始化")?;
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
    if !matches!(
        provider,
        "openrouter" | "bfl" | "comfy" | "runware" | "google" | "ark" | "byteplus" | "xai"
    ) {
        return Err("未知提供商".into());
    }
    if !matches!(config.source.as_str(), "environment" | "manual") {
        return Err("密钥来源无效".into());
    }
    let name = &config.env_name;
    if name.is_empty() || name.contains(['=', '\0', '\r', '\n']) {
        return Err("请输入有效的环境变量名称（不含等号或换行）".into());
    }
    Ok(())
}

pub fn save_key_settings(provider: &str, config: CredentialSettings) -> Result<(), String> {
    validate_key_settings(provider, &config)?;
    let path = KEY_SETTINGS_PATH.get().ok_or("密钥来源存储尚未初始化")?;
    let mut guard = KEY_SETTINGS
        .get()
        .ok_or("密钥来源尚未初始化")?
        .write()
        .map_err(|_| "密钥来源暂不可用")?;
    let mut next = guard.clone();
    next.insert(provider.into(), config);
    let bytes = serde_json::to_vec_pretty(&next).map_err(|_| "密钥来源配置序列化失败")?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|_| "密钥来源配置保存失败")?;
    std::fs::rename(tmp, path).map_err(|_| "密钥来源配置保存失败")?;
    *guard = next;
    Ok(())
}

pub fn credential_entry(provider: &str) -> Result<keyring::Entry, String> {
    if !matches!(
        provider,
        "bfl" | "openrouter" | "comfy" | "runware" | "google" | "ark" | "byteplus" | "xai"
    ) {
        return Err("未知提供商".into());
    }
    keyring::Entry::new("app.lutriui.desktop", provider).map_err(|_| "无法访问系统凭据存储".into())
}

pub fn stored_key(provider: &str) -> Option<String> {
    credential_entry(provider)
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|s| !s.trim().is_empty())
}

pub fn configured_key(provider: &str) -> Option<String> {
    if !matches!(
        provider,
        "openrouter" | "bfl" | "comfy" | "runware" | "google" | "ark" | "byteplus" | "xai"
    ) {
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
