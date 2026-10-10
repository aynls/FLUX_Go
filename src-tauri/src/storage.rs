use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use tauri::Manager;

use crate::provider::{io_failed, ProviderError};

fn coded(code: &str, message: impl Into<String>) -> ProviderError {
    ProviderError::coded(code, message)
}

const WORKBENCH_DIR: &str = "workbench";
const LOCATION_FILE: &str = "library-location.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryLocation {
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMigration {
    pub previous_path: String,
    pub path: String,
}

pub fn location_path(app_data: &Path) -> PathBuf {
    app_data.join(LOCATION_FILE)
}

pub fn default_root(app_data: &Path) -> PathBuf {
    app_data.join(WORKBENCH_DIR)
}

pub fn resolve_root(app_data: &Path) -> Result<PathBuf, String> {
    let config = location_path(app_data);
    let raw = match std::fs::read(&config) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(default_root(app_data));
        }
        Err(e) => {
            return Err(coded(
                "backend_library_unavailable",
                format!("Couldn't read the library location: {e}"),
            )
            .with_param("path", config.to_string_lossy().to_string())
            .with_param("detail", e.to_string())
            .into())
        }
    };
    let saved: LibraryLocation = serde_json::from_slice(&raw).map_err(|e| {
        coded(
            "backend_library_unavailable",
            format!("The library location setting is corrupt: {e}"),
        )
        .with_param("path", config.to_string_lossy().to_string())
        .with_param("detail", e.to_string())
    })?;
    let root = PathBuf::from(&saved.path);
    if !root.is_absolute() || !root.is_dir() {
        return Err(coded(
            "backend_library_unavailable",
            format!(
                "The configured library folder isn't available: {}",
                saved.path
            ),
        )
        .with_param("path", saved.path)
        .into());
    }
    Ok(root)
}

pub fn save_location(app_data: &Path, root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(app_data).map_err(|e| {
        coded(
            "backend_library_config_failed",
            format!("Couldn't save the new library location: {e}"),
        )
        .with_param("detail", e.to_string())
    })?;
    let config = location_path(app_data);
    let body = serde_json::to_vec_pretty(&LibraryLocation {
        path: root.to_string_lossy().to_string(),
    })
    .map_err(io_failed)?;
    let failed = |e: std::io::Error| {
        coded(
            "backend_library_config_failed",
            format!("Couldn't save the new library location: {e}"),
        )
        .with_param("detail", e.to_string())
    };
    let tmp = config.with_extension("json.tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)
        .map_err(failed)?;
    file.write_all(&body).map_err(failed)?;
    file.sync_all().map_err(failed)?;
    drop(file);
    std::fs::rename(&tmp, &config).map_err(failed)?;
    Ok(())
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    let resolved = std::fs::canonicalize(path).map_err(io_failed)?;
    Ok(simplify(resolved))
}

#[cfg(windows)]
fn simplify(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.starts_with(r"UNC\") => PathBuf::from(format!(r"\\{}", &rest[4..])),
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

#[cfg(not(windows))]
fn simplify(path: PathBuf) -> PathBuf {
    path
}

fn normalized(path: &Path) -> String {
    let text = path.to_string_lossy();
    #[cfg(windows)]
    let text = text.replace('\\', "/").to_lowercase();
    text.trim_end_matches('/').to_string()
}

fn same_path(a: &Path, b: &Path) -> bool {
    normalized(a) == normalized(b)
}

fn is_prefix_of(prefix: &Path, path: &Path) -> bool {
    normalized(path).starts_with(&format!("{}/", normalized(prefix)))
}

#[derive(Default)]
struct GateState {
    operations: usize,
    generations: usize,
    migrating: bool,
}

struct Shared {
    state: Mutex<GateState>,
    released: Condvar,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, GateState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[derive(Clone)]
pub struct StorageGate {
    shared: Arc<Shared>,
}

impl Default for StorageGate {
    fn default() -> Self {
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(GateState::default()),
                released: Condvar::new(),
            }),
        }
    }
}

pub struct OperationGuard {
    shared: Arc<Shared>,
}

pub struct GenerationGuard {
    shared: Arc<Shared>,
}

pub struct MigrationGuard {
    shared: Arc<Shared>,
}

impl StorageGate {
    fn shared(&self) -> Arc<Shared> {
        self.shared.clone()
    }

    fn migrating_error() -> String {
        coded(
            "backend_storage_migrating",
            "Storage is moving to a new folder. Try again in a moment",
        )
        .into()
    }

    pub fn operation(&self) -> Result<OperationGuard, String> {
        let shared = self.shared();
        let mut state = shared.lock();
        if state.migrating {
            return Err(Self::migrating_error());
        }
        state.operations += 1;
        drop(state);
        Ok(OperationGuard { shared })
    }

    pub fn generation(&self) -> Result<GenerationGuard, String> {
        let shared = self.shared();
        let mut state = shared.lock();
        if state.migrating {
            return Err(Self::migrating_error());
        }
        state.generations += 1;
        drop(state);
        Ok(GenerationGuard { shared })
    }

    pub fn migrate(&self) -> Result<MigrationGuard, String> {
        let shared = self.shared();
        let mut state = shared.lock();
        if state.migrating || state.generations > 0 {
            return Err(coded(
                "backend_library_busy",
                "Wait for running tasks to finish before moving the library",
            )
            .into());
        }
        state.migrating = true;
        while state.operations > 0 {
            state = shared
                .released
                .wait(state)
                .unwrap_or_else(|e| e.into_inner());
        }
        drop(state);
        Ok(MigrationGuard { shared })
    }
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        let mut state = self.shared.lock();
        state.operations -= 1;
        self.shared.released.notify_all();
    }
}

