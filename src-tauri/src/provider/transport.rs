//! 共享网络与媒体处理。提交付费任务只发送一次；轮询只读取已经提交的任务。
use super::{OutputImage, ProviderError};
use base64::Engine;
use serde_json::Value;
use std::{sync::OnceLock, time::Duration};

pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("HTTP 客户端初始化失败")
    })
}
pub fn key(provider: &str) -> Result<String, ProviderError> {
    super::configured_key(provider).ok_or_else(|| {
        ProviderError::msg(format!("尚未配置 {provider} API Key"))
            .with_hint("请在设置中配置密钥及其来源。")
    })
}
pub async fn json(
    request: reqwest::RequestBuilder,
    provider: &str,
) -> Result<(u16, Value), ProviderError> {
    let (status, body, _) = json_with_retry_after(request, provider).await?;
    Ok((status, body))
}
pub async fn json_with_retry_after(
    request: reqwest::RequestBuilder,
    provider: &str,
) -> Result<(u16, Value, Option<Duration>), ProviderError> {
    let (status, body, retry_after, _) = json_with_metadata(request, provider).await?;
    Ok((status, body, retry_after))
}
pub async fn json_with_metadata(
    request: reqwest::RequestBuilder,
    provider: &str,
) -> Result<(u16, Value, Option<Duration>, Option<f64>), ProviderError> {
    let response = request.send().await.map_err(|_| {
        ProviderError::msg(format!("{provider} 网络请求失败"))
            .with_hint("任务可能已被接受；不会自动重新提交付费请求。")
    })?;
    let status = response.status().as_u16();
    let credits = response
        .headers()
        .get("X-Comfy-Credits-Used")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n >= 0.0);
    let retry_after = response
        .headers()
        .get("Retry-After")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .map(|s| Duration::from_secs(s.clamp(1, 60)));
    let body: Value = response
        .json()
        .await
        .map_err(|_| ProviderError::msg(format!("{provider} 返回了无法解析的响应")))?;
    if !(200..300).contains(&status) {
        let message = body
            .pointer("/error/message")
            .or_else(|| body.get("message"))
            .or_else(|| body.get("detail"))
            .and_then(Value::as_str)
            .unwrap_or("服务请求失败");
        return Err(ProviderError::http(
            status,
            format!("{provider}: {message}"),
        ));
    }
    Ok((status, body, retry_after, credits))
}
pub fn base64_image(b64: &str, mime: &str) -> Result<OutputImage, ProviderError> {
    let data_url = format!("data:{mime};base64,{b64}");
    super::parse_data_url(&data_url)?;
    Ok(OutputImage {
        data_url,
        media_type: mime.into(),
    })
}
pub async fn download_image(url: &str) -> Result<OutputImage, ProviderError> {
    if url.starts_with("data:") {
        let (mime, _) = super::parse_data_url(url)?;
        return Ok(OutputImage {
            data_url: url.into(),
            media_type: mime,
        });
    }
    let parsed = reqwest::Url::parse(url).map_err(|_| ProviderError::msg("结果图片 URL 无效"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ProviderError::msg("结果图片须使用 HTTP(S)"));
    }
    let mut response = client()
        .get(parsed)
        .send()
        .await
        .map_err(|_| ProviderError::msg("结果已生成，但图片下载失败"))?;
    if !response.status().is_success() {
        return Err(ProviderError::msg(format!(
            "结果图片下载失败（HTTP {}）",
            response.status()
        )));
    }
    const MAX: usize = 64 * 1024 * 1024;
    if response.content_length().is_some_and(|n| n > MAX as u64) {
        return Err(ProviderError::msg("结果图片超过 64MiB"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ProviderError::msg("结果图片下载中断"))?
    {
        if bytes.len() + chunk.len() > MAX {
            return Err(ProviderError::msg("结果图片超过 64MiB"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let format =
        image::guess_format(&bytes).map_err(|_| ProviderError::msg("下载的结果不是图片"))?;
    let mime = match format {
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::WebP => "image/webp",
        image::ImageFormat::Gif => "image/gif",
        image::ImageFormat::Png => "image/png",
        _ => return Err(ProviderError::msg("结果图片格式不受支持")),
    };
    base64_image(
        &base64::engine::general_purpose::STANDARD.encode(bytes),
        mime,
    )
}
pub async fn openai_images(
    body: &Value,
    default_format: &str,
) -> Result<Vec<OutputImage>, ProviderError> {
    let items = body["data"]
        .as_array()
        .ok_or_else(|| ProviderError::msg("响应缺少图片 data"))?;
    let mut images = Vec::new();
    for item in items {
        if let Some(b64) = item["b64_json"].as_str() {
            let fallback = format!("image/{default_format}");
            images.push(base64_image(
                b64,
                item["media_type"].as_str().unwrap_or(&fallback),
            )?);
        } else if let Some(url) = item["url"].as_str() {
            images.push(download_image(url).await?);
        }
    }
    if images.is_empty() {
        return Err(ProviderError::msg("响应中没有图片"));
    }
    Ok(images)
}
