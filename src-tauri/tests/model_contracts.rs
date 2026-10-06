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
            // Every Lite route must preserve the application's one-paid-request-per-image contract.
            if model["id"] == "seedream-5-lite" {
                match provider.as_str() {
                    "runware" => assert_eq!(payload[0]["settings"]["maxSequentialImages"], 1),
                    "comfy" | "ark" | "byteplus" => {
                        assert_eq!(payload["sequential_image_generation"], "disabled")
                    }
                    _ => assert_eq!(payload["n"], 1),
                }
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
fn unsupported_fields_and_reference_limits_fail_before_billing() {
    assert!(
        serde_json::from_value::<lutriui_lib::provider::GenerateParams>(
            json!({"aspect_ratio":"16:9"})
        )
        .is_err()
    );
    for images in [
        vec!["https://example.com/a.png".into()],
        vec!["data:text/plain;base64,YQ==".into()],
    ] {
        let mut invalid = req("openrouter", "flux-3-image", json!({}));
        invalid.images = images;
        assert!(models::validate(&invalid).is_err());
    }
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
