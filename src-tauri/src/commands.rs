//! Tauri 命令：前端唯一入口。密钥不经过任何命令的返回值。

use base64::Engine;
use serde::Serialize;
use tauri::{Emitter, Manager, State};

use crate::history::{HistoryFileIn, HistoryItem, HistoryStore};
use crate::provider::{io_failed, GenerateOutput, GenerateRequest, ProviderError};
use crate::AppState;

/// 命令错误的 ProviderError JSON 结构：前端按 code 本地化，detail 等参数只做插值。
fn coded(code: &str, message: impl Into<String>) -> ProviderError {
    ProviderError::coded(code, message)
}

fn image_too_large() -> String {
    coded(
        "backend_image_too_large",
        "The image file exceeds the 64MB limit",
    )
    .into()
}

fn image_unrecognized() -> String {
    coded("backend_image_unrecognized", "Couldn't recognize the image").into()
}

fn image_area_64mp() -> String {
    coded(
        "backend_image_area_64mp",
        "The image area exceeds 64MP. Reduce it before importing",
    )
    .into()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub openrouter: bool,
    pub bfl: bool,
    pub comfy: bool,
    pub runware: bool,
    pub google: bool,
    pub ark: bool,
    pub byteplus: bool,
    pub xai: bool,
    pub qwencloud: bool,
    pub sources: std::collections::HashMap<String, String>,
    pub settings: std::collections::HashMap<String, crate::provider::CredentialSettings>,
    pub stored_keys: std::collections::HashMap<String, bool>,
}

#[tauri::command]
pub async fn provider_status() -> ProviderStatus {
    let mut sources = std::collections::HashMap::new();
    let mut settings = std::collections::HashMap::new();
    let mut stored_keys = std::collections::HashMap::new();
    for p in crate::models::provider_ids() {
        let config = crate::provider::key_settings(p);
        let source = if config.source == "manual" {
            "system"
        } else {
            "environment"
        };
        sources.insert(p.to_string(), source.to_string());
        settings.insert(p.to_string(), config);
        stored_keys.insert(p.to_string(), crate::provider::stored_key(p).is_some());
    }
    ProviderStatus {
        openrouter: crate::provider::configured_key("openrouter").is_some(),
        bfl: crate::provider::configured_key("bfl").is_some(),
        comfy: crate::provider::configured_key("comfy").is_some(),
        runware: crate::provider::configured_key("runware").is_some(),
        google: crate::provider::configured_key("google").is_some(),
        ark: crate::provider::configured_key("ark").is_some(),
        byteplus: crate::provider::configured_key("byteplus").is_some(),
        xai: crate::provider::configured_key("xai").is_some(),
        qwencloud: crate::provider::configured_key("qwencloud").is_some(),
        sources,
        settings,
        stored_keys,
    }
}

#[tauri::command]
pub async fn credential_configure(
    provider: String,
    source: String,
    env_name: String,
) -> Result<(), String> {
    crate::provider::save_key_settings(
        &provider,
        crate::provider::CredentialSettings {
            source,
            env_name: env_name.trim().into(),
        },
    )
}

#[tauri::command]
pub async fn credential_save(provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() || key.contains(['\r', '\n']) {
        return Err(coded("backend_credential_invalid", "Enter a valid key").into());
    }
    crate::provider::credential_entry(&provider)?
        .set_password(key)
        .map_err(|_| {
            coded(
                "backend_credential_save_failed",
                "Couldn't save the key to the system credential store",
            )
            .into()
        })
}

#[tauri::command]
pub async fn credential_remove(provider: String) -> Result<(), String> {
    match crate::provider::credential_entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(coded(
            "backend_credential_remove_failed",
            "Couldn't remove the key from the system credential store",
        )
        .into()),
    }
}

