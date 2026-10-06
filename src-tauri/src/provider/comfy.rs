//! Comfy Router v2：按模型使用原生请求，异步队列与 API Key 鉴权。
use super::{transport, GenerateOutput, GenerateRequest, ProviderError, ProviderResult};
use serde_json::{json, Map, Value};
use std::time::{Duration, Instant};
pub const ENDPOINT: &str = "https://api.comfy.org/v2/models";

pub fn build_payload(req: &GenerateRequest) -> Result<Value, ProviderError> {
    crate::models::validate(req)?;
    let model = crate::models::resolve(req)?;
    let p = &req.params;
    match model.family {
        "flux" => super::bfl::build_payload(req),
        "gpt" => {
            let mut body = json!({"prompt":req.final_prompt, "quality":p.quality.as_deref().unwrap_or("auto"), "size":p.size.as_deref().unwrap_or("1024x1024"), "background":p.background.as_deref().unwrap_or("auto"), "output_format":p.output_format.as_deref().unwrap_or("png"), "moderation":p.moderation.as_deref().unwrap_or("auto"), "n":p.count.unwrap_or(1)});
            if !req.images.is_empty() {
                body["image"] = json!(req.images);
            }
            if let Some(mask) = &req.mask {
                body["mask"] = json!(mask);
            }
            if p.output_format.as_deref().is_some_and(|f| f != "png") {
                if let Some(c) = p.output_compression {
                    body["output_compression"] = json!(c);
                }
            }
            Ok(body)
        }
        "qwen" => {
            let mut content: Vec<Value> = req.images.iter().map(|im| json!({"image":im})).collect();
            content.push(json!({"text":req.final_prompt}));
            let mut parameters = json!({"n":p.count.unwrap_or(1), "prompt_extend":p.prompt_extend.unwrap_or(true), "watermark":p.watermark.unwrap_or(false)});
            if let (Some(width), Some(height)) = (p.width, p.height) {
                parameters["size"] = json!(format!("{width}*{height}"));
            }
            if let Some(seed) = p.seed {
                parameters["seed"] = json!(seed);
            }
            if let Some(negative) = &p.negative_prompt {
                if !negative.is_empty() {
                    parameters["negative_prompt"] = json!(negative);
                }
            }
            if p.prompt_extend != Some(false) {
                parameters["prompt_extend_mode"] =
                    json!(p.prompt_extend_mode.as_deref().unwrap_or("direct"));
            }
            Ok(
                json!({"input":{"messages":[{"role":"user","content":content}]}, "parameters":parameters}),
            )
        }
        _ => Err(ProviderError::msg("Comfy 尚未实现该模型家族的请求编码")),
    }
}
pub async fn generate(req: &GenerateRequest) -> ProviderResult {
    let key = transport::key("comfy")?;
    generate_at(req, &key, ENDPOINT).await
}
#[doc(hidden)]
pub async fn generate_at(req: &GenerateRequest, key: &str, endpoint: &str) -> ProviderResult {
    let model = crate::models::resolve(req)?;
    let payload = build_payload(req)?;
    let idempotency = req
        .request_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let url = format!("{endpoint}/{}/requests", model.wire_id());
    let (_, submit, _, mut actual_credits) = transport::json_with_metadata(
        transport::client()
            .post(&url)
            .header("X-API-Key", key)
            .header("Idempotency-Key", idempotency)
            .json(&payload),
        "Comfy",
    )
    .await?;
    let id = submit["request_id"]
        .as_str()
        .filter(|id| {
            !id.is_empty()
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
        .ok_or_else(|| ProviderError::msg("Comfy 提交响应缺少有效 request_id"))?;
    let result_url = format!("{url}/{id}");
    super::progress::report("waiting", Some(id), None, None);
    let deadline = Instant::now() + Duration::from_secs(900);
    let mut interval = Duration::from_secs(2);
    let mut read_failures = 0;
    let body = loop {
        tokio::time::sleep(interval).await;
        let read = transport::json_with_metadata(
            transport::client()
                .get(&result_url)
                .header("X-API-Key", key),
            "Comfy",
        )
        .await;
        let (status, body, retry_after, credits) = match read {
            Ok(response) => {
                read_failures = 0;
                response
            }
            Err(e)
                if (e.status.is_none() || e.status.is_some_and(|s| s >= 500))
                    && read_failures < 3
                    && Instant::now() < deadline =>
            {
                read_failures += 1;
                interval = Duration::from_secs(2 * read_failures);
                continue;
            }
            Err(e) => return Err(e.with_hint(format!("已提交任务 {id}；未自动重新生成。"))),
        };
        interval = retry_after.unwrap_or(Duration::from_secs(2));
        if credits.is_some() {
            actual_credits = credits;
        }
        super::progress::report(
            if status == 200 {
                "downloading"
            } else if body["status"].as_str() == Some("RUNNING") {
                "generating"
            } else if matches!(body["status"].as_str(), Some("QUEUED" | "PENDING")) {
                "queued"
            } else {
                "waiting"
            },
            Some(id),
            None,
            body["status"].as_str(),
        );
        if status == 200 {
            break body;
        }
        if matches!(body["status"].as_str(), Some("FAILED" | "CANCELLED")) {
            return Err(ProviderError::msg(format!(
                "Comfy 任务 {id} 终止：{}",
                body["status"]
            )));
        }
        if Instant::now() > deadline {
            return Err(ProviderError::msg("Comfy 等待结果超时")
                .with_hint(format!("任务 {id} 可能仍在运行；未重新提交。")));
        }
    };
    let mut out = normalize(req, &body, Some(id)).await?;
    out.usage["comfyRequestId"] = json!(id);
    out.usage["comfyChargeReported"] = json!(actual_credits.is_some());
    if let Some(credits) = actual_credits {
        out.usage["credits"] = json!(credits);
    }
    Ok(out)
}
pub async fn normalize(req: &GenerateRequest, body: &Value, job: Option<&str>) -> ProviderResult {
    let model = crate::models::resolve(req)?;
    let images = match model.family {
        "gpt" => {
            transport::openai_images(body, req.params.output_format.as_deref().unwrap_or("png"))
                .await?
        }
        "flux" => vec![
            transport::download_image(
                body.pointer("/result/sample")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ProviderError::msg("Comfy FLUX 响应缺少结果图片"))?,
            )
            .await?,
        ],
        "qwen" => {
            let choices = body
                .pointer("/output/choices")
                .and_then(Value::as_array)
                .ok_or_else(|| ProviderError::msg("Comfy Qwen 响应缺少结果"))?;
            let mut images = Vec::new();
            for choice in choices {
                if let Some(content) = choice.pointer("/message/content").and_then(Value::as_array)
                {
                    for part in content {
                        if let Some(url) = part["image"].as_str() {
                            images.push(transport::download_image(url).await?);
                        }
                    }
                }
            }
            if images.is_empty() {
                return Err(ProviderError::msg("Comfy Qwen 没有返回图片"));
            }
            images
        }
        _ => return Err(ProviderError::msg("Comfy 结果格式未实现")),
    };
    let mut usage = body["usage"].as_object().cloned().unwrap_or_else(Map::new);
    // Native provider cost/credits fields are not the Comfy charge.
    usage.remove("credits");
    usage.remove("cost");
    Ok(GenerateOutput {
        provider: "comfy".into(),
        model: model.wire_id().into(),
        final_prompt: req.final_prompt.clone(),
        images,
        usage: Value::Object(usage),
        notes: job
            .map(|id| {
                vec![format!(
                    "Comfy 任务 {id}；实际扣费以 Comfy 返回的 Credits 为准。"
                )]
            })
            .unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };

    #[tokio::test]
    async fn charge_metadata_survives_submit_and_absent_collect_headers() {
        for reported in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}/v2/models", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                for (status, body) in [
                    (201, json!({"request_id":"billing-test"})),
                    (
                        200,
                        json!({"data":[{"b64_json":"YWJj"}], "usage":{"credits":999,"cost":99}}),
                    ),
                ] {
                    let (mut stream, _) = listener.accept().unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    let mut chunk = [0u8; 4096];
                    loop {
                        let n = stream.read(&mut chunk).unwrap();
                        assert!(n > 0);
                        bytes.extend_from_slice(&chunk[..n]);
                        if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&bytes[..end]);
                            let length: usize = head
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .map(|v| v.trim().parse().unwrap())
                                })
                                .unwrap_or(0);
                            if bytes.len() >= end + 4 + length {
                                break;
                            }
                        }
                    }
                    let text = body.to_string();
                    let billing = if status == 201 && reported {
                        "X-Comfy-Credits-Used: 12.75\r\n"
                    } else {
                        ""
                    };
                    write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{billing}Connection: close\r\n\r\n{text}", text.len()).unwrap();
                }
            });
            let request: GenerateRequest = serde_json::from_value(json!({"provider":"comfy", "model":"gpt-image-2.5-flare", "finalPrompt":"test", "params":{"size":"1024x1024","outputFormat":"png","count":1}})).unwrap();
            let result = generate_at(&request, "test-only-key", &endpoint)
                .await
                .unwrap();
            server.join().unwrap();
            assert_eq!(result.usage["comfyChargeReported"], reported);
            assert_eq!(
                result.usage["credits"],
                if reported { json!(12.75) } else { Value::Null }
            );
            assert!(result.usage["cost"].is_null());
            assert_eq!(result.usage["comfyRequestId"], "billing-test");
        }
    }
}
