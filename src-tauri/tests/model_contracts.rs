//! 离线契约检查，不访问供应商、不产生费用。
use base64::Engine;
use lutriui_lib::{
    models,
    provider::{ark, comfy, google, openrouter, parse_data_url, runware, GenerateRequest},
};
use serde_json::{json, Value};

fn req(provider: &str, model: &str, params: Value) -> GenerateRequest {
    serde_json::from_value(json!({"provider":provider,"model":model,"finalPrompt":"a clear image with exact text","instruction":"a clear image with exact text","params":params})).unwrap()
}
fn png(alpha: bool) -> String {
    let mut image = image::RgbaImage::from_pixel(256, 256, image::Rgba([40, 80, 120, 255]));
    if alpha {
        image.put_pixel(0, 0, image::Rgba([0, 0, 0, 0]));
    }
    let mut output = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut output, image::ImageFormat::Png)
        .unwrap();
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(output.into_inner())
    )
}
#[test]
fn every_catalog_route_builds_a_provider_native_request() {
    let catalog = models::catalog();
    for model in catalog["models"].as_array().unwrap() {
        for (provider, route) in model["routes"].as_object().unwrap() {
            let family = catalog["families"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["id"] == model["family"])
                .unwrap();
            let mut params = serde_json::Map::new();
            for (key, _) in route["parameters"].as_object().unwrap() {
                if key == "outputCompression" {
                    continue;
                }
                let value = route["defaults"]
                    .get(key)
                    .unwrap_or(&family["defaults"][key]);
                if !value.is_null() {
                    params.insert(key.clone(), value.clone());
                }
            }
            let mut request = req(
                provider,
                model["id"].as_str().unwrap(),
                Value::Object(params),
            );
            if provider == "runware" && model["family"] == "flux" {
                request.regions = serde_json::from_value(json!([{"id":"scene","description":"the scene","referenceIndex":null,"sourceBox":null,"targetBox":[0,0,1000,1000]}])).unwrap();
            }
            models::validate(&request)
                .unwrap_or_else(|e| panic!("{provider}/{}: {}", model["id"], e.message));
            let payload = match provider.as_str() {
                "openrouter" => openrouter::build_payload(&request),
                "bfl" => lutriui_lib::provider::bfl::build_payload(&request),
                "comfy" => comfy::build_payload(&request),
                "google" => google::build_payload(&request),
                "ark" | "byteplus" => ark::build_payload(&request),
                "runware" => {
                    runware::build_payload(&request, "50836053-a0ee-4cf5-b9d6-ae7c5d140ada")
                }
                _ => panic!("unimplemented provider"),
            }
            .unwrap();
            if provider == "openrouter" {
                assert_eq!(payload["model"], route["model"]);
            }
            if provider == "runware" {
                assert_eq!(payload[0]["model"], route["model"]);
                assert_eq!(payload[0]["deliveryMethod"], "async");
            }
        }
    }
}

#[test]
fn gemini_native_requests_preserve_reference_order_and_route_configuration() {
    let mut request = req(
        "google",
        "gemini-3.1-flash-image",
        json!({"resolution":"512","aspectRatio":"8:1"}),
    );
    request.images = vec![png(false), png(true)];
    let payload = google::build_payload(&request).unwrap();
    let parts = payload["contents"][0]["parts"].as_array().unwrap();
    assert_eq!(parts.len(), 3);
    assert_eq!(
        parts[0]["inlineData"]["data"],
        request.images[0].split_once(',').unwrap().1
    );
    assert_eq!(
        parts[1]["inlineData"]["data"],
        request.images[1].split_once(',').unwrap().1
    );
    assert_eq!(parts[2]["text"], request.final_prompt);
    assert_eq!(
        payload["generationConfig"]["responseFormat"]["image"]["imageSize"],
        "512"
    );
    assert!(payload["generationConfig"].get("imageConfig").is_none());
    request.provider = "comfy".into();
    request.params.resolution = Some("2K".into());
    request.params.output_format = Some("jpeg".into());
    let body = comfy::build_payload(&request).unwrap();
    assert_eq!(
        body["generationConfig"]["imageConfig"]["imageOutputOptions"]["mimeType"],
        "image/jpeg"
    );
    assert!(body["generationConfig"].get("responseFormat").is_none());
    request.provider = "google".into();
    assert!(google::build_payload(&request).is_err());
}

