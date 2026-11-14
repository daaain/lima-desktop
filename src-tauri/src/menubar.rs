//! The menu bar: up to three items (memory, CPU, disk), each the whole computer's use as a figure,
//! drawn — a trace of the last few measurements, or an upright bar — with the VMs' part solid and
//! everything else pale. Clicking one opens the popover (the UI's `/menubar` page, in a small
//! borderless window under it) on that resource; its menu (right click) opens the app or quits.
//! With all three off the app's own icon stays, as the way back in when the window is closed.
//!
//! The drawings are template images (macOS tints them for a light or dark menu bar), except past
//! three quarters, when they're drawn in the warning colour instead.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::collector::{Collector, Snapshot};
use crate::settings::{Look, MenuBar, Saved};

/// The popover window's label, and its width in points.
pub const POPOVER: &str = "popover";
const POPOVER_WIDTH: f64 = 360.0;
const APP_ITEM: &str = "app";

/// One of the computer's resources, as an item in the menu bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Res {
    Mem,
    Cpu,
    Disk,
}

/// Left to right as they're first put in the menu bar.
pub const RESOURCES: [Res; 3] = [Res::Mem, Res::Cpu, Res::Disk];

impl Res {
    /// The item's id, the popover's `?tab=`, and what `names` puts before the figure.
    pub fn id(self) -> &'static str {
        match self {
            Res::Mem => "mem",
            Res::Cpu => "cpu",
            Res::Disk => "disk",
        }
    }
    fn from_id(id: &str) -> Option<Res> {
        RESOURCES.into_iter().find(|r| r.id() == id)
    }
    fn look(self, m: &MenuBar) -> Look {
        match self {
            Res::Mem => m.memory,
            Res::Cpu => m.cpu,
            Res::Disk => m.disk,
        }
    }
    fn index(self) -> usize {
        self as usize
    }
}

/// A resource's use as shares of the whole computer, 0 to 1: everything in use, and the VMs' part
/// of it.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Share {
    pub whole: f32,
    pub vms: f32,
}

impl Share {
    /// Past three quarters: the app's one threshold.
    pub fn hot(self) -> bool {
        self.whole > 0.75
    }
}

/// The share from the computer's `used` and `total` and the VMs' own parts; `None` without the
/// computer's figures. The VMs' part never exceeds the whole (their figures are read a moment
/// apart from the computer's).
pub fn share(used: Option<i64>, total: Option<i64>, vms: impl Iterator<Item = i64>) -> Option<Share> {
    let (used, total) = (used.filter(|&u| u >= 0)?, total.filter(|&t| t > 0)?);
    let whole = (used as f64 / total as f64).clamp(0.0, 1.0) as f32;
    let vms: i64 = vms.filter(|&v| v > 0).sum();
    Some(Share { whole, vms: ((vms as f64 / total as f64) as f32).clamp(0.0, whole) })
}

/// Memory, CPU and disk from a snapshot: memory and CPU from the running VMs, disk from every VM
/// (a stopped one's image still takes its space).
pub fn shares(s: &Snapshot) -> [Option<Share>; 3] {
    let Some(host) = s.host_use.as_ref() else {
        return [None; 3];
    };
    let h = |k: &str| host.latest.get(k).copied();
    let running = || s.vms.iter().filter(|v| v.instance.running());
    [
        share(h("mem_used"), h("mem_total"), running().filter_map(|v| v.latest.get("host_rss").copied())),
        share(h("cpu_mc"), h("cpu_total_mc"), running().filter_map(|v| v.latest.get("host_cpu_mc").copied())),
        share(h("disk_used"), h("disk_total"), s.vms.iter().filter_map(|v| v.latest.get("host_disk_alloc").copied())),
    ]
}

/// What's written beside the drawing: the whole computer's use, as a percent.
pub fn title(res: Res, share: Share, names: bool) -> String {
    let pct = (share.whole * 100.0).round() as u32;
    if names { format!("{} {pct}%", res.id()) } else { format!("{pct}%") }
}

// ---- drawing ------------------------------------------------------------------------------------

