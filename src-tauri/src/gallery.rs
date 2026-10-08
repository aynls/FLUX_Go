//! Owned image assets. Generation keys survive deletion so retries cannot resurrect assets.
use crate::provider::{io_failed, ProviderError};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<crate::provider::GenerationDetails>,
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub width: u32,
    pub height: u32,
    pub mime: String,
    pub source: String,
    pub history_id: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub file_path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub thumb_path: String,
    #[serde(default)]
    pub pending_delete: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    items: Vec<GalleryItem>,
    generated: BTreeMap<String, String>,
}

pub struct GalleryStore {
    dir: PathBuf,
}
impl GalleryStore {
    pub fn new(dir: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir.join("images"))?;
        let store = Self { dir };
        // Interrupted deletions remain visible and retryable if the OS still locks a file.
        if let Ok(index) = store.read() {
            for item in index.items.iter().filter(|i| i.pending_delete) {
                let _ = store.delete(&item.id);
            }
        }
        Ok(store)
    }
    fn read(&self) -> Result<Index, String> {
        let path = self.dir.join("index.json");
        if !path.exists() {
            return Ok(Index::default());
        }
        let index: Index = serde_json::from_slice(&std::fs::read(path).map_err(io_failed)?)
            .map_err(|e| {
                coded(
                    "backend_gallery_index_corrupt",
                    format!("The gallery index is corrupt; the original file was kept: {e}"),
                )
                .with_param("detail", e.to_string())
            })?;
        for item in &index.items {
            uuid::Uuid::parse_str(&item.id).map_err(|_| gallery_id_invalid())?;
            extension(&item.mime)?;
        }
        Ok(index)
    }
    fn write(&self, index: &Index) -> Result<(), String> {
        let temp = self.dir.join("index.json.tmp");
        let save_failed = |e: std::io::Error| {
            coded(
                "backend_gallery_write_failed",
                format!("Couldn't save the gallery record: {e}"),
            )
            .with_param("detail", e.to_string())
        };
        std::fs::write(&temp, serde_json::to_vec(index).map_err(io_failed)?)
            .map_err(save_failed)?;
        std::fs::rename(temp, self.dir.join("index.json")).map_err(save_failed)?;
        Ok(())
    }
    fn paths(&self, mut item: GalleryItem) -> Result<GalleryItem, String> {
        let dir = self.dir.join("images").join(&item.id);
        // Stored paths never participate in filesystem operations.
        item.file_path = dir
            .join(format!("original.{}", extension(&item.mime)?))
            .to_string_lossy()
            .into();
        item.thumb_path = dir.join("thumbnail.png").to_string_lossy().into();
        Ok(item)
    }
    pub fn list(&self) -> Result<Vec<GalleryItem>, String> {
        let mut items = self.read()?.items;
        items.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
        items.into_iter().map(|item| self.paths(item)).collect()
    }
    pub fn get(&self, id: &str) -> Result<GalleryItem, String> {
        let item = self
            .read()?
            .items
            .into_iter()
            .find(|i| i.id == id && !i.pending_delete)
            .ok_or_else(|| {
                coded(
                    "backend_gallery_deleted",
                    "The image was deleted from the gallery",
                )
            })?;
        self.paths(item)
    }
    pub fn import(&self, data: &str, name: &str, source: &str) -> Result<GalleryItem, String> {
        if !["file", "clipboard", "url"].contains(&source) {
            return Err(coded(
                "backend_import_source_invalid",
                "The import source is invalid",
            )
            .into());
        }
        self.add(data, name, source, None, None)
            .map(|(_, item)| item.unwrap())
    }
    pub fn generated(
        &self,
        data: &str,
        name: &str,
        history: &crate::history::HistoryItem,
    ) -> Result<String, String> {
        // 默认名称由前端按当前语言补全，持久化的名称保持为空。
        self.add(
            data,
            "",
            "generated",
            Some((format!("{}/{}", history.id, name), history)),
            history.result_details.get(name).cloned(),
        )
        .map(|(id, _)| id)
    }
    fn add(
        &self,
        data: &str,
        name: &str,
        source: &str,
        generated: Option<(String, &crate::history::HistoryItem)>,
        details: Option<crate::provider::GenerationDetails>,
    ) -> Result<(String, Option<GalleryItem>), String> {
        let mut index = self.read()?;
        if let Some((key, _)) = &generated {
            if let Some(id) = index.generated.get(key) {
                return Ok((
                    id.clone(),
                    index
                        .items
                        .iter()
                        .find(|i| &i.id == id && !i.pending_delete)
                        .cloned()
                        .map(|i| self.paths(i))
                        .transpose()?,
                ));
            }
        }
        if data.len() > 90_000_000 {
            return Err(image_too_large());
        }
        let (_, bytes) = crate::provider::parse_data_url(data)?;
        if bytes.len() > 64 * 1024 * 1024 {
            return Err(image_too_large());
        }
        let reader = image::ImageReader::new(std::io::Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(io_failed)?;
        let format = reader.format().ok_or_else(|| {
            coded(
                "backend_image_unrecognized",
                "Couldn't recognize the image format",
            )
        })?;
        let mime = format.to_mime_type().to_string();
        let ext = extension(&mime)?;
        let (width, height) = reader.into_dimensions().map_err(|_| {
            coded(
                "backend_image_dimensions_unreadable",
                "Couldn't read the image dimensions",
            )
        })?;
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 64_000_000 {
            return Err(coded(
                "backend_image_area_64mp",
                "The image area exceeds 64MP. Reduce it before importing",
            )
            .into());
        }
        let image = image::load_from_memory(&bytes)
            .map_err(|_| coded("backend_image_decode_failed", "Couldn't decode the image"))?;
        let item = GalleryItem {
            details,
            id: uuid::Uuid::new_v4().to_string(),
            name: name.chars().take(240).collect(),
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            width,
            height,
            mime,
            source: source.into(),
            history_id: generated.as_ref().map(|(_, h)| h.id.clone()),
            model: generated.as_ref().map(|(_, h)| h.model.clone()),
            provider: generated.as_ref().map(|(_, h)| h.provider.clone()),
            file_path: String::new(),
            thumb_path: String::new(),
            pending_delete: false,
        };
        let dir = self.dir.join("images").join(&item.id);
        std::fs::create_dir(&dir).map_err(io_failed)?;
        let written = (|| -> Result<(), String> {
            std::fs::write(dir.join(format!("original.{ext}")), bytes).map_err(io_failed)?;
            image
                .thumbnail(384, 384)
                .save_with_format(dir.join("thumbnail.png"), image::ImageFormat::Png)
                .map_err(io_failed)?;
            index.items.push(item.clone());
            if let Some((key, _)) = generated {
                index.generated.insert(key, item.id.clone());
            }
            self.write(&index)
        })();
        if let Err(error) = written {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(coded(
                "backend_gallery_not_saved",
                format!("The image wasn't saved to the gallery: {error}"),
            )
            .with_param("detail", error)
            .into());
        }
        Ok((item.id.clone(), Some(self.paths(item)?)))
    }
    pub fn delete(&self, id: &str) -> Result<(), String> {
        uuid::Uuid::parse_str(id).map_err(|_| gallery_id_invalid())?;
        let mut index = self.read()?;
        let Some(item) = index.items.iter_mut().find(|i| i.id == id) else {
            return Ok(());
        };
        item.pending_delete = true;
        self.write(&index)?;
        // Journal first: a crash cannot make a deleted generated image reappear on the next save.
        let dir = self.dir.join("images").join(id);
        if dir.exists() {
            std::fs::remove_dir_all(dir).map_err(|e| {
                coded(
                    "backend_gallery_delete_pending",
                    format!("The image file deletion didn't finish. You can retry: {e}"),
                )
                .with_param("detail", e.to_string())
            })?;
        }
        index.items.retain(|i| i.id != id);
        self.write(&index)
    }
}
fn gallery_id_invalid() -> ProviderError {
    coded(
        "backend_gallery_id_invalid",
        "The gallery image ID is invalid",
    )
}
fn extension(mime: &str) -> Result<&'static str, String> {
    match mime {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/webp" => Ok("webp"),
        "image/gif" => Ok("gif"),
        _ => Err(coded(
            "backend_format_unsupported",
            "Only PNG, JPEG, WebP, and GIF images are supported",
        )
        .into()),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use base64::Engine;
    pub fn png() -> String {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(32, 16)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
        )
    }
    fn temp() -> PathBuf {
        std::env::temp_dir().join(format!("lutriui-gallery-{}", uuid::Uuid::new_v4()))
    }
    fn history() -> crate::history::HistoryItem {
        serde_json::from_value(serde_json::json!({"id":"task","createdAt":1,"provider":"google","model":"gemini-nano-banana-2.1","mode":"t2i","prompt":"test","finalPrompt":"test","params":{},"boxes":[],"status":"ok"})).unwrap()
    }
    #[test]
    fn imports_persist_owned_files_and_deletion_removes_both_images() {
        let dir = temp();
        let store = GalleryStore::new(dir.clone()).unwrap();
        let image = store.import(&png(), "../original", "clipboard").unwrap();
        assert_eq!((image.width, image.height), (32, 16));
        assert!(PathBuf::from(&image.file_path).is_file());
        assert!(PathBuf::from(&image.thumb_path).is_file());
        let store = GalleryStore::new(dir.clone()).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
        assert_eq!(store.get(&image.id).unwrap().name, "../original");
        store.delete(&image.id).unwrap();
        assert!(store.list().unwrap().is_empty());
        assert!(!PathBuf::from(&image.file_path).exists());
        assert!(!PathBuf::from(&image.thumb_path).exists());
        assert!(store.get(&image.id).is_err());
        assert!(store.delete("../outside").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn generation_save_is_idempotent_even_after_deletion_and_restart() {
        let dir = temp();
        let store = GalleryStore::new(dir.clone()).unwrap();
        let id = store.generated(&png(), "result_0", &history()).unwrap();
        assert_eq!(store.generated(&png(), "result_0", &history()).unwrap(), id);
        assert_eq!(store.list().unwrap().len(), 1);
        store.delete(&id).unwrap();
        let store = GalleryStore::new(dir.clone()).unwrap();
        assert_eq!(store.generated(&png(), "result_0", &history()).unwrap(), id);
        assert!(store.list().unwrap().is_empty());
        store.generated(&png(), "result_1", &history()).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn interrupted_deletion_finishes_on_restart_and_corrupt_index_is_preserved() {
        let dir = temp();
        let store = GalleryStore::new(dir.clone()).unwrap();
        let asset = store.import(&png(), "file", "file").unwrap();
        let mut index = store.read().unwrap();
        index.items[0].pending_delete = true;
        store.write(&index).unwrap();
        let store = GalleryStore::new(dir.clone()).unwrap();
        assert!(store.list().unwrap().is_empty());
        assert!(!PathBuf::from(asset.file_path).exists());
        std::fs::write(dir.join("index.json"), b"broken").unwrap();
        assert!(store.import(&png(), "file", "file").is_err());
        assert_eq!(std::fs::read(dir.join("index.json")).unwrap(), b"broken");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
