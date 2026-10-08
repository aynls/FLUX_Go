//! BFL 官方 API 直连适配器（第二后端，可选）。
//!
//! 端点: POST https://api.bfl.ai/v1/flux-3-image，x-key 鉴权，
//! 异步提交 → 轮询 polling_url → 下载 result.sample。
//! 该端点严格校验未知字段（422），载荷只包含官方文档列出的字段。
//! 使用 BFL_API_KEY。

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Map, Value};

use super::{
    localized_note, GenerateOutput, GenerateRequest, OutputImage, ProviderError, ProviderResult,
};

pub const ENDPOINT: &str = "https://api.bfl.ai/v1/flux-3-image";
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const POLL_TIMEOUT: Duration = Duration::from_secs(600);

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("HTTP client initialization failed")
    })
}

fn read_key() -> Result<String, ProviderError> {
    super::configured_key("bfl").ok_or_else(|| {
        ProviderError::coded("backend_missing_api_key", "No BFL API key is configured")
            .with_param("provider", "BFL")
            .with_hint("Check the key source, environment variable, or saved key in Settings.")
            .with_hint_code("backend_check_key_settings")
    })
}

pub fn build_payload(req: &GenerateRequest) -> Result<Value, ProviderError> {
    crate::models::validate(req)?;
    if crate::models::resolve(req)?.family != "flux" {
        return Err(ProviderError::coded(
            "backend_bfl_flux_only",
            "The BFL adapter only supports FLUX.3 Image",
        ));
    }
    if req.params.safety_tolerance.is_some_and(|s| s > 4) {
        return Err(ProviderError::coded(
            "backend_bfl_safety",
            "BFL safety_tolerance must be between 0 and 4",
        ));
    }
    if let Some(a) = &req.params.aspect_ratio {
        if ![
            "21:9", "2:1", "16:9", "3:2", "7:5", "4:3", "5:4", "1:1", "4:5", "3:4", "5:7", "2:3",
            "9:16", "1:2", "9:21", "auto",
        ]
        .contains(&a.as_str())
        {
            return Err(ProviderError::coded(
                "backend_invalid_aspect",
                format!("Invalid aspect_ratio: {a}"),
            )
            .with_param("value", a.clone()));
        }
    }
    if req.final_prompt.trim().is_empty() {
        return Err(ProviderError::coded(
            "backend_empty_prompt",
            "The prompt cannot be empty",
        ));
    }
    if req.images.len() > 10 {
        return Err(ProviderError::coded(
            "backend_bfl_max_refs",
            "At most 10 reference images are allowed",
        ));
    }
    let mut p = Map::new();
    if let Some(version) = &req.params.version {
        if version != "latest" {
            return Err(ProviderError::coded(
                "backend_bfl_version",
                "BFL version only supports latest",
            ));
        }
        p.insert("version".into(), json!(version));
    }
    p.insert("prompt".into(), json!(req.final_prompt));
    if req.images.is_empty() {
        // 文生图：aspect_ratio + resolution
        let aspect = req
            .params
            .aspect_ratio
            .clone()
            .unwrap_or_else(|| "auto".into());
        p.insert("aspect_ratio".into(), json!(aspect));
    } else {
        // 编辑：图片 + aspect（默认 auto 保持输入比例）
        for img in &req.images {
            let (_, bytes) = super::parse_data_url(img)?;
            let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
                .with_guessed_format()
                .map_err(|_| {
                    ProviderError::coded(
                        "backend_ref_format",
                        "Couldn't recognize the reference image format",
                    )
                })?;
            let (w, h) = reader.into_dimensions().map_err(|_| {
                ProviderError::coded(
                    "backend_ref_not_image",
                    "The reference image is not a valid image",
                )
            })?;
            if w < 256 || h < 256 || u64::from(w) * u64::from(h) > 16_000_000 {
                return Err(ProviderError::coded(
                    "backend_bfl_ref_bounds",
                    "Each BFL reference image must be at least 256px on each side and at most 16MP, including after compression",
                ));
            }
        }
        p.insert("images".into(), json!(req.images));
        let aspect = req
            .params
            .aspect_ratio
            .clone()
            .unwrap_or_else(|| "auto".into());
        p.insert("aspect_ratio".into(), json!(aspect));
    }
    if let Some(r) = &req.params.resolution {
        let wire = match r.as_str() {
            "768" | "768sq" => "768sq",
            "1K" | "1k" => "1k",
            "1.5K" | "1.5k" => "1.5k",
            "2K" | "2k" => "2k",
            "4K" | "4k" => "4k",
            _ => {
                return Err(ProviderError::coded(
                    "backend_invalid_resolution",
                    format!("Invalid resolution: {r}"),
                )
                .with_param("value", r.clone()))
            }
        };
        p.insert("resolution".into(), json!(wire));
    }
    if let Some(grounding) = req.params.grounding {
        p.insert("grounding".into(), json!(grounding));
    }
    if let Some(s) = req.params.safety_tolerance {
        p.insert("safety_tolerance".into(), json!(s));
    }
    Ok(Value::Object(p))
}