/// An RGBA image at twice the menu bar's points (it's 18 pt tall).
#[derive(Debug, Clone, PartialEq)]
pub struct Icon {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

const H: u32 = 36;
const FRAME: u32 = 2;
/// Columns in a trace, each this wide, touching.
pub const COLUMNS: usize = 11;
const COLUMN: u32 = 4;
const TRACE_WIDTH: u32 = 2 * FRAME + COLUMNS as u32 * COLUMN;
const BAR_WIDTH: u32 = 10;
const SOLID: u8 = 255;
const PALE: u8 = 95;
/// The warning colour, legible on a light or a dark menu bar.
const WARN: [u8; 3] = [240, 110, 20];
const INK: [u8; 3] = [0, 0, 0];

impl Icon {
    fn new(width: u32, height: u32) -> Icon {
        Icon { width, height, rgba: vec![0; (width * height * 4) as usize] }
    }
    /// Paints rows `y0..y1` of columns `x0..x1` (clipped), replacing what was there.
    fn fill(&mut self, x0: u32, x1: u32, y0: u32, y1: u32, rgb: [u8; 3], alpha: u8) {
        for y in y0.min(self.height)..y1.min(self.height) {
            for x in x0.min(self.width)..x1.min(self.width) {
                let i = ((y * self.width + x) * 4) as usize;
                self.rgba[i..i + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], alpha]);
            }
        }
    }
    fn frame(&mut self, rgb: [u8; 3]) {
        let (w, h) = (self.width, self.height);
        self.fill(0, w, 0, FRAME, rgb, SOLID);
        self.fill(0, w, h - FRAME, h, rgb, SOLID);
        self.fill(0, FRAME, 0, h, rgb, SOLID);
        self.fill(w - FRAME, w, 0, h, rgb, SOLID);
    }
    /// A column inside the frame, from the bottom: the VMs solid, the rest of the whole pale.
    fn column(&mut self, x0: u32, x1: u32, s: Share, rgb: [u8; 3]) {
        let inside = self.height - 2 * FRAME;
        let bottom = self.height - FRAME;
        let px = |f: f32| (f.clamp(0.0, 1.0) * inside as f32).round() as u32;
        let (whole, vms) = (px(s.whole), px(s.vms).min(px(s.whole)));
        self.fill(x0, x1, bottom - whole, bottom - vms, rgb, PALE);
        self.fill(x0, x1, bottom - vms, bottom, rgb, SOLID);
    }
}

fn ink(hot: bool) -> [u8; 3] {
    if hot { WARN } else { INK }
}

/// The last [`COLUMNS`] measurements, oldest first, the newest at the right; columns touch.
pub fn trace(history: &[Share]) -> Icon {
    let hot = history.last().is_some_and(|s| s.hot());
    let rgb = ink(hot);
    let mut icon = Icon::new(TRACE_WIDTH, H);
    icon.frame(rgb);
    let recent = &history[history.len().saturating_sub(COLUMNS)..];
    let first = COLUMNS - recent.len();
    for (i, s) in recent.iter().enumerate() {
        let x0 = FRAME + (first + i) as u32 * COLUMN;
        icon.column(x0, x0 + COLUMN, *s, rgb);
    }
    icon
}

/// Now, as an upright bar notched at quarters.
pub fn bar(now: Share) -> Icon {
    let rgb = ink(now.hot());
    let mut icon = Icon::new(BAR_WIDTH, H);
    icon.frame(rgb);
    icon.column(FRAME, BAR_WIDTH - FRAME, now, rgb);
    let inside = H - 2 * FRAME;
    for q in 1..4 {
        let y = H - FRAME - inside * q / 4;
        icon.fill(FRAME, BAR_WIDTH - FRAME, y - 1, y + 1, rgb, 0);
    }
    icon
}

/// The app's own glyph: three bars, the shortest on top.
pub fn glyph() -> Icon {
    let mut icon = Icon::new(30, H);
    for (y, w) in [(7, 16), (15, 30), (23, 22)] {
        icon.fill(0, w, y, y + 6, INK, SOLID);
    }
    icon
}

