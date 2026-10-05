//! OpenRouter Image API 适配器。
//!
//! 端点: POST https://openrouter.ai/api/v1/images（同步返回 base64 图片）。
//! 请求字段仅限官方文档与 flux-3-image 端点 supported_parameters 中列出的项：
//! model, prompt, resolution, aspect_ratio, safety_tolerance(透传), input_references。
//! OpenRouter 未开放任何结构化包围盒字段——包围盒位于 final_prompt 内
//! （FLUX.3 官方布局协议），本适配器不做任何坐标改写。

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Map, Value};

use super::{
    GenerateOutput, GenerateParams, GenerateRequest, OutputImage, ProviderError, ProviderResult,
};

pub const ENDPOINT: &str = "https://openrouter.ai/api/v1/images";

const RESOLUTIONS: [&str; 5] = ["768", "1K", "1.5K", "2K", "4K"];
const ASPECT_RATIOS: [&str; 16] = [
    "21:9", "2:1", "16:9", "3:2", "7:5", "4:3", "5:4", "1:1", "4:5", "3:4", "5:7", "2:3", "9:16",
    "1:2", "9:21", "auto",
];

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .expect("构建 HTTP 客户端失败")
    })
}

fn read_key() -> Result<String, ProviderError> {
    super::configured_key("openrouter").ok_or_else(|| {
        ProviderError::msg("尚未配置 OpenRouter API Key")
            .with_hint("请在应用设置中检查所选密钥来源、环境变量名称或手动填写的密钥。")
    })
}

pub fn build_payload(req: &GenerateRequest) -> Result<Value, ProviderError> {
    validate_params(&req.params)?;
    if req.final_prompt.trim().is_empty() {
        return Err(ProviderError::msg("提示词不能为空"));
    }
    if req.images.len() > 10 {
        return Err(ProviderError::msg(format!(
            "参考图最多 10 张（当前 {} 张）",
            req.images.len()
        )));
    }
    let mut p = Map::new();
    p.insert("model".into(), json!(req.model));
    p.insert("prompt".into(), json!(req.final_prompt));
    if let Some(r) = &req.params.resolution {
        p.insert("resolution".into(), json!(r));
    }
    if let Some(a) = &req.params.aspect_ratio {
        p.insert("aspect_ratio".into(), json!(a));
    }
    if let Some(s) = req.params.safety_tolerance {
        // OpenRouter 官方透传白名单中的唯一 BFL 参数
        p.insert("safety_tolerance".into(), json!(s));
    }
    if !req.images.is_empty() {
        for img in &req.images {
            super::parse_data_url(img)?;
        }
        let refs: Vec<Value> = req
            .images
            .iter()
            .map(|url| json!({ "type": "image_url", "image_url": { "url": url } }))
            .collect();
        p.insert("input_references".into(), Value::Array(refs));
    }
    Ok(Value::Object(p))
}

fn validate_params(params: &GenerateParams) -> Result<(), ProviderError> {
    if let Some(r) = &params.resolution {
        if !RESOLUTIONS.contains(&r.as_str()) {
            return Err(ProviderError::msg(format!(
                "resolution 无效: {r}（允许 768/1K/1.5K/2K/4K）"
            )));
        }
    }
    if let Some(a) = &params.aspect_ratio {
        if !ASPECT_RATIOS.contains(&a.as_str()) {
            return Err(ProviderError::msg(format!("aspect_ratio 无效: {a}")));
        }
    }
    if let Some(s) = params.safety_tolerance {
        if s > 6 {
            return Err(ProviderError::msg("safety_tolerance 取值范围 0–6"));
        }
    }
    Ok(())
}

