use crate::library::{
    check_roots, db_failed, decode_image_data, invalid, io_failed, make_thumbnail,
    parse_image_data, sanitize_name, store_failed, validate_history_id, validate_id,
    write_original, write_snapshot, LibraryStore,
};
use crate::library_sql;
use crate::provider::GenerationDetails;
use crate::provider::ProviderError;
use rusqlite::params_from_iter;
use rusqlite::types::Value;
use rusqlite::{OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSubmission {
    pub idempotency_key: String,
    pub workspace_version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSubmissionRecord {
    pub idempotency_key: String,
    pub workspace_version: String,
    pub task_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HistoryItem {
    pub id: String,
    pub created_at: u64,
    pub provider: String,
    pub model: String,
    pub mode: String,
    pub prompt: String,
    pub final_prompt: String,
    pub params: serde_json::Value,
    #[serde(default)]
    pub boxes: Vec<serde_json::Value>,
    pub canvas_width: Option<u32>,
    pub canvas_height: Option<u32>,
    pub input_files: Vec<String>,
    pub result_files: Vec<String>,
    #[serde(default)]
    pub result_asset_ids: Vec<String>,
    pub mask_file: Option<String>,
    pub thumbnail_asset_id: Option<String>,
    pub thumb: Option<String>,
    pub result_details: Option<BTreeMap<String, GenerationDetails>>,
    pub usage: Option<serde_json::Value>,
    pub cost: Option<f64>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipe: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_submission: Option<McpSubmission>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationFile {
    pub kind: String,
    pub name: String,
    pub data: String,
}

struct PreparedOutput {
    file: GenerationFile,
    asset_id: String,
    mime: String,
    bytes: Vec<u8>,
    thumbnail: Option<Vec<u8>>,
    width: u32,
    height: u32,
    details: Option<GenerationDetails>,
    /// Whether the file rows (asset + key tombstone) still need inserting.
    fresh: bool,
}

fn active_task() -> String {
    String::from(ProviderError::coded(
        "backend_history_active",
        "Task is queued or running",
    ))
}

pub fn write_data_url(data_url: &str, path: &Path) -> Result<(), String> {
    let (_, payload) = data_url
        .split_once(',')
        .ok_or_else(|| invalid("image data isn't a data url"))?;
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| invalid(e))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| io_failed("create directory", e))?;
    }
    let mut file = fs::File::create(path).map_err(|e| io_failed("save image", e))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| io_failed("save image", e))
}

impl LibraryStore {
    pub fn has_active(&self) -> Result<bool, String> {
        self.conn
            .query_row(library_sql::HISTORY_ACTIVE, [], |r| r.get::<_, i64>(0))
            .map(|n| n > 0)
            .map_err(|e| db_failed("inspect history", e))
    }