#[test]
fn seedream_official_sizes_are_independent_from_aggregator_constraints() {
    for provider in ["ark", "byteplus"] {
        models::validate(&req(
            provider,
            "seedream-5-pro",
            json!({"resolution":"1.5K"}),
        ))
        .unwrap();
        models::validate(&req(
            provider,
            "seedream-5-pro",
            json!({"width":2816,"height":1584}),
        ))
        .unwrap();
        models::validate(&req(
            provider,
            "seedream-5-lite",
            json!({"resolution":"4K"}),
        ))
        .unwrap();
        models::validate(&req(
            provider,
            "seedream-5-lite",
            json!({"width":4096,"height":4096}),
        ))
        .unwrap();
        assert!(models::validate(&req(
            provider,
            "seedream-5-pro",
            json!({"width":4096,"height":4096})
        ))
        .is_err());
    }
    assert!(
        models::validate(&req("comfy", "seedream-5-lite", json!({"resolution":"4K"}))).is_err()
    );
    assert!(models::validate(&req(
        "comfy",
        "seedream-5-pro",
        json!({"width":2816,"height":1584})
    ))
    .is_err());
}

#[test]
fn runware_gemini_uses_each_models_exact_dimensions_and_reference_auto_resolution() {
    for (model, width) in [
        ("gemini-3.1-flash-image", 1584),
        ("gemini-3-pro-image", 1548),
    ] {
        let mut request = req(
            "runware",
            model,
            json!({"resolution":"1K","aspectRatio":"21:9","seed":123}),
        );
        let p = runware::build_payload(&request, "test-id").unwrap();
        assert_eq!(p[0]["width"], width);
        assert_eq!(p[0]["height"], 672);
        assert_eq!(p[0]["seed"], 123);
        assert!(p[0].get("resolution").is_none());
        request.params.aspect_ratio = Some("auto".into());
        assert!(runware::build_payload(&request, "test-id").is_err());
        request.images = vec![png(false)];
        let p = runware::build_payload(&request, "test-id").unwrap();
        assert_eq!(p[0]["resolution"], "1K");
        assert!(p[0].get("width").is_none());
    }
}

#[test]
fn seedream_official_regions_have_distinct_model_ids_and_lite_returns_one_image() {
    for (provider, prefix) in [("ark", "doubao-"), ("byteplus", "dola-")] {
        let mut request = req(
            provider,
            "seedream-5-pro",
            json!({"width":1024,"height":1024,"seed":42,"outputFormat":"png","watermark":false}),
        );
        request.images = vec![png(false), png(true)];
        let body = ark::build_payload(&request).unwrap();
        assert_eq!(body["model"], format!("{prefix}seedream-5-0-pro-260628"));
        assert_eq!(body["image"], json!(request.images));
        assert_eq!(body["size"], "1024x1024");
        assert_eq!(body["seed"], 42);
        assert!(body.get("mask").is_none());
        request.model = "seedream-5-lite".into();
        request.params.width = None;
        request.params.height = None;
        request.params.resolution = Some("3K".into());
        let body = ark::build_payload(&request).unwrap();
        assert_eq!(body["sequential_image_generation"], "disabled");
        assert_eq!(body["size"], "3K");
        assert_eq!(
            body["model"],
            if provider == "ark" {
                "doubao-seedream-5-0-260128"
            } else {
                "seedream-5-0-260128"
            }
        );
    }
    let request = req(
        "runware",
        "seedream-5-lite",
        json!({"resolution":"3K","aspectRatio":"16:9"}),
    );
    let body = runware::build_payload(&request, "test-id").unwrap();
    assert_eq!(body[0]["width"], 4096);
    assert_eq!(body[0]["height"], 2304);
    assert_eq!(body[0]["settings"]["maxSequentialImages"], 1);
    assert!(body[0].get("resolution").is_none());
}

