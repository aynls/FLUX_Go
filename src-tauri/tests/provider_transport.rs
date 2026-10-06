//! Local HTTP simulations validate admission, auth, polling and single submission.
use base64::Engine;
use lutriui_lib::provider::{comfy, runware, GenerateRequest};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
    time::{Duration, Instant},
};

fn png() -> String {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(16, 16)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
    )
}
fn server(responses: Vec<(u16, Value)>) -> (String, thread::JoinHandle<Vec<(String, Value)>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let handle = thread::spawn(move || {
        let mut requests = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(20);
        for (status, body) in responses {
            let mut stream = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            Instant::now() < deadline,
                            "expected HTTP request did not arrive"
                        );
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 4096];
            let (head, length, offset) = loop {
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&chunk[..read]);
                if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let head = String::from_utf8(bytes[..end].to_vec()).unwrap();
                    let length: usize = head
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    break (head, length, end + 4);
                }
            };
            while bytes.len() < offset + length {
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
            }
            let payload = if length > 0 {
                serde_json::from_slice(&bytes[offset..offset + length]).unwrap()
            } else {
                Value::Null
            };
            requests.push((head, payload));
            let text = serde_json::to_string(&body).unwrap();
            let billing = if status == 200 {
                "X-Comfy-Credits-Used: 12.75\r\n"
            } else {
                ""
            };
            write!(stream,"HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nRetry-After: 1\r\n{billing}Connection: close\r\n\r\n{text}",text.len()).unwrap();
        }
        requests
    });
    (url, handle)
}
fn req(provider: &str, count: u32) -> GenerateRequest {
    serde_json::from_value(json!({"provider":provider,"model":"gpt-image-2.5-flare","finalPrompt":"a simple icon","requestId":"50836053-a0ee-4cf5-b9d6-ae7c5d140ada","params":{"size":"1024x1024","outputFormat":"png","count":count}})).unwrap()
}
#[tokio::test]
async fn comfy_submits_once_and_collects_native_result_with_api_key() {
    let image = png();
    let b64 = image.split_once(',').unwrap().1;
    let (url, handle) = server(vec![
        (201, json!({"request_id":"test-job"})),
        (202, json!({"status":"IN_PROGRESS"})),
        (502, json!({"detail":"temporary gateway outage"})),
        (
            200,
            json!({"data":[{"b64_json":b64}],"usage":{"total_tokens":123}}),
        ),
    ]);
    let out = comfy::generate_at(
        &req("comfy", 1),
        "test-only-key",
        &format!("{url}/v2/models"),
    )
    .await
    .unwrap();
    let requests = handle.join().unwrap();
    assert_eq!(out.images.len(), 1);
    assert_eq!(out.usage["credits"], 12.75);
    assert_eq!(requests.len(), 4);
    assert!(requests[0]
        .0
        .starts_with("POST /v2/models/openai/gpt-image-2.5-flare/requests "));
    assert!(requests[0]
        .0
        .to_lowercase()
        .contains("x-api-key: test-only-key"));
    assert!(requests[0]
        .0
        .to_lowercase()
        .contains("idempotency-key: 50836053-a0ee-4cf5-b9d6-ae7c5d140ada"));
    assert_eq!(requests[0].1["size"], "1024x1024");
    assert!(requests[1].0.starts_with("GET "));
    assert!(requests[2].0.starts_with("GET "));
    assert!(requests[3].0.starts_with("GET "));
}
#[tokio::test]
async fn runware_polls_one_task_and_counts_repeated_results_once() {
    let id = "50836053-a0ee-4cf5-b9d6-ae7c5d140ada";
    let image = png();
    let first = json!({"taskUUID":id,"imageUUID":"first","imageDataURI":image,"cost":0.2});
    let second = json!({"taskUUID":id,"imageUUID":"second","imageDataURI":image,"cost":0.3});
    let (url, handle) = server(vec![
        (200, json!({"data":[{"taskUUID":id}]})),
        (200, json!({"data":[first]})),
        (200, json!({"data":[first,second]})),
    ]);
    let out = runware::generate_at(&req("runware", 2), "test-only-key", &url)
        .await
        .unwrap();
    let requests = handle.join().unwrap();
    assert_eq!(out.images.len(), 2);
    assert_eq!(out.usage["cost"], 0.5);
    assert_eq!(requests[0].1[0]["taskType"], "imageInference");
    assert!(requests[0]
        .0
        .to_lowercase()
        .contains("authorization: bearer test-only-key"));
    assert_eq!(requests[1].1[0]["taskType"], "getResponse");
    assert_eq!(requests[2].1[0]["taskUUID"], id);
    assert_eq!(
        requests
            .iter()
            .filter(|(_, body)| body[0]["taskType"] == "imageInference")
            .count(),
        1
    );
}
#[tokio::test]
async fn admission_error_does_not_resubmit_paid_generation() {
    let (url, handle) = server(vec![(
        402,
        json!({"error":{"message":"not enough credits"}}),
    )]);
    let error = comfy::generate_at(&req("comfy", 1), "test-only-key", &url)
        .await
        .unwrap_err();
    assert_eq!(error.status, Some(402));
    assert_eq!(handle.join().unwrap().len(), 1);
}