// ---- in the app ---------------------------------------------------------------------------------

/// Which tab the popover is open on, and when it last closed (on which): a click on an item first
/// takes the focus from the popover, closing it, and mustn't then open it again.
#[derive(Default, Clone, Copy)]
struct Popover {
    open_on: Option<Res>,
    closed: Option<(Res, Instant)>,
}

/// The menu bar's own state: each resource's recent shares, and the popover.
#[derive(Default)]
pub struct State {
    history: Mutex<[VecDeque<Share>; 3]>,
    popover: Mutex<Popover>,
    /// Whether the menu bar could be used here (Linux needs an app indicator library): without it,
    /// closing the window mustn't leave an app with no way back in.
    available: AtomicBool,
}

/// Whether closing the window should leave the app running.
pub fn keeps_running(app: &AppHandle) -> bool {
    app.state::<Saved>().get().keep_running
        && app.try_state::<State>().is_some_and(|s| s.available.load(Ordering::Relaxed))
}

/// Puts the chosen items in the menu bar and keeps them current, at the measuring interval.
pub fn start(app: &AppHandle) {
    app.manage(State::default());
    apply(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let secs = app.state::<std::sync::Arc<Collector>>().interval_secs().max(1);
            tokio::time::sleep(Duration::from_secs(secs)).await;
            tick(&app);
        }
    });
}

/// Adds and removes items as Settings says, then draws them.
pub fn apply(app: &AppHandle) {
    let chosen = app.state::<Saved>().get().menu_bar;
    let state = app.state::<State>();
    let mut ok = true;
    let none = RESOURCES.iter().all(|r| r.look(&chosen) == Look::Off);
    // Added right to left, so they read memory, CPU, disk.
    for res in RESOURCES.into_iter().rev() {
        let want = res.look(&chosen) != Look::Off;
        match (want, app.tray_by_id(res.id()).is_some()) {
            (true, false) => ok &= add(app, res.id(), None).is_ok(),
            (false, true) => {
                app.remove_tray_by_id(res.id());
            }
            _ => {}
        }
    }
    match (none, app.tray_by_id(APP_ITEM).is_some()) {
        (true, false) => ok &= add(app, APP_ITEM, Some(glyph())).is_ok(),
        (false, true) => {
            app.remove_tray_by_id(APP_ITEM);
        }
        _ => {}
    }
    state.available.store(ok, Ordering::Relaxed);
    draw(app);
}

fn add(app: &AppHandle, id: &str, icon: Option<Icon>) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Open Lima Desktop", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit Lima Desktop", true, None::<&str>)?,
        ],
    )?;
    let mut b = TrayIconBuilder::with_id(id)
        .tooltip("Lima Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => open_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                id,
                rect,
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                let res = Res::from_id(id.as_ref()).unwrap_or(Res::Mem);
                toggle_popover(tray.app_handle(), res, rect);
            }
        });
    if let Some(i) = icon {
        b = b.icon(Image::new_owned(i.rgba, i.width, i.height)).icon_as_template(true);
    }
    b.build(app).map(|_| ()).inspect_err(|e| log::warn!("can't put {id} in the menu bar: {e}"))
}

/// One measuring interval: the newest shares into each history, and every item redrawn.
fn tick(app: &AppHandle) {
    let snap = app.state::<std::sync::Arc<Collector>>().snapshot();
    let now = shares(&snap);
    {
        let state = app.state::<State>();
        let mut h = state.history.lock().expect("menu bar lock");
        for res in RESOURCES {
            if let Some(s) = now[res.index()] {
                let q = &mut h[res.index()];
                q.push_back(s);
                while q.len() > COLUMNS {
                    q.pop_front();
                }
            }
        }
    }
    draw(app);
}

