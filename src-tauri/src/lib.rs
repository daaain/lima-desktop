pub mod collector;
pub mod commands;
pub mod lima;
pub mod marker;
pub mod podman;
pub mod probe;
pub mod store;

use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
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
            commands::system_df,
            commands::series,
            commands::summary,
            commands::entities,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
