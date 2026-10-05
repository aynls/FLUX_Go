//! 本地生成历史：图片文件 + index.json 元数据，存于应用数据目录。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
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
}

impl HistoryStore {
    pub fn new(dir: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir.join("images"))?;
        Ok(Self { dir })
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
    fn absolutize(&self, mut item: HistoryItem) -> HistoryItem {
        item.input_files = item
            .input_files
            .iter()
            .map(|p| self.dir.join(p).to_string_lossy().to_string())
            .collect();
        item.result_files = item
            .result_files
            .iter()
            .map(|p| self.dir.join(p).to_string_lossy().to_string())
            .collect();
        item
    }

    pub fn save(
        &self,
        mut item: HistoryItem,
        files: Vec<HistoryFileIn>,
    ) -> Result<HistoryItem, String> {
        validate_id(&item.id)?;
        if item.id.trim().is_empty() {
            return Err("历史条目缺少 id".into());
        }
        let img_dir = self.dir.join("images").join(&item.id);
        std::fs::create_dir_all(&img_dir).map_err(|e| format!("创建历史目录失败: {e}"))?;
        for f in files {
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
                "input" => item.input_files.push(rel),
                "result" => item.result_files.push(rel),
                _ => return Err(format!("未知历史文件类型: {}", f.kind)),
            }
        }
        let mut items = self.read_index()?;
        items.retain(|it| it.id != item.id);
        items.push(item.clone());
        self.write_index(&items)?;
        Ok(self.absolutize(item))
    }

    pub fn list(&self) -> Result<Vec<HistoryItem>, String> {
        let mut items = self.read_index()?;
        items.sort_by_key(|a| std::cmp::Reverse(a.created_at));
        Ok(items.into_iter().map(|it| self.absolutize(it)).collect())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        let mut items = self.read_index()?;
        items.retain(|it| it.id != id);
        self.write_index(&items)?;
        let dir = self.dir.join("images").join(id);
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("删除历史图片失败: {e}"))?;
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
            "flux-history-test-{}-{}-{}",
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
        store.delete("recipe_test").unwrap();
        assert!(store.list().unwrap().is_empty());
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
