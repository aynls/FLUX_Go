//! Explicit opt-in verification; two paid requests through each production adapter.
use lutriui_lib::provider::{
    comfy, configured_key, google, init_key_settings, openrouter, parse_data_url, runware, GenerateRequest,
};
use serde_json::json;

#[tokio::test]
#[ignore = "Two paid OpenRouter Nano Banana 2.1 requests; requires explicit authorization"]
async fn nano_banana_21_generation_and_reference_edit() {
    verify("openrouter").await;
}

#[tokio::test]
#[ignore = "Two paid Google Nano Banana 2.1 requests including image search; requires explicit authorization"]
async fn google_nano_banana_21_search_and_reference_edit() {
    verify("google").await;
}

#[tokio::test]
#[ignore = "Two paid Comfy Nano Banana 2.1 requests; requires explicit authorization"]
async fn comfy_nano_banana_21_generation_and_edit() {
    verify("comfy").await;
}

#[tokio::test]
#[ignore = "Two paid Runware Nano Banana 2.1 requests; requires explicit authorization"]
async fn runware_nano_banana_21_generation_and_edit() {
    verify("runware").await;
}

async fn verify(provider: &str) {
    static SETTINGS: std::sync::Once = std::sync::Once::new();
    SETTINGS.call_once(|| {
        let dir = std::env::var_os("LUTRIUI_TEST_CONFIG_DIR")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("APPDATA")
                    .map(|p| std::path::PathBuf::from(p).join("app.lutriui.desktop"))
            });
        if let Some(dir) = dir.filter(|d| d.join("key-sources.json").is_file()) {
            init_key_settings(&dir).unwrap();
        }
    });
    assert!(
        configured_key(provider).is_some(),
        "{provider} is not configured; no request sent"
    );
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../.cache/verification/nano-banana-21")
        .join(provider)
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
    let generation = if provider == "google" {
        "Use Google Search images to reference a sunflower's petal structure. Create a clean watercolor illustration of one sunflower on a plain white background. No text."
    } else {
        "A single flat blue circle centered on a plain white background. Minimal geometric test image. No text, no shadow."
    };
    let edit = if provider == "google" {
        "Edit the provided image: change only the white background to pale cream. Keep the sunflower's shape, position and watercolor style. No text."
    } else {
        "Edit the provided image: change only the blue circle to coral red. Keep its position, size, shape and the plain white background. No text, no shadow."
    };
    for (name, prompt) in [("generation", generation), ("edit", edit)] {
        let mut params = json!({"resolution":"1K","aspectRatio":"1:1"});
        if provider == "google" {
            params["thinkingLevel"] = json!(if name == "generation" {
                "medium"
            } else {
                "minimal"
            });
            params["includeThoughts"] = json!(true);
            params["responseText"] = json!(true);
            params["searchMode"] = json!(if name == "generation" {
                "web_images"
            } else {
                "none"
            });
        } else if provider == "openrouter" {
            params["count"] = json!(1);
        } else {
            params["thinkingLevel"] = json!("minimal");
        }
        let request: GenerateRequest=serde_json::from_value(json!({"provider":provider,"model":"gemini-nano-banana-2.1","finalPrompt":prompt,"images":input,"params":params})).unwrap();
        let started = std::time::Instant::now();
        let result = match provider {
            "google" => google::generate(&request).await,
            "comfy" => comfy::generate(&request).await,
            "runware" => runware::generate(&request).await,
            _ => openrouter::generate(&request).await,
        };
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                let report = json!({"provider":provider,"stage":name,"error":error.to_json(),"elapsedSeconds":started.elapsed().as_secs_f64()});
                std::fs::write(
                    dir.join("failure.json"),
                    serde_json::to_vec_pretty(&report).unwrap(),
                )
                .unwrap();
                panic!("{report}");
            }
        };
        assert_eq!(result.images.len(), 1);
        let (_, bytes) = parse_data_url(&result.images[0].data_url).unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (1024, 1024));
        image.save(dir.join(format!("{name}.png"))).unwrap();
        let report = json!({"provider":provider,"stage":name,"model":result.model,"inputImages":request.images.len(),"width":image.width(),"height":image.height(),"usage":result.usage,"details":result.images[0].details,"elapsedSeconds":started.elapsed().as_secs_f64()});
        println!(
            "{}",
            json!({"provider":provider,"stage":name,"images":result.images.len(),"elapsedSeconds":started.elapsed().as_secs_f64()})
        );
        reports.push(report);
        std::fs::write(
            dir.join("report.json"),
            serde_json::to_vec_pretty(&reports).unwrap(),
        )
        .unwrap();
        input = vec![result.images[0].data_url.clone()];
    }
    println!("Evidence: {}", dir.display());
}
