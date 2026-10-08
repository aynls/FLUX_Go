mod commands;
mod gallery;
mod history;
pub mod models;
pub mod provider;

use std::sync::Mutex;

use tauri::Manager;

pub struct AppState {
    pub history: Mutex<Option<history::HistoryStore>>,
    pub draft_lock: Mutex<()>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            history: Mutex::new(None),
            draft_lock: Mutex::new(()),
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::default()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(AppState::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?.join("workbench");
            let store = history::HistoryStore::new(dir.clone())
                .map_err(|e| format!("Couldn't initialize history storage: {e}"))?;
            // Register the existing, resolved image roots before the WebView reads assets.
            // Keep credentials, drafts and metadata outside the asset protocol scope.
            let assets = app.asset_protocol_scope();
            assets.allow_directory(dir.join("images"), true)?;
            assets.allow_directory(dir.join("gallery/images"), true)?;
            provider::init_key_settings(&app.path().app_data_dir()?)?;
            *app.state::<AppState>().history.lock().unwrap() = Some(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::provider_status,
            commands::credential_save,
            commands::credential_remove,
            commands::credential_check,
            commands::credential_configure,
            commands::draft_load,
            commands::draft_save,
            commands::import_url,
            commands::clipboard_image,
            commands::copy_image,
            commands::history_storage,
            commands::generate,
            commands::import_image,
            commands::save_data_url,
            commands::history_list,
            commands::history_save,
            commands::history_delete,
            commands::gallery_list,
            commands::gallery_import,
            commands::gallery_read,
            commands::gallery_delete,
        ])
        .run(tauri::generate_context!())
        .expect("LutriUI failed to start");
}