impl Drop for GenerationGuard {
    fn drop(&mut self) {
        let mut state = self.shared.lock();
        state.generations -= 1;
        self.shared.released.notify_all();
    }
}

impl Drop for MigrationGuard {
    fn drop(&mut self) {
        let mut state = self.shared.lock();
        state.migrating = false;
        self.shared.released.notify_all();
    }
}

enum Target {
    Same,
    Empty(PathBuf),
}

fn canonical_for(path: &Path) -> Result<PathBuf, String> {
    let mut missing = Vec::new();
    let mut cursor = path;
    while !cursor.exists() {
        let invalid = || {
            coded(
                "backend_library_target",
                "Choose an absolute folder for the library",
            )
            .with_param("detail", path.to_string_lossy().to_string())
        };
        missing.push(cursor.file_name().ok_or_else(|| String::from(invalid()))?);
        cursor = cursor.parent().ok_or_else(|| String::from(invalid()))?;
    }
    let mut base = canonical(cursor)?;
    for name in missing.iter().rev() {
        base.push(name);
    }
    Ok(base)
}

fn prepare_target(source: &Path, target: &Path) -> Result<Target, String> {
    if !target.is_absolute() {
        return Err(coded(
            "backend_library_target",
            "Choose an absolute folder for the library",
        )
        .with_param("detail", target.to_string_lossy().to_string())
        .into());
    }
    let exists = match std::fs::symlink_metadata(target) {
        Ok(meta) => {
            if !meta.is_dir() || is_link(&meta) {
                return Err(coded(
                    "backend_library_target",
                    "The selected library folder isn't a plain directory",
                )
                .with_param("detail", target.to_string_lossy().to_string())
                .into());
            }
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => {
            return Err(coded(
                "backend_library_target",
                format!("Couldn't inspect the selected folder: {e}"),
            )
            .with_param("detail", e.to_string())
            .into())
        }
    };
    let prospective = canonical_for(target)?;
    let source = canonical(source)?;
    if same_path(&source, &prospective) {
        return Ok(Target::Same);
    }
    if is_prefix_of(&source, &prospective) || is_prefix_of(&prospective, &source) {
        return Err(coded(
            "backend_library_nested",
            "The new folder can't be inside the current library or contain it",
        )
        .into());
    }
    if exists {
        if std::fs::read_dir(target)
            .map_err(io_failed)?
            .next()
            .is_some()
        {
            return Err(coded(
                "backend_library_not_empty",
                "The selected folder isn't empty. Choose an empty folder",
            )
            .into());
        }
    } else {
        std::fs::create_dir_all(target).map_err(|e| {
            coded(
                "backend_library_target",
                format!("Couldn't create the selected folder: {e}"),
            )
            .with_param("detail", e.to_string())
        })?;
    }
    Ok(Target::Empty(canonical(target)?))
}

#[cfg(windows)]
fn is_link(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_link(meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

const COPY_CHUNK: usize = 1024 * 1024;

fn copy_failed(e: impl std::fmt::Display) -> String {
    coded(
        "backend_library_copy_failed",
        format!("Copying the library failed: {e}"),
    )
    .with_param("detail", e.to_string())
    .into()
}

fn copy_file(source: &Path, target: &Path) -> Result<(), String> {
    let mut input = std::fs::File::open(source).map_err(copy_failed)?;
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(copy_failed)?;
    let mut buffer = vec![0u8; COPY_CHUNK];
    loop {
        let read = input.read(&mut buffer).map_err(copy_failed)?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read]).map_err(copy_failed)?;
    }
    output.sync_all().map_err(copy_failed)?;
    drop(output);
    verify_file(source, target)
}

fn fill(reader: &mut impl Read, buffer: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}

fn verify_file(source: &Path, target: &Path) -> Result<(), String> {
    let mut a = std::fs::File::open(source).map_err(copy_failed)?;
    let mut b = std::fs::File::open(target).map_err(copy_failed)?;
    let mut left = vec![0u8; COPY_CHUNK];
    let mut right = vec![0u8; COPY_CHUNK];
    loop {
        let an = fill(&mut a, &mut left).map_err(copy_failed)?;
        let bn = fill(&mut b, &mut right).map_err(copy_failed)?;
        if an != bn || left[..an] != right[..bn] {
            return Err(coded(
                "backend_library_verify_failed",
                "A copied file didn't match the original",
            )
            .with_param("path", source.to_string_lossy().to_string())
            .into());
        }
        if an == 0 {
            return Ok(());
        }
    }
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(source).map_err(io_failed)? {
        let entry = entry.map_err(io_failed)?;
        let meta = entry.metadata().map_err(io_failed)?;
        let name = entry.file_name();
        let dest = target.join(&name);
        if is_link(&meta) {
            return Err(coded(
                "backend_library_link",
                "The library contains a link that can't be copied",
            )
            .with_param("path", entry.path().to_string_lossy().to_string())
            .into());
        }
        if meta.is_dir() {
            std::fs::create_dir(&dest).map_err(copy_failed)?;
            copy_tree(&entry.path(), &dest)?;
        } else if meta.is_file() {
            copy_file(&entry.path(), &dest)?;
        } else {
            return Err(coded(
                "backend_library_link",
                "The library contains an entry that can't be copied",
            )
            .with_param("path", entry.path().to_string_lossy().to_string())
            .into());
        }
    }
    Ok(())
}

pub fn relocate(source: &Path, target: &Path) -> Result<Option<PathBuf>, String> {
    match prepare_target(source, target)? {
        Target::Same => Ok(None),
        Target::Empty(canonical) => {
            copy_tree(source, &canonical)?;
            Ok(Some(canonical))
        }
    }
}

fn active_root(state: &tauri::State<'_, crate::AppState>) -> Result<PathBuf, String> {
    state
        .history
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|store| store.dir().to_path_buf())
        .ok_or_else(|| {
            String::from(coded(
                "backend_history_uninitialized",
                "History storage isn't initialized",
            ))
        })
}

