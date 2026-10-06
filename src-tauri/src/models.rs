//! 模型契约。与前端共用 shared/model-catalog.json，所有付费请求在这里校验。
use crate::provider::{parse_data_url, GenerateRequest, ProviderError};
use serde_json::Value;
use std::sync::OnceLock;

pub fn catalog() -> &'static Value {
    static CATALOG: OnceLock<Value> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../shared/model-catalog.json")).expect("模型目录无效")
    })
}
pub struct ResolvedModel {
    pub id: &'static str,
    pub family: &'static str,
    pub route: &'static Value,
}
impl ResolvedModel {
    pub fn wire_id(&self) -> &str {
        self.route["model"].as_str().unwrap()
    }
}
pub fn resolve(req: &GenerateRequest) -> Result<ResolvedModel, ProviderError> {
    let models = catalog()["models"].as_array().unwrap();
    let model = models
        .iter()
        .find(|m| {
            m["id"].as_str() == Some(&req.model)
                || m["routes"]
                    .as_object()
                    .unwrap()
                    .values()
                    .any(|r| r["model"].as_str() == Some(&req.model))
        })
        .ok_or_else(|| ProviderError::msg(format!("未知模型: {}", req.model)))?;
    let route = model["routes"]
        .get(&req.provider)
        .filter(|r| r.is_object())
        .ok_or_else(|| ProviderError::msg("该供应商不支持所选模型"))?;
    Ok(ResolvedModel {
        id: model["id"].as_str().unwrap(),
        family: model["family"].as_str().unwrap(),
        route,
    })
}
pub fn validate(req: &GenerateRequest) -> Result<(), ProviderError> {
    let m = resolve(req)?;
    let prompt = if m.family == "flux" && req.provider == "runware" {
        req.instruction.as_deref().unwrap_or(&req.final_prompt)
    } else {
        &req.final_prompt
    };
    let min_prompt = m.route["minPrompt"].as_u64().unwrap_or(1);
    let max_prompt = m.route["maxPrompt"].as_u64().unwrap_or(32000);
    if prompt.trim().chars().count() < min_prompt as usize
        || prompt.chars().count() > max_prompt as usize
    {
        return Err(ProviderError::msg(format!(
            "提示词须为 {min_prompt}–{max_prompt} 字符"
        )));
    }
    let rules = m.route["parameters"].as_object().unwrap();
    let params =
        serde_json::to_value(&req.params).map_err(|_| ProviderError::msg("参数序列化失败"))?;
    for (key, value) in params.as_object().unwrap() {
        let rule = rules
            .get(key)
            .ok_or_else(|| ProviderError::msg(format!("此模型路由不支持参数 {key}")))?;
        let base = &catalog()["fields"][key];
        let get = |name: &str| rule.get(name).unwrap_or(&base[name]);
        let invalid = match base["kind"].as_str().unwrap_or("") {
            "enum" => !get("values")
                .as_array()
                .is_some_and(|values| values.contains(value)),
            "integer" => !value.as_u64().is_some_and(|v| {
                v >= get("min").as_u64().unwrap_or(0)
                    && v <= get("max").as_u64().unwrap_or(u64::MAX)
            }),
            "boolean" => !value.is_boolean(),
            "text" => !value.as_str().is_some_and(|v| {
                v.chars().count() as u64 <= get("maxLength").as_u64().unwrap_or(u64::MAX)
                    && (v.is_empty()
                        || v.chars().count() as u64 >= get("minLength").as_u64().unwrap_or(0))
            }),
            _ => false,
        };
        if invalid {
            return Err(ProviderError::msg(format!("参数 {key} 无效")));
        }
    }
    if req.images.len() as u64 > m.route["maxRefs"].as_u64().unwrap_or(0) {
        return Err(ProviderError::msg("参考图数量超过此模型路由上限"));
    }
    let mut total_bytes = 0;
    for im in &req.images {
        let (mime, bytes) = parse_data_url(im)?;
        if !["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&mime.as_str()) {
            return Err(ProviderError::msg("不支持的输入图片类型"));
        }
        let limit = m.route["maxInputBytes"]
            .as_u64()
            .unwrap_or(50 * 1024 * 1024);
        if bytes.len() as u64 > limit {
            return Err(ProviderError::msg("单张参考图超过此路由大小上限"));
        }
        if m.family == "gpt" && mime == "image/gif" {
            return Err(ProviderError::msg("GPT Image 参考图须为 PNG/JPEG/WebP"));
        }
        if m.family == "gemini" && mime == "image/gif" {
            return Err(ProviderError::msg("Gemini 参考图须为 PNG/JPEG/WebP"));
        }
        if m.family == "flux"
            && matches!(req.provider.as_str(), "bfl" | "comfy")
            && bytes.len() > 20 * 1024 * 1024
        {
            return Err(ProviderError::msg("FLUX 原生参考图超过 20MiB"));
        }
        if m.family == "gpt"
            && req.provider == "comfy"
            && (bytes.len() > 25 * 1024 * 1024 || mime == "image/gif")
        {
            return Err(ProviderError::msg(
                "Comfy GPT 参考图须为 PNG/JPEG/WebP，单张至多 25MiB",
            ));
        }
        total_bytes += bytes.len();
        if m.family == "seedream" && req.provider != "openrouter" {
            let (w, h) = image::ImageReader::new(std::io::Cursor::new(bytes))
                .with_guessed_format()
                .map_err(|_| ProviderError::msg("参考图无效"))?
                .into_dimensions()
                .map_err(|_| ProviderError::msg("参考图无效"))?;
            if w.min(h) < 15
                || w.max(h) as f64 / w.min(h) as f64 > 16.0
                || u64::from(w) * u64::from(h)
                    > m.route["maxInputPixels"].as_u64().unwrap_or(u64::MAX)
            {
                return Err(ProviderError::msg(
                    "Seedream 参考图尺寸或比例超过此路由限制",
                ));
            }
        }
    }
    if m.family == "gpt" && req.provider == "comfy" && total_bytes > 64 * 1024 * 1024 {
        return Err(ProviderError::msg("Comfy GPT 参考图总大小超过 64MiB"));
    }
    if let Some(limit) = m.route["maxRequestBytes"].as_u64() {
        let size = req.images.iter().map(String::len).sum::<usize>()
            + prompt.len()
            + params.to_string().len()
            + 1024;
        if size as u64 > limit {
            return Err(ProviderError::msg(
                "请求超过此路由总大小上限，请降低参考图尺寸",
            ));
        }
    }
    if m.family == "gemini"
        && req.provider == "runware"
        && req.params.aspect_ratio.as_deref() == Some("auto")
        && req.images.is_empty()
    {
        return Err(ProviderError::msg("自动比例需要参考图"));
    }
    if m.family == "seedream" && rules.contains_key("width") {
        if req.params.width.is_some() != req.params.height.is_some() {
            return Err(ProviderError::msg("宽度和高度须同时设置"));
        }
        if req.params.width.is_none() && rules["width"]["nullable"].as_bool() != Some(true) {
            return Err(ProviderError::msg("此路由需要指定宽度和高度"));
        }
        if let (Some(w), Some(h)) = (req.params.width, req.params.height) {
            let area = u64::from(w) * u64::from(h);
            if area < m.route["minPixels"].as_u64().unwrap_or(1)
                || area > m.route["maxPixels"].as_u64().unwrap_or(u64::MAX)
                || w.max(h) as f64 / w.min(h) as f64 > m.route["maxAspect"].as_f64().unwrap_or(16.0)
            {
                return Err(ProviderError::msg(
                    "Seedream 输出面积或宽高比超过此路由限制",
                ));
            }
        }
    }
    if m.family != "flux" && !req.regions.is_empty() {
        return Err(ProviderError::msg("此模型不支持 FLUX 区域协议"));
    }
    for region in &req.regions {
        if region.id.is_empty() || region.description.trim().is_empty() {
            return Err(ProviderError::msg("区域缺少名称或描述"));
        }
        if region
            .reference_index
            .is_some_and(|i| i >= req.images.len())
            || (region.source_box.is_some() && region.reference_index.is_none())
        {
            return Err(ProviderError::msg("区域来源参考图无效"));
        }
        for b in [region.source_box, region.target_box].into_iter().flatten() {
            if b.iter().any(|v| *v > 1000) || b[0] >= b[2] || b[1] >= b[3] {
                return Err(ProviderError::msg("区域坐标须为 0–1000 的有效矩形"));
            }
        }
        if region.target_box.is_none() && region.source_box.is_none() {
            return Err(ProviderError::msg("移除区域需要来源区域"));
        }
    }
    if m.family == "flux"
        && req.provider == "runware"
        && req.images.is_empty()
        && (req.regions.is_empty() || req.params.aspect_ratio.as_deref() == Some("auto"))
    {
        return Err(ProviderError::msg(
            "Runware FLUX 文生图需要放置区域和明确的宽高比",
        ));
    }
    if m.family == "gpt" {
        if let Some(size) = &req.params.size {
            let allow_auto = rules["size"]["allowAuto"].as_bool().unwrap_or(false);
            if size != "auto" || !allow_auto {
                validate_gpt_size(size)?;
            }
        }
        if req.params.background.as_deref() == Some("transparent")
            && req.params.output_format.as_deref() == Some("jpeg")
        {
            return Err(ProviderError::msg("透明背景不支持 JPEG"));
        }
    }
    if m.family == "qwen" {
        if req.params.width.is_some() != req.params.height.is_some() {
            return Err(ProviderError::msg("宽度和高度须同时设置"));
        }
        if let (Some(w), Some(h)) = (req.params.width, req.params.height) {
            let area = u64::from(w) * u64::from(h);
            if area < 262144
                || area > m.route["maxPixels"].as_u64().unwrap_or(4194304)
                || w.max(h) as f64 / w.min(h) as f64 > 8.0
            {
                return Err(ProviderError::msg("Qwen 输出面积或宽高比超过此路由限制"));
            }
        }
        if req.params.prompt_extend_mode.as_deref() == Some("agent") && !req.images.is_empty() {
            return Err(ProviderError::msg("Qwen 编辑仅支持 direct 扩写"));
        }
        if req.params.prompt_extend == Some(false) && req.params.prompt_extend_mode.is_some() {
            return Err(ProviderError::msg("关闭扩写时请省略扩写方式"));
        }
    }
    if let Some(mask) = &req.mask {
        if !m.route["mask"].as_bool().unwrap_or(false) {
            return Err(ProviderError::msg("此模型路由不支持蒙版"));
        }
        let first = req
            .images
            .first()
            .ok_or_else(|| ProviderError::msg("蒙版需要第一张参考图"))?;
        let (mime, bytes) = parse_data_url(mask)?;
        if mime != "image/png" || bytes.len() >= 4 * 1024 * 1024 {
            return Err(ProviderError::msg("蒙版须为小于 4MiB 的透明 PNG"));
        }
        let im =
            image::load_from_memory(&bytes).map_err(|_| ProviderError::msg("蒙版不是有效图片"))?;
        let (_, first_bytes) = parse_data_url(first)?;
        let reference = image::ImageReader::new(std::io::Cursor::new(first_bytes))
            .with_guessed_format()
            .map_err(|_| ProviderError::msg("参考图无效"))?
            .into_dimensions()
            .map_err(|_| ProviderError::msg("参考图无效"))?;
        if !im.color().has_alpha() || (im.width(), im.height()) != reference {
            return Err(ProviderError::msg(
                "蒙版须有 alpha 通道且与第一张参考图同尺寸",
            ));
        }
        if !im.to_rgba8().pixels().any(|p| p.0[3] == 0) {
            return Err(ProviderError::msg("蒙版需要完全透明的编辑区域"));
        }
    }
    Ok(())
}
pub fn validate_gpt_size(size: &str) -> Result<(u32, u32), ProviderError> {
    let pair = size
        .split_once('x')
        .and_then(|(w, h)| Some((w.parse::<u32>().ok()?, h.parse::<u32>().ok()?)));
    if let Some((w, h)) = pair {
        let area = u64::from(w) * u64::from(h);
        if w > 0
            && h > 0
            && w % 16 == 0
            && h % 16 == 0
            && w.max(h) <= 3840
            && (655360..=8294400).contains(&area)
            && w.max(h) as f64 / w.min(h) as f64 <= 3.0
        {
            return Ok((w, h));
        }
    }
    Err(ProviderError::msg("GPT Image 输出尺寸无效"))
}