    fn resolve_item(&self, mut item: HistoryItem) -> Result<HistoryItem, String> {
        let mut inputs = Vec::with_capacity(item.input_files.len());
        for stored in &item.input_files {
            let path = self.owned_path(stored).ok_or_else(|| {
                invalid(format!("stored input file {stored} is outside the library"))
            })?;
            inputs.push(path.to_string_lossy().into_owned());
        }
        item.input_files = inputs;
        item.mask_file = item
            .mask_file
            .as_ref()
            .map(|stored| {
                self.owned_path(stored)
                    .ok_or_else(|| {
                        invalid(format!("stored mask file {stored} is outside the library"))
                    })
                    .map(|p| p.to_string_lossy().into_owned())
            })
            .transpose()?;
        let mut stmt = self
            .conn
            .prepare(library_sql::HISTORY_OUTPUTS)
            .map_err(|e| db_failed("load outputs", e))?;
        let outputs = stmt
            .query_map([&item.id], |r| r.get::<_, String>(0))
            .map_err(|e| db_failed("load outputs", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| db_failed("load outputs", e))?;
        item.result_asset_ids = outputs;
        let mut resolved = Vec::with_capacity(item.result_asset_ids.len());
        let mut thumbnail_id = None;
        for id in &item.result_asset_ids {
            match self.find_asset(id)? {
                Some(asset) if !asset.pending_delete => {
                    if thumbnail_id.is_none() && asset.has_thumbnail {
                        thumbnail_id = Some(id.clone());
                    }
                    if self.inspect(&asset)?.is_some() {
                        resolved.push(asset.file_path.clone());
                    } else {
                        resolved.push(String::new());
                    }
                }
                _ => resolved.push(String::new()),
            }
        }
        item.result_files = resolved;
        item.thumbnail_asset_id = thumbnail_id;
        Ok(item)
    }

    pub fn history_list(&self) -> Result<Vec<HistoryItem>, String> {
        let mut stmt = self
            .conn
            .prepare(library_sql::HISTORY_ALL)
            .map_err(|e| db_failed("list history", e))?;
        let payloads = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| db_failed("list history", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| db_failed("list history", e))?;
        payloads
            .iter()
            .map(|payload| {
                let item: HistoryItem =
                    serde_json::from_str(payload).map_err(|e| db_failed("parse history", e))?;
                self.resolve_item(item)
            })
            .collect()
    }

    pub fn draft_load(&self) -> Result<Option<serde_json::Value>, String> {
        self.conn
            .query_row(library_sql::LOAD_WORKSPACE, [], |r| r.get::<_, String>(0))
            .optional()
            .map_err(|e| db_failed("load workspace", e))?
            .map(|payload| {
                serde_json::from_str(&payload).map_err(|e| db_failed("parse workspace", e))
            })
            .transpose()
    }

    /// Idempotency ledger lookup used before dispatching an MCP submission.
    /// Independent of history rows so deleting history cannot re-bill a retry.
    pub fn mcp_submission_get(&self, key: &str) -> Result<Option<McpSubmissionRecord>, String> {
        validate_id(key)?;
        self.conn
            .query_row(library_sql::MCP_SUBMISSION_GET, [key], |r| {
                Ok(McpSubmissionRecord {
                    idempotency_key: r.get(0)?,
                    workspace_version: r.get(1)?,
                    task_id: r.get(2)?,
                })
            })
            .optional()
            .map_err(|e| db_failed("load mcp submission", e))
    }

    pub fn draft_save(&self, draft: &serde_json::Value) -> Result<(), String> {
        let payload = serde_json::to_string(draft).map_err(|e| db_failed("encode workspace", e))?;
        self.conn
            .execute(library_sql::SAVE_WORKSPACE, [payload])
            .map(|_| ())
            .map_err(|e| db_failed("save workspace", e))
    }

    pub fn history_progress(
        &self,
        id: &str,
        phase: &str,
        task_id: Option<&str>,
    ) -> Result<(), String> {
        validate_history_id(id)?;
        self.conn
            .execute(
                library_sql::HISTORY_PROGRESS,
                params_from_iter([
                    Value::Text(id.to_string()),
                    Value::Text(phase.to_string()),
                    task_id
                        .map(|t| Value::Text(t.to_string()))
                        .unwrap_or(Value::Null),
                ]),
            )
            .map(|_| ())
            .map_err(|e| db_failed("record progress", e))
    }

    pub fn history_delete(&mut self, id: &str) -> Result<(), String> {
        validate_history_id(id)?;
        let payload: Option<String> = self
            .conn
            .query_row(library_sql::HISTORY_ONE, [id], |r| r.get(0))
            .optional()
            .map_err(|e| db_failed("load history", e))?;
        if let Some(payload) = payload {
            let status = serde_json::from_str::<serde_json::Value>(&payload)
                .ok()
                .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(String::from))
                .unwrap_or_default();
            if matches!(status.as_str(), "queued" | "running") {
                return Err(active_task());
            }
        }
        self.conn
            .execute(library_sql::DELETE_HISTORY, [id])
            .map_err(|e| db_failed("delete history", e))?;
        Ok(())
    }

