pub mod collector;
pub mod commands;
pub mod guest_files;
pub mod journal;
pub mod lima;
pub mod marker;
pub mod oom;
pub mod podman;
pub mod probe;
pub mod settings;
pub mod store;

use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;

/// Overrides where the app keeps its data (the metrics history, the settings): a replay or a test
/// run sets it so the real ones are never written to.
const DATA_DIR_ENV: &str = "LD_DATA_DIR";

fn data_dir(app: &tauri::App) -> tauri::Result<PathBuf> {
    match std::env::var_os(DATA_DIR_ENV).filter(|d| !d.is_empty()) {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => app.path().app_data_dir(),
    }
}

/// A debug build (`pnpm tauri dev`) is another app to the system: its own identifier, so its own
/// data directory (history, settings) and remembered window, and "(dev)" in its title. It can run
/// beside the installed app without either writing over the other's history.
fn dev_apart(ctx: &mut tauri::Context) {
    if cfg!(debug_assertions) {
        let config = ctx.config_mut();
        config.identifier.push_str(".dev");
        for w in &mut config.app.windows {
            w.title.push_str(" (dev)");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut ctx = tauri::generate_context!();
    dev_apart(&mut ctx);
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Remembers the window's size and place between runs (saved as it closes).
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let dir = data_dir(app)?;
            std::fs::create_dir_all(&dir)?;
            let path = dir.join("metrics.db");
            log::info!("metrics history in {}", path.display());
            let store = store::Store::open(&path)?;
            let saved = settings::Saved::load(dir.join("settings.json"));
            let collector = collector::Collector::new(store, collector::Retention::default());
            collector.set_interval(saved.get().interval_secs);
            collector.start();
            app.manage(collector);
            app.manage(saved);
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
            commands::settings,
            commands::set_settings,
            commands::vm_action,
            commands::vm_resize,
            commands::container_action,
            commands::container_logs,
            commands::container_inspect,
            commands::images,
            commands::image_history,
            commands::image_remove,
            commands::images_prune,
            commands::volumes,
            commands::guest_files,
            commands::guest_file,
            commands::volume_remove,
            commands::volumes_prune,
            commands::system_df,
            commands::series,
            commands::summary,
            commands::entities,
            commands::oom_events,
        ])
        .run(ctx)
        .expect("error while running tauri application");
}
