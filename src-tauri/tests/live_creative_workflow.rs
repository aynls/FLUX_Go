//! Three opt-in paid requests: two FLUX candidates, then one GPT reference edit.
//! LUTRIUI_TEST_CANDIDATE resumes with one edit of a saved PNG, without regenerating.
use base64::Engine;
use lutriui_lib::provider::{
    comfy, configured_key, init_key_settings, parse_data_url, GenerateRequest,
};
use serde_json::json;

#[tokio::test]
#[ignore = "Three paid Comfy requests; requires explicit authorization"]
async fn batch_candidates_then_cross_model_edit() {
    let config = std::env::var_os("LUTRIUI_TEST_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("APPDATA")
                .map(|p| std::path::PathBuf::from(p).join("app.lutriui.desktop"))
        });
    if let Some(config) = config.filter(|p| p.join("key-sources.json").is_file()) {
        init_key_settings(&config).unwrap();
    }
    assert!(
        configured_key("comfy").is_some(),
        "Comfy is not configured; no request sent"
    );
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../.cache/verification/creative-workflow")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir).unwrap();
    let source = std::env::var_os("LUTRIUI_TEST_CANDIDATE").map(std::path::PathBuf::from);
    let mut candidate = source.as_ref().map(|path| {
        let bytes = std::fs::read(path).unwrap();
        image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).unwrap();
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    });
    let mut reports = Vec::new();
    let stages = if candidate.is_some() {
        vec!["edit"]
    } else {
        vec!["candidate-1", "candidate-2", "edit"]
    };
    for stage in stages {
        let editing = stage == "edit";
        let request: GenerateRequest = serde_json::from_value(json!({
            "provider": "comfy",
            "model": if editing { "gpt-image-2.5-flare" } else { "flux-3-image" },
            "finalPrompt": if editing {
                "Edit the provided image: change only the blue ceramic vase to warm terracotta. Preserve its shape, the daisies, composition and pale cream background. No text."
            } else {
                "A simple watercolor illustration of a small blue ceramic vase holding three white daisies, centered on a pale cream background. Soft daylight, no text."
            },
            "images": if editing { vec![candidate.clone().unwrap()] } else { Vec::<String>::new() },
            "params": if editing {
                json!({"size":"1024x1024", "quality":"low", "outputFormat":"png", "count":1})
            } else {
                json!({"resolution":"1K", "aspectRatio":"1:1"})
            },
            "requestId": uuid::Uuid::new_v4().to_string()
        })).unwrap();
        let started = std::time::Instant::now();
        let result = match comfy::generate(&request).await {
            Ok(result) => result,
            Err(error) => {
                let report = json!({"stage":stage,"error":error.to_json(),"elapsedSeconds":started.elapsed().as_secs_f64()});
                std::fs::write(
                    dir.join("failure.json"),
                    serde_json::to_vec_pretty(&report).unwrap(),
                )
                .unwrap();
                panic!("{report}; evidence: {}", dir.display());
            }
        };
        assert_eq!(result.images.len(), 1);
        let (_, bytes) = parse_data_url(&result.images[0].data_url).unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (1024, 1024));
        image.save(dir.join(format!("{stage}.png"))).unwrap();
        if candidate.is_none() {
            candidate = Some(result.images[0].data_url.clone());
        }
        let report = json!({"stage":stage,"model":result.model,"inputImages":request.images.len(),"inputSource":source,"usage":result.usage,"width":image.width(),"height":image.height(),"elapsedSeconds":started.elapsed().as_secs_f64()});
        println!("{report}");
        reports.push(report);
        std::fs::write(
            dir.join("report.json"),
            serde_json::to_vec_pretty(&reports).unwrap(),
        )
        .unwrap();
    }
    println!("Evidence: {}", dir.display());
}
