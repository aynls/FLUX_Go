//! 本地生成历史：图片文件 + index.json 元数据，存于应用数据目录。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    #[serde(default)]
    pub batch: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub phase: Option<String>,
    pub id: String,
    pub created_at: u64,
    pub provider: String,
    pub model: String,
    /// "edit" | "t2i"
    pub mode: String,
    pub prompt: String,
    pub final_prompt: String,
    pub params: serde_json::Value,
    /// 前端 Box[]（画布像素坐标 + 角色 + 描述）
    pub boxes: serde_json::Value,
    pub canvas_width: Option<u32>,
    pub canvas_height: Option<u32>,
    #[serde(default)]
    pub input_files: Vec<String>,
    #[serde(default)]
    pub result_files: Vec<String>,
    #[serde(default)]
    pub result_asset_ids: Vec<String>,
    #[serde(default)]
    pub thumb_file: Option<String>,
    #[serde(default)]
    pub mask_file: Option<String>,
    /// 结果缩略图 data URL（内联，供列表展示）
    #[serde(default)]
    pub thumb: Option<String>,
    #[serde(default)]
    pub usage: serde_json::Value,
    #[serde(default)]
    pub cost: Option<f64>,
    pub status: String,
    #[serde(default)]
    pub recipe: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HistoryFileIn {
    /// "input" | "result"
    pub kind: String,
    pub name: String,
    /// data URL
    pub data: String,
}

pub struct HistoryStore {
    dir: PathBuf,
    pub gallery: crate::gallery::GalleryStore,
}

impl HistoryStore {
    pub fn new(dir: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir.join("images"))?;
        let gallery = crate::gallery::GalleryStore::new(dir.join("gallery"))?;
        let store = Self { dir, gallery };
        if let Ok(mut items) = store.read_index() {
            let mut changed = false;
            for item in &mut items {
                if item.status == "running" {
                    item.status = "interrupted".into();
                    item.error =
                        Some("应用关闭时任务尚未完成；供应商可能仍在处理，未自动重新提交。".into());
                    if let Some(requests) = item
                        .batch
                        .as_mut()
                        .and_then(|batch| batch.get_mut("requests"))
                        .and_then(|requests| requests.as_array_mut())
                    {
                        for request in requests {
                            match request["status"].as_str() {
                                Some("running") => {
                                    request["status"] = serde_json::json!("interrupted")
                                }
                                Some("queued") => request["status"] = serde_json::json!("skipped"),
                                _ => {}
                            }
                        }
                    }
                    changed = true;
                }
            }
            if changed {
                store.write_index(&items).map_err(std::io::Error::other)?;
            }
        }
        Ok(store)
    }

    fn index_path(&self) -> PathBuf {
        self.dir.join("index.json")
    }

    fn read_index(&self) -> Result<Vec<HistoryItem>, String> {
        let p = self.index_path();
        if !p.exists() {
            return Ok(Vec::new());
        }
        let text = std::fs::read_to_string(&p).map_err(|e| format!("读取历史索引失败: {e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("历史索引损坏: {e}"))
    }

    fn write_index(&self, items: &[HistoryItem]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
        let tmp = self.index_path().with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("写入历史索引失败: {e}"))?;
        std::fs::rename(&tmp, self.index_path()).map_err(|e| format!("写入历史索引失败: {e}"))?;
        Ok(())
    }

    /// 文件路径：磁盘存相对路径，返回给前端时转绝对路径
    fn absolutize(
        &self,
        mut item: HistoryItem,
        assets: &[crate::gallery::GalleryItem],
    ) -> HistoryItem {
        item.input_files = item
            .input_files
            .iter()
            .map(|p| self.dir.join(p).to_string_lossy().to_string())
            .collect();
        item.result_files = item
            .result_asset_ids
            .iter()
            .map(|id| {
                assets
                    .iter()
                    .find(|a| &a.id == id && !a.pending_delete)
                    .map(|a| a.file_path.clone())
                    .unwrap_or_default()
            })
            .collect();
        item.thumb_file = item.result_asset_ids.iter().find_map(|id| {
            assets
                .iter()
                .find(|a| &a.id == id && !a.pending_delete)
                .map(|a| a.thumb_path.clone())
        });
        item.thumb = None;
        item.mask_file = item
            .mask_file
            .map(|p| self.dir.join(p).to_string_lossy().to_string());
        item
    }

    pub fn save(
        &self,
        mut item: HistoryItem,
        files: Vec<HistoryFileIn>,
    ) -> Result<HistoryItem, String> {
        validate_id(&item.id)?;
        let mut items = self.read_index()?;
        if let Some(old) = items.iter().find(|old| old.id == item.id) {
            item.result_asset_ids = old.result_asset_ids.clone();
        }
        item.result_files.clear();
        item.thumb = None;
        item.thumb_file = None;
        // Updates arrive with the absolute paths returned by list/save.
        for paths in [&mut item.input_files, &mut item.result_files] {
            for path in paths {
                let p = std::path::Path::new(path);
                if p.is_absolute() {
                    *path = p
                        .strip_prefix(&self.dir)
                        .map_err(|_| "历史图片路径不属于本地历史目录")?
                        .to_string_lossy()
                        .replace('\\', "/");
                }
            }
        }
        if let Some(path) = &mut item.mask_file {
            let p = std::path::Path::new(path);
            if p.is_absolute() {
                *path = p
                    .strip_prefix(&self.dir)
                    .map_err(|_| "历史蒙版路径不属于本地历史目录")?
                    .to_string_lossy()
                    .replace('\\', "/");
            }
        }
        if item.id.trim().is_empty() {
            return Err("历史条目缺少 id".into());
        }
        let img_dir = self.dir.join("images").join(&item.id);
        std::fs::create_dir_all(&img_dir).map_err(|e| format!("创建历史目录失败: {e}"))?;
        for f in files {
            if f.kind == "result" {
                let id = self.gallery.generated(&f.data, &f.name, &item)?;
                if !item.result_asset_ids.contains(&id) {
                    item.result_asset_ids.push(id);
                }
                continue;
            }
            let (mime, bytes) = crate::provider::parse_data_url(&f.data).map_err(|e| e.message)?;
            let ext = match mime.as_str() {
                "image/png" => "png",
                "image/jpeg" => "jpg",
                "image/webp" => "webp",
                "image/gif" => "gif",
                other => return Err(format!("不支持的历史图片类型: {other}")),
            };
            let base = sanitize_name(&f.name);
            let file_name = format!("{base}.{ext}");
            std::fs::write(img_dir.join(&file_name), &bytes)
                .map_err(|e| format!("写入历史图片失败: {e}"))?;
            let rel = format!("images/{}/{file_name}", item.id);
            match f.kind.as_str() {
                "input" => {
                    if !item.input_files.contains(&rel) {
                        item.input_files.push(rel);
                    }
                }
                "mask" => item.mask_file = Some(rel),
                _ => return Err(format!("未知历史文件类型: {}", f.kind)),
            }
        }
        items.retain(|it| it.id != item.id);
        items.push(item.clone());
        self.write_index(&items)?;
        Ok(self.absolutize(item, &self.gallery.list()?))
    }

    pub fn list(&self) -> Result<Vec<HistoryItem>, String> {
        let mut items = self.read_index()?;
        items.sort_by_key(|a| std::cmp::Reverse(a.created_at));
        let assets = self.gallery.list()?;
        Ok(items
            .into_iter()
            .map(|it| self.absolutize(it, &assets))
            .collect())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        let mut items = self.read_index()?;
        if items
            .iter()
            .any(|it| it.id == id && matches!(it.status.as_str(), "queued" | "running"))
        {
            return Err("请先取消等待任务，或等待正在执行的任务完成后再删除".into());
        }
        items.retain(|it| it.id != id);
        self.write_index(&items)?;
        Ok(())
    }

    pub fn progress(&self, id: &str, phase: &str, task_id: Option<&str>) -> Result<(), String> {
        let mut items = self.read_index()?;
        if let Some(item) = items
            .iter_mut()
            .find(|it| it.id == id && it.status == "running")
        {
            item.phase = Some(phase.into());
            if let Some(task_id) = task_id {
                item.task_id = Some(task_id.into());
            }
            self.write_index(&items)?;
        }
        Ok(())
    }
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("历史 ID 无效".into());
    }
    Ok(())
}

fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "image".into()
    } else {
        cleaned
    }
}

/// 把 data URL 解码写到任意路径（用于「另存为」）
pub fn write_data_url(data_url: &str, path: &std::path::Path) -> Result<(), String> {
    let (_mime, bytes) = crate::provider::parse_data_url(data_url).map_err(|e| e.message)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    std::fs::write(path, bytes).map_err(|e| format!("写入文件失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "lutriui-history-test-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    #[test]
    fn complete_recipe_and_all_inputs_round_trip() {
        let dir = temp();
        let store = HistoryStore::new(dir.clone()).unwrap();
        let value = serde_json::json!({
            "id":"recipe_test", "createdAt":1,"provider":"bfl","model":"flux-3-image","mode":"edit",
            "prompt":"test","finalPrompt":"test","params":{"resolution":"768","grounding":false,"version":"latest"},
            "boxes":[],"canvasWidth":1024,"canvasHeight":768,"status":"ok",
            "recipe":{"schema":2,"baseId":"b","refIds":["a","b"],"refNames":["first","second"],"compressEnabled":false,"maxInputEdge":4096}
        });
        let item: HistoryItem = serde_json::from_value(value).unwrap();
        let saved = store
            .save(
                item,
                vec![
                    HistoryFileIn {
                        kind: "input".into(),
                        name: "input_0".into(),
                        data: "data:image/png;base64,aGVsbG8=".into(),
                    },
                    HistoryFileIn {
                        kind: "input".into(),
                        name: "input_1".into(),
                        data: "data:image/png;base64,aGVsbG8=".into(),
                    },
                    HistoryFileIn {
                        kind: "result".into(),
                        name: "result_0".into(),
                        data: crate::gallery::tests::png(),
                    },
                    HistoryFileIn {
                        kind: "mask".into(),
                        name: "mask".into(),
                        data: "data:image/png;base64,aGVsbG8=".into(),
                    },
                ],
            )
            .unwrap();
        assert_eq!(saved.input_files.len(), 2);
        let listed = store.list().unwrap();
        assert_eq!(listed[0].input_files, saved.input_files);
        assert_eq!(
            listed[0].recipe.as_ref().unwrap()["refIds"],
            serde_json::json!(["a", "b"])
        );
        assert_eq!(listed[0].recipe.as_ref().unwrap()["compressEnabled"], false);
        let files: Vec<_> = saved
            .input_files
            .iter()
            .chain(saved.result_files.iter())
            .chain(saved.mask_file.iter())
            .map(|path| (path.clone(), std::fs::read(path).unwrap()))
            .collect();
        store.delete("recipe_test").unwrap();
        assert!(store.list().unwrap().is_empty());
        for (path, bytes) in files {
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
        assert!(HistoryStore::new(dir.clone())
            .unwrap()
            .list()
            .unwrap()
            .is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn task_updates_preserve_paths_and_restart_does_not_resubmit_running_work() {
        let dir = temp();
        let store = HistoryStore::new(dir.clone()).unwrap();
        let item: HistoryItem = serde_json::from_value(serde_json::json!({
            "id":"queued_task", "createdAt":1, "provider":"comfy", "model":"qwen-image-3.0",
            "mode":"t2i", "prompt":"snapshot", "finalPrompt":"snapshot", "params":{},
            "boxes":[], "status":"queued",
            "batch":{"requests":[{"requestId":"first", "status":"ok", "seed":11},
                {"requestId":"second", "status":"running", "seed":22},
                {"requestId":"third", "status":"queued", "seed":33}]}
        }))
        .unwrap();
        let mut saved = store
            .save(
                item,
                vec![HistoryFileIn {
                    kind: "input".into(),
                    name: "input_0".into(),
                    data: "data:image/png;base64,aGVsbG8=".into(),
                }],
            )
            .unwrap();
        assert!(store.delete(&saved.id).is_err());
        let original_paths = saved.input_files.clone();
        saved.status = "running".into();
        store.save(saved, vec![]).unwrap();
        store
            .progress("queued_task", "waiting", Some("remote-task"))
            .unwrap();
        let restored = HistoryStore::new(dir.clone())
            .unwrap()
            .list()
            .unwrap()
            .remove(0);
        assert_eq!(restored.status, "interrupted");
        assert_eq!(restored.task_id.as_deref(), Some("remote-task"));
        assert_eq!(restored.input_files, original_paths);
        assert!(restored.error.is_some());
        let requests = &restored.batch.as_ref().unwrap()["requests"];
        assert_eq!(requests[0]["status"], "ok");
        assert_eq!(requests[1]["status"], "interrupted");
        assert_eq!(requests[2]["status"], "skipped");
        assert_eq!(requests[1]["seed"], 22);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn gallery_deletion_keeps_recipe_and_does_not_resurrect_on_batch_save() {
        let dir = temp();
        let store = HistoryStore::new(dir.clone()).unwrap();
        let item: HistoryItem = serde_json::from_value(serde_json::json!({
            "id":"gallery_batch", "createdAt":1, "provider":"google", "model":"gemini-nano-banana-2.1",
            "mode":"t2i", "prompt":"snapshot", "finalPrompt":"snapshot", "params":{}, "boxes":[], "status":"ok"
        })).unwrap();
        let files = || {
            (0..2)
                .map(|i| HistoryFileIn {
                    kind: "result".into(),
                    name: format!("result_{i}"),
                    data: crate::gallery::tests::png(),
                })
                .collect()
        };
        let saved = store.save(item, files()).unwrap();
        assert_eq!(saved.result_asset_ids.len(), 2);
        let removed = saved.result_files[0].clone();
        store.gallery.delete(&saved.result_asset_ids[0]).unwrap();
        let saved = store.save(saved, files()).unwrap();
        assert_eq!(saved.prompt, "snapshot");
        assert_eq!(saved.result_files[0], "");
        assert!(!std::path::Path::new(&removed).exists());
        assert!(std::path::Path::new(&saved.result_files[1]).exists());
        assert_eq!(store.gallery.list().unwrap().len(), 1);
        let store = HistoryStore::new(dir.clone()).unwrap();
        assert_eq!(store.list().unwrap()[0].result_files[0], "");
        store.delete("gallery_batch").unwrap();
        assert_eq!(store.gallery.list().unwrap().len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn malformed_index_is_reported_and_traversal_is_rejected() {
        let dir = temp();
        let store = HistoryStore::new(dir.clone()).unwrap();
        std::fs::write(dir.join("index.json"), b"broken").unwrap();
        assert!(store.list().is_err());
        assert!(store.delete("../outside").is_err());
        assert!(store.delete("..").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
