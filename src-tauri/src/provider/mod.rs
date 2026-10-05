//! 提供商适配层。
//!
//! 前端负责 FLUX.3 模型协议（提示词 + 包围盒 JSON，见 src/lib/protocol.ts），
//! 这里只负责各提供商的传输格式、鉴权与错误映射。密钥只在本层读取，绝不回传前端。

pub mod bfl;
pub mod openrouter;

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
    if provider == "bfl" {
        "BFL_API_KEY"
    } else {
        "OPENROUTER_API_KEY"
    }
}

fn default_key_settings() -> HashMap<String, CredentialSettings> {
    ["openrouter", "bfl"]
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
    if !matches!(provider, "openrouter" | "bfl") {
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

/// 与前端 src/lib/types.ts 的 GenerateRequest 对应
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    pub provider: String,
    pub model: String,
    /// 前端按 FLUX.3 官方协议合成的最终提示词（可能含包围盒 JSON），原样发送
    pub final_prompt: String,
    /// 参考图 data URL（data:image/...;base64,...），≤10 张
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub params: GenerateParams,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerateParams {
    #[serde(default)]
    pub resolution: Option<String>,
    #[serde(default)]
    pub aspect_ratio: Option<String>,
    #[serde(default)]
    pub safety_tolerance: Option<u8>,
    #[serde(default)]
    pub grounding: Option<bool>,
    #[serde(default)]
    pub version: Option<String>,
}

pub fn credential_entry(provider: &str) -> Result<keyring::Entry, String> {
    if !matches!(provider, "bfl" | "openrouter") {
        return Err("未知提供商".into());
    }
    keyring::Entry::new("app.fluxgo.desktop", provider)
        .map_err(|_| "无法访问系统凭据存储".into())
}

pub fn stored_key(provider: &str) -> Option<String> {
    credential_entry(provider)
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|s| !s.trim().is_empty())
}

pub fn configured_key(provider: &str) -> Option<String> {
    if !matches!(provider, "openrouter" | "bfl") {
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputImage {
    pub data_url: String,
    pub media_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateOutput {
    pub provider: String,
    pub model: String,
    pub final_prompt: String,
    pub images: Vec<OutputImage>,
    pub usage: serde_json::Value,
    pub notes: Vec<String>,
}

/// 结构化错误：前端按 JSON 解析展示。绝不包含密钥。
#[derive(Debug, Clone, Serialize)]
pub struct ProviderError {
    pub status: Option<u16>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl ProviderError {
    pub fn msg(message: impl Into<String>) -> Self {
        Self {
            status: None,
            message: message.into(),
            hint: None,
        }
    }
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
    pub fn http(status: u16, message: impl Into<String>) -> Self {
        Self {
            status: Some(status),
            message: message.into(),
            hint: None,
        }
    }
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| self.message.clone())
    }
}

pub type ProviderResult = Result<GenerateOutput, ProviderError>;

pub async fn dispatch(req: &GenerateRequest) -> ProviderResult {
    match req.provider.as_str() {
        "openrouter" => openrouter::generate(req).await,
        "bfl" => bfl::generate(req).await,
        other => Err(ProviderError::msg(format!("未知提供商: {other}"))),
    }
}

/// 校验并解码 data URL，返回 (mime, bytes)
pub fn parse_data_url(url: &str) -> Result<(String, Vec<u8>), ProviderError> {
    let rest = url
        .strip_prefix("data:")
        .ok_or_else(|| ProviderError::msg("图片必须以 data URL 形式提供"))?;
    let (meta, b64) = rest
        .split_once(";base64,")
        .ok_or_else(|| ProviderError::msg("data URL 缺少 base64 载荷"))?;
    let mime = meta.to_string();
    if !mime.starts_with("image/") {
        return Err(ProviderError::msg(format!("不支持的图片类型: {mime}")));
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| ProviderError::msg(format!("图片 base64 解码失败: {e}")))?;
    if bytes.is_empty() {
        return Err(ProviderError::msg("图片内容为空"));
    }
    Ok((mime, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn system_credential_roundtrip_in_isolated_namespace() {
        let entry = keyring::Entry::new(
            "app.fluxgo.verification",
            &format!(
                "test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ),
        )
        .unwrap();
        entry.set_password("test-only-not-a-real-api-key").unwrap();
        let read = entry.get_password();
        entry.delete_credential().unwrap();
        assert_eq!(read.unwrap(), "test-only-not-a-real-api-key");
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    }

    #[test]
    fn frontend_params_survive_ipc() {
        let p: GenerateParams = serde_json::from_value(serde_json::json!({
            "resolution": "768", "aspectRatio": "16:9", "safetyTolerance": 4, "grounding": false
        }))
        .unwrap();
        assert_eq!(p.aspect_ratio.as_deref(), Some("16:9"));
        assert_eq!(p.safety_tolerance, Some(4));
        assert_eq!(p.grounding, Some(false));
        assert!(serde_json::from_value::<GenerateParams>(
            serde_json::json!({"aspect_ratio":"16:9"})
        )
        .is_err());
    }

    fn req(images: Vec<&str>, params: GenerateParams) -> GenerateRequest {
        GenerateRequest {
            provider: "openrouter".into(),
            model: "black-forest-labs/flux-3-image".into(),
            final_prompt: "test prompt".into(),
            images: images.into_iter().map(String::from).collect(),
            params,
        }
    }

    #[test]
    fn parse_data_url_roundtrip() {
        let (mime, bytes) = parse_data_url("data:image/png;base64,aGVsbG8=").unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, b"hello");
    }

    #[test]
    fn parse_data_url_rejects_non_image() {
        assert!(parse_data_url("data:text/plain;base64,aGVsbG8=").is_err());
        assert!(parse_data_url("https://example.com/a.png").is_err());
    }

    #[test]
    fn dispatch_rejects_unknown_provider() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let mut r = req(vec![], GenerateParams::default());
            r.provider = "foo".into();
            assert!(dispatch(&r).await.is_err());
        });
    }
}