#[tauri::command]
pub async fn credential_check(provider: String) -> Result<String, String> {
    let key = crate::provider::configured_key(&provider).ok_or_else(|| {
        coded(
            "backend_key_not_configured",
            "No key is configured for this provider",
        )
    })?;
    let client = crate::provider::transport::client_with_timeout(30)?;
    let req = match provider.as_str() {
        "openrouter" => client
            .get("https://openrouter.ai/api/v1/key")
            .bearer_auth(&key),
        "bfl" => client
            .get("https://api.bfl.ai/v1/credits")
            .header("x-key", &key),
        "xai" => client.get("https://api.x.ai/v1/models").bearer_auth(&key),
        "google" => client.get("https://generativelanguage.googleapis.com/v1/models").header("x-goog-api-key", &key),
        "ark" | "byteplus" | "qwencloud" => {
            return Err(coded(
                "backend_check_unsupported",
                "This provider has no confirmed free key check endpoint. Confirm model access by generating an image.",
            )
            .into())
        }
        "comfy" => client.get("https://cloud.comfy.org/api/user").header("X-API-Key", &key),
        "runware" => client.post("https://api.runware.ai/v1").bearer_auth(&key).json(&serde_json::json!([{
            "taskType":"accountManagement", "taskUUID":uuid::Uuid::new_v4().to_string(), "operation":"getDetails"
        }])),
        _ => return Err(crate::provider::unknown_provider(&provider)),
    };
    let response = req.send().await.map_err(|_| {
        coded(
            "backend_connection_failed",
            "Connection failed. Check the network and try again",
        )
    })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        return Err(coded(
            "backend_check_failed_http",
            format!("Key check failed (HTTP {status})"),
        )
        .with_param("status", status)
        .into());
    }
    if provider == "runware" {
        let body: serde_json::Value = response.json().await.map_err(|_| {
            coded(
                "backend_check_response_invalid",
                "The connection check response is invalid",
            )
        })?;
        if body["errors"]
            .as_array()
            .is_some_and(|errors| !errors.is_empty())
            || !body["data"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
        {
            return Err(coded(
                "backend_runware_check_failed",
                "Runware connection check failed. Check the key and account permissions",
            )
            .into());
        }
    }
    // 返回稳定码，前端按当前语言展示。
    Ok("backend_check_verified".into())
}

#[tauri::command]
pub async fn draft_load(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let p = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("workbench")
        .join("session.json");
    if !p.exists() {
        return Ok(None);
    }
    let s = std::fs::read_to_string(p).map_err(io_failed)?;
    serde_json::from_str(&s).map(Some).map_err(|_| {
        coded(
            "backend_draft_unreadable",
            "The draft file couldn't be read",
        )
        .into()
    })
}

#[tauri::command]
pub async fn draft_save(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    draft: serde_json::Value,
) -> Result<(), String> {
    let _guard = state.draft_lock.lock().map_err(|_| {
        coded(
            "backend_draft_unavailable",
            "Draft storage is temporarily unavailable",
        )
    })?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(io_failed)?
        .join("workbench");
    std::fs::create_dir_all(&dir).map_err(io_failed)?;
    let p = dir.join("session.json");
    let tmp = dir.join("session.json.tmp");
    let json = serde_json::to_vec(&draft).map_err(io_failed)?;
    std::fs::write(&tmp, json).map_err(io_failed)?;
    std::fs::rename(tmp, p).map_err(io_failed)?;
    Ok(())
}

fn imported_bytes(bytes: Vec<u8>, name: String) -> Result<ImportedImage, String> {
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err(image_too_large());
    }
    let reader = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| image_unrecognized())?;
    let format = reader.format().ok_or_else(image_unrecognized)?;
    let (width, height) = reader.into_dimensions().map_err(|_| {
        coded(
            "backend_image_dimensions_unreadable",
            "Couldn't read the image dimensions",
        )
    })?;
    if u64::from(width) * u64::from(height) > 64_000_000 {
        return Err(image_area_64mp());
    }
    Ok(ImportedImage {
        data_url: format!(
            "data:{};base64,{}",
            format.to_mime_type(),
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ),
        width,
        height,
        name,
    })
}