pub fn ensure_migratable(store: &crate::history::HistoryStore) -> Result<(), String> {
    if store.has_active()? {
        return Err(coded(
            "backend_library_tasks",
            "Wait for queued or running records to finish before moving the library",
        )
        .into());
    }
    Ok(())
}

pub fn migrate(app: &tauri::AppHandle, target: &Path) -> Result<LibraryMigration, String> {
    let state = app.state::<crate::AppState>();
    let _migration = state.gate.migrate()?;
    let previous = active_root(&state)?;
    let canonical_target = match prepare_target(&previous, target)? {
        Target::Same => {
            let path = previous.to_string_lossy().to_string();
            return Ok(LibraryMigration {
                previous_path: path.clone(),
                path,
            });
        }
        Target::Empty(canonical) => canonical,
    };
    {
        let guard = state.history.lock().unwrap_or_else(|e| e.into_inner());
        let store = guard.as_ref().ok_or_else(|| {
            String::from(coded(
                "backend_history_uninitialized",
                "History storage isn't initialized",
            ))
        })?;
        ensure_migratable(store)?;
    }
    copy_tree(&previous, &canonical_target)?;
    fn migrate_failed(e: impl std::fmt::Display) -> String {
        coded(
            "backend_library_failed",
            format!("Couldn't move the library: {e}"),
        )
        .with_param("detail", e.to_string())
        .into()
    }
    let store =
        crate::history::HistoryStore::new(canonical_target.clone()).map_err(migrate_failed)?;
    let assets = app.asset_protocol_scope();
    assets
        .allow_directory(canonical_target.join("images"), true)
        .map_err(migrate_failed)?;
    assets
        .allow_directory(canonical_target.join("gallery/images"), true)
        .map_err(migrate_failed)?;
    let app_data = app.path().app_data_dir().map_err(io_failed)?;
    save_location(&app_data, &canonical_target)?;
    *state.history.lock().unwrap_or_else(|e| e.into_inner()) = Some(store);
    Ok(LibraryMigration {
        previous_path: previous.to_string_lossy().to_string(),
        path: canonical_target.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "lutriui-storage-test-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn item(status: &str) -> crate::history::HistoryItem {
        serde_json::from_value(serde_json::json!({
            "id":"task_a", "createdAt":1, "provider":"bfl", "model":"flux-3-image",
            "mode":"edit", "prompt":"p", "finalPrompt":"p", "params":{}, "boxes":[],
            "status":status
        }))
        .unwrap()
    }

    fn files() -> Vec<crate::history::HistoryFileIn> {
        vec![
            crate::history::HistoryFileIn {
                kind: "input".into(),
                name: "input_0".into(),
                data: "data:image/png;base64,aGVsbG8=".into(),
            },
            crate::history::HistoryFileIn {
                kind: "result".into(),
                name: "result_0".into(),
                data: crate::gallery::tests::png(),
            },
            crate::history::HistoryFileIn {
                kind: "mask".into(),
                name: "mask".into(),
                data: "data:image/png;base64,aGVsbG8=".into(),
            },
        ]
    }

    fn bytes_of(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let rel = path
                .strip_prefix(dir)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if path.is_dir() {
                for (name, bytes) in bytes_of(&path) {
                    out.push((format!("{rel}/{name}"), bytes));
                }
            } else {
                out.push((rel, std::fs::read(&path).unwrap()));
            }
        }
        out.sort();
        out
    }

    fn seed_library(source: &Path) -> crate::history::HistoryStore {
        let store = crate::history::HistoryStore::new(source.to_path_buf()).unwrap();
        store.save(item("ok"), files()).unwrap();
        std::fs::write(source.join("session.json"), b"{\"schema\":2}").unwrap();
        let bulk: Vec<u8> = (0..2_500_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(source.join("images/blob.bin"), &bulk).unwrap();
        store
    }

    #[test]
    fn resolve_root_defaults_and_uses_saved_location() {
        let app_data = temp();
        assert_eq!(resolve_root(&app_data).unwrap(), default_root(&app_data));
        let custom = temp();
        std::fs::create_dir_all(&custom).unwrap();
        save_location(&app_data, &custom).unwrap();
        assert_eq!(resolve_root(&app_data).unwrap(), custom);
        std::fs::remove_dir_all(&custom).unwrap();
        assert!(resolve_root(&app_data).is_err());
        assert!(!custom.exists());
        std::fs::remove_dir_all(&app_data).unwrap();
    }

    #[test]
    fn resolve_root_rejects_corrupt_and_relative_config() {
        let app_data = temp();
        std::fs::create_dir_all(&app_data).unwrap();
        std::fs::write(location_path(&app_data), b"not json").unwrap();
        assert!(resolve_root(&app_data).is_err());
        std::fs::write(location_path(&app_data), b"{\"path\":\"relative/dir\"}").unwrap();
        assert!(resolve_root(&app_data).is_err());
        std::fs::remove_dir_all(&app_data).unwrap();
    }

    #[test]
    fn save_location_failure_keeps_previous_config() {
        let app_data = temp();
        let first = temp();
        std::fs::create_dir_all(&first).unwrap();
        save_location(&app_data, &first).unwrap();
        let second = temp();
        std::fs::create_dir_all(&second).unwrap();
        let original = std::fs::read(location_path(&app_data)).unwrap();
        std::fs::create_dir(app_data.join("library-location.json.tmp")).unwrap();
        assert!(save_location(&app_data, &second).is_err());
        assert_eq!(std::fs::read(location_path(&app_data)).unwrap(), original);
        assert_eq!(resolve_root(&app_data).unwrap(), first);
        std::fs::remove_dir_all(&app_data).unwrap();
        std::fs::remove_dir_all(&first).unwrap();
        std::fs::remove_dir_all(&second).unwrap();
    }

    #[test]
    fn gate_waits_for_operations_and_rejects_during_migration() {
        let gate = StorageGate::default();
        let operation = gate.operation().unwrap();
        let worker = {
            let gate = gate.clone();
            std::thread::spawn(move || gate.migrate().unwrap())
        };
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(gate.operation().is_err());
        drop(operation);
        let migration = worker.join().unwrap();
        assert!(gate.operation().is_err());
        assert!(gate.migrate().is_err());
        drop(migration);
        drop(gate.operation().unwrap());
    }

    #[test]
    fn gate_rejects_migration_while_generation_active_and_recovers() {
        let gate = StorageGate::default();
        let generation = gate.generation().unwrap();
        assert!(gate.migrate().is_err());
        drop(generation);
        let migration = gate.migrate().unwrap();
        assert!(gate.generation().is_err());
        drop(migration);
        drop(gate.operation().unwrap());
        drop(gate.generation().unwrap());
    }

    #[test]
    fn relocate_copies_everything_and_rebases_listed_paths() {
        let source = temp();
        let store = seed_library(&source);
        let listed = store.list().unwrap().remove(0);
        let assets = store.gallery.list().unwrap();
        let target = temp().join("new-library");
        let canonical = relocate(&source, &target).unwrap().unwrap();
        assert!(canonical.is_absolute());
        assert_eq!(bytes_of(&source), bytes_of(&canonical));
        assert!(source.join("session.json").exists());
        assert!(source.join("index.json").exists());
        let moved = crate::history::HistoryStore::new(canonical.clone()).unwrap();
        let relisted = moved.list().unwrap().remove(0);
        assert_eq!(relisted.id, listed.id);
        assert_eq!(relisted.result_asset_ids, listed.result_asset_ids);
        let rebased: Vec<String> = relisted
            .input_files
            .iter()
            .chain(relisted.result_files.iter())
            .chain(relisted.thumb_file.iter())
            .chain(relisted.mask_file.iter())
            .cloned()
            .collect();
        for path in &rebased {
            assert!(path.starts_with(&canonical.to_string_lossy().to_string()));
            assert!(Path::new(path).is_file());
        }
        let moved_assets = moved.gallery.list().unwrap();
        assert_eq!(
            moved_assets
                .iter()
                .map(|a| a.id.clone())
                .collect::<Vec<_>>(),
            assets.iter().map(|a| a.id.clone()).collect::<Vec<_>>()
        );
        let mut extra = item("ok");
        extra.id = "task_b".into();
        moved.save(extra, vec![]).unwrap();
        assert!(canonical.join("index.json").exists());
        let source_index = std::fs::read_to_string(source.join("index.json")).unwrap();
        assert!(!source_index.contains("task_b"));
        std::fs::remove_dir_all(&source).unwrap();
        std::fs::remove_dir_all(&canonical).unwrap();
    }

    #[test]
    fn relocate_same_root_is_noop_and_rejects_bad_targets() {
        let source = temp();
        seed_library(&source);
        let source_canonical = canonical(&source).unwrap();
        assert_eq!(relocate(&source, &source).unwrap(), None);
        assert_eq!(relocate(&source, &source_canonical).unwrap(), None);
        let file = temp();
        std::fs::write(&file, b"x").unwrap();
        assert!(relocate(&source, &file).is_err());
        let occupied = temp();
        std::fs::create_dir_all(&occupied).unwrap();
        std::fs::write(occupied.join("keep.txt"), b"x").unwrap();
        assert!(relocate(&source, &occupied).is_err());
        assert_eq!(std::fs::read(occupied.join("keep.txt")).unwrap(), b"x");
        assert!(relocate(&source, &source.join("child")).is_err());
        assert!(!source.join("child").exists());
        let parent = source.parent().unwrap().to_path_buf();
        assert!(relocate(&source, &parent).is_err());
        assert!(relocate(&source, Path::new("relative-target")).is_err());
        assert!(source.join("index.json").exists());
        std::fs::remove_dir_all(&source).unwrap();
        std::fs::remove_dir_all(&occupied).unwrap();
        std::fs::remove_file(&file).unwrap();
    }

    #[cfg(windows)]
    fn make_link(link: &Path, target: &Path) -> bool {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return true;
        }
        std::process::Command::new("pwsh")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "New-Item -ItemType Junction -Path $env:LUTRIUI_TEST_LINK -Target $env:LUTRIUI_TEST_TARGET -ErrorAction Stop | Out-Null",
            ])
            .env("LUTRIUI_TEST_LINK", link)
            .env("LUTRIUI_TEST_TARGET", target)
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }

    #[cfg(not(windows))]
    fn make_link(link: &Path, target: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    #[test]
    fn relocate_rejects_link_entries_and_keeps_source() {
        let source = temp();
        seed_library(&source);
        let outside = temp();
        std::fs::create_dir_all(&outside).unwrap();
        let link = source.join("linked");
        if !make_link(&link, &outside) {
            eprintln!("skipping link test: cannot create reparse point");
            std::fs::remove_dir_all(&source).unwrap();
            std::fs::remove_dir_all(&outside).unwrap();
            return;
        }
        let target = temp().join("target");
        let error = relocate(&source, &target).unwrap_err();
        assert!(error.contains("backend_library_link"));
        assert!(target.exists());
        assert!(source.join("index.json").exists());
        assert!(source.join("session.json").exists());
        assert!(!outside.join("index.json").exists());
        std::fs::remove_dir_all(&source).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
        std::fs::remove_dir_all(&target).unwrap();
    }

    #[test]
    fn ensure_migratable_rejects_queued_and_running_records() {
        let source = temp();
        let store = crate::history::HistoryStore::new(source.clone()).unwrap();
        assert!(ensure_migratable(&store).is_ok());
        store.save(item("queued"), vec![]).unwrap();
        let error = ensure_migratable(&store).unwrap_err();
        assert!(error.contains("backend_library_tasks"));
        store.save(item("ok"), vec![]).unwrap();
        assert!(ensure_migratable(&store).is_ok());
        std::fs::remove_dir_all(&source).unwrap();
    }
}
