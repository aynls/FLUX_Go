//! 模型契约。与前端共用 shared/model-catalog.json，所有付费请求在这里校验。
use crate::provider::{parse_data_url, GenerateRequest, ProviderError};
use serde_json::Value;
use std::sync::OnceLock;

pub fn catalog() -> &'static Value {
    static CATALOG: OnceLock<Value> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../shared/model-catalog.json")).expect("invalid model catalog")
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
        .ok_or_else(|| {
            ProviderError::coded("backend_unknown_model", format!("Unknown model: {}", req.model))
                .with_param("name", req.model.clone())
        })?;
    let route = model["routes"]
        .get(&req.provider)
        .filter(|r| r.is_object())
        .ok_or_else(|| {
            ProviderError::coded(
                "backend_provider_model",
                "This provider does not support the selected model",
            )
        })?;
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
        return Err(ProviderError::coded(
            "backend_prompt_length",
            format!("The prompt must be {min_prompt}–{max_prompt} characters"),
        )
        .with_param("min", min_prompt)
        .with_param("max", max_prompt));
    }
    let rules = m.route["parameters"].as_object().unwrap();
    let params = serde_json::to_value(&req.params).map_err(|_| {
        ProviderError::coded("backend_params_serialize", "Couldn't serialize parameters")
    })?;
    for (key, value) in params.as_object().unwrap() {
        let rule = rules.get(key).ok_or_else(|| {
            ProviderError::coded(
                "backend_param_unsupported",
                format!("This route does not support parameter {key}"),
            )
            .with_param("key", key.clone())
        })?;
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
            return Err(ProviderError::coded(
                "backend_param_invalid",
                format!("Parameter {key} is invalid"),
            )
            .with_param("key", key.clone()));
        }
    }
    if req.images.len() as u64 > m.route["maxRefs"].as_u64().unwrap_or(0) {
        return Err(ProviderError::coded(
            "backend_too_many_refs",
            "Too many references for this route",
        ));
    }
    let mut total_bytes = 0;
    for im in &req.images {
        let (mime, bytes) = parse_data_url(im)?;
        if !["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&mime.as_str()) {
            return Err(ProviderError::coded(
                "backend_input_type",
                "Unsupported input image type",
            ));
        }
        let limit = m.route["maxInputBytes"]
            .as_u64()
            .unwrap_or(50 * 1024 * 1024);
        if bytes.len() as u64 > limit {
            return Err(ProviderError::coded(
                "backend_ref_too_large",
                "A reference exceeds this route's size limit",
            ));
        }
        if m.family == "gpt" && mime == "image/gif" {
            return Err(ProviderError::coded(
                "backend_gpt_ref_type",
                "GPT Image references must be PNG, JPEG, or WebP",
            ));
        }
        if m.family == "gemini" && mime == "image/gif" {
            return Err(ProviderError::coded(
                "backend_gemini_ref_type",
                "Gemini references must be PNG, JPEG, or WebP",
            ));
        }
        if m.family == "grok" && mime == "image/gif" {
            return Err(ProviderError::coded(
                "backend_grok_ref_type",
                "Grok references must be PNG, JPEG, or WebP",
            ));
        }
        if m.family == "flux"
            && matches!(req.provider.as_str(), "bfl" | "comfy")
            && bytes.len() > 20 * 1024 * 1024
        {
            return Err(ProviderError::coded(
                "backend_flux_ref_size",
                "A native FLUX reference exceeds 20MiB",
            ));
        }
        if m.family == "gpt"
            && req.provider == "comfy"
            && (bytes.len() > 25 * 1024 * 1024 || mime == "image/gif")
        {
            return Err(ProviderError::coded(
                "backend_comfy_gpt_ref",
                "Comfy GPT references must be PNG, JPEG, or WebP, and at most 25MiB each",
            ));
        }
        total_bytes += bytes.len();
        if m.family == "seedream" && req.provider != "openrouter" {
            let (w, h) = image::ImageReader::new(std::io::Cursor::new(bytes))
                .with_guessed_format()
                .map_err(|_| ProviderError::coded("backend_ref_invalid", "The reference image is invalid"))?
                .into_dimensions()
                .map_err(|_| ProviderError::coded("backend_ref_invalid", "The reference image is invalid"))?;
            if w.min(h) < 15
                || w.max(h) as f64 / w.min(h) as f64 > 16.0
                || u64::from(w) * u64::from(h)
                    > m.route["maxInputPixels"].as_u64().unwrap_or(u64::MAX)
            {
                return Err(ProviderError::coded(
                    "backend_seedream_ref",
                    "A Seedream reference exceeds this route's size or aspect limit",
                ));
            }
        }
    }
    if m.family == "gpt" && req.provider == "comfy" && total_bytes > 64 * 1024 * 1024 {
        return Err(ProviderError::coded(
            "backend_comfy_gpt_total",
            "Comfy GPT references exceed 64MiB in total",
        ));
    }
    if let Some(limit) = m.route["maxRequestBytes"].as_u64() {
        let size = req.images.iter().map(String::len).sum::<usize>()
            + prompt.len()
            + params.to_string().len()
            + 1024;
        if size as u64 > limit {
            return Err(ProviderError::coded(
                "backend_request_too_large",
                "The request exceeds this route's size limit. Reduce the references",
            ));
        }
    }
    if matches!(m.family, "gemini" | "grok")
        && req.provider == "runware"
        && req.params.aspect_ratio.as_deref() == Some("auto")
        && req.images.is_empty()
    {
        return Err(ProviderError::coded(
            "backend_auto_aspect",
            "Automatic aspect ratio needs a reference",
        ));
    }
    if m.family == "seedream" && rules.contains_key("width") {
        if req.params.width.is_some() != req.params.height.is_some() {
            return Err(ProviderError::coded(
                "backend_dimensions_together",
                "Set width and height together",
            ));
        }
        if req.params.width.is_none() && rules["width"]["nullable"].as_bool() != Some(true) {
            return Err(ProviderError::coded(
                "backend_dimensions_required",
                "This route requires width and height",
            ));
        }
        if let (Some(w), Some(h)) = (req.params.width, req.params.height) {
            let area = u64::from(w) * u64::from(h);
            if area < m.route["minPixels"].as_u64().unwrap_or(1)
                || area > m.route["maxPixels"].as_u64().unwrap_or(u64::MAX)
                || w.max(h) as f64 / w.min(h) as f64 > m.route["maxAspect"].as_f64().unwrap_or(16.0)
            {
                return Err(ProviderError::coded(
                    "backend_seedream_output",
                    "Seedream output area or aspect ratio exceeds this route's limit",
                ));
            }
        }
    }
    if m.family != "flux" && !req.regions.is_empty() {
        return Err(ProviderError::coded(
            "backend_flux_regions",
            "This model does not support the FLUX region protocol",
        ));
    }
    for region in &req.regions {
        if region.id.is_empty() || region.description.trim().is_empty() {
            return Err(ProviderError::coded(
                "backend_region_incomplete",
                "A region is missing a name or description",
            ));
        }
        if region
            .reference_index
            .is_some_and(|i| i >= req.images.len())
            || (region.source_box.is_some() && region.reference_index.is_none())
        {
            return Err(ProviderError::coded(
                "backend_region_source",
                "A region's source reference is invalid",
            ));
        }
        for b in [region.source_box, region.target_box].into_iter().flatten() {
            if b.iter().any(|v| *v > 1000) || b[0] >= b[2] || b[1] >= b[3] {
                return Err(ProviderError::coded(
                    "backend_region_coords",
                    "Region coordinates must be a valid rectangle from 0 to 1000",
                ));
            }
        }
        if region.target_box.is_none() && region.source_box.is_none() {
            return Err(ProviderError::coded(
                "backend_region_remove_source",
                "A remove region needs a source region",
            ));
        }
    }
    if m.family == "flux"
        && req.provider == "runware"
        && req.images.is_empty()
        && (req.regions.is_empty() || req.params.aspect_ratio.as_deref() == Some("auto"))
    {
        return Err(ProviderError::coded(
            "backend_runware_flux_t2i",
            "Runware FLUX text-to-image needs a place region and an explicit aspect ratio",
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
            return Err(ProviderError::coded(
                "backend_transparent_jpeg",
                "A transparent background does not support JPEG",
            ));
        }
    }
    if m.family == "qwen" {
        if req.params.width.is_some() != req.params.height.is_some() {
            return Err(ProviderError::coded(
                "backend_dimensions_together",
                "Set width and height together",
            ));
        }
        if let (Some(w), Some(h)) = (req.params.width, req.params.height) {
            let area = u64::from(w) * u64::from(h);
            if area < 262144
                || area > m.route["maxPixels"].as_u64().unwrap_or(4194304)
                || w.max(h) as f64 / w.min(h) as f64 > 8.0
            {
                return Err(ProviderError::coded(
                    "backend_qwen_output",
                    "Qwen output area or aspect ratio exceeds this route's limit",
                ));
            }
        }
        if req.params.prompt_extend_mode.as_deref() == Some("agent") && !req.images.is_empty() {
            return Err(ProviderError::coded(
                "backend_qwen_direct",
                "Qwen editing only supports direct expansion",
            ));
        }
        if req.params.prompt_extend == Some(false) && req.params.prompt_extend_mode.is_some() {
            return Err(ProviderError::coded(
                "backend_qwen_extend_mode",
                "Omit the expansion method when expansion is off",
            ));
        }
    }
    if let Some(mask) = &req.mask {
        if !m.route["mask"].as_bool().unwrap_or(false) {
            return Err(ProviderError::coded(
                "backend_mask_unsupported",
                "This route does not support masks",
            ));
        }
        let first = req
            .images
            .first()
            .ok_or_else(|| {
                ProviderError::coded(
                    "backend_mask_needs_ref",
                    "A mask needs the first reference image",
                )
            })?;
        let (mime, bytes) = parse_data_url(mask)?;
        if mime != "image/png" || bytes.len() >= 4 * 1024 * 1024 {
            return Err(ProviderError::coded(
                "backend_mask_png",
                "The mask must be a transparent PNG under 4MiB",
            ));
        }
        let im =
            image::load_from_memory(&bytes).map_err(|_| {
                ProviderError::coded("backend_mask_invalid", "The mask is not a valid image")
            })?;
        let (_, first_bytes) = parse_data_url(first)?;
        let reference = image::ImageReader::new(std::io::Cursor::new(first_bytes))
            .with_guessed_format()
            .map_err(|_| ProviderError::coded("backend_ref_invalid", "The reference image is invalid"))?
            .into_dimensions()
            .map_err(|_| ProviderError::coded("backend_ref_invalid", "The reference image is invalid"))?;
        if !im.color().has_alpha() || (im.width(), im.height()) != reference {
            return Err(ProviderError::coded(
                "backend_mask_match",
                "The mask needs an alpha channel and the same size as the first reference",
            ));
        }
        if !im.to_rgba8().pixels().any(|p| p.0[3] == 0) {
            return Err(ProviderError::coded(
                "backend_mask_transparent",
                "The mask needs a fully transparent edit area",
            ));
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
    Err(ProviderError::coded(
        "backend_gpt_size",
        "The GPT Image output size is invalid",
    ))
}
