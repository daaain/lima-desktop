pub mod collector;
pub mod commands;
pub mod guest_files;
pub mod host_proc;
pub mod host_use;
pub mod journal;
pub mod lima;
pub mod marker;
pub mod menubar;
pub mod oom;
pub mod podman;
pub mod probe;
pub mod settings;
pub mod stall;
pub mod store;
pub mod top_apps;
#[cfg(target_os = "macos")]
pub mod typeset;
pub mod updates;

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

/// Every window takes `theme` (its title bar, and on macOS what its page sees as the system's).
pub(crate) fn apply_theme<R: tauri::Runtime>(app: &impl Manager<R>, theme: settings::Theme) {
    for (label, w) in app.webview_windows() {
        if let Err(e) = w.set_theme(theme.native()) {
            log::warn!("can't set {label}'s theme: {e}");
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
        // The popover opens under the menu bar item clicked, so it's never put back somewhere else.
        .plugin(tauri_plugin_window_state::Builder::default().with_denylist(&[menubar::POPOVER]).build())
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
            apply_theme(app, saved.get().theme);
            app.manage(collector);
            app.manage(saved);
            // The popover's list of what else is running, sampled only when it asks.
            app.manage(Arc::new(top_apps::TopApps::default()));
            menubar::start(app.handle());
            let version = app.package_info().version.clone();
            app.manage(updates::Updates::load(dir.join("updates.json"), version));
            updates::start(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event
                && window.label() == "main"
            {
                if let Some(c) = window.try_state::<Arc<collector::Collector>>() {
                    c.flush_now();
                }
                menubar::main_closed(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::snapshot,
            commands::settings,
            commands::platform,
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
            commands::compose_series,
            commands::summary,
            commands::entities,
            commands::oom_events,
            commands::stalls,
            commands::host_stack,
            commands::top_apps,
            commands::open_main,
            commands::quit,
            commands::fit_popover,
            commands::update_available,
        ])
        .build(ctx)
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // The last window closed (an exit asked for has a code): keep recording, in the menu
            // bar, if Settings says so and the menu bar is there to come back by.
            tauri::RunEvent::ExitRequested { code: None, api, .. } if menubar::keeps_running(app) => {
                api.prevent_exit();
            }
            // The Dock icon clicked with no window open.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => menubar::open_main(app),
            tauri::RunEvent::Exit => {
                if let Some(c) = app.try_state::<Arc<collector::Collector>>() {
                    c.flush_now();
                }
            }
            _ => {}
        });
}
