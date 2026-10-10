//! Shared library access for Tauri commands and the native side of the MCP
//! server. Both entry points serialize through the same migration gate and
//! blocking-pool execution.

use tauri::Manager;

use crate::library::LibraryStore;
use crate::provider::ProviderError;
use crate::AppState;

fn uninitialized() -> String {
    String::from(ProviderError::coded(
        "backend_history_uninitialized",
        "History storage isn't initialized",
    ))
}

/// Serialize library work and gate it against migration. The closure runs on
/// the blocking pool, so callers can perform filesystem and SQLite work.
pub async fn with_library<T: Send + 'static>(
    app: tauri::AppHandle,
    f: impl FnOnce(&mut LibraryStore) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _operation = state.gate.operation()?;
        let mut guard = state.library.lock().unwrap_or_else(|e| e.into_inner());
        let store = guard.as_mut().ok_or_else(uninitialized)?;
        f(store)
    })
    .await
    .map_err(|e| {
        String::from(
            ProviderError::coded(
                "backend_library_failed",
                format!("Library task failed: {e}"),
            )
            .with_param("detail", e.to_string()),
        )
    })?
}