/// 空名称表示默认名称；由前端按当前语言补全，后端不保存本地化文案。
#[tauri::command]
pub async fn import_url(url: String) -> Result<ImportedImage, String> {
    let parsed = reqwest::Url::parse(&url)
        .map_err(|_| coded("backend_url_invalid", "The image URL is invalid"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(coded(
            "backend_url_scheme",
            "Only http and https image URLs are supported",
        )
        .into());
    }
    let name = parsed
        .path_segments()
        .and_then(|mut s| s.next_back())
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
        .to_string();
    let client = crate::provider::transport::client_with_timeout(60)?;
    let mut response = client
        .get(parsed)
        .send()
        .await
        .map_err(|_| coded("backend_download_failed", "Image download failed"))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        return Err(coded(
            "backend_download_http",
            format!("Image download failed (HTTP {status})"),
        )
        .with_param("status", status)
        .into());
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_IMPORT_BYTES)
    {
        return Err(image_too_large());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        coded(
            "backend_download_interrupted",
            "The image download was interrupted",
        )
    })? {
        if bytes.len() as u64 + chunk.len() as u64 > MAX_IMPORT_BYTES {
            return Err(image_too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    imported_bytes(bytes, name)
}

#[tauri::command]
pub fn clipboard_image() -> Result<ImportedImage, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|_| clipboard_unavailable())?;
    let im = clipboard.get_image().map_err(|_| {
        coded(
            "backend_clipboard_no_image",
            "The clipboard has no readable image",
        )
    })?;
    if im.width * im.height > 16_000_000 {
        return Err(coded("backend_clipboard_area_16mp", "The image area exceeds 16MP").into());
    }
    let rgba = image::RgbaImage::from_raw(im.width as u32, im.height as u32, im.bytes.into_owned())
        .ok_or_else(|| {
            coded(
                "backend_clipboard_image_invalid",
                "The clipboard image is invalid",
            )
        })?;
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|_| coded("backend_image_encode_failed", "Couldn't encode the image"))?;
    imported_bytes(bytes.into_inner(), String::new())
}

fn clipboard_unavailable() -> String {
    coded(
        "backend_clipboard_unavailable",
        "Couldn't access the clipboard",
    )
    .into()
}

#[tauri::command]
pub fn copy_image(data_url: String) -> Result<(), String> {
    let (_, bytes) = crate::provider::parse_data_url(&data_url)?;
    let rgba = image::load_from_memory(&bytes)
        .map_err(|_| coded("backend_image_decode_failed", "Couldn't decode the image"))?
        .into_rgba8();
    let mut clipboard = arboard::Clipboard::new().map_err(|_| clipboard_unavailable())?;
    clipboard
        .set_image(arboard::ImageData {
            width: rgba.width() as usize,
            height: rgba.height() as usize,
            bytes: std::borrow::Cow::Owned(rgba.into_raw()),
        })
        .map_err(|_| coded("backend_clipboard_copy_failed", "Couldn't copy the image").into())
}

