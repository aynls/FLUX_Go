//! Tauri 命令：前端唯一入口。密钥不经过任何命令的返回值。

use std::sync::atomic::Ordering;

use base64::Engine;
use serde::Serialize;
use tauri::{Manager, State};

use crate::history::{HistoryFileIn, HistoryItem, HistoryStore};
use crate::provider::{GenerateOutput, GenerateRequest};
use crate::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub openrouter: bool,
    pub bfl: bool,
    pub sources: std::collections::HashMap<String, String>,
    pub settings: std::collections::HashMap<String, crate::provider::CredentialSettings>,
    pub stored_keys: std::collections::HashMap<String, bool>,
}

#[tauri::command]
pub async fn provider_status() -> ProviderStatus {
    let mut sources = std::collections::HashMap::new();
    let mut settings = std::collections::HashMap::new();
    let mut stored_keys = std::collections::HashMap::new();
    for p in ["openrouter", "bfl"] {
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
        return Err("请输入有效密钥".into());
    }
    crate::provider::credential_entry(&provider)?
        .set_password(key)
        .map_err(|_| "系统凭据保存失败".into())
}

#[tauri::command]
pub async fn credential_remove(provider: String) -> Result<(), String> {
    match crate::provider::credential_entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("系统凭据移除失败".into()),
    }
}

#[tauri::command]
pub async fn credential_check(provider: String) -> Result<String, String> {
    let key = crate::provider::configured_key(&provider).ok_or("尚未配置密钥")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| "网络初始化失败")?;
    let req = match provider.as_str() {
        "openrouter" => client
            .get("https://openrouter.ai/api/v1/key")
            .bearer_auth(&key),
        "bfl" => client
            .get("https://api.bfl.ai/v1/credits")
            .header("x-key", &key),
        _ => return Err("未知提供商".into()),
    };
    let response = req.send().await.map_err(|_| "连接失败，请检查网络后重试")?;
    if !response.status().is_success() {
        return Err(format!(
            "密钥检查失败（HTTP {}）",
            response.status().as_u16()
        ));
    }
    Ok("已验证连接（未提交生成，不产生生图费用）".into())
}

#[tauri::command]
pub async fn draft_load(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let p = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("draft.json");
    if !p.exists() {
        return Ok(None);
    }
    let s = std::fs::read_to_string(p).map_err(|e| e.to_string())?;
    serde_json::from_str(&s)
        .map(Some)
        .map_err(|_| "草稿文件无法读取".into())
}

#[tauri::command]
pub async fn draft_save(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    draft: serde_json::Value,
) -> Result<(), String> {
    let _guard = state.draft_lock.lock().map_err(|_| "草稿存储暂不可用")?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let p = dir.join("draft.json");
    let tmp = dir.join("draft.json.tmp");
    let json = serde_json::to_vec(&draft).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, p).map_err(|e| e.to_string())
}

fn imported_bytes(bytes: Vec<u8>, name: String) -> Result<ImportedImage, String> {
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err("图片文件超过 64MB 限制".into());
    }
    let reader = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| "无法识别图片")?;
    let format = reader.format().ok_or("无法识别图片")?;
    let (width, height) = reader.into_dimensions().map_err(|_| "图片尺寸无法读取")?;
    if u64::from(width) * u64::from(height) > 16_000_000 {
        return Err("图片面积超过 16MP，请缩小后导入".into());
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

#[tauri::command]
pub async fn import_url(url: String) -> Result<ImportedImage, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "图片 URL 无效")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("仅支持 http/https 图片 URL".into());
    }
    let name = parsed
        .path_segments()
        .and_then(|mut s| s.next_back())
        .filter(|s| !s.is_empty())
        .unwrap_or("网络图片")
        .to_string();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(parsed)
        .send()
        .await
        .map_err(|_| "图片下载失败")?;
    if !response.status().is_success() {
        return Err(format!("图片下载失败（HTTP {}）", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_IMPORT_BYTES)
    {
        return Err("图片超过 64MB".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "图片下载中断")? {
        if bytes.len() as u64 + chunk.len() as u64 > MAX_IMPORT_BYTES {
            return Err("图片超过 64MB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    imported_bytes(bytes, name)
}

#[tauri::command]
pub fn clipboard_image() -> Result<ImportedImage, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|_| "无法访问剪贴板")?;
    let im = clipboard
        .get_image()
        .map_err(|_| "剪贴板中没有可读取的图片")?;
    if im.width * im.height > 16_000_000 {
        return Err("图片面积超过 16MP".into());
    }
    let rgba = image::RgbaImage::from_raw(im.width as u32, im.height as u32, im.bytes.into_owned())
        .ok_or("剪贴板图片无效")?;
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|_| "图片编码失败")?;
    imported_bytes(bytes.into_inner(), "剪贴板图片".into())
}

#[tauri::command]
pub fn copy_image(data_url: String) -> Result<(), String> {
    let (_, bytes) = crate::provider::parse_data_url(&data_url).map_err(|e| e.message)?;
    let rgba = image::load_from_memory(&bytes)
        .map_err(|_| "图片解码失败")?
        .into_rgba8();
    let mut clipboard = arboard::Clipboard::new().map_err(|_| "无法访问剪贴板")?;
    clipboard
        .set_image(arboard::ImageData {
            width: rgba.width() as usize,
            height: rgba.height() as usize,
            bytes: std::borrow::Cow::Owned(rgba.into_raw()),
        })
        .map_err(|_| "图片复制失败".into())
}

#[tauri::command]
pub fn history_storage(app: tauri::AppHandle) -> Result<String, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("history")
        .to_string_lossy()
        .to_string())
}

struct BusyGuard<'a>(&'a std::sync::atomic::AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn generate(
    state: State<'_, AppState>,
    request: GenerateRequest,
) -> Result<GenerateOutput, String> {
    if state
        .busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("已有生成任务进行中，请等待完成后再试（防止重复提交与重复计费）。".to_string());
    }
    let _guard = BusyGuard(&state.busy);
    crate::provider::dispatch(&request)
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
    let meta = std::fs::metadata(&p).map_err(|_| format!("文件不存在: {path}"))?;
    if !meta.is_file() {
        return Err("不是文件".into());
    }
    if meta.len() > MAX_IMPORT_BYTES {
        return Err("图片文件超过 64MB 限制".into());
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
            return Err(format!(
                "不支持的图片格式: .{other}（支持 png/jpg/webp/gif）"
            ))
        }
    };
    let (width, height) =
        image::image_dimensions(&p).map_err(|e| format!("无法读取图片尺寸: {e}"))?;
    let bytes = std::fs::read(&p).map_err(|e| format!("读取文件失败: {e}"))?;
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
    let s = guard
        .as_ref()
        .ok_or_else(|| "历史存储未初始化".to_string())?;
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
