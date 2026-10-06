//! 提供商适配层。
//!
//! 模型与路由契约由 models 校验。适配器负责原生字段、鉴权、异步任务和结果处理。
//! 密钥只在本层读取，绝不回传前端。

pub mod bfl;
pub mod comfy;
mod credentials;
pub mod openrouter;
pub mod progress;
pub mod runware;
pub mod transport;
pub use credentials::*;

use serde::{Deserialize, Serialize};

/// 与前端 src/lib/types.ts 的 GenerateRequest 对应
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    pub provider: String,
    pub model: String,
    /// 按模型与路由编译的提示词；结构化区域通过 regions 传递。
    pub final_prompt: String,
    /// 有序参考图 data URL；数量限制由路由目录定义。
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub params: GenerateParams,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub regions: Vec<LayoutRegion>,
    #[serde(default)]
    pub mask: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub history_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayoutRegion {
    pub id: String,
    pub description: String,
    pub reference_index: Option<usize>,
    pub source_box: Option<[u16; 4]>,
    pub target_box: Option<[u16; 4]>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerateParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safety_tolerance: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grounding: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_compression: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moderation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub negative_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_extend: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_extend_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watermark: Option<bool>,
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
    crate::models::validate(req)?;
    match req.provider.as_str() {
        "openrouter" => openrouter::generate(req).await,
        "bfl" => bfl::generate(req).await,
        "comfy" => comfy::generate(req).await,
        "runware" => runware::generate(req).await,
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
            "app.lutriui.verification",
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
            ..Default::default()
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
