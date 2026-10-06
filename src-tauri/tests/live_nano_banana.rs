//! Explicit opt-in verification; two paid requests via the production adapter.
use lutriui_lib::provider::{configured_key, openrouter, parse_data_url, GenerateRequest};
use serde_json::json;

#[tokio::test]
#[ignore = "Two paid Nano Banana 2.1 requests; requires explicit authorization"]
async fn nano_banana_21_generation_and_reference_edit() {
    assert!(
        configured_key("openrouter").is_some(),
        "OpenRouter is not configured"
    );
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../.cache/verification/nano-banana-21")
        .join(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
                .to_string(),
        );
    std::fs::create_dir_all(&dir).unwrap();
    let mut input = Vec::new();
    let mut reports = Vec::new();
    for (name, prompt) in [
        ("generation", "A single flat blue circle centered on a plain white background. Minimal geometric test image. No text, no shadow."),
        ("edit", "Edit the provided image: change only the blue circle to coral red. Keep its position, size, shape and the plain white background. No text, no shadow."),
    ] {
        let request: GenerateRequest = serde_json::from_value(json!({
            "provider":"openrouter", "model":"gemini-nano-banana-2.1",
            "finalPrompt":prompt, "images":input,
            "params":{"resolution":"1K", "aspectRatio":"1:1", "count":1}
        })).unwrap();
        let started = std::time::Instant::now();
        let result = match openrouter::generate(&request).await {
            Ok(result) => result,
            Err(error) => {
                let report = json!({"stage":name,"error":error.to_json(),"elapsedSeconds":started.elapsed().as_secs_f64()});
                std::fs::write(dir.join("failure.json"), serde_json::to_vec_pretty(&report).unwrap()).unwrap();
                panic!("{report}");
            }
        };
        assert_eq!(result.images.len(), 1);
        let (_, bytes) = parse_data_url(&result.images[0].data_url).unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (1024, 1024));
        image.save(dir.join(format!("{name}.png"))).unwrap();
        let report = json!({"stage":name,"model":result.model,"inputImages":request.images.len(),"width":image.width(),"height":image.height(),"usage":result.usage,"elapsedSeconds":started.elapsed().as_secs_f64()});
        println!("{report}");
        reports.push(report);
        std::fs::write(dir.join("report.json"), serde_json::to_vec_pretty(&reports).unwrap()).unwrap();
        input = vec![result.images[0].data_url.clone()];
    }
    println!("Evidence: {}", dir.display());
}