#[tauri::command]
pub fn history_storage(app: tauri::AppHandle) -> Result<String, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(io_failed)?
        .join("workbench")
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
pub async fn generate(
    app: tauri::AppHandle,
    request: GenerateRequest,
) -> Result<GenerateOutput, String> {
    let request_id = request.request_id.clone();
    let history_id = request.history_id.clone().or_else(|| request_id.clone());
    let reporter: crate::provider::progress::Reporter = std::sync::Arc::new(
        move |phase, task_id, completed, status| {
            if let Some(id) = history_id.as_deref() {
                if let Ok(store) = app.state::<AppState>().history.lock() {
                    if let Some(store) = store.as_ref() {
                        let _ = store.progress(id, phase, task_id);
                    }
                }
            }
            let _ = app.emit("generation-progress", serde_json::json!({"requestId": request_id, "phase": phase, "taskId": task_id, "completed": completed, "status": status}));
        },
    );
    crate::provider::progress::with_reporter(reporter, async {
        crate::provider::progress::report("submitting", None, None, None);
        crate::provider::dispatch(&request).await
    })
    .await
    .map_err(|e| e.to_json())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedImage {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    pub name: String,
}

const MAX_IMPORT_BYTES: u64 = 64 * 1024 * 1024;

#[tauri::command]
pub async fn import_image(path: String) -> Result<ImportedImage, String> {
    let p = std::path::PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|_| {
        coded(
            "backend_file_missing",
            format!("The file doesn't exist: {path}"),
        )
        .with_param("path", path.clone())
    })?;
    if !meta.is_file() {
        return Err(coded("backend_not_a_file", "The selected path is not a file").into());
    }
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(image_too_large());
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        other => {
            return Err(coded(
                "backend_image_format_unsupported",
                format!("Unsupported image format: .{other} (supports png, jpg, webp, gif)"),
            )
            .with_param("ext", other)
            .into())
        }
    };
    let (width, height) = image::image_dimensions(&p).map_err(|_| {
        coded(
            "backend_image_dimensions_unreadable",
            "Couldn't read the image dimensions",
        )
    })?;
    let bytes = std::fs::read(&p).map_err(io_failed)?;
    let data_url = format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    );
    let name = p
        .file_stem()
        .and_then(|e| e.to_str())
        .unwrap_or("image")
        .to_string();
    Ok(ImportedImage {
        data_url,
        width,
        height,
        name,
    })
}

#[tauri::command]
pub async fn save_data_url(data_url: String, path: String) -> Result<String, String> {
    let p = std::path::PathBuf::from(&path);
    crate::history::write_data_url(&data_url, &p)?;
    Ok(path)
}

fn with_store<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&HistoryStore) -> Result<T, String>,
) -> Result<T, String> {
    let guard = state.history.lock().unwrap();
    let s = guard.as_ref().ok_or_else(|| {
        String::from(coded(
            "backend_history_uninitialized",
            "History storage isn't initialized",
        ))
    })?;
    f(s)
}

#[tauri::command]
pub async fn history_list(state: State<'_, AppState>) -> Result<Vec<HistoryItem>, String> {
    with_store(&state, |s| s.list())
}

#[tauri::command]
pub async fn history_save(
    state: State<'_, AppState>,
    item: HistoryItem,
    files: Vec<HistoryFileIn>,
) -> Result<HistoryItem, String> {
    with_store(&state, |s| s.save(item, files))
}

#[tauri::command]
pub async fn history_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    with_store(&state, |s| s.delete(&id))
}

#[tauri::command]
pub async fn gallery_list(
    state: State<'_, AppState>,
) -> Result<Vec<crate::gallery::GalleryItem>, String> {
    with_store(&state, |s| s.gallery.list())
}

#[tauri::command]
pub async fn gallery_import(
    state: State<'_, AppState>,
    data_url: String,
    name: String,
    source: String,
) -> Result<crate::gallery::GalleryItem, String> {
    with_store(&state, |s| s.gallery.import(&data_url, &name, &source))
}

#[tauri::command]
pub async fn gallery_read(state: State<'_, AppState>, id: String) -> Result<ImportedImage, String> {
    with_store(&state, |s| {
        let asset = s.gallery.get(&id)?;
        let bytes = std::fs::read(&asset.file_path).map_err(|e| {
            coded(
                "backend_gallery_read_failed",
                format!("The gallery image can't be read: {e}"),
            )
            .with_param("detail", e.to_string())
        })?;
        imported_bytes(bytes, asset.name)
    })
}

#[tauri::command]
pub async fn gallery_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    with_store(&state, |s| s.gallery.delete(&id))
}
