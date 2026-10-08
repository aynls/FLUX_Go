//! Runware Models API：统一任务协议、结构化 FLUX 区域和白色编辑蒙版。
use super::{
    localized_note, transport, GenerateOutput, GenerateRequest, OutputImage, ProviderError,
    ProviderResult,
};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
pub const ENDPOINT: &str = "https://api.runware.ai/v1";

pub fn build_payload(req: &GenerateRequest, task_id: &str) -> Result<Value, ProviderError> {
    crate::models::validate(req)?;
    let m = crate::models::resolve(req)?;
    let p = &req.params;
    let format = match p.output_format.as_deref().unwrap_or("png") {
        "jpeg" => "JPG",
        "webp" => "WEBP",
        _ => "PNG",
    };
    let mut task = json!({"taskType":"imageInference", "taskUUID":task_id, "model":m.wire_id(), "positivePrompt":req.final_prompt, "deliveryMethod":"async", "outputType":"URL", "outputFormat":format, "includeCost":true, "numberResults":p.count.unwrap_or(1)});
    if format != "PNG" {
        task["outputQuality"] = json!(p.output_compression.unwrap_or(95));
    }
    if !req.images.is_empty() {
        task["inputs"] = json!({"referenceImages":req.images});
    }
    match m.family {
        "flux" => {
            task["positivePrompt"] = json!(req.instruction.as_deref().unwrap_or(&req.final_prompt));
            if !req.images.is_empty() && p.aspect_ratio.as_deref() == Some("auto") {
                task["resolution"] = json!(if p.resolution.as_deref() == Some("768") {
                    "0.75K"
                } else {
                    p.resolution.as_deref().unwrap_or("1K")
                });
            } else {
                let size = flux_dimensions(
                    p.resolution.as_deref().unwrap_or("1K"),
                    p.aspect_ratio.as_deref().unwrap_or("1:1"),
                )?;
                task["width"] = json!(size.0);
                task["height"] = json!(size.1);
            }
            let mut settings = json!({"grounding":p.grounding.unwrap_or(true)});
            if let Some(safety) = p.safety_tolerance {
                settings["safetyTolerance"] = json!(safety);
            }
            if !req.regions.is_empty() {
                settings["boundingBoxes"] = json!(req.regions);
            }
            task["settings"] = settings;
        }
        "gpt" => {
            let (w, h) =
                crate::models::validate_gpt_size(p.size.as_deref().unwrap_or("1024x1024"))?;
            task["width"] = json!(w);
            task["height"] = json!(h);
            task["settings"] = json!({"quality":p.quality.as_deref().unwrap_or("auto"), "background":p.background.as_deref().unwrap_or("auto"), "moderation":p.moderation.as_deref().unwrap_or("auto")});
            if format != "PNG" {
                task["outputQuality"] = json!(p.output_compression.unwrap_or(95));
            }
            if let Some(mask) = &req.mask {
                task["inputs"]["maskImage"] = json!(white_edit_mask(mask)?);
            }
        }
        "qwen" => {
            task["width"] = json!(p.width.unwrap_or(1024));
            task["height"] = json!(p.height.unwrap_or(1024));
            if let Some(seed) = p.seed {
                task["seed"] = json!(seed);
            }
            if let Some(negative) = &p.negative_prompt {
                if !negative.is_empty() {
                    task["negativePrompt"] = json!(negative);
                }
            }
            task["settings"] = json!({"promptExtend":p.prompt_extend.unwrap_or(true)});
            if p.prompt_extend != Some(false) {
                task["settings"]["promptExtendMode"] =
                    json!(p.prompt_extend_mode.as_deref().unwrap_or("direct"));
            }
        }
        "gemini" => {
            let aspect = p.aspect_ratio.as_deref().unwrap_or("1:1");
            let resolution = p.resolution.as_deref().unwrap_or("1K");
            let mut settings = serde_json::Map::new();
            if let Some(level) = &p.thinking_level {
                settings.insert("thinkingLevel".into(), json!(level));
            }
            if let Some(mode) = p.search_mode.as_deref() {
                settings.insert("webSearch".into(), json!(matches!(mode, "web" | "web_images")));
                settings.insert("imageSearch".into(), json!(matches!(mode, "images" | "web_images")));
            }
            if !settings.is_empty() {
                task["settings"] = Value::Object(settings);
            }
            if aspect == "auto" {
                task["resolution"] = json!(if resolution == "512" {
                    "0.5K"
                } else {
                    resolution
                });
            } else {
                let key = m.route["dimensionsKey"].as_str().unwrap_or(m.id);
                let pair = crate::models::catalog()["imageDimensions"][key][resolution][aspect]
                    .as_array()
                    .ok_or_else(|| {
                        ProviderError::coded(
                            "backend_gemini_dimensions",
                            "The Gemini resolution or aspect ratio is invalid",
                        )
                    })?;
                task["width"] = pair[0].clone();
                task["height"] = pair[1].clone();
            }
            if let Some(seed) = p.seed {
                task["seed"] = json!(seed);
            }
        }
        "grok" => {
            let aspect = p.aspect_ratio.as_deref().unwrap_or("1:1");
            let resolution = p.resolution.as_deref().unwrap_or("1K");
            task["settings"] = json!({"quality": p.quality.as_deref().unwrap_or("medium")});
            if aspect == "auto" {
                task["resolution"] = json!(resolution);
            } else {
                let key = m.route["dimensionsKey"].as_str().unwrap_or(m.id);
                let pair = crate::models::catalog()["imageDimensions"][key][resolution][aspect]
                    .as_array()
                    .ok_or_else(|| {
                        ProviderError::coded(
                            "backend_grok_dimensions",
                            "The Grok resolution or aspect ratio is invalid",
                        )
                    })?;
                task["width"] = pair[0].clone();
                task["height"] = pair[1].clone();
            }
        }
        "seedream" => {
            if let Some(key) = m.route["dimensionsKey"].as_str() {
                let pair = crate::models::catalog()["imageDimensions"][key]
                    [p.resolution.as_deref().unwrap_or("2K")]
                    [p.aspect_ratio.as_deref().unwrap_or("1:1")]
                .as_array()
                .ok_or_else(|| {
                    ProviderError::coded(
                        "backend_seedream_dimensions",
                        "The Seedream resolution or aspect ratio is invalid",
                    )
                })?;
                task["width"] = pair[0].clone();
                task["height"] = pair[1].clone();
            } else {
                task["width"] = json!(p
                    .width
                    .ok_or_else(|| {
                        ProviderError::coded(
                            "backend_seedream_width",
                            "Seedream requires an output width",
                        )
                    })?);
                task["height"] = json!(p
                    .height
                    .ok_or_else(|| {
                        ProviderError::coded(
                            "backend_seedream_height",
                            "Seedream requires an output height",
                        )
                    })?);
            }
            if m.id == "seedream-5-lite" {
                task["settings"] = json!({"maxSequentialImages":1});
            }
        }
        _ => {
            return Err(ProviderError::coded(
                "backend_runware_family",
                "Runware cannot encode this model family yet",
            ))
        }
    }
    Ok(json!([task]))
}
pub fn flux_dimensions(resolution: &str, aspect: &str) -> Result<(u32, u32), ProviderError> {
    let pair = crate::models::catalog()["fluxDimensions"][resolution][aspect]
        .as_array()
        .ok_or_else(|| {
            ProviderError::coded(
                "backend_runware_flux_dimensions",
                "The Runware FLUX resolution or aspect ratio is invalid",
            )
        })?;
    Ok((
        pair[0].as_u64().unwrap() as u32,
        pair[1].as_u64().unwrap() as u32,
    ))
}
pub fn white_edit_mask(mask: &str) -> Result<String, ProviderError> {
    let (_, bytes) = super::parse_data_url(mask)?;
    let im = image::load_from_memory(&bytes)
        .map_err(|_| ProviderError::coded("backend_mask_decode", "Couldn't decode the mask"))?
        .to_rgba8();
    let gray = image::GrayImage::from_fn(im.width(), im.height(), |x, y| {
        image::Luma([if im.get_pixel(x, y).0[3] == 0 { 255 } else { 0 }])
    });
    let mut output = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageLuma8(gray)
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|_| ProviderError::coded("backend_mask_convert", "Couldn't convert the mask"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(output.into_inner())
    ))
}
pub async fn generate(req: &GenerateRequest) -> ProviderResult {
    let key = transport::key("runware")?;
    generate_at(req, &key, ENDPOINT).await
}
#[doc(hidden)]
pub async fn generate_at(req: &GenerateRequest, key: &str, endpoint: &str) -> ProviderResult {
    let id = req
        .request_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err(ProviderError::coded(
            "backend_task_uuid",
            "The task id must be a UUID",
        ));
    }
    let payload = build_payload(req, &id)?;
    let (_, mut body) = transport::json(
        transport::client()
            .post(endpoint)
            .bearer_auth(key)
            .json(&payload),
        "Runware",
    )
    .await?;
    let mut results: BTreeMap<String, Value> = BTreeMap::new();
    super::progress::report("waiting", Some(&id), Some(0), None);
    let deadline = Instant::now() + Duration::from_secs(900);
    let expected = req.params.count.unwrap_or(1) as usize;
    let mut notes = vec![localized_note(
        "backend_runware_task",
        format!("Runware task {id}"),
        &[("id", id.clone())],
    )];
    let mut interval = 2;
    loop {
        let terminal_error = collect_results(&body, &id, &mut results);
        super::progress::report("waiting", Some(&id), Some(results.len()), None);
        if let Some(error) = terminal_error {
            if results.is_empty() {
                return Err(runware_failure(error)
                    .with_hint(format!("Task {id}; not retried automatically."))
                    .with_hint_code("backend_task_not_retried")
                    .with_param("id", id.clone()));
            }
            notes.push(localized_note(
                "backend_runware_partial_failed",
                format!("Some results failed: {error}"),
                &[("detail", error.clone())],
            ));
            break;
        }
        if results.len() >= expected {
            break;
        }
        if Instant::now() >= deadline {
            if results.is_empty() {
                return Err(ProviderError::coded(
                    "backend_runware_timeout",
                    "Timed out waiting for the Runware result",
                )
                .with_hint(format!(
                    "Task {id} may still be running. It was not submitted again."
                ))
                .with_hint_code("backend_task_still_running")
                .with_param("id", id.clone()));
            }
            notes.push(localized_note(
                "backend_runware_partial_missing",
                "Some results are still missing. Received images were saved; nothing was generated again.",
                &[],
            ));
            break;
        }
        tokio::time::sleep(Duration::from_secs(interval)).await;
        interval = (interval + 1).min(8);
        match transport::json(
            transport::client()
                .post(endpoint)
                .bearer_auth(key)
                .json(&json!([{"taskType":"getResponse","taskUUID":id}])),
            "Runware",
        )
        .await
        {
            Ok((_, next)) => body = next,
            Err(e) if !results.is_empty() => {
                notes.push(localized_note(
                    "backend_runware_later_results",
                    format!(
                        "Couldn't read later results: {}. Received images were saved.",
                        e.message
                    ),
                    &[("detail", e.message.clone())],
                ));
                break;
            }
            Err(e) => {
                return Err(e
                    .with_hint(format!("Submitted task {id}; nothing was generated again."))
                    .with_hint_code("backend_task_submitted")
                    .with_param("id", id.clone()))
            }
        }
    }
    let mut images: Vec<OutputImage> = Vec::new();
    super::progress::report("downloading", Some(&id), Some(results.len()), None);
    let mut cost = 0.0;
    let mut has_cost = false;
    for item in results.values() {
        let image = if let Some(url) = item["imageDataURI"]
            .as_str()
            .or_else(|| item["imageURL"].as_str())
        {
            transport::download_image(url).await?
        } else if let Some(b64) = item["imageBase64Data"].as_str() {
            transport::base64_image(
                b64,
                &format!(
                    "image/{}",
                    req.params.output_format.as_deref().unwrap_or("png")
                ),
            )?
        } else {
            continue;
        };
        images.push(image);
        if let Some(c) = item["cost"].as_f64() {
            cost += c;
            has_cost = true;
        }
    }
    if images.is_empty() {
        return Err(ProviderError::coded(
            "backend_runware_no_image",
            "Runware returned no image",
        ));
    }
    let usage = if has_cost {
        json!({"cost":cost})
    } else {
        Value::Null
    };
    Ok(GenerateOutput {
        provider: "runware".into(),
        model: crate::models::resolve(req)?.wire_id().into(),
        final_prompt: req.final_prompt.clone(),
        images,
        usage,
        notes,
    })
}
/// Polling may repeat earlier outputs. Deduplicate by image identity, never by URL expiry tokens.
pub fn collect_results(
    body: &Value,
    task_id: &str,
    results: &mut BTreeMap<String, Value>,
) -> Option<String> {
    if let Some(items) = body["data"].as_array() {
        for item in items {
            if item["taskUUID"].as_str() != Some(task_id) {
                continue;
            }
            if let Some(id) = item["imageUUID"]
                .as_str()
                .or_else(|| item["imageURL"].as_str())
                .or_else(|| item["imageDataURI"].as_str())
            {
                results.insert(id.into(), item.clone());
            }
        }
    }
    body["errors"]
        .as_array()
        .and_then(|errors| {
            errors
                .iter()
                .find(|e| e["taskUUID"].as_str().is_none_or(|id| id == task_id))
        })
        .map(|e| {
            e["message"]
                .as_str()
                .unwrap_or(RUNWARE_TASK_FAILED)
                .to_string()
        })
}

const RUNWARE_TASK_FAILED: &str = "Runware task failed";

fn runware_failure(detail: String) -> ProviderError {
    ProviderError::coded(
        "backend_runware_task_failed",
        format!("Runware task failed: {detail}"),
    )
    .with_param("detail", detail)
}
