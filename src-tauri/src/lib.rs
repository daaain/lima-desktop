pub mod collector;
pub mod commands;
pub mod journal;
pub mod lima;
pub mod marker;
pub mod oom;
pub mod podman;
pub mod probe;
pub mod store;

use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;

/// Overrides where the app keeps its data (the metrics history): a replay or a test run sets it so
/// the real history is never written to.
const DATA_DIR_ENV: &str = "LD_DATA_DIR";

fn data_dir(app: &tauri::App) -> tauri::Result<PathBuf> {
    match std::env::var_os(DATA_DIR_ENV).filter(|d| !d.is_empty()) {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => app.path().app_data_dir(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = data_dir(app)?;
            std::fs::create_dir_all(&dir)?;
            let path = dir.join("metrics.db");
            log::info!("metrics history in {}", path.display());
            let store = store::Store::open(&path)?;
            let collector = collector::Collector::new(store, collector::Retention::default());
            collector.start();
            app.manage(collector);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event
                && let Some(c) = window.try_state::<Arc<collector::Collector>>()
            {
                c.flush_now();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::snapshot,
            commands::vm_action,
            commands::vm_resize,
            commands::container_action,
            commands::container_logs,
            commands::container_inspect,
            commands::images,
            commands::image_remove,
            commands::images_prune,
            commands::volumes,
            commands::volume_remove,
            commands::volumes_prune,
            commands::system_df,
            commands::series,
            commands::summary,
            commands::entities,
            commands::oom_events,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