fn draw(app: &AppHandle) {
    let chosen = app.state::<Saved>().get().menu_bar;
    let state = app.state::<State>();
    let history = state.history.lock().expect("menu bar lock").clone();
    for res in RESOURCES {
        let look = res.look(&chosen);
        let Some(tray) = app.tray_by_id(res.id()) else {
            continue;
        };
        let h: Vec<Share> = history[res.index()].iter().copied().collect();
        let Some(&now) = h.last() else {
            let _ = tray.set_title(Some(if chosen.names { format!("{} –", res.id()) } else { "–".into() }));
            continue;
        };
        let icon = match look {
            Look::Trace => Some(trace(&h)),
            Look::Bar => Some(bar(now)),
            Look::Figure | Look::Off => None,
        };
        let result = (|| -> tauri::Result<()> {
            match icon {
                Some(i) => {
                    tray.set_icon(Some(Image::new_owned(i.rgba, i.width, i.height)))?;
                    tray.set_icon_as_template(!now.hot())?;
                }
                None => tray.set_icon(None)?,
            }
            tray.set_title(Some(title(res, now, chosen.names)))?;
            tray.set_tooltip(Some(format!(
                "{}: this computer {:.0} % in use, the VMs {:.0} %",
                res.id(),
                now.whole * 100.0,
                now.vms * 100.0
            )))
        })();
        if let Err(e) = result {
            log::warn!("can't redraw {} in the menu bar: {e}", res.id());
        }
    }
}

/// Opens the popover under the item clicked, on its tab; a second click on the same item closes it.
fn toggle_popover(app: &AppHandle, res: Res, rect: tauri::Rect) {
    let state = app.state::<State>();
    let Popover { open_on, closed } = *state.popover.lock().expect("popover lock");
    if let Some(w) = app.get_webview_window(POPOVER) {
        let _ = w.close();
        if open_on == Some(res) {
            return;
        }
    } else if closed.is_some_and(|(r, t)| r == res && t.elapsed() < Duration::from_millis(400)) {
        // This click is what took the focus away and closed it.
        return;
    }
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map_or(1.0, |m| m.scale_factor());
    let pos = rect.position.to_logical::<f64>(scale);
    let size = rect.size.to_logical::<f64>(scale);
    let x = pos.x + size.width / 2.0 - POPOVER_WIDTH / 2.0;
    let y = pos.y + size.height + 4.0;
    let theme = app.state::<Saved>().get().theme.native();
    let url = WebviewUrl::App(format!("menubar?tab={}", res.id()).into());
    let built = WebviewWindowBuilder::new(app, POPOVER, url)
        .title("Lima Desktop")
        .inner_size(POPOVER_WIDTH, 560.0)
        .position(x.max(0.0), y)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(true)
        .focused(true)
        .theme(theme)
        .build();
    match built {
        Ok(w) => {
            state.popover.lock().expect("popover lock").open_on = Some(res);
            let app = app.clone();
            w.on_window_event(move |e| {
                if let tauri::WindowEvent::Focused(false) = e {
                    if let Some(w) = app.get_webview_window(POPOVER) {
                        let _ = w.close();
                    }
                    let state = app.state::<State>();
                    let mut p = state.popover.lock().expect("popover lock");
                    *p = Popover { open_on: None, closed: Some((res, Instant::now())) };
                }
            });
        }
        Err(e) => log::warn!("can't open the menu bar's popover: {e}"),
    }
}

/// Sizes the popover to its page (which knows how tall it came out).
pub fn fit_popover(app: &AppHandle, height: f64) {
    if let Some(w) = app.get_webview_window(POPOVER) {
        let _ = w.set_size(tauri::LogicalSize::new(POPOVER_WIDTH, height.clamp(200.0, 900.0)));
    }
}

/// Shows the main window, making it again from the config if it was closed, and brings the app
/// back to the Dock.
pub fn open_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let Some(config) = app.config().app.windows.first().cloned() else {
        return;
    };
    match WebviewWindowBuilder::from_config(app, &config).and_then(|b| b.build()) {
        Ok(w) => {
            let _ = w.set_theme(app.state::<Saved>().get().theme.native());
            let _ = w.set_focus();
        }
        Err(e) => log::error!("can't open the window again: {e}"),
    }
}

