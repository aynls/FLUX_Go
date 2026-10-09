//! QwenCloud 同步图像接口：DashScope 多模态生成，Bearer 鉴权，不重试付费请求。
use super::{transport, GenerateOutput, GenerateRequest, ProviderError, ProviderResult};
use serde_json::{json, Map, Value};

pub const ENDPOINT: &str =
    "https://maas.qwencloudapi.com/api/v1/services/aigc/multimodal-generation/generation";

pub fn build_payload(req: &GenerateRequest) -> Result<Value, ProviderError> {
    crate::models::validate(req)?;
    let model = crate::models::resolve(req)?;
    if model.family != "qwen" || req.provider != "qwencloud" {
        return Err(ProviderError::coded(
            "backend_qwencloud_only",
            "This route only supports Qwen Image on QwenCloud",
        ));
    }
    let p = &req.params;
    let rules = &model.route["parameters"];
    let mut content: Vec<Value> = req.images.iter().map(|im| json!({"image": im})).collect();
    content.push(json!({"text": req.final_prompt}));
    let mut parameters = Map::new();
    if rules.get("count").is_some() {
        parameters.insert("n".into(), json!(p.count.unwrap_or(1)));
    }
    if rules.get("promptExtend").is_some() {
        parameters.insert(
            "prompt_extend".into(),
            json!(p.prompt_extend.unwrap_or(true)),
        );
    }
    if rules.get("watermark").is_some() {
        parameters.insert("watermark".into(), json!(p.watermark.unwrap_or(false)));
    }
    if let (Some(width), Some(height)) = (p.width, p.height) {
        parameters.insert("size".into(), json!(format!("{width}*{height}")));
    }
    if let Some(seed) = p.seed {
        parameters.insert("seed".into(), json!(seed));
    }
    if let Some(negative) = &p.negative_prompt {
        if rules.get("negativePrompt").is_some() && !negative.is_empty() {
            parameters.insert("negative_prompt".into(), json!(negative));
        }
    }
    if p.prompt_extend != Some(false) {
        if rules.get("promptExtendMode").is_some() {
            parameters.insert(
                "prompt_extend_mode".into(),
                json!(p.prompt_extend_mode.as_deref().unwrap_or("direct")),
            );
        }
        if rules.get("enableThinking").is_some() {
            if let Some(thinking) = p.enable_thinking {
                parameters.insert("enable_thinking".into(), json!(thinking));
            }
        }
    }
    Ok(json!({
        "model": model.wire_id(),
        "input": {"messages": [{"role": "user", "content": content}]},
        "parameters": parameters,
    }))
}

pub fn image_urls(body: &Value) -> Result<Vec<String>, ProviderError> {
    if body.get("output").is_none() {
        let message = body["message"]
            .as_str()
            .or_else(|| body["code"].as_str())
            .unwrap_or("QwenCloud generation failed");
        return Err(ProviderError::msg(format!("QwenCloud: {message}")));
    }
    let choices = body
        .pointer("/output/choices")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ProviderError::coded(
                "backend_qwencloud_missing_result",
                "The QwenCloud response has no result",
            )
        })?;
    let mut urls = Vec::new();
    for choice in choices {
        if let Some(content) = choice.pointer("/message/content").and_then(Value::as_array) {
            for part in content {
                if let Some(url) = part["image"].as_str() {
                    urls.push(url.to_string());
                }
            }
        }
    }
    if urls.is_empty() {
        return Err(ProviderError::coded(
            "backend_qwencloud_no_image",
            "QwenCloud returned no image",
        ));
    }
    Ok(urls)
}

pub async fn generate(req: &GenerateRequest) -> ProviderResult {
    let key = transport::key("qwencloud")?;
    generate_at(req, &key, ENDPOINT).await
}

#[doc(hidden)]
pub async fn generate_at(req: &GenerateRequest, key: &str, endpoint: &str) -> ProviderResult {
    let payload = build_payload(req)?;
    let client = transport::client_with_timeout(900)?;
    super::progress::report("waiting", None, None, None);
    let (_, body) = transport::json(
        client.post(endpoint).bearer_auth(key).json(&payload),
        "QwenCloud",
    )
    .await?;
    super::progress::report("downloading", None, None, None);
    let mut images = Vec::new();
    for url in image_urls(&body)? {
        images.push(transport::download_image(&url).await?);
    }
    let mut usage = body
        .get("usage")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(id) = body["request_id"].as_str() {
        usage.insert("requestId".into(), json!(id));
    }
    Ok(GenerateOutput {
        provider: req.provider.clone(),
        model: req.model.clone(),
        final_prompt: req.final_prompt.clone(),
        images,
        usage: Value::Object(usage),
        notes: Vec::new(),
    })
}
