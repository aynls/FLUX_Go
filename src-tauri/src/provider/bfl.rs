//! BFL 官方 API 直连适配器（第二后端，可选）。
//!
//! 端点: POST https://api.bfl.ai/v1/flux-3-image，x-key 鉴权，
//! 异步提交 → 轮询 polling_url → 下载 result.sample。
//! 该端点严格校验未知字段（422），载荷只包含官方文档列出的字段。
//! 使用 BFL_API_KEY。

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Map, Value};

use super::{GenerateOutput, GenerateRequest, OutputImage, ProviderError, ProviderResult};

pub const ENDPOINT: &str = "https://api.bfl.ai/v1/flux-3-image";
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const POLL_TIMEOUT: Duration = Duration::from_secs(600);

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("构建 HTTP 客户端失败")
    })
}

fn read_key() -> Result<String, ProviderError> {
    super::configured_key("bfl").ok_or_else(|| {
        ProviderError::msg("尚未配置 BFL API Key")
            .with_hint("请在应用设置中检查所选密钥来源、环境变量名称或手动填写的密钥。")
    })
}

pub fn build_payload(req: &GenerateRequest) -> Result<Value, ProviderError> {
    crate::models::validate(req)?;
    if crate::models::resolve(req)?.family != "flux" {
        return Err(ProviderError::msg("BFL 适配器仅支持 FLUX 3 Image"));
    }
    if req.params.safety_tolerance.is_some_and(|s| s > 4) {
        return Err(ProviderError::msg("BFL safety_tolerance 取值范围 0–4"));
    }
    if let Some(a) = &req.params.aspect_ratio {
        if ![
            "21:9", "2:1", "16:9", "3:2", "7:5", "4:3", "5:4", "1:1", "4:5", "3:4", "5:7", "2:3",
            "9:16", "1:2", "9:21", "auto",
        ]
        .contains(&a.as_str())
        {
            return Err(ProviderError::msg(format!("aspect_ratio 无效: {a}")));
        }
    }
    if req.final_prompt.trim().is_empty() {
        return Err(ProviderError::msg("提示词不能为空"));
    }
    if req.images.len() > 10 {
        return Err(ProviderError::msg("参考图最多 10 张"));
    }
    let mut p = Map::new();
    if let Some(version) = &req.params.version {
        if version != "latest" {
            return Err(ProviderError::msg("BFL version 仅支持 latest"));
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
                .map_err(|_| ProviderError::msg("无法识别参考图格式"))?;
            let (w, h) = reader
                .into_dimensions()
                .map_err(|_| ProviderError::msg("参考图不是有效图片"))?;
            if w < 256 || h < 256 || u64::from(w) * u64::from(h) > 16_000_000 {
                return Err(ProviderError::msg(
                    "BFL 参考图每边至少 256px，面积最多 16MP（压缩后也须满足）",
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
            _ => return Err(ProviderError::msg(format!("resolution 无效: {r}"))),
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
        .map_err(|e| ProviderError::msg(format!("无法连接 BFL API: {e}")))?;
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if status != 200 {
        let message = body
            .pointer("/detail/0/msg")
            .or_else(|| body.pointer("/detail"))
            .map(|v| v.to_string())
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(ProviderError::http(status, message));
    }
    let polling_url = body
        .get("polling_url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ProviderError::msg("BFL 响应缺少 polling_url"))?
        .to_string();

    let deadline = std::time::Instant::now() + POLL_TIMEOUT;
    let result: Value = loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        let poll = client()
            .get(&polling_url)
            .header("x-key", &key)
            .send()
            .await
            .map_err(|e| ProviderError::msg(format!("轮询失败: {e}")))?;
        let poll_status = poll.status().as_u16();
        let poll_body: Value = poll.json().await.unwrap_or(Value::Null);
        if poll_status != 200 {
            return Err(ProviderError::http(poll_status, poll_body.to_string()));
        }
        let st = poll_body
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        match st {
            "Ready" => break poll_body,
            "Error" | "Failed" | "Content Moderated" | "Request Moderated" | "Task Not Found" => {
                return Err(ProviderError::msg(format!(
                    "BFL 任务终止: {st}{}",
                    poll_body
                        .pointer("/result/details")
                        .map(|v| format!(" ({v})"))
                        .unwrap_or_default()
                )));
            }
            _ => {}
        }
        if std::time::Instant::now() > deadline {
            return Err(ProviderError::msg("BFL 任务超时（10 分钟）"));
        }
    };

    let sample = result
        .pointer("/result/sample")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ProviderError::msg("BFL 结果缺少 sample URL"))?;
    let img = client()
        .get(sample)
        .send()
        .await
        .map_err(|e| ProviderError::msg(format!("下载结果图片失败: {e}")))?;
    if !img.status().is_success() {
        return Err(ProviderError::http(
            img.status().as_u16(),
            "下载结果图片失败",
        ));
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
        .map_err(|e| ProviderError::msg(format!("下载结果图片失败: {e}")))?;
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
            notes.push(format!("BFL 展开后的提示词: {expanded}"));
        }
    }

    Ok(GenerateOutput {
        provider: "bfl".into(),
        model: "flux-3-image".into(),
        final_prompt: req.final_prompt.clone(),
        images: vec![OutputImage {
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
    fn edit_keeps_resolution_and_grounding() {
        let p = build_payload(&req(
            vec![png(256, 256)],
            GenerateParams {
                resolution: Some("768".into()),
                grounding: Some(false),
                ..Default::default()
            },
        ))
        .unwrap();
        assert_eq!(p["aspect_ratio"], "auto");
        assert_eq!(p["resolution"], "768sq");
        assert_eq!(p["grounding"], false);
        assert_eq!(p.as_object().unwrap().len(), 5);
    }
    #[test]
    fn all_resolution_tiers_map_for_both_modes() {
        for (ui, wire) in [
            ("768", "768sq"),
            ("1K", "1k"),
            ("1.5K", "1.5k"),
            ("2K", "2k"),
            ("4K", "4k"),
        ] {
            for images in [vec![], vec![png(256, 256)]] {
                let p = build_payload(&req(
                    images,
                    GenerateParams {
                        resolution: Some(ui.into()),
                        aspect_ratio: Some("16:9".into()),
                        ..Default::default()
                    },
                ))
                .unwrap();
                assert_eq!(p["resolution"], wire);
                assert_eq!(p["aspect_ratio"], "16:9");
                assert!(p.get("grounding").is_none());
            }
        }
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
    #[test]
    fn validates_native_params() {
        for params in [
            GenerateParams {
                safety_tolerance: Some(5),
                ..Default::default()
            },
            GenerateParams {
                resolution: Some("8K".into()),
                ..Default::default()
            },
            GenerateParams {
                aspect_ratio: Some("11:9".into()),
                ..Default::default()
            },
        ] {
            assert!(build_payload(&req(vec![], params)).is_err());
        }
        let p = build_payload(&req(
            vec![],
            GenerateParams {
                safety_tolerance: Some(4),
                aspect_ratio: Some("auto".into()),
                ..Default::default()
            },
        ))
        .unwrap();
        assert_eq!(p["safety_tolerance"], 4);
        assert_eq!(p["aspect_ratio"], "auto");
    }

    #[test]
    fn version_is_explicit_and_invalid_versions_are_rejected() {
        let p = build_payload(&req(
            vec![],
            GenerateParams {
                version: Some("latest".into()),
                ..Default::default()
            },
        ))
        .unwrap();
        assert_eq!(p["version"], "latest");
        assert!(build_payload(&req(
            vec![],
            GenerateParams {
                version: Some("unknown".into()),
                ..Default::default()
            }
        ))
        .is_err());
    }
}
