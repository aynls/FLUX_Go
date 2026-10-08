//! Grok 官方 Images API：JSON 生成/编辑，同步返回，不重试付费请求。
use super::{
    transport, GenerateOutput, GenerateRequest, OutputImage, ProviderError, ProviderResult,
};
use serde_json::{json, Value};

pub const ENDPOINT: &str = "https://api.x.ai/v1/images";

pub fn build_payload(req: &GenerateRequest) -> Result<Value, ProviderError> {
    crate::models::validate(req)?;
    let model = crate::models::resolve(req)?;
    if model.family != "grok" || !matches!(req.provider.as_str(), "xai" | "comfy") {
        return Err(ProviderError::coded(
            "backend_grok_only",
            "This route only supports Grok Imagine",
        ));
    }
    let mut body = json!({
        "model": model.wire_id().strip_prefix("xai/").unwrap_or(model.wire_id()),
        "prompt": req.final_prompt,
        "n": 1,
        "response_format": "url",
        "resolution": req.params.resolution.as_deref().unwrap_or("1K").to_lowercase(),
        "aspect_ratio": req.params.aspect_ratio.as_deref().unwrap_or("1:1"),
        "quality": req.params.quality.as_deref().unwrap_or(if req.provider == "comfy" { "medium" } else { "auto" }),
    });
    match req.images.as_slice() {
        [] => {}
        [image] => body["image"] = json!({"type":"image_url", "url":image}),
        images => {
            body["images"] = json!(images
                .iter()
                .map(|image| json!({"type":"image_url", "url":image}))
                .collect::<Vec<_>>())
        }
    }
    Ok(body)
}

pub async fn images(body: &Value) -> Result<Vec<OutputImage>, ProviderError> {
    if let Some(reason) = body["block_reason"].as_str().filter(|s| !s.is_empty()) {
        return Err(ProviderError::coded(
            "backend_grok_blocked",
            format!("Grok did not generate an image: {reason}"),
        )
        .with_param("reason", reason));
    }
    if let Some(error) = body.get("error").filter(|v| !v.is_null()) {
        return Err(match error["message"].as_str().or(error.as_str()) {
            Some(message) => ProviderError::msg(message),
            None => ProviderError::coded("backend_grok_failed", "Grok generation failed"),
        });
    }
    transport::openai_images(body, "jpeg").await
}

pub async fn generate(req: &GenerateRequest) -> ProviderResult {
    let key = transport::key("xai")?;
    generate_at(req, &key, ENDPOINT).await
}

#[doc(hidden)]
pub async fn generate_at(req: &GenerateRequest, key: &str, endpoint: &str) -> ProviderResult {
    if req.provider != "xai" {
        return Err(ProviderError::coded(
            "backend_grok_route",
            "The official Grok route is invalid",
        ));
    }
    let payload = build_payload(req)?;
    let operation = if req.images.is_empty() {
        "generations"
    } else {
        "edits"
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|_| {
            ProviderError::coded(
                "backend_grok_client",
                "Couldn't initialize the Grok HTTP client",
            )
        })?;
    super::progress::report("waiting", None, None, None);
    let (_, body) = transport::json(
        client
            .post(format!("{endpoint}/{operation}"))
            .bearer_auth(key)
            .json(&payload),
        "Grok",
    )
    .await?;
    super::progress::report("downloading", None, None, None);
    let mut usage = body
        .get("usage")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(ticks) = usage.get("cost_in_usd_ticks").and_then(Value::as_u64) {
        usage.insert("cost".into(), json!(ticks as f64 / 10_000_000_000.0));
    }
    Ok(GenerateOutput {
        provider: req.provider.clone(),
        model: req.model.clone(),
        final_prompt: req.final_prompt.clone(),
        images: images(&body).await?,
        usage: Value::Object(usage),
        notes: Vec::new(),
    })
}