pub async fn generate(req: &GenerateRequest) -> ProviderResult {
    let key = read_key()?;
    let payload = build_payload(req)?;

    let resp = client()
        .post(ENDPOINT)
        .bearer_auth(key)
        .header("X-Title", "Flux Studio")
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            ProviderError::msg(format!("无法连接 OpenRouter: {e}"))
                .with_hint("请检查网络连接（该请求为同步付费调用，失败不会自动重试）。")
        })?;

    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);

    if status != 200 {
        let message = body
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| truncate(&text, 300));
        let hint = match status {
            401 => Some("API 密钥无效或已撤销，请检查 OPENROUTER_API_KEY。".to_string()),
            402 => Some("OpenRouter 余额不足，请到 openrouter.ai/credits 充值。".to_string()),
            413 => Some("请求体过大：尝试在高级设置中降低参考图尺寸上限。".to_string()),
            429 => Some("请求过于频繁或超出额度，稍后再试。".to_string()),
            500..=599 => Some("OpenRouter 或上游提供商临时故障，未自动重试。".to_string()),
            _ => None,
        };
        return Err(ProviderError {
            status: Some(status),
            message,
            hint,
        });
    }

    let data = body
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| ProviderError::msg("OpenRouter 响应缺少 data 字段"))?;
    if data.is_empty() {
        return Err(ProviderError::msg("OpenRouter 响应中没有图片"));
    }
    let mut images = Vec::new();
    for item in data {
        let b64 = item
            .get("b64_json")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ProviderError::msg("响应图片缺少 b64_json"))?;
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| ProviderError::msg(format!("图片 base64 解码失败: {e}")))?;
        let media_type = item
            .get("media_type")
            .and_then(|v| v.as_str())
            .unwrap_or("image/png")
            .to_string();
        images.push(OutputImage {
            data_url: format!(
                "data:{media_type};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ),
            media_type,
        });
    }

    Ok(GenerateOutput {
        provider: "openrouter".into(),
        model: req.model.clone(),
        final_prompt: req.final_prompt.clone(),
        images,
        usage: body.get("usage").cloned().unwrap_or(Value::Null),
        notes: Vec::new(),
    })
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let t: String = s.chars().take(n).collect();
        format!("{t}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(images: Vec<&str>, params: GenerateParams) -> GenerateRequest {
        GenerateRequest {
            provider: "openrouter".into(),
            model: "black-forest-labs/flux-3-image".into(),
            final_prompt: "In <ref_image_0>, add a star [{\"id\":\"star_1\"}]".into(),
            images: images.into_iter().map(String::from).collect(),
            params,
        }
    }

    const PNG: &str = "data:image/png;base64,aGVsbG8=";

    #[test]
    fn edit_payload_has_exact_documented_fields() {
        let p = build_payload(&req(
            vec![PNG],
            GenerateParams {
                resolution: Some("1K".into()),
                aspect_ratio: Some("auto".into()),
                safety_tolerance: Some(2),
                grounding: None,
                version: None,
            },
        ))
        .unwrap();
        let keys: Vec<&str> = p.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            vec![
                "model",
                "prompt",
                "resolution",
                "aspect_ratio",
                "safety_tolerance",
                "input_references"
            ]
        );
        let refs = p["input_references"].as_array().unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0]["type"], "image_url");
        assert_eq!(refs[0]["image_url"]["url"], PNG);
    }

    #[test]
    fn t2i_payload_has_no_input_references() {
        let p = build_payload(&req(
            vec![],
            GenerateParams {
                resolution: Some("768".into()),
                aspect_ratio: Some("1:1".into()),
                safety_tolerance: None,
                grounding: None,
                version: None,
            },
        ))
        .unwrap();
        assert!(p.get("input_references").is_none());
        assert!(p.get("safety_tolerance").is_none());
        assert_eq!(p["resolution"], "768");
    }

    #[test]
    fn rejects_invalid_params() {
        let mut r = req(vec![], GenerateParams::default());
        r.params.resolution = Some("8K".into());
        assert!(build_payload(&r).is_err());
        r.params.resolution = None;
        r.params.aspect_ratio = Some("11:9".into());
        assert!(build_payload(&r).is_err());
        r.params.aspect_ratio = None;
        r.params.safety_tolerance = Some(9);
        assert!(build_payload(&r).is_err());
        r.params.safety_tolerance = None;
        assert!(build_payload(&r).is_ok());
    }

    #[test]
    fn rejects_bad_image_scheme_and_too_many_images() {
        let mut r = req(vec!["https://example.com/a.png"], GenerateParams::default());
        assert!(build_payload(&r).is_err());
        r.images = (0..11).map(|_| PNG.to_string()).collect();
        assert!(build_payload(&r).is_err());
    }
    #[test]
    fn unsupported_native_fields_are_not_sent() {
        let p = build_payload(&req(
            vec![],
            GenerateParams {
                aspect_ratio: Some("auto".into()),
                grounding: Some(true),
                version: Some("latest".into()),
                ..Default::default()
            },
        ))
        .unwrap();
        assert_eq!(p["aspect_ratio"], "auto");
        assert!(p.get("version").is_none());
        assert!(p.get("grounding").is_none());
    }
}