/// The main window has closed while the app keeps recording: out of the Dock (and the app
/// switcher) until it's opened again, as a menu bar app is.
pub fn main_closed(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if keeps_running(app) {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn px(i: &Icon, x: u32, y: u32) -> [u8; 4] {
        let k = ((y * i.width + x) * 4) as usize;
        i.rgba[k..k + 4].try_into().unwrap()
    }

    #[test]
    fn a_share_is_of_the_whole_computer_and_the_vms_never_exceed_it() {
        let s = share(Some(48), Some(64), [16, 8, -1].into_iter()).unwrap();
        assert_eq!(s, Share { whole: 0.75, vms: 0.375 });
        assert!(!s.hot());
        assert!(share(Some(49), Some(64), std::iter::empty()).unwrap().hot());
        // Read a moment apart, the VMs can come out above the computer: they're capped.
        assert_eq!(share(Some(10), Some(100), [30].into_iter()).unwrap().vms, 0.1);
        assert_eq!(share(None, Some(64), std::iter::empty()), None);
        assert_eq!(share(Some(-1), Some(64), std::iter::empty()), None);
        assert_eq!(share(Some(1), Some(0), std::iter::empty()), None);
    }

    #[test]
    fn the_title_is_the_whole_computer_as_a_percent() {
        let s = Share { whole: 0.704, vms: 0.5 };
        assert_eq!(title(Res::Mem, s, false), "70%");
        assert_eq!(title(Res::Cpu, s, true), "cpu 70%");
        assert_eq!(title(Res::Disk, Share { whole: 1.0, vms: 0.0 }, true), "disk 100%");
    }

    #[test]
    fn a_trace_draws_the_vms_solid_under_everything_else_pale_newest_at_the_right() {
        let i = trace(&[Share { whole: 0.5, vms: 0.25 }]);
        assert_eq!((i.width, i.height, i.rgba.len()), (48, 36, 48 * 36 * 4));
        let x = i.width - FRAME - 1; // the newest column
        assert_eq!(px(&i, x, H - FRAME - 1), [0, 0, 0, SOLID]); // VMs, at the bottom
        assert_eq!(px(&i, x, H - FRAME - 10), [0, 0, 0, PALE]); // everything else, above them
        assert_eq!(px(&i, x, FRAME + 2), [0, 0, 0, 0]); // free
        assert_eq!(px(&i, FRAME, H - FRAME - 1), [0, 0, 0, 0]); // no older measurement yet
        assert_eq!(px(&i, 0, 0)[3], SOLID); // the frame
    }

    #[test]
    fn columns_touch_with_no_gap() {
        let full = Share { whole: 1.0, vms: 1.0 };
        let i = trace(&[full; COLUMNS]);
        let y = H / 2;
        assert!((FRAME..i.width - FRAME).all(|x| px(&i, x, y)[3] == SOLID));
    }

    #[test]
    fn only_the_last_columns_are_drawn() {
        let mut h = vec![Share { whole: 1.0, vms: 1.0 }];
        h.extend(std::iter::repeat_n(Share::default(), COLUMNS));
        let i = trace(&h);
        assert!((FRAME..i.width - FRAME).all(|x| px(&i, x, H / 2)[3] == 0));
    }

    #[test]
    fn past_three_quarters_it_is_drawn_in_the_warning_colour() {
        let i = trace(&[Share { whole: 0.9, vms: 0.5 }]);
        assert_eq!(&px(&i, 0, 0)[..3], &WARN);
        let i = bar(Share { whole: 0.9, vms: 0.5 });
        assert_eq!(&px(&i, 0, 0)[..3], &WARN);
        assert_eq!(&trace(&[Share { whole: 0.7, vms: 0.5 }]).rgba[..3], &INK);
    }

    #[test]
    fn a_bar_is_notched_at_quarters() {
        let i = bar(Share { whole: 1.0, vms: 1.0 });
        assert_eq!(i.width, BAR_WIDTH);
        let inside = H - 2 * FRAME;
        let notch = H - FRAME - inside / 2;
        assert_eq!(px(&i, BAR_WIDTH / 2, notch)[3], 0);
        assert_eq!(px(&i, BAR_WIDTH / 2, notch + 3)[3], SOLID);
    }
}