    pub fn recover_interrupted(&mut self) -> Result<(), String> {
        let mut stmt = self
            .conn
            .prepare(library_sql::HISTORY_RUNNING)
            .map_err(|e| db_failed("inspect history", e))?;
        let payloads = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| db_failed("inspect history", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| db_failed("inspect history", e))?;
        for payload in payloads {
            let mut item: HistoryItem =
                serde_json::from_str(&payload).map_err(|e| db_failed("parse history", e))?;
            item.status = "interrupted".into();
            item.phase = None;
            item.error = Some(String::from(
                ProviderError::coded("backend_task_interrupted", "Task was interrupted")
                    .with_param("detail", "the app closed before the request completed"),
            ));
            if let Some(batch) = &mut item.batch {
                if let Some(requests) = batch.get_mut("requests").and_then(|r| r.as_array_mut()) {
                    for request in requests {
                        match request.get("status").and_then(|s| s.as_str()) {
                            Some("running") => {
                                request["status"] = json!("interrupted");
                                if request.get("error").is_none() || request["error"].is_null() {
                                    request["error"] =
                                        item.error.clone().map_or(serde_json::Value::Null, |e| {
                                            serde_json::Value::String(e)
                                        });
                                }
                            }
                            Some("queued") => {
                                request["status"] = json!("skipped");
                            }
                            _ => {}
                        }
                    }
                }
            }
            let payload =
                serde_json::to_string(&item).map_err(|e| db_failed("encode history", e))?;
            self.conn
                .execute(
                    library_sql::SAVE_HISTORY,
                    params_from_iter([
                        Value::Text(item.id),
                        Value::Integer(item.created_at as i64),
                        Value::Text(item.status),
                        Value::Text(payload),
                    ]),
                )
                .map_err(|e| db_failed("recover history", e))?;
        }
        Ok(())
    }

    fn insert_generated(
        tx: &Transaction<'_>,
        item: &HistoryItem,
        prepared: &PreparedOutput,
    ) -> Result<(), String> {
        if prepared.fresh {
            tx.execute(
                library_sql::INSERT_ASSET,
                params_from_iter([
                    Value::Text(prepared.asset_id.clone()),
                    Value::Text(String::new()),
                    Value::Integer(item.created_at as i64),
                    Value::Integer(prepared.width as i64),
                    Value::Integer(prepared.height as i64),
                    Value::Text(prepared.mime.clone()),
                    Value::Text("generated".into()),
                    Value::Text(item.id.clone()),
                    Value::Text(item.model.clone()),
                    Value::Text(item.provider.clone()),
                    Value::Text(item.prompt.clone()),
                    prepared
                        .details
                        .as_ref()
                        .and_then(|d| serde_json::to_string(d).ok())
                        .map(Value::Text)
                        .unwrap_or(Value::Null),
                    Value::Integer(prepared.bytes.len() as i64),
                    Value::Text(["", &item.prompt, &item.model].join("\n").to_lowercase()),
                    prepared
                        .thumbnail
                        .clone()
                        .map(Value::Blob)
                        .unwrap_or(Value::Null),
                ]),
            )
            .map_err(|e| db_failed("register image", e))?;
            tx.execute(
                library_sql::INSERT_GENERATION_KEY,
                params_from_iter([
                    Value::Text(format!("{}/{}", item.id, prepared.file.name)),
                    Value::Text(prepared.asset_id.clone()),
                ]),
            )
            .map_err(|e| db_failed("register image", e))?;
        }
        tx.execute(
            library_sql::ADD_HISTORY_OUTPUT,
            params_from_iter([
                Value::Text(item.id.clone()),
                Value::Text(prepared.asset_id.clone()),
            ]),
        )
        .map_err(|e| db_failed("record output", e))?;
        Ok(())
    }

