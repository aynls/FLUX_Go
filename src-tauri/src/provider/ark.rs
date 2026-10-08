//! Seedream 官方直连：火山方舟（国内）与 BytePlus ModelArk（国际）。
use super::{transport, GenerateOutput, GenerateRequest, ProviderError, ProviderResult};
use serde_json::{json, Value};
pub const ARK_ENDPOINT: &str = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
pub const BYTEPLUS_ENDPOINT: &str =
    "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations";

/// 原生图像请求内容，Comfy 路由通过路径指定模型，官方直连通过 model 字段指定。
pub fn native_payload(req: &GenerateRequest) -> Result<Value, ProviderError> {
    crate::models::validate(req)?;
    let model = crate::models::resolve(req)?;
    let p = &req.params;
    let mut body = json!({"prompt":req.final_prompt,"response_format":"url","watermark":p.watermark.unwrap_or(false),"output_format":p.output_format.as_deref().unwrap_or("png")});
    body["size"] = json!(match (p.width, p.height) {
        (Some(w), Some(h)) => format!("{w}x{h}"),
        _ => p.resolution.clone().unwrap_or_else(|| "1K".into()),
    });
    if !req.images.is_empty() {
        body["image"] = json!(req.images);
    }
    if let Some(seed) = p.seed {
        body["seed"] = json!(seed);
    }
    if model.id == "seedream-5-lite" {
        body["sequential_image_generation"] = json!("disabled");
    }
    Ok(body)
}
pub fn build_payload(req: &GenerateRequest) -> Result<Value, ProviderError> {
    let model = crate::models::resolve(req)?;
    if !matches!(req.provider.as_str(), "ark" | "byteplus") || model.family != "seedream" {
        return Err(ProviderError::coded(
            "backend_seedream_official_only",
            "This official route only supports Seedream",
        ));
    }
    let mut body = native_payload(req)?;
    body["model"] = json!(model.wire_id());
    Ok(body)
}
pub async fn generate(req: &GenerateRequest) -> ProviderResult {
    let endpoint = match req.provider.as_str() {
        "ark" => ARK_ENDPOINT,
        "byteplus" => BYTEPLUS_ENDPOINT,
        _ => {
            return Err(ProviderError::coded(
                "backend_seedream_route",
                "Unknown official Seedream route",
            ))
        }
    };
    let key = transport::key(&req.provider)?;
    generate_at(req, &key, endpoint).await
}
#[doc(hidden)]
pub async fn generate_at(req: &GenerateRequest, key: &str, endpoint: &str) -> ProviderResult {
    let payload = build_payload(req)?;
    super::progress::report("waiting", None, None, None);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|_| {
            ProviderError::coded(
                "backend_seedream_client",
                "Couldn't initialize the Seedream HTTP client",
            )
        })?;
    let (_, body) = transport::json(
        client.post(endpoint).bearer_auth(key).json(&payload),
        if req.provider == "ark" { "Ark" } else { "BytePlus" },
    )
    .await?;
    if let Some(error) = body.get("error").filter(|e| !e.is_null()) {
        return Err(match error["message"].as_str() {
            Some(message) => ProviderError::msg(message),
            None => ProviderError::coded("backend_seedream_failed", "Seedream generation failed"),
        });
    }
    super::progress::report("downloading", None, None, None);
    Ok(GenerateOutput {
        provider: req.provider.clone(),
        model: req.model.clone(),
        final_prompt: req.final_prompt.clone(),
        images: transport::openai_images(
            &body,
            req.params.output_format.as_deref().unwrap_or("png"),
        )
        .await?,
        usage: body.get("usage").cloned().unwrap_or(Value::Null),
        notes: Vec::new(),
    })
}