#[tokio::test]
async fn gemini_results_ignore_thought_images_and_support_mixed_image_parts() {
    let encoded = png(false);
    let body = json!({"candidates":[{"content":{"parts":[{"text":"description"},{"thought":true,"inlineData":{"data":encoded.split_once(',').unwrap().1,"mimeType":"image/png"}},{"inlineData":{"data":encoded.split_once(',').unwrap().1,"mimeType":"image/png"}},{"fileData":{"fileUri":encoded,"mimeType":"image/png"}}]}}],"usageMetadata":{"totalTokenCount":123}});
    let request = req("comfy", "gemini-3-pro-image", json!({}));
    let result = comfy::normalize(&request, &body, None).await.unwrap();
    assert_eq!(result.images.len(), 2);
    assert_eq!(result.usage["totalTokenCount"], 123);
    assert!(result.usage.get("cost").is_none());
    assert!(
        google::images(&json!({"candidates":[{"content":{"parts":[{"text":"refusal"}]}}]}))
            .await
            .is_err()
    );
}
#[test]
fn qwen_auto_size_is_omitted_and_runware_output_options_are_mapped() {
    let qwen = req("comfy", "qwen-image-3", json!({"width":null,"height":null}));
    let payload = comfy::build_payload(&qwen).unwrap();
    assert!(payload["parameters"].get("size").is_none());
    for model in ["flux-3-image", "qwen-image-3"] {
        let mut request = req(
            "runware",
            model,
            json!({"outputFormat":"webp","outputCompression":90}),
        );
        if model == "flux-3-image" {
            request.regions = serde_json::from_value(json!([{"id":"scene","description":"the scene","referenceIndex":null,"sourceBox":null,"targetBox":[0,0,1000,1000]}])).unwrap();
        }
        let payload =
            runware::build_payload(&request, "50836053-a0ee-4cf5-b9d6-ae7c5d140ada").unwrap();
        assert_eq!(payload[0]["outputFormat"], "WEBP");
        assert_eq!(payload[0]["outputQuality"], 90);
        request.params.output_compression = Some(100);
        assert!(models::validate(&request).is_err());
    }
}
#[test]
fn unsupported_fields_and_reference_limits_fail_before_billing() {
    assert!(models::validate(&req("bfl", "gpt-image-2.5-flare", json!({}))).is_err());
    assert!(models::validate(&req(
        "openrouter",
        "gpt-image-2.5-flare",
        json!({"size":"1024x1024"})
    ))
    .is_err());
    assert!(models::validate(&req(
        "openrouter",
        "qwen-image-3",
        json!({"negativePrompt":"bad"})
    ))
    .is_err());
    let mut request = req("comfy", "qwen-image-3", json!({}));
    request.images = vec![png(false); 4];
    assert!(models::validate(&request).is_err());
    request.provider = "openrouter".into();
    models::validate(&request).unwrap();
    request.params.count = Some(7);
    assert!(models::validate(&request).is_err());
}
#[test]
fn qwen_payload_uses_native_messages_size_and_edit_dependencies() {
    let mut request = req(
        "comfy",
        "qwen-image-3-pro",
        json!({"width":1536,"height":1024,"seed":0,"count":2,"negativePrompt":"blurry lettering","promptExtend":false,"watermark":false}),
    );
    request.images = vec![png(false)];
    let payload = comfy::build_payload(&request).unwrap();
    assert_eq!(payload["parameters"]["size"], "1536*1024");
    assert_eq!(payload["parameters"]["seed"], 0);
    assert_eq!(
        payload["input"]["messages"][0]["content"][0]["image"],
        request.images[0]
    );
    assert_eq!(
        payload["input"]["messages"][0]["content"][1]["text"],
        request.final_prompt
    );
    assert!(payload["parameters"].get("prompt_extend_mode").is_none());
    assert!(payload.get("prompt").is_none());
    request.params.prompt_extend = Some(true);
    request.params.prompt_extend_mode = Some("agent".into());
    assert!(comfy::build_payload(&request).is_err());
}
#[test]
fn flux_runware_uses_structured_regions_and_exact_dimensions() {
    let mut request = req(
        "runware",
        "flux-3-image",
        json!({"resolution":"1K","aspectRatio":"16:9","grounding":false,"safetyTolerance":2}),
    );
    request.regions = serde_json::from_value(json!([{"id":"sky","description":"blue sky","referenceIndex":null,"sourceBox":null,"targetBox":[0,0,500,1000]}])).unwrap();
    let payload = runware::build_payload(&request, "50836053-a0ee-4cf5-b9d6-ae7c5d140ada").unwrap();
    assert_eq!(payload[0]["width"], 1360);
    assert_eq!(payload[0]["height"], 768);
    assert!(payload[0].get("resolution").is_none());
    assert_eq!(
        payload[0]["settings"]["boundingBoxes"][0]["targetBox"],
        json!([0, 0, 500, 1000])
    );
    assert_eq!(
        payload[0]["positivePrompt"],
        request.instruction.as_deref().unwrap()
    );
    request.images = vec![png(false)];
    request.params.aspect_ratio = Some("auto".into());
    let edit = runware::build_payload(&request, "50836053-a0ee-4cf5-b9d6-ae7c5d140ada").unwrap();
    assert_eq!(edit[0]["resolution"], "1K");
    assert!(edit[0].get("width").is_none());
}
#[test]
fn masks_apply_to_first_image_and_convert_alpha_to_runware_white_edit_regions() {
    let mask = png(true);
    let converted = runware::white_edit_mask(&mask).unwrap();
    let (_, bytes) = parse_data_url(&converted).unwrap();
    let im = image::load_from_memory(&bytes).unwrap().to_luma8();
    assert_eq!(im.get_pixel(0, 0).0[0], 255);
    assert_eq!(im.get_pixel(1, 0).0[0], 0);
    let mut request = req("comfy", "gpt-image-2.5-flare", json!({"size":"1024x1024"}));
    request.images = vec![png(false)];
    request.mask = Some(mask);
    assert!(models::validate(&request).is_ok());
    request.provider = "openrouter".into();
    assert!(models::validate(&request).is_err());
    request.provider = "comfy".into();
    request.images.clear();
    assert!(models::validate(&request).is_err());
}
#[tokio::test]
async fn comfy_native_outputs_preserve_images_without_fabricating_dollar_costs() {
    let request = req(
        "comfy",
        "gpt-image-2.5-sunburst",
        json!({"outputFormat":"png"}),
    );
    let encoded = png(false);
    let b64 = encoded.split_once(',').unwrap().1;
    let out = comfy::normalize(&request,&json!({"data":[{"b64_json":b64},{"b64_json":b64}],"cost":211,"usage":{"total_tokens":999}}),Some("test-job")).await.unwrap();
    assert_eq!(out.images.len(), 2);
    assert!(out.usage.get("credits").is_none());
    assert!(out.usage.get("cost").is_none());
    assert_eq!(out.usage["total_tokens"], 999);
}
#[test]
fn polling_deduplicates_outputs_and_does_not_mix_other_tasks() {
    let mut results = std::collections::BTreeMap::new();
    let body = json!({"data":[{"taskUUID":"job","imageUUID":"first","imageURL":"a","cost":0.1},{"taskUUID":"other","imageUUID":"foreign","imageURL":"b"}]});
    assert!(runware::collect_results(&body, "job", &mut results).is_none());
    runware::collect_results(&body, "job", &mut results);
    assert_eq!(results.len(), 1);
    let failed = json!({"data":[{"taskUUID":"job","imageUUID":"second","imageURL":"c"}],"errors":[{"taskUUID":"job","message":"partial failure"}]});
    assert_eq!(
        runware::collect_results(&failed, "job", &mut results).as_deref(),
        Some("partial failure")
    );
    assert_eq!(results.len(), 2);
}