pub async fn generate(req: &GenerateRequest) -> ProviderResult {
    let key = read_key()?;
    let payload = build_payload(req)?;

    let resp = client()
        .post(ENDPOINT)
        .header("x-key", &key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            ProviderError::coded(
                "backend_bfl_connect",
                format!("Couldn't connect to the BFL API: {e}"),
            )
            .with_param("detail", e.to_string())
        })?;
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if status != 200 {
        let upstream = body
            .pointer("/detail/0/msg")
            .or_else(|| body.pointer("/detail"))
            .map(|v| v.to_string());
        return Err(match upstream {
            Some(message) => ProviderError::http(status, message),
            None => ProviderError::coded("backend_http_status", format!("HTTP {status}"))
                .with_param("status", status)
                .with_status(status),
        });
    }
    let polling_url = body
        .get("polling_url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            ProviderError::coded(
                "backend_bfl_missing_poll",
                "The BFL response is missing polling_url",
            )
        })?
        .to_string();
    super::progress::report("waiting", body["id"].as_str(), None, None);

    let deadline = std::time::Instant::now() + POLL_TIMEOUT;
    let result: Value = loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        let poll = client()
            .get(&polling_url)
            .header("x-key", &key)
            .send()
            .await
            .map_err(|e| {
                ProviderError::coded("backend_bfl_poll", format!("Polling failed: {e}"))
                    .with_param("detail", e.to_string())
            })?;
        let poll_status = poll.status().as_u16();
        let poll_body: Value = poll.json().await.unwrap_or(Value::Null);
        if poll_status != 200 {
            return Err(ProviderError::http(poll_status, poll_body.to_string()));
        }
        let st = poll_body
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        super::progress::report(
            match st {
                "Pending" => "queued",
                "Reasoning" => "reasoning",
                "Generating" => "generating",
                "Ready" => "downloading",
                _ => "waiting",
            },
            body["id"].as_str(),
            None,
            Some(st),
        );
        match st {
            "Ready" => break poll_body,
            "Error" | "Failed" | "Content Moderated" | "Request Moderated" | "Task Not Found" => {
                let detail = poll_body
                    .pointer("/result/details")
                    .map(|v| format!(" ({v})"))
                    .unwrap_or_default();
                return Err(ProviderError::coded(
                    "backend_bfl_task_ended",
                    format!("BFL task ended: {st}{detail}"),
                )
                .with_param("status", st)
                .with_param("detail", detail));
            }
            _ => {}
        }
        if std::time::Instant::now() > deadline {
            return Err(ProviderError::coded(
                "backend_bfl_timeout",
                "The BFL task timed out after 10 minutes",
            ));
        }
    };

    let sample = result
        .pointer("/result/sample")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            ProviderError::coded(
                "backend_bfl_missing_sample",
                "The BFL result is missing a sample URL",
            )
        })?;
    let img = client()
        .get(sample)
        .send()
        .await
        .map_err(|e| {
            ProviderError::coded(
                "backend_download_result",
                format!("Couldn't download the result image: {e}"),
            )
            .with_param("detail", e.to_string())
        })?;
    if !img.status().is_success() {
        return Err(ProviderError::coded(
            "backend_download_result_failed",
            "Couldn't download the result image",
        )
        .with_status(img.status().as_u16()));
    }
    let media_type = img
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .split(';')
        .next()
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = img
        .bytes()
        .await
        .map_err(|e| {
            ProviderError::coded(
                "backend_download_result",
                format!("Couldn't download the result image: {e}"),
            )
            .with_param("detail", e.to_string())
        })?;
    use base64::Engine;
    let data_url = format!(
        "data:{media_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    );

    let mut notes = Vec::new();
    // BFL cost 的单位为 credits；1 credit = $0.01。保留原始单位并归一化 UI 的美元字段。
    let mut usage = result.get("result").cloned().unwrap_or_else(|| json!({}));
    if let Some(credits) = body.get("cost").and_then(Value::as_f64) {
        usage["costCredits"] = json!(credits);
        usage["cost"] = json!(credits / 100.0);
    }
    for field in ["id", "input_mp", "output_mp"] {
        if let Some(value) = body.get(field) {
            usage[field] = value.clone();
        }
    }
    if let Some(expanded) = result.pointer("/result/prompt").and_then(|v| v.as_str()) {
        if expanded != req.final_prompt {
            notes.push(localized_note(
                "backend_bfl_expanded_prompt",
                format!("BFL expanded prompt: {expanded}"),
                &[("prompt", expanded.to_string())],
            ));
        }
    }

    Ok(GenerateOutput {
        provider: "bfl".into(),
        model: "flux-3-image".into(),
        final_prompt: req.final_prompt.clone(),
        images: vec![OutputImage {
            details: None,
            data_url,
            media_type,
        }],
        usage,
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::GenerateParams;
    use base64::Engine;

    fn req(images: Vec<String>, params: GenerateParams) -> GenerateRequest {
        GenerateRequest {
            provider: "bfl".into(),
            model: "flux-3-image".into(),
            final_prompt: "edit instruction".into(),
            images,
            params,
            ..Default::default()
        }
    }
    fn png(w: u32, h: u32) -> String {
        let img = image::DynamicImage::new_rgb8(w, h);
        let mut bytes = std::io::Cursor::new(Vec::new());
        img.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
        )
    }
    #[test]
    fn rejects_bad_images_and_dimensions() {
        for images in [
            vec!["not-a-data-url".into()],
            vec!["data:image/png;base64,aGVsbG8=".into()],
            vec![png(255, 256)],
            vec![png(256, 256); 11],
        ] {
            assert!(build_payload(&req(images, GenerateParams::default())).is_err());
        }
    }
}