    /// Absolute stored paths normalize to root-relative; relative paths must live in this task's snapshot directory.
    fn snapshot_relative(&self, raw: &str, item_id: &str) -> Result<String, String> {
        let path = Path::new(raw);
        if path.is_absolute() {
            return self
                .owned_relative(path)
                .ok_or_else(|| invalid(format!("input file {raw} outside the library")));
        }
        let prefix = format!("images/{item_id}/");
        if !raw.starts_with(&prefix)
            || !Path::new(raw)
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))
        {
            return Err(invalid(format!(
                "input file {raw} outside the task directory"
            )));
        }
        Ok(raw.replace('\\', "/"))
    }

    pub fn history_save(
        &mut self,
        mut item: HistoryItem,
        files: Vec<GenerationFile>,
    ) -> Result<HistoryItem, String> {
        check_roots(self)?;
        validate_history_id(&item.id)?;
        for path in &mut item.input_files {
            *path = self.snapshot_relative(path, &item.id)?;
        }
        if let Some(mask) = &mut item.mask_file {
            *mask = self.snapshot_relative(mask, &item.id)?;
        }
        // Validate every kind and payload before touching the filesystem.
        enum PendingFile {
            Result {
                file: GenerationFile,
                mime: String,
                bytes: Vec<u8>,
                width: u32,
                height: u32,
            },
            Snapshot {
                kind: String,
                safe: String,
                mime: String,
                bytes: Vec<u8>,
            },
        }
        let mut pending: Vec<PendingFile> = Vec::with_capacity(files.len());
        for file in &files {
            if !matches!(file.kind.as_str(), "input" | "result" | "mask") {
                return Err(invalid("invalid file kind"));
            }
            if file.kind == "result" {
                let (mime, bytes, width, height) = decode_image_data(&file.data)?;
                pending.push(PendingFile::Result {
                    file: GenerationFile {
                        kind: file.kind.clone(),
                        name: file.name.clone(),
                        data: String::new(),
                    },
                    mime,
                    bytes,
                    width,
                    height,
                });
            } else {
                let (mime, bytes) = parse_image_data(&file.data)?;
                let safe = sanitize_name(&file.name)?;
                pending.push(PendingFile::Snapshot {
                    kind: file.kind.clone(),
                    safe,
                    mime,
                    bytes,
                });
            }
        }
        let mut created: Vec<PathBuf> = Vec::new();
        let mut outputs: Vec<PreparedOutput> = Vec::new();
        let prepared = (|| -> Result<(), String> {
            for file in pending {
                match file {
                    PendingFile::Result {
                        file,
                        mime,
                        bytes,
                        width,
                        height,
                    } => {
                        let key = format!("{}/{}", item.id, file.name);
                        if let Some(asset_id) = self
                            .conn
                            .query_row(library_sql::GENERATION_KEY, [&key], |r| {
                                r.get::<_, String>(0)
                            })
                            .optional()
                            .map_err(|e| db_failed("check image key", e))?
                        {
                            outputs.push(PreparedOutput {
                                file,
                                asset_id,
                                mime,
                                bytes,
                                thumbnail: None,
                                width,
                                height,
                                details: None,
                                fresh: false,
                            });
                            continue;
                        }
                        let thumbnail = make_thumbnail(&mime, &bytes)?;
                        let asset_id = uuid::Uuid::new_v4().to_string();
                        let path = self.asset_path(&asset_id, &mime);
                        let parent = path.parent().ok_or_else(|| invalid("asset path"))?;
                        fs::create_dir_all(parent)
                            .map_err(|e| io_failed("create asset directory", e))?;
                        self.check_dir_chain(parent)?;
                        write_original(&path, &bytes)?;
                        created.push(self.asset_dir(&asset_id));
                        let details = item
                            .result_details
                            .as_ref()
                            .and_then(|d| d.get(&file.name).cloned());
                        outputs.push(PreparedOutput {
                            file,
                            asset_id,
                            mime,
                            bytes,
                            thumbnail: Some(thumbnail),
                            width,
                            height,
                            details,
                            fresh: true,
                        });
                    }
                    PendingFile::Snapshot {
                        kind,
                        safe,
                        mime,
                        bytes,
                    } => {
                        let rel = format!(
                            "images/{}/{safe}.{}",
                            item.id,
                            crate::library::extension(&mime)
                        );
                        let path = self.root.join(&rel);
                        let parent = path.parent().ok_or_else(|| invalid("asset path"))?;
                        fs::create_dir_all(parent)
                            .map_err(|e| io_failed("create input directory", e))?;
                        self.check_dir_chain(parent)?;
                        if write_snapshot(&path, &bytes)? {
                            created.push(path);
                        }
                        match kind.as_str() {
                            "input" => {
                                if !item.input_files.contains(&rel) {
                                    item.input_files.push(rel);
                                }
                            }
                            "mask" => item.mask_file = Some(rel),
                            _ => {}
                        }
                    }
                }
            }
            Ok(())
        })();
        if let Err(e) = prepared {
            for path in &created {
                if path.is_dir() {
                    let _ = fs::remove_dir_all(path);
                } else {
                    let _ = fs::remove_file(path);
                }
            }
            return Err(e);
        }
        item.result_files = Vec::new();
        item.result_asset_ids = Vec::new();
        item.thumbnail_asset_id = None;
        item.thumb = None;
        let payload = serde_json::to_string(&item).map_err(|e| db_failed("encode history", e))?;
        let saved = (|| -> Result<(), String> {
            let tx = self
                .conn
                .transaction()
                .map_err(|e| db_failed("save history", e))?;
            tx.execute(
                library_sql::SAVE_HISTORY,
                params_from_iter([
                    Value::Text(item.id.clone()),
                    Value::Integer(item.created_at as i64),
                    Value::Text(item.status.clone()),
                    Value::Text(payload),
                ]),
            )
            .map_err(|e| db_failed("save history", e))?;
            if let Some(sub) = &item.mcp_submission {
                if uuid::Uuid::parse_str(&sub.idempotency_key).is_err()
                    || sub.idempotency_key != item.id
                {
                    return Err(invalid("invalid mcp submission key"));
                }
                let existing: Option<(String, String)> = tx
                    .query_row(
                        library_sql::MCP_SUBMISSION_GET,
                        [&sub.idempotency_key],
                        |r| Ok((r.get(1)?, r.get(2)?)),
                    )
                    .optional()
                    .map_err(|e| db_failed("load mcp submission", e))?;
                if let Some((version, task)) = existing {
                    if version != sub.workspace_version || task != item.id {
                        return Err(String::from(ProviderError::coded(
                            "backend_mcp_submission_conflict",
                            "The MCP submission key doesn't match the recorded task",
                        )));
                    }
                }
                tx.execute(
                    library_sql::MCP_SUBMISSION_INSERT,
                    params_from_iter([
                        Value::Text(sub.idempotency_key.clone()),
                        Value::Text(sub.workspace_version.clone()),
                        Value::Text(item.id.clone()),
                    ]),
                )
                .map_err(|e| db_failed("record mcp submission", e))?;
            }
            for output in &outputs {
                Self::insert_generated(&tx, &item, output)?;
            }
            tx.commit().map_err(|e| db_failed("save history", e))
        })();
        if let Err(e) = saved {
            for path in &created {
                if path.is_dir() {
                    let _ = fs::remove_dir_all(path);
                } else {
                    let _ = fs::remove_file(path);
                }
            }
            return Err(e);
        }
        self.history_get(&item.id)
    }

    fn history_get(&self, id: &str) -> Result<HistoryItem, String> {
        self.history_find(id)?
            .ok_or_else(|| store_failed("load history", "record disappeared"))
    }

    pub fn history_find(&self, id: &str) -> Result<Option<HistoryItem>, String> {
        validate_history_id(id)?;
        let payload: Option<String> = self
            .conn
            .query_row(library_sql::HISTORY_ONE, [id], |r| r.get(0))
            .optional()
            .map_err(|e| db_failed("load history", e))?;
        payload
            .map(|payload| {
                let item: HistoryItem =
                    serde_json::from_str(&payload).map_err(|e| db_failed("parse history", e))?;
                self.resolve_item(item)
            })
            .transpose()
    }
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
        let mut store = LibraryStore::new(dir.clone()).unwrap();
        let value = serde_json::json!({
            "resultDetails":{"result_0":{"text":"description","thoughts":"summary","sources":[{"title":"Source","url":"https://example.org/source","kind":"web"}],"searchQueries":["source"],"searchHtml":"<div>Google Search</div>"}},
            "id":"recipe_test", "createdAt":1,"provider":"bfl","model":"flux-3-image","mode":"edit",
            "prompt":"test","finalPrompt":"test","params":{"resolution":"768","grounding":false,"version":"latest"},
            "boxes":[],"canvasWidth":1024,"canvasHeight":768,"status":"ok",
            "recipe":{"schema":2,"baseId":"b","refIds":["a","b"],"refNames":["first","second"],"compressEnabled":false,"maxInputEdge":4096}
        });
        let item: HistoryItem = serde_json::from_value(value).unwrap();
        let saved = store
            .history_save(
                item,
                vec![
                    GenerationFile {
                        kind: "input".into(),
                        name: "input_0".into(),
                        data: "data:image/png;base64,aGVsbG8=".into(),
                    },
                    GenerationFile {
                        kind: "input".into(),
                        name: "input_1".into(),
                        data: "data:image/png;base64,aGVsbG8=".into(),
                    },
                    GenerationFile {
                        kind: "result".into(),
                        name: "result_0".into(),
                        data: crate::gallery::tests::png(),
                    },
                    GenerationFile {
                        kind: "mask".into(),
                        name: "mask".into(),
                        data: "data:image/png;base64,aGVsbG8=".into(),
                    },
                ],
            )
            .unwrap();
        assert_eq!(saved.input_files.len(), 2);
        let listed = store.history_list().unwrap();
        assert_eq!(listed[0].input_files, saved.input_files);
        assert_eq!(
            listed[0].result_details.as_ref().unwrap()["result_0"].sources[0].title,
            "Source"
        );
        let asset_id = &saved.result_asset_ids[0];
        assert_eq!(
            store
                .find_asset(asset_id)
                .unwrap()
                .unwrap()
                .details
                .unwrap()
                .sources[0]
                .url,
            "https://example.org/source"
        );
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
        store.history_delete("recipe_test").unwrap();
        let restarted = LibraryStore::new(dir.clone()).unwrap();
        let details = restarted
            .find_asset(asset_id)
            .unwrap()
            .unwrap()
            .details
            .unwrap();
        assert_eq!(details.text, "description");
        assert_eq!(details.thoughts, "summary");
        assert_eq!(
            details.search_html.as_deref(),
            Some("<div>Google Search</div>")
        );
        assert!(store.history_list().unwrap().is_empty());
        for (path, bytes) in files {
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
        assert!(LibraryStore::new(dir.clone())
            .unwrap()
            .history_list()
            .unwrap()
            .is_empty());
        drop(store);
        drop(restarted);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn task_updates_preserve_paths_and_restart_does_not_resubmit_running_work() {
        let dir = temp();
        let mut store = LibraryStore::new(dir.clone()).unwrap();
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
            .history_save(
                item,
                vec![GenerationFile {
                    kind: "input".into(),
                    name: "input_0".into(),
                    data: "data:image/png;base64,aGVsbG8=".into(),
                }],
            )
            .unwrap();
        assert!(store.history_delete(&saved.id).is_err());
        let original_paths = saved.input_files.clone();
        saved.status = "running".into();
        store.history_save(saved, vec![]).unwrap();
        store
            .history_progress("queued_task", "waiting", Some("remote-task"))
            .unwrap();
        drop(store);
        let restored = LibraryStore::new(dir.clone())
            .unwrap()
            .history_list()
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
        let mut store = LibraryStore::new(dir.clone()).unwrap();
        let item: HistoryItem = serde_json::from_value(serde_json::json!({
            "id":"gallery_batch", "createdAt":1, "provider":"google", "model":"gemini-nano-banana-2.1",
            "mode":"t2i", "prompt":"snapshot", "finalPrompt":"snapshot", "params":{}, "boxes":[], "status":"ok"
        })).unwrap();
        let files = || {
            (0..2)
                .map(|i| GenerationFile {
                    kind: "result".into(),
                    name: format!("result_{i}"),
                    data: crate::gallery::tests::png(),
                })
                .collect()
        };
        let saved = store.history_save(item, files()).unwrap();
        assert_eq!(saved.result_asset_ids.len(), 2);
        let removed = saved.result_files[0].clone();
        store
            .gallery_delete(&[saved.result_asset_ids[0].clone()])
            .unwrap();
        let saved = store.history_save(saved, files()).unwrap();
        assert_eq!(saved.prompt, "snapshot");
        assert_eq!(saved.result_files[0], "");
        assert!(!std::path::Path::new(&removed).exists());
        assert!(std::path::Path::new(&saved.result_files[1]).exists());
        assert_eq!(
            store
                .gallery_query(crate::gallery::GalleryQuery::default())
                .unwrap()
                .total,
            1
        );
        drop(store);
        let mut store = LibraryStore::new(dir.clone()).unwrap();
        assert_eq!(store.history_list().unwrap()[0].result_files[0], "");
        store.history_delete("gallery_batch").unwrap();
        assert_eq!(
            store
                .gallery_query(crate::gallery::GalleryQuery::default())
                .unwrap()
                .total,
            1
        );
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn mcp_ledger_survives_history_deletion_and_rejects_version_mismatch() {
        let dir = temp();
        let key = uuid::Uuid::new_v4().to_string();
        let mut store = LibraryStore::new(dir.clone()).unwrap();
        let item: HistoryItem = serde_json::from_value(serde_json::json!({
            "id": key, "createdAt":1, "provider":"bfl", "model":"flux-3-image",
            "mode":"t2i", "prompt":"p", "finalPrompt":"p", "params":{}, "boxes":[],
            "status":"queued",
            "mcpSubmission":{"idempotencyKey": key, "workspaceVersion":"ws-1"}
        }))
        .unwrap();
        let mut saved = store
            .history_save(
                item,
                vec![GenerationFile {
                    kind: "input".into(),
                    name: "input_0".into(),
                    data: "data:image/png;base64,aGVsbG8=".into(),
                }],
            )
            .unwrap();
        assert_eq!(
            saved.mcp_submission.as_ref().unwrap().workspace_version,
            "ws-1"
        );
        saved.status = "ok".into();
        store.history_save(saved, vec![]).unwrap();
        store.history_delete(&key).unwrap();
        drop(store);
        let mut reopened = LibraryStore::new(dir.clone()).unwrap();
        let record = reopened.mcp_submission_get(&key).unwrap().unwrap();
        assert_eq!(record.idempotency_key, key);
        assert_eq!(record.workspace_version, "ws-1");
        assert_eq!(record.task_id, key);
        // An actual retry with a mismatched workspace version must fail
        // before any provider call and leave the original record intact.
        let conflicting: HistoryItem = serde_json::from_value(serde_json::json!({
            "id": key, "createdAt":2, "provider":"bfl", "model":"flux-3-image",
            "mode":"t2i", "prompt":"p", "finalPrompt":"p", "params":{}, "boxes":[],
            "status":"queued",
            "mcpSubmission":{"idempotencyKey": key, "workspaceVersion":"ws-2"}
        }))
        .unwrap();
        assert!(reopened.history_save(conflicting, vec![]).is_err());
        let unchanged = reopened.mcp_submission_get(&key).unwrap().unwrap();
        assert_eq!(unchanged.workspace_version, "ws-1");
        assert_eq!(unchanged.task_id, key);
        assert!(reopened.history_find(&key).unwrap().is_none());
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_database_is_reported_and_traversal_is_rejected() {
        let dir = temp();
        let mut store = LibraryStore::new(dir.clone()).unwrap();
        assert!(store.history_delete("../outside").is_err());
        assert!(store.history_delete("..").is_err());
        drop(store);
        std::fs::write(dir.join(crate::library::DB_FILE), vec![b'x'; 1024]).unwrap();
        assert!(LibraryStore::new(dir.clone()).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
