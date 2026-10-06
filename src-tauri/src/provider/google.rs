//! Google Gemini 官方 API；密钥放在请求头，付费请求不重试。
use super::{
    transport, GenerateOutput, GenerateRequest, OutputImage, ProviderError, ProviderResult,
};
use base64::Engine;
use serde_json::{json, Value};

pub const ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1/models";

/// Gemini 原生输入；Vertex AI 与 Google AI Studio 的输出配置分别编码。
pub fn native_payload(req: &GenerateRequest, vertex: bool) -> Result<Value, ProviderError> {
    crate::models::validate(req)?;
    let p = &req.params;
    let mut parts = Vec::new();
    for im in &req.images {
        let (mime, bytes) = super::parse_data_url(im)?;
        parts.push(json!({"inlineData":{"mimeType":mime,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}}));
    }
    parts.push(json!({"text":req.final_prompt}));
    let mut image = json!({"imageSize":p.resolution.as_deref().unwrap_or("1K")});
    if let Some(aspect) = &p.aspect_ratio {
        if aspect != "auto" {
            image["aspectRatio"] = json!(aspect);
        }
    }
    if vertex {
        if let Some(format) = &p.output_format {
            image["imageOutputOptions"] = json!({"mimeType":format!("image/{format}")});
        }
    }
    let mut config = json!({"responseModalities":["IMAGE"]});
    if vertex {
        config["imageConfig"] = image;
    } else {
        config["responseFormat"] = json!({"image":image});
    }
    Ok(json!({"contents":[{"role":"user","parts":parts}],"generationConfig":config}))
}

pub fn build_payload(req: &GenerateRequest) -> Result<Value, ProviderError> {
    let model = crate::models::resolve(req)?;
    if req.provider != "google" || model.family != "gemini" {
        return Err(ProviderError::msg("Google 官方路由仅支持 Gemini Image"));
    }
    native_payload(req, false)
}

pub async fn images(body: &Value) -> Result<Vec<OutputImage>, ProviderError> {
    let mut images = Vec::new();
    if let Some(candidates) = body["candidates"].as_array() {
        for candidate in candidates {
            if let Some(parts) = candidate
                .pointer("/content/parts")
                .and_then(Value::as_array)
            {
                for part in parts {
                    if part["thought"].as_bool() == Some(true) {
                        continue;
                    }
                    if let Some(data) = part.pointer("/inlineData/data").and_then(Value::as_str) {
                        let mime = part
                            .pointer("/inlineData/mimeType")
                            .and_then(Value::as_str)
                            .unwrap_or("image/png");
                        if mime.starts_with("image/") {
                            images.push(transport::base64_image(data, mime)?);
                        }
                    } else if let Some(url) =
                        part.pointer("/fileData/fileUri").and_then(Value::as_str)
                    {
                        if part
                            .pointer("/fileData/mimeType")
                            .and_then(Value::as_str)
                            .is_some_and(|m| m.starts_with("image/"))
                        {
                            images.push(transport::download_image(url).await?);
                        }
                    }
                }
            }
        }
    }
    if images.is_empty() {
        return Err(ProviderError::msg(
            "Gemini 没有返回图片，请检查内容限制或提示词",
        ));
    }
    Ok(images)
}

pub async fn generate(req: &GenerateRequest) -> ProviderResult {
    let key = transport::key("google")?;
    generate_at(req, &key, ENDPOINT).await
}

#[doc(hidden)]
pub async fn generate_at(req: &GenerateRequest, key: &str, endpoint: &str) -> ProviderResult {
    let payload = build_payload(req)?;
    let model = crate::models::resolve(req)?;
    super::progress::report("waiting", None, None, None);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|_| ProviderError::msg("Google HTTP 客户端初始化失败"))?;
    let (_, body) = transport::json(
        client
            .post(format!("{endpoint}/{}:generateContent", model.wire_id()))
            .header("x-goog-api-key", key)
            .json(&payload),
        "Google",
    )
    .await?;
    super::progress::report("downloading", None, None, None);
    Ok(GenerateOutput {
        provider: "google".into(),
        model: req.model.clone(),
        final_prompt: req.final_prompt.clone(),
        images: images(&body).await?,
        usage: body.get("usageMetadata").cloned().unwrap_or(Value::Null),
        notes: Vec::new(),
    })
}
