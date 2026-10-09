//! 提供商适配层。
//!
//! 模型与路由契约由 models 校验。适配器负责原生字段、鉴权、异步任务和结果处理。
//! 密钥只在本层读取，绝不回传前端。

pub mod ark;
pub mod bfl;
pub mod comfy;
mod credentials;
pub mod google;
pub mod openrouter;
pub mod progress;
pub mod qwencloud;
pub mod runware;
pub mod transport;
pub mod xai;
pub use credentials::*;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

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
    pub enable_thinking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watermark: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_thoughts: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_text: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputImage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<GenerationDetails>,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationDetails {
    pub text: String,
    pub thoughts: String,
    pub sources: Vec<GenerationSource>,
    pub search_queries: Vec<String>,
    pub search_html: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationSource {
    pub title: String,
    pub url: String,
    pub kind: String,
}

/// 结构化错误：前端按 JSON 解析展示。绝不包含密钥。
#[derive(Debug, Clone, Serialize)]
pub struct ProviderError {
    pub status: Option<u16>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub code: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub hint_code: String,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
}

impl ProviderError {
    pub fn msg(message: impl Into<String>) -> Self {
        Self {
            status: None,
            message: message.into(),
            hint: None,
            code: String::new(),
            hint_code: String::new(),
            params: Map::new(),
        }
    }
    pub fn coded(code: impl Into<String>, message: impl Into<String>) -> Self {
        let mut error = Self::msg(message);
        error.code = code.into();
        error
    }
    pub fn with_param(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.params.insert(key.into(), value.into());
        self
    }
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
    pub fn with_hint_code(mut self, code: impl Into<String>) -> Self {
        self.hint_code = code.into();
        self
    }
    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }
    pub fn http(status: u16, message: impl Into<String>) -> Self {
        Self {
            status: Some(status),
            message: message.into(),
            hint: None,
            code: String::new(),
            hint_code: String::new(),
            params: Map::new(),
        }
    }
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| self.message.clone())
    }
}

/// Tauri 命令错误统一以 ProviderError JSON 返回，前端按错误码本地化。
impl From<ProviderError> for String {
    fn from(error: ProviderError) -> Self {
        error.to_json()
    }
}

/// 结果备注：持久化稳定码和英文回退，界面按当前语言展示。
pub fn localized_note(code: &str, message: impl Into<String>, params: &[(&str, String)]) -> String {
    let mut body = Map::new();
    body.insert("code".into(), json!(code));
    body.insert("message".into(), json!(message.into()));
    if !params.is_empty() {
        let mut values = Map::new();
        for (key, value) in params {
            values.insert((*key).into(), json!(value));
        }
        body.insert("params".into(), Value::Object(values));
    }
    serde_json::to_string(&body).unwrap_or_else(|_| code.to_string())
}

/// 本地文件或系统操作失败；系统原始细节只作为参数，文案由前端本地化。
pub fn io_failed(error: impl std::fmt::Display) -> ProviderError {
    ProviderError::coded(
        "backend_io_failed",
        format!("File operation failed: {error}"),
    )
    .with_param("detail", error.to_string())
}

pub type ProviderResult = Result<GenerateOutput, ProviderError>;

pub async fn dispatch(req: &GenerateRequest) -> ProviderResult {
    crate::models::validate(req)?;
    match req.provider.as_str() {
        "openrouter" => openrouter::generate(req).await,
        "bfl" => bfl::generate(req).await,
        "comfy" => comfy::generate(req).await,
        "runware" => runware::generate(req).await,
        "google" => google::generate(req).await,
        "xai" => xai::generate(req).await,
        "qwencloud" => qwencloud::generate(req).await,
        "ark" | "byteplus" => ark::generate(req).await,
        other => Err(ProviderError::coded(
            "backend_unknown_provider",
            format!("Unknown provider: {other}"),
        )
        .with_param("name", other)),
    }
}

/// 校验并解码 data URL，返回 (mime, bytes)
pub fn parse_data_url(url: &str) -> Result<(String, Vec<u8>), ProviderError> {
    let rest = url.strip_prefix("data:").ok_or_else(|| {
        ProviderError::coded("backend_data_url", "Images must be provided as data URLs")
    })?;
    let (meta, b64) = rest.split_once(";base64,").ok_or_else(|| {
        ProviderError::coded(
            "backend_data_url_payload",
            "The data URL has no base64 payload",
        )
    })?;
    let mime = meta.to_string();
    if !mime.starts_with("image/") {
        return Err(ProviderError::coded(
            "backend_image_type",
            format!("Unsupported image type: {mime}"),
        )
        .with_param("type", mime));
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| {
            ProviderError::coded(
                "backend_base64",
                format!("Couldn't decode the image base64: {e}"),
            )
            .with_param("detail", e.to_string())
        })?;
    if bytes.is_empty() {
        return Err(ProviderError::coded(
            "backend_empty_image",
            "The image is empty",
        ));
    }
    Ok((mime, bytes))
}
