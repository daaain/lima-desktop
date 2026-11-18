//! The menu bar: up to three items (memory, CPU, disk), each the whole computer's use as a figure,
//! drawn — a trace of the last few measurements, or an upright bar — with the VMs' part pale at
//! the bottom and everything else solid above it, its top edge the whole. Clicking one opens the
//! popover (the UI's `/menubar` page, in a small borderless window under it) on that resource; its
//! menu (right click) opens the app or quits.
//! With all three off the app's own icon stays, as the way back in when the window is closed.
//!
//! On macOS each item is one image, its figure and name set in it beside the drawing (`typeset`),
//! a template image that macOS tints for a light or dark menu bar; one that warns is drawn in the
//! warning colour instead (and, as macOS can't invert it while it's highlighted, again for that, as
//! for the other menu bar). When each warns is set in Settings: memory and CPU past a percent in use
//! (three quarters unless chosen otherwise), the disk with less than so many GB free. Elsewhere the
//! image is the drawing alone and the figure its title.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::collector::{Collector, Snapshot, now_ms};
use crate::settings::{Drawing, Item, MenuBar, Saved, Warn};
use crate::store::{Stack, Store};

/// The popover window's label, and its width in points.
pub const POPOVER: &str = "popover";
const POPOVER_WIDTH: f64 = 396.0;
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
    /// The item's id, the popover's `?tab=`, and its name in the menu bar.
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
    fn item(self, m: &MenuBar) -> Item {
        match self {
            Res::Mem => m.memory,
            Res::Cpu => m.cpu,
            Res::Disk => m.disk,
        }
    }
    /// Memory and CPU past a percent in use, the disk under so many GB (powers of 1000) free.
    fn threshold(self, w: &Warn) -> Threshold {
        let past = |pct: Option<u8>| pct.map_or(Threshold::Never, |p| Threshold::Past(f32::from(p) / 100.0));
        match self {
            Res::Mem => past(w.memory_pct),
            Res::Cpu => past(w.cpu_pct),
            Res::Disk => {
                w.disk_free_gb.map_or(Threshold::Never, |gb| Threshold::FreeUnder(u64::from(gb) * 1_000_000_000))
            }
        }
    }
    fn index(self) -> usize {
        self as usize
    }
}

/// A resource's use as shares of the whole computer, 0 to 1: everything in use, and the VMs' part
/// of it; and what's left, in the resource's own unit (bytes, or millicores for CPU).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Share {
    pub whole: f32,
    pub vms: f32,
    pub free: u64,
}

/// When an item turns the warning colour, as Settings has it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Threshold {
    Never,
    /// Past this share of the whole in use, 0 to 1.
    Past(f32),
    /// With less than this much left (a disk's bytes).
    FreeUnder(u64),
}

impl Share {
    pub fn hot(self, t: Threshold) -> bool {
        match t {
            Threshold::Never => false,
            Threshold::Past(share) => self.whole > share,
            Threshold::FreeUnder(left) => self.free < left,
        }
    }
}

/// Whether an item warns: its newest share is past its threshold.
pub fn warns(history: &[Share], t: Threshold) -> bool {
    history.last().is_some_and(|s| s.hot(t))
}

/// The share from the computer's `used` and `total` and the VMs' own parts; `None` without the
/// computer's figures. The VMs' part never exceeds the whole (their figures are read a moment
/// apart from the computer's).
pub fn share(used: Option<i64>, total: Option<i64>, vms: impl Iterator<Item = i64>) -> Option<Share> {
    let (used, total) = (used.filter(|&u| u >= 0)?, total.filter(|&t| t > 0)?);
    let whole = (used as f64 / total as f64).clamp(0.0, 1.0) as f32;
    let vms: i64 = vms.filter(|&v| v > 0).sum();
    Some(Share {
        whole,
        vms: ((vms as f64 / total as f64) as f32).clamp(0.0, whole),
        free: (total - used).max(0) as u64,
    })
}

/// The shares in measurements saved earlier, oldest first: each time the computer was measured, its
/// use and the part of the VMs measured with it.
pub fn saved_shares(stack: &Stack) -> Vec<Share> {
    (0..stack.ts.len())
        .filter_map(|j| {
            let vms = stack.vms.iter().filter_map(|v| v.avg.get(j).copied().flatten());
            share(stack.used.get(j).copied().flatten(), stack.total.get(j).copied().flatten(), vms)
        })
        .collect()
}

/// A VM's part of the memory in use: its share (`host_mem`, its compressed memory at the compressor's
/// size, as the computer's use counts it), else, before that was measured, its footprint.
fn vm_memory(latest: &HashMap<String, i64>) -> Option<i64> {
    latest.get("host_mem").or_else(|| latest.get("host_rss")).copied()
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
        share(h("mem_used"), h("mem_total"), running().filter_map(|v| vm_memory(&v.latest))),
        share(h("cpu_mc"), h("cpu_total_mc"), running().filter_map(|v| v.latest.get("host_cpu_mc").copied())),
        share(h("disk_used"), h("disk_total"), s.vms.iter().filter_map(|v| v.latest.get("host_disk_alloc").copied())),
    ]
}

/// The figure: the whole computer's use, as a percent; a dash before the first measurement.
pub fn figure(now: Option<Share>) -> String {
    match now {
        Some(s) => format!("{}%", (s.whole * 100.0).round() as u32),
        None => "–".into(),
    }
}

/// The title where the figure can't be drawn into the image (not macOS): the name before it.
pub fn title(res: Res, now: Option<Share>, names: bool) -> String {
    if names { format!("{} {}", res.id(), figure(now)) } else { figure(now) }
}

pub fn tooltip(res: Res, now: Share) -> String {
    format!("{}: this computer {:.0} % in use, the VMs {:.0} %", res.id(), now.whole * 100.0, now.vms * 100.0)
}

/// What an item is made of, left to right.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Parts {
    /// The name, tiny and on its side, left of the drawing: named, with no figure to put it under.
    pub side_name: bool,
    pub drawing: Drawing,
    pub figure: bool,
    /// The name, small, under the figure.
    pub name_under: bool,
}

/// An item's parts as Settings has it; `None` when it isn't in the menu bar.
pub fn parts(item: Item, names: bool) -> Option<Parts> {
    item.shown().then_some(Parts {
        side_name: names && !item.figure,
        drawing: item.drawing,
        figure: item.figure,
        name_under: names && item.figure,
    })
}

// ---- drawing ------------------------------------------------------------------------------------

/// An RGBA image at twice the menu bar's points (it's 18 pt tall).
#[derive(Debug, Clone, PartialEq)]
pub struct Icon {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// What's drawn, before it's coloured: each pixel's coverage, 0 to 255, top row first. An item is
/// one colour throughout, so the drawing and the text are laid into one mask and painted at the end.
#[derive(Debug, Clone, PartialEq)]
pub struct Mask {
    pub width: u32,
    pub height: u32,
    pub alpha: Vec<u8>,
}

const H: u32 = 36;
const FRAME: u32 = 2;
/// Columns in a trace, each this wide (a point), touching.
pub const COLUMNS: usize = 22;
const COLUMN: u32 = 2;
const TRACE_WIDTH: u32 = 2 * FRAME + COLUMNS as u32 * COLUMN;
const BAR_WIDTH: u32 = 10;
const SOLID: u8 = 255;
const PALE: u8 = 95;
/// The warning colour: macOS's orange for a dark menu bar, which still reads on a light one.
const HOT: [u8; 3] = [255, 159, 10];
/// On a light menu bar the bright one is faint (about 2:1): a deeper one, legible as small text.
const HOT_ON_LIGHT: [u8; 3] = [179, 77, 0];
const INK: [u8; 3] = [0, 0, 0];
const WHITE: [u8; 3] = [255, 255, 255];

/// The menu bar's appearance, for what it can't tint. On macOS an item that warns isn't a template
/// image, so its warning colour is chosen for the bar, and its names painted in the bar's own text
/// colour. A Linux panel tints nothing, so every item is painted for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Bar {
    #[default]
    Dark,
    Light,
}

impl Bar {
    fn ink(self) -> [u8; 3] {
        match self {
            Bar::Dark => WHITE,
            Bar::Light => INK,
        }
    }

    /// The warning colour on this menu bar.
    fn hot(self) -> [u8; 3] {
        match self {
            Bar::Dark => HOT,
            Bar::Light => HOT_ON_LIGHT,
        }
    }

    /// What an item is painted in on this menu bar: its ink, or when it warns its warning colour.
    pub fn paint(self, hot: bool) -> [u8; 3] {
        if hot { self.hot() } else { self.ink() }
    }

    /// The menu bar as an item it highlights shows it: inverted (a light highlight on a dark bar).
    #[cfg(target_os = "macos")]
    fn inverted(self) -> Bar {
        match self {
            Bar::Dark => Bar::Light,
            Bar::Light => Bar::Dark,
        }
    }
}

impl Mask {
    pub fn new(width: u32, height: u32) -> Mask {
        Mask { width, height, alpha: vec![0; (width * height) as usize] }
    }
    pub fn at(&self, x: u32, y: u32) -> u8 {
        self.alpha[(y * self.width + x) as usize]
    }
    /// Covers rows `y0..y1` of columns `x0..x1` (clipped) by `alpha`, replacing what was there.
    fn fill(&mut self, x0: u32, x1: u32, y0: u32, y1: u32, alpha: u8) {
        for y in y0.min(self.height)..y1.min(self.height) {
            for x in x0.min(self.width)..x1.min(self.width) {
                self.alpha[(y * self.width + x) as usize] = alpha;
            }
        }
    }
    /// A frame round columns `x0..x1`.
    fn frame(&mut self, x0: u32, x1: u32) {
        let h = self.height;
        self.fill(x0, x1, 0, FRAME, SOLID);
        self.fill(x0, x1, h - FRAME, h, SOLID);
        self.fill(x0, x0 + FRAME, 0, h, SOLID);
        self.fill(x1 - FRAME, x1, 0, h, SOLID);
    }
    /// A column inside the frame, from the bottom: the VMs pale, the rest of the whole solid above
    /// them, so its top edge (the whole) stands out, VMs or none: solid as thick as the frame's
    /// line at least, even where the VMs are nearly all of it.
    fn column(&mut self, x0: u32, x1: u32, s: Share) {
        let inside = self.height - 2 * FRAME;
        let bottom = self.height - FRAME;
        let px = |f: f32| (f.clamp(0.0, 1.0) * inside as f32).round() as u32;
        let whole = px(s.whole);
        let vms = px(s.vms).min(whole.saturating_sub(FRAME));
        self.fill(x0, x1, bottom - whole, bottom - vms, SOLID);
        self.fill(x0, x1, bottom - vms, bottom, PALE);
    }
    /// The last [`COLUMNS`] measurements from `x`, oldest first, the newest at the right; columns
    /// touch.
    fn trace(&mut self, x: u32, history: &[Share]) {
        self.frame(x, x + TRACE_WIDTH);
        let recent = &history[history.len().saturating_sub(COLUMNS)..];
        let first = COLUMNS - recent.len();
        for (i, s) in recent.iter().enumerate() {
            let x0 = x + FRAME + (first + i) as u32 * COLUMN;
            self.column(x0, x0 + COLUMN, *s);
        }
    }
    /// Now, from `x`, as an upright bar notched at quarters.
    fn bar(&mut self, x: u32, now: Option<Share>) {
        self.frame(x, x + BAR_WIDTH);
        if let Some(now) = now {
            self.column(x + FRAME, x + BAR_WIDTH - FRAME, now);
        }
        let inside = self.height - 2 * FRAME;
        for q in 1..4 {
            let y = self.height - FRAME - inside * q / 4;
            self.fill(x + FRAME, x + BAR_WIDTH - FRAME, y - 1, y + 1, 0);
        }
    }
    /// The whole mask in one colour.
    pub fn paint(&self, rgb: [u8; 3]) -> Icon {
        let rgba = self.alpha.iter().flat_map(|&a| [rgb[0], rgb[1], rgb[2], a]).collect();
        Icon { width: self.width, height: self.height, rgba }
    }

    /// This in `rgb`, with `over` (the same size, set apart from it) in `over_rgb` on top.
    pub fn paint_under(&self, rgb: [u8; 3], over: &Mask, over_rgb: [u8; 3]) -> Icon {
        let rgba = self
            .alpha
            .iter()
            .zip(&over.alpha)
            .flat_map(|(&a, &o)| {
                // Over coverage `o`, the other colour shows through what's left.
                let mix =
                    |c: u8, d: u8| ((u16::from(d) * u16::from(o) + u16::from(c) * (255 - u16::from(o))) / 255) as u8;
                let alpha = (u16::from(o) + u16::from(a) * (255 - u16::from(o)) / 255) as u8;
                [mix(rgb[0], over_rgb[0]), mix(rgb[1], over_rgb[1]), mix(rgb[2], over_rgb[2]), alpha]
            })
            .collect();
        Icon { width: self.width, height: self.height, rgba }
    }
}

/// The colour an item is painted, and whether it's a template image for macOS to tint: the warning
/// colour when it warns.
pub fn ink(hot: bool) -> ([u8; 3], bool) {
    if hot { (HOT, false) } else { (INK, true) }
}

fn drawing_width(d: Drawing) -> u32 {
    match d {
        Drawing::Off => 0,
        Drawing::Trace => TRACE_WIDTH,
        Drawing::Bar => BAR_WIDTH,
    }
}

/// The drawing alone, with nothing set beside it; `hot`, in the warning colour.
pub fn drawing(d: Drawing, history: &[Share], hot: bool) -> Option<Icon> {
    drawing_in(d, history, ink(hot).0)
}

/// The drawing alone, painted in `rgb`.
pub fn drawing_in(d: Drawing, history: &[Share], rgb: [u8; 3]) -> Option<Icon> {
    let mut m = Mask::new(drawing_width(d), H);
    match d {
        Drawing::Off => return None,
        Drawing::Trace => m.trace(0, history),
        Drawing::Bar => m.bar(0, history.last().copied()),
    }
    Some(m.paint(rgb))
}

/// The last [`COLUMNS`] measurements, oldest first, the newest at the right; columns touch. Not
/// warning.
pub fn trace(history: &[Share]) -> Icon {
    drawing(Drawing::Trace, history, false).expect("a trace")
}

/// Now, as an upright bar notched at quarters. Not warning.
pub fn bar(now: Share) -> Icon {
    drawing(Drawing::Bar, &[now], false).expect("a bar")
}

// ---- an item's layout ---------------------------------------------------------------------------

/// How an item's type measures, in pixels (CoreText's measures, on macOS).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Measures {
    /// The room for the figure: "100%" as it's set, so an item keeps its width as the figure
    /// changes.
    pub figure: f64,
    /// The name under the figure.
    pub name: f64,
    /// The name on its side: its length, and how far it reaches across the item, its cap height
    /// one side of its baseline and its descent the other.
    pub side: f64,
    pub side_cap: f64,
    pub side_descent: f64,
}

/// Where a line of type starts: the left end of its baseline, in pixels from the top left. On its
/// side, the bottom end.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pen {
    pub x: f64,
    pub y: f64,
}

/// Where each part of an item goes, and how wide the item is, in pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layout {
    pub width: u32,
    pub side_name: Option<Pen>,
    /// The drawing's left edge.
    pub drawing: Option<u32>,
    pub figure: Option<Pen>,
    pub name_under: Option<Pen>,
}

/// Type sizes in pixels (half that in points): the figure with its name under it, and alone; the
/// name under it; the name on its side.
pub const FIGURE_NAMED_PX: f64 = 22.0;
pub const FIGURE_ALONE_PX: f64 = 24.0;
pub const NAME_PX: f64 = 14.0;
pub const SIDE_PX: f64 = 17.0;
/// Baselines from the top: the figure over its name, the name, the figure alone (its digits
/// centred).
const FIGURE_NAMED_BASELINE: f64 = 17.0;
const NAME_BASELINE: f64 = 31.0;
const FIGURE_ALONE_BASELINE: f64 = 26.5;
/// Between the name on its side and the drawing, and between the drawing and the figure.
const SIDE_GAP: u32 = 3;
const FIGURE_GAP: u32 = 5;

pub fn layout(p: Parts, m: Measures) -> Layout {
    let mut x = 0;
    let side_name = p.side_name.then(|| {
        x = (m.side_cap + m.side_descent).ceil() as u32 + SIDE_GAP;
        Pen { x: m.side_cap, y: (H as f64 + m.side) / 2.0 }
    });
    let drawing = (p.drawing != Drawing::Off).then(|| {
        let at = x;
        x += drawing_width(p.drawing);
        at
    });
    let (mut figure, mut name_under) = (None, None);
    if p.figure {
        if drawing.is_some() {
            x += FIGURE_GAP;
        }
        let at = x as f64;
        if p.name_under {
            figure = Some(Pen { x: at, y: FIGURE_NAMED_BASELINE });
            name_under = Some(Pen { x: at, y: NAME_BASELINE });
            x += m.figure.max(m.name).ceil() as u32;
        } else {
            figure = Some(Pen { x: at, y: FIGURE_ALONE_BASELINE });
            x += m.figure.ceil() as u32;
        }
    }
    Layout { width: x, side_name, drawing, figure, name_under }
}

/// The whole item as one image, its figure and name set beside the drawing; `hot`, in the warning
/// colour.
#[cfg(target_os = "macos")]
pub fn item(res: Res, p: Parts, history: &[Share], hot: bool, bar: Bar) -> Icon {
    use crate::typeset::Face;
    let fig = if p.name_under {
        Face::system(FIGURE_NAMED_PX, FIGURE_WEIGHT)
    } else {
        Face::system(FIGURE_ALONE_PX, FIGURE_WEIGHT)
    };
    let name = Face::system(NAME_PX, NAME_WEIGHT);
    let side = Face::system(SIDE_PX, SIDE_WEIGHT);
    let l = layout(
        p,
        Measures {
            figure: fig.width("100%"),
            name: name.width(res.id()),
            side: side.width(res.id()),
            side_cap: side.cap_height(),
            side_descent: side.descent(),
        },
    );
    let now = history.last().copied();
    let mut m = Mask::new(l.width, H);
    match (l.drawing, p.drawing) {
        (Some(x), Drawing::Trace) => m.trace(x, history),
        (Some(x), Drawing::Bar) => m.bar(x, now),
        _ => {}
    }
    if let Some(pen) = l.figure {
        fig.draw(&mut m, &figure(now), pen.x, pen.y, false);
    }
    // The names apart, so that when it warns they keep the menu bar's own colour.
    let mut names = Mask::new(l.width, H);
    if let Some(pen) = l.name_under {
        name.draw(&mut names, res.id(), pen.x, pen.y, false);
    }
    if let Some(pen) = l.side_name {
        side.draw(&mut names, res.id(), pen.x, pen.y, true);
    }
    match ink(hot) {
        (rgb, true) => m.paint_under(rgb, &names, rgb),
        (_, false) => m.paint_under(bar.hot(), &names, bar.ink()),
    }
}

/// Font weights, on CoreText's scale (0 regular, 0.23 medium, 0.3 semibold).
#[cfg(target_os = "macos")]
const FIGURE_WEIGHT: f64 = 0.23;
#[cfg(target_os = "macos")]
const NAME_WEIGHT: f64 = 0.0;
/// The name on its side, a touch heavier: it's read across its strokes.
#[cfg(target_os = "macos")]
const SIDE_WEIGHT: f64 = 0.23;

/// The app's own glyph, for when no item is chosen: the icon's serif L, as a template image.
#[cfg(target_os = "macos")]
pub fn glyph() -> Icon {
    use crate::typeset::Face;
    let l = Face::named(GLYPH_FONT, GLYPH_PX);
    let mut m = Mask::new(l.width("L").ceil() as u32, H);
    // Its capital centred top to bottom.
    l.draw(&mut m, "L", 0.0, (H as f64 + l.cap_height()) / 2.0, false);
    m.paint(INK)
}

/// The icon's L is Newsreader's, which only the webview has; Georgia's bold is the nearest serif
/// every Mac has, with the same bracketed serifs (macOS's own serif, New York, can't be had by
/// name). About 13 pt to the top of the capital, as tall as the menu bar's own symbols.
#[cfg(target_os = "macos")]
const GLYPH_FONT: &str = "Georgia-Bold";
#[cfg(target_os = "macos")]
const GLYPH_PX: f64 = 38.0;

/// The app's own glyph, for when no item is chosen: an L (a plain one: no font is to hand to set it
/// in), in the panel's ink.
#[cfg(not(target_os = "macos"))]
pub fn glyph_on(bar: Bar) -> Icon {
    let mut m = Mask::new(20, H);
    m.fill(3, 9, 6, 30, SOLID);
    m.fill(3, 18, 25, 30, SOLID);
    m.paint(bar.ink())
}

/// In black, as macOS's is, for the tests that look at either.
#[cfg(all(test, not(target_os = "macos")))]
fn glyph() -> Icon {
    glyph_on(Bar::Light)
}

// ---- in the app ---------------------------------------------------------------------------------

/// Which tab the popover is open on, and when it was last hidden (on which): a click on an item
/// first takes the focus from the popover, hiding it, and mustn't then show it again.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct Popover {
    open_on: Option<Res>,
    closed: Option<(Res, Instant)>,
}

/// How soon after the popover was hidden a click on the same item is the one that hid it.
const CLICK_HID_IT: Duration = Duration::from_millis(400);

/// What a click on an item does to the popover.
#[derive(Debug, PartialEq, Eq)]
enum Click {
    /// Under the item, on its tab: shown, or moved there from another item.
    Show,
    Hide,
    /// It was this click that took the focus away and hid it: it stays hidden.
    Nothing,
}

impl Popover {
    /// A click on `res`'s item, the popover on screen or not: a second click on the same item
    /// hides it.
    fn click(self, res: Res, shown: bool, now: Instant) -> Click {
        let just_hidden = self.closed.is_some_and(|(r, t)| r == res && now.saturating_duration_since(t) < CLICK_HID_IT);
        match (shown, self.open_on == Some(res)) {
            (true, true) => Click::Hide,
            (true, false) => Click::Show,
            (false, _) if just_hidden => Click::Nothing,
            (false, _) => Click::Show,
        }
    }

    /// Hidden now; when, and on which item, if it was showing.
    fn hidden(self, now: Instant) -> Popover {
        Popover { open_on: None, closed: self.open_on.map(|r| (r, now)).or(self.closed) }
    }
}

/// The menu bar's own state: each resource's recent shares, what each item shows, and the popover.
#[derive(Default)]
pub struct State {
    history: Mutex<[VecDeque<Share>; 3]>,
    /// What each item was last drawn showing, and when it was put in the menu bar (`added`).
    drawn: Mutex<[Option<(u32, Shown)>; 3]>,
    /// Counts each time an item is put in the menu bar, so one that's new is drawn whole.
    added: [AtomicU32; 3],
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

/// How far back a trace is filled from the saved measurements when the app starts: a restart (a
/// rebuild, an update) carries on from the last [`COLUMNS`] in this, a longer break starts empty.
/// The columns are the last measurements, not fixed moments, so a short gap isn't drawn.
const SAVED_SPAN: Duration = Duration::from_secs(5 * 60);

/// Puts the chosen items in the menu bar and keeps them current, at the measuring interval.
pub fn start(app: &AppHandle) {
    app.manage(State::default());
    fill_from_saved(app);
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

/// Each history from the last [`COLUMNS`] measurements saved in the last [`SAVED_SPAN`].
fn fill_from_saved(app: &AppHandle) {
    let collector = app.state::<std::sync::Arc<Collector>>();
    let interval = collector.interval_secs();
    let mut store = collector.store();
    let state = app.state::<State>();
    let mut h = state.history.lock().expect("menu bar lock");
    let to = now_ms();
    for res in RESOURCES {
        h[res.index()] = saved_history(&mut store, res, to, interval);
    }
}

/// The last [`COLUMNS`] measurements of `res` saved in the [`SAVED_SPAN`] up to `to`, taken every
/// `interval_secs`.
fn saved_history(store: &mut Store, res: Res, to: i64, interval_secs: u64) -> VecDeque<Share> {
    let from = to - SAVED_SPAN.as_millis() as i64;
    // A bucket per measurement, at most.
    let points = (SAVED_SPAN.as_secs() / interval_secs.max(1)) as usize + 1;
    match store.stack(res.id(), from, to, points) {
        Ok(stack) => {
            let saved = saved_shares(&stack);
            saved[saved.len().saturating_sub(COLUMNS)..].iter().copied().collect()
        }
        Err(e) => {
            log::warn!("can't read the saved {} for the menu bar: {e}", res.id());
            VecDeque::new()
        }
    }
}

/// Adds and removes items as Settings says, then draws them (on another thread: see `draw`).
pub fn apply(app: &AppHandle) {
    let chosen = app.state::<Saved>().get().menu_bar;
    let state = app.state::<State>();
    let mut ok = true;
    let none = RESOURCES.iter().all(|r| !r.item(&chosen).shown());
    // Added right to left, so they read memory, CPU, disk.
    for res in RESOURCES.into_iter().rev() {
        let want = res.item(&chosen).shown();
        match (want, app.tray_by_id(res.id()).is_some()) {
            (true, false) => {
                state.added[res.index()].fetch_add(1, Ordering::Relaxed);
                ok &= add(app, res.id(), None).is_ok();
            }
            (false, true) => {
                app.remove_tray_by_id(res.id());
            }
            _ => {}
        }
    }
    match (none, app.tray_by_id(APP_ITEM).is_some()) {
        (true, false) => ok &= add(app, APP_ITEM, Some(app_glyph())).is_ok(),
        (false, true) => {
            app.remove_tray_by_id(APP_ITEM);
        }
        _ => {}
    }
    state.available.store(ok, Ordering::Relaxed);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || draw(&app));
}

fn add(app: &AppHandle, id: &str, icon: Option<Icon>) -> tauri::Result<()> {
    // The item's own tab; the app's item opens on memory.
    let res = Res::from_id(id).unwrap_or(Res::Mem);
    let open = MenuItem::with_id(app, "open", "Open Lima Desktop", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Lima Desktop", true, None::<&str>)?;
    // Linux tells of no clicks on an item, only of its menu: the popover is opened from there.
    #[cfg(not(target_os = "macos"))]
    let popover = MenuItem::with_id(app, "popover", "Memory, CPU and Disk…", true, None::<&str>)?;
    #[cfg(not(target_os = "macos"))]
    let items: &[&dyn tauri::menu::IsMenuItem<tauri::Wry>] = &[&popover, &open, &separator, &quit];
    #[cfg(target_os = "macos")]
    let items: &[&dyn tauri::menu::IsMenuItem<tauri::Wry>] = &[&open, &separator, &quit];
    let menu = Menu::with_items(app, items)?;
    let mut b = TrayIconBuilder::with_id(id)
        .tooltip("Lima Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, e| match e.id().as_ref() {
            "popover" => open_popover(app, res, None),
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

/// What an item shows, kept so that a tick changes only what has changed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Shown {
    pub icon: Option<Icon>,
    pub template: bool,
    /// The image while the item is highlighted (pressed, or its menu open), for when macOS can't
    /// invert it as it does a template image: a warning item's, drawn as for the other menu bar.
    pub highlighted: Option<Icon>,
    pub title: Option<String>,
    pub tooltip: Option<String>,
}

/// What an item shows, from its recent shares and whether it warns (`hot`): on macOS one image, the
/// figure and name in it.
pub fn shown(res: Res, p: Parts, history: &[Share], hot: bool, bar: Bar) -> Shown {
    let now = history.last().copied();
    #[cfg(target_os = "macos")]
    let (icon, title) = (Some(item(res, p, history, hot, bar)), None);
    #[cfg(not(target_os = "macos"))]
    let (icon, title) = (
        // Linux shows no title without an image: one with only its figure has the app's.
        drawing_in(p.drawing, history, bar.paint(hot)).or_else(|| Some(glyph_on(bar))),
        p.figure.then(|| title(res, now, p.name_under)),
    );
    // Highlighted, macOS inverts a template image itself; one that warns is drawn again, inverted.
    #[cfg(target_os = "macos")]
    let highlighted = hot.then(|| item(res, p, history, hot, bar.inverted()));
    #[cfg(not(target_os = "macos"))]
    let highlighted = None;
    Shown { icon, template: ink(hot).1, highlighted, title, tooltip: now.map(|s| tooltip(res, s)) }
}

/// Redraws every item, changing only what has changed. Never on the main thread: each change
/// waits for it, so the lock on what's shown would deadlock with an `apply` there.
fn draw(app: &AppHandle) {
    let chosen = app.state::<Saved>().get().menu_bar;
    let state = app.state::<State>();
    let history = state.history.lock().expect("menu bar lock").clone();
    let mut drawn = state.drawn.lock().expect("menu bar lock");
    for res in RESOURCES {
        let (Some(tray), Some(p)) = (app.tray_by_id(res.id()), parts(res.item(&chosen), chosen.names)) else {
            continue;
        };
        let h: Vec<Share> = history[res.index()].iter().copied().collect();
        // As Settings has it now, so a change there shows at once.
        let hot = warns(&h, res.threshold(&chosen.warn));
        // On macOS only an item that warns needs to know (and asking is a trip to the main thread);
        // a Linux panel tints nothing, so there every item does.
        let bar = if hot || cfg!(not(target_os = "macos")) { appearance(&tray) } else { Bar::default() };
        let new = shown(res, p, &h, hot, bar);
        // An item put in the menu bar again since it was last drawn starts empty.
        let added = state.added[res.index()].load(Ordering::Relaxed);
        let old = match drawn[res.index()].take() {
            Some((at, old)) if at == added => old,
            _ => Shown::default(),
        };
        let result = (|| -> tauri::Result<()> {
            // The image and whether it's a template in one call: `set_icon` makes it not a
            // template, and macOS can show it for a frame, untinted, before
            // `set_icon_as_template` makes it one again (black on a dark menu bar: a flash).
            if (&new.icon, new.template) != (&old.icon, old.template) {
                let image = new.icon.clone().map(|i| Image::new_owned(i.rgba, i.width, i.height));
                tray.set_icon_with_as_template(image, new.template)?;
            }
            if new.highlighted != old.highlighted {
                set_highlighted(&tray, new.highlighted.as_ref())?;
            }
            if new.title != old.title {
                tray.set_title(new.title.as_deref())?;
            }
            if new.tooltip != old.tooltip && new.tooltip.is_some() {
                tray.set_tooltip(new.tooltip.as_deref())?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => drawn[res.index()] = Some((added, new)),
            Err(e) => log::warn!("can't redraw {} in the menu bar: {e}", res.id()),
        }
    }
}

/// The appearance of the menu bar `tray` is in: its button's, which follows the menu bar's (dark
/// or light, with the wallpaper behind it), not the app's.
#[cfg(target_os = "macos")]
fn appearance(tray: &tauri::tray::TrayIcon) -> Bar {
    use objc2_app_kit::NSAppearanceCustomization;
    let dark = tray.with_inner_tray_icon(|t| {
        let mtm = objc2::MainThreadMarker::new()?;
        let name = t.ns_status_item()?.button(mtm)?.effectiveAppearance().name();
        Some(name.to_string().contains("Dark"))
    });
    match dark {
        Ok(Some(false)) => Bar::Light,
        _ => Bar::Dark,
    }
}

#[cfg(not(target_os = "macos"))]
fn appearance(_: &tauri::tray::TrayIcon) -> Bar {
    desktop_bar()
}

/// The app's glyph, for its item when no other is chosen: a template image on macOS, painted for
/// the panel elsewhere.
#[cfg(target_os = "macos")]
fn app_glyph() -> Icon {
    glyph()
}
#[cfg(not(target_os = "macos"))]
fn app_glyph() -> Icon {
    glyph_on(desktop_bar())
}

/// The panel a Linux desktop shows its tray items on, from its name (`XDG_CURRENT_DESKTOP`, as
/// "ubuntu:GNOME") and the colour scheme its portal says (1 dark, 2 light, 0 no preference; None
/// with no portal). Dark unless it says light, as most panels are; GNOME's top bar is dark in both.
#[cfg(any(not(target_os = "macos"), test))]
fn panel_bar(desktop: &str, scheme: Option<u32>) -> Bar {
    if desktop.split(':').any(|d| d.eq_ignore_ascii_case("GNOME")) {
        return Bar::Dark;
    }
    match scheme {
        Some(2) => Bar::Light,
        _ => Bar::Dark,
    }
}

/// [`panel_bar`] for this desktop, asked again at most every half minute, as a change of theme is
/// rare and each tick redraws every item.
#[cfg(not(target_os = "macos"))]
fn desktop_bar() -> Bar {
    static LAST: Mutex<Option<(Instant, Bar)>> = Mutex::new(None);
    let mut last = LAST.lock().expect("panel lock");
    if let Some((at, bar)) = *last
        && at.elapsed() < Duration::from_secs(30)
    {
        return bar;
    }
    let bar = panel_bar(&std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default(), portal_color_scheme());
    *last = Some((Instant::now(), bar));
    bar
}

/// The colour scheme the desktop's settings portal says (`org.freedesktop.appearance`), if there's
/// one to ask; given up on after a moment, so a stuck portal can't hold up the items.
#[cfg(not(target_os = "macos"))]
fn portal_color_scheme() -> Option<u32> {
    use zbus::zvariant::Value;
    // `Read` gives the value in a variant, and older portals in a variant in that.
    fn number(v: &Value) -> Option<u32> {
        match v {
            Value::U32(n) => Some(*n),
            Value::Value(inner) => number(inner),
            _ => None,
        }
    }
    let bus =
        zbus::blocking::connection::Builder::session().ok()?.method_timeout(Duration::from_secs(2)).build().ok()?;
    let reply = bus
        .call_method(
            Some("org.freedesktop.portal.Desktop"),
            "/org/freedesktop/portal/desktop",
            Some("org.freedesktop.portal.Settings"),
            "Read",
            &("org.freedesktop.appearance", "color-scheme"),
        )
        .ok()?;
    let value: zbus::zvariant::OwnedValue = reply.body().deserialize().ok()?;
    number(&value)
}

/// The image `tray` shows while it's highlighted (pressed, or its menu open): `icon`, else its own,
/// as macOS shows it then (a template image inverted, any other as it is). It's the button's
/// alternate image, at the size Tauri gives its image (18 points tall), which its cell shows only
/// while it highlights its contents: on a status item, by default, it highlights nothing itself.
#[cfg(target_os = "macos")]
fn set_highlighted(tray: &tauri::tray::TrayIcon, icon: Option<&Icon>) -> tauri::Result<()> {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSButtonCell, NSCellStyleMask, NSImage};
    use objc2_foundation::{NSData, NSSize};
    let png = match icon {
        Some(i) => {
            let mut png = Vec::new();
            let mut e = png::Encoder::new(&mut png, i.width, i.height);
            e.set_color(png::ColorType::Rgba);
            e.set_depth(png::BitDepth::Eight);
            e.write_header().and_then(|mut w| w.write_image_data(&i.rgba)).map_err(std::io::Error::from)?;
            Some((png, NSSize::new(f64::from(i.width) * 18.0 / f64::from(i.height), 18.0)))
        }
        None => None,
    };
    tray.with_inner_tray_icon(move |t| {
        let mtm = objc2::MainThreadMarker::new()?;
        let button = t.ns_status_item()?.button(mtm)?;
        let image = png.and_then(|(png, size)| {
            let image = NSImage::initWithData(NSImage::alloc(), &NSData::from_vec(png))?;
            image.setSize(size);
            Some(image)
        });
        button.setAlternateImage(image.as_deref());
        let cell = button.cell()?.downcast::<NSButtonCell>().ok()?;
        let mut by = cell.highlightsBy();
        by.set(NSCellStyleMask::ContentsCellMask, image.is_some());
        cell.setHighlightsBy(by);
        Some(())
    })?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn set_highlighted(_: &tauri::tray::TrayIcon, _: Option<&Icon>) -> tauri::Result<()> {
    Ok(())
}

/// Shows the popover under the item clicked, on its tab; a second click on the same item hides it.
/// The window is built once and then only hidden and shown again, so its page isn't loaded again
/// each time (in the dark, a new window flashed white first).
fn toggle_popover(app: &AppHandle, res: Res, rect: tauri::Rect) {
    let state = app.state::<State>();
    let window = app.get_webview_window(POPOVER);
    let shown = window.as_ref().is_some_and(|w| w.is_visible().unwrap_or(false));
    let popover = *state.popover.lock().expect("popover lock");
    match popover.click(res, shown, Instant::now()) {
        Click::Nothing => {}
        Click::Hide => hide_popover(app),
        Click::Show => open_popover(app, res, Some(rect)),
    }
}

/// Shows the popover on `res`'s tab, under the item at `item` (none: see [`place_alone`]), making
/// its window the first time.
fn open_popover(app: &AppHandle, res: Res, item: Option<tauri::Rect>) {
    let w = match app.get_webview_window(POPOVER).map_or_else(|| build_popover(app, res), Ok) {
        Ok(w) => w,
        Err(e) => {
            log::warn!("can't open the menu bar's popover: {e}");
            return;
        }
    };
    show_popover(app, &w, res, item);
}

/// The popover's window, hidden until it's put under an item. Its page opens on `res`'s tab; it's
/// told another tab with an event each time it's shown.
fn build_popover(app: &AppHandle, res: Res) -> tauri::Result<tauri::WebviewWindow> {
    let theme = app.state::<Saved>().get().theme.native();
    let url = WebviewUrl::App(format!("menubar?tab={}", res.id()).into());
    let w = WebviewWindowBuilder::new(app, POPOVER, url)
        .title("Lima Desktop")
        .inner_size(POPOVER_WIDTH, 560.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(true)
        .visible(false)
        .theme(theme)
        // Until the page paints, in the theme's background (the page's --bg), not white. The system's
        // light or dark is only known once there's a window: `show_popover` sets it again.
        .background_color(background(theme.unwrap_or(tauri::Theme::Light)))
        .build()?;
    let handle = app.clone();
    w.on_window_event(move |e| {
        if let tauri::WindowEvent::Focused(false) = e {
            hide_popover(&handle);
        }
    });
    Ok(w)
}

/// The page's background (`--bg` in routes/+layout.svelte), light or dark.
fn background(theme: tauri::Theme) -> tauri::window::Color {
    match theme {
        tauri::Theme::Dark => tauri::window::Color(0x11, 0x14, 0x18, 0xff),
        _ => tauri::window::Color(0xff, 0xff, 0xff, 0xff),
    }
}

/// What the popover's page is told as it's shown: which tab, and the theme Settings has now.
#[derive(Clone, serde::Serialize)]
struct PopoverShown {
    tab: &'static str,
    theme: crate::settings::Theme,
}

/// A rectangle on the screens.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Area {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Area {
    fn holds(&self, x: f64, y: f64) -> bool {
        (self.x..self.x + self.w).contains(&x) && (self.y..self.y + self.h).contains(&y)
    }
    fn scaled(self, by: f64) -> Area {
        Area { x: self.x / by, y: self.y / by, w: self.w / by, h: self.h / by }
    }
}

/// Between the popover and its item, and the popover and a screen's edge (points).
const GAP: f64 = 4.0;

/// Where the popover goes: centred under `item`, kept whole on `screen` (a screen left of the main
/// one has negative coordinates). All in points: the one measure every screen shares.
fn place(item: Area, screen: Area) -> (f64, f64) {
    let x = item.x + item.w / 2.0 - POPOVER_WIDTH / 2.0;
    let x = x.clamp(screen.x + GAP, (screen.x + screen.w - POPOVER_WIDTH - GAP).max(screen.x + GAP));
    (x, item.y + item.h + GAP)
}

/// Where the popover goes with no item to go under (on Linux, opened from a menu): the top right of
/// the screen's work area (points).
fn place_alone(work_area: Area) -> (f64, f64) {
    let corner = Area { x: work_area.x + work_area.w, y: work_area.y, w: 0.0, h: 0.0 };
    place(corner, work_area)
}

/// A screen: its area in points, and how many pixels make a point on it.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Screen {
    area: Area,
    scale: f64,
}

/// The screen a menu bar item is on, by the pointer that clicked it (`pointer`, in points), else
/// the first whose area holds the item's middle.
///
/// On macOS "physical" pixels mean something different on each screen: a screen's position, and the
/// item's rect, are their points times that screen's own scale. So an item at 1000 pt on a 2x
/// laptop is said to be at 2000 px, which a 1x screen to its right starting at 1512 pt also holds.
/// The pointer is said at the main screen's scale wherever it is, so in points it's unambiguous.
fn item_screen(screens: &[Screen], item: Area, pointer: Option<(f64, f64)>) -> Option<usize> {
    if let Some(i) = pointer.and_then(|(x, y)| screens.iter().position(|s| s.area.holds(x, y))) {
        return Some(i);
    }
    screens.iter().position(|s| {
        let i = item.scaled(s.scale);
        s.area.holds(i.x + i.w / 2.0, i.y + i.h / 2.0)
    })
}

/// A monitor's whole screen, or its work area (less the menu bar, panels and Dock), in points.
fn screen_of(m: &tauri::Monitor, work: bool) -> Screen {
    let (x, y, w, h) = if work {
        let a = m.work_area();
        (a.position.x, a.position.y, a.size.width, a.size.height)
    } else {
        (m.position().x, m.position().y, m.size().width, m.size().height)
    };
    let scale = m.scale_factor();
    Screen { area: Area { x: x.into(), y: y.into(), w: w.into(), h: h.into() }.scaled(scale), scale }
}

/// Puts the popover where it goes ([`place`]), on its item's screen, or with no item
/// ([`place_alone`]), on the main one.
///
/// In points, as a `LogicalPosition`: tao turns a physical position into points at the scale of
/// the screen the window is on *now*. The popover, hidden, is still on the screen it was last shown
/// on, so the first time it opened on a screen of another scale it went to the wrong place.
fn position_popover(app: &AppHandle, w: &tauri::WebviewWindow, item: Option<tauri::Rect>) {
    let monitors = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten();
    let (x, y) = match item {
        Some(rect) => {
            let screens: Vec<Screen> = monitors.iter().map(|m| screen_of(m, false)).collect();
            // The tray says physical pixels (at its own screen's scale); the main screen's scale only
            // matters were it to say points.
            let main_scale = primary.as_ref().map_or(1.0, |m| m.scale_factor());
            let pos = rect.position.to_physical::<f64>(main_scale);
            let size = rect.size.to_physical::<f64>(main_scale);
            let item = Area { x: pos.x, y: pos.y, w: size.width, h: size.height };
            let pointer = app.cursor_position().ok().map(|p| (p.x / main_scale, p.y / main_scale));
            let screen = match item_screen(&screens, item, pointer) {
                Some(i) => screens[i],
                None => match primary.as_ref() {
                    Some(m) => screen_of(m, false),
                    None => return,
                },
            };
            place(item.scaled(screen.scale), screen.area)
        }
        None => {
            let Some(m) = primary.as_ref().or(monitors.first()) else { return };
            place_alone(screen_of(m, true).area)
        }
    };
    let _ = w.set_position(tauri::LogicalPosition::new(x.round(), y.round()));
}

/// Puts the popover under the item at `item` (none: see [`place_alone`]), on `res`'s tab, and gives
/// it the focus: losing it hides the popover again, and WebKit follows the pointer (for hover) only
/// in the key window of the active app. `set_focus` makes it key and asks for the app to be
/// activated; macOS may say no to an activation that doesn't follow the person's own click.
fn show_popover(app: &AppHandle, w: &tauri::WebviewWindow, res: Res, item: Option<tauri::Rect>) {
    use tauri::Emitter as _;
    position_popover(app, w, item);
    if let Ok(t) = w.theme() {
        let _ = w.set_background_color(Some(background(t)));
    }
    let shown = PopoverShown { tab: res.id(), theme: app.state::<Saved>().get().theme };
    if let Err(e) = w.emit_to(POPOVER, "popover-shown", shown) {
        log::warn!("can't tell the popover its tab: {e}");
    }
    // Before it's shown: should it lose the focus at once, it's hidden as open on this item.
    app.state::<State>().popover.lock().expect("popover lock").open_on = Some(res);
    let _ = w.show();
    // Once more, now it's on its screen: should the move have left it at another screen's scale
    // (the cause of the popover opening out of place, fixed above), it's put right before it's seen
    // for long. Where it already is, this moves nothing.
    position_popover(app, w, item);
    let _ = w.set_focus();
}

/// Hides the popover (its page stops fetching while it's hidden), remembering on which item.
fn hide_popover(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(POPOVER) {
        let _ = w.hide();
    }
    let state = app.state::<State>();
    let mut p = state.popover.lock().expect("popover lock");
    *p = p.hidden(Instant::now());
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

/// The main window has closed. If the app keeps recording, it leaves the Dock (and the app switcher)
/// until it's opened again, as a menu bar app does; otherwise it quits. Tauri would quit only once
/// every window was gone, and the popover's, once opened, is hidden, never closed.
pub fn main_closed(app: &AppHandle) {
    if keeps_running(app) {
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    } else {
        app.exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::StackVm;

    fn px(i: &Icon, x: u32, y: u32) -> [u8; 4] {
        let k = ((y * i.width + x) * 4) as usize;
        i.rgba[k..k + 4].try_into().unwrap()
    }

    /// A screen at `x`, 1000 by 800 points.
    fn screen_at(x: f64) -> Area {
        Area { x, y: 0.0, w: 1000.0, h: 800.0 }
    }

    #[test]
    fn the_popover_goes_centred_under_its_item() {
        let item = Area { x: 480.0, y: 0.0, w: 40.0, h: 24.0 };
        assert_eq!(place(item, screen_at(0.0)), (500.0 - POPOVER_WIDTH / 2.0, 24.0 + GAP));
        let (x, _) = place(Area { x: 960.0, y: 0.0, w: 80.0, h: 24.0 }, screen_at(0.0));
        assert_eq!(x, 1000.0 - POPOVER_WIDTH - GAP, "kept whole on its screen");
    }

    // A screen left of the main one has negative coordinates: the popover stays on it.
    #[test]
    fn the_popover_stays_on_its_items_screen() {
        let item = Area { x: -1000.0, y: 0.0, w: 40.0, h: 24.0 };
        assert_eq!(place(item, screen_at(-1000.0)).0, -1000.0 + GAP);
        let item = Area { x: -30.0, y: 0.0, w: 20.0, h: 24.0 };
        assert_eq!(place(item, screen_at(-1000.0)).0, -POPOVER_WIDTH - GAP);
    }

    #[test]
    fn with_no_item_the_popover_goes_top_right() {
        let screen = Area { x: 1000.0, y: 30.0, w: 1000.0, h: 770.0 };
        assert_eq!(place_alone(screen), (2000.0 - POPOVER_WIDTH - GAP, 30.0 + GAP));
    }

    // A 2x laptop (1512 pt wide) with a 1x screen to its right. macOS says each one's pixels at its
    // own scale: an item at 1000 pt on the laptop is at 2000 px, inside the other's 1512–3432 too.
    #[test]
    fn an_item_is_on_the_screen_under_the_pointer_in_points() {
        let laptop = Screen { area: Area { x: 0.0, y: 0.0, w: 1512.0, h: 982.0 }, scale: 2.0 };
        let external = Screen { area: Area { x: 1512.0, y: 0.0, w: 1920.0, h: 1080.0 }, scale: 1.0 };
        let screens = [external, laptop];
        let on_laptop = Area { x: 2000.0, y: 0.0, w: 60.0, h: 48.0 };
        assert_eq!(item_screen(&screens, on_laptop, Some((1015.0, 12.0))), Some(1));
        let on_external = Area { x: 2000.0, y: 0.0, w: 30.0, h: 24.0 };
        assert_eq!(item_screen(&screens, on_external, Some((2015.0, 12.0))), Some(0));
        // Without the pointer, the first screen holding the item's middle at its own scale.
        assert_eq!(item_screen(&[laptop, external], on_laptop, None), Some(0));
        assert_eq!(item_screen(&[laptop], Area { x: 4000.0, y: 0.0, w: 10.0, h: 10.0 }, None), None);
        // And it goes under the item in points, on that screen: centred under 1015 pt.
        let (x, y) = place(on_laptop.scaled(laptop.scale), laptop.area);
        assert_eq!((x, y), (1015.0 - POPOVER_WIDTH / 2.0, 24.0 + GAP));
        // Near the external screen's right edge, kept whole on it.
        let (x, _) = place(Area { x: 3400.0, y: 0.0, w: 30.0, h: 24.0 }, external.area);
        assert_eq!(x, 3432.0 - POPOVER_WIDTH - GAP);
    }

    /// A share with nothing said about what's left of the computer.
    fn used(whole: f32, vms: f32) -> Share {
        Share { whole, vms, ..Share::default() }
    }

    #[test]
    fn saved_measurements_become_shares_oldest_first_where_the_computer_was_measured() {
        let vm = |avg: Vec<Option<i64>>| StackVm { name: "a".into(), avg, peak: None };
        let stack = Stack {
            ts: vec![1, 2, 3],
            used: vec![Some(50), None, Some(80)],
            total: vec![Some(100), None, Some(100)],
            wired: None,
            // One VM measured throughout, another only in the last (stopped before).
            vms: vec![vm(vec![Some(20), Some(30), Some(10)]), vm(vec![None, None, Some(15)])],
        };
        let s = saved_shares(&stack);
        assert_eq!(s.len(), 2);
        assert_eq!((s[0].whole, s[0].vms, s[0].free), (0.5, 0.2, 50));
        assert_eq!((s[1].whole, s[1].vms, s[1].free), (0.8, 0.25, 20));
        assert!(saved_shares(&Stack::default()).is_empty());
    }

    #[test]
    fn a_restart_carries_on_each_trace_from_the_last_saved() {
        use crate::store::{ABSENT, HOST_METRICS, Kind, Store, VM_METRICS};
        let mut s = Store::in_memory().unwrap();
        let host = s.entity(Kind::Host, "", "host", "this computer", 0).unwrap();
        let vm = s.entity(Kind::Vm, "a", "a", "a", 0).unwrap();
        let col = |m: &str| HOST_METRICS.iter().position(|c| *c == m).unwrap();
        let t = 10 * 60_000;
        for i in 0..90 {
            let mut h = vec![ABSENT; HOST_METRICS.len()];
            (h[col("mem_used")], h[col("mem_total")]) = (i, 100);
            (h[col("cpu_mc")], h[col("cpu_total_mc")]) = (i, 100);
            (h[col("disk_used")], h[col("disk_total")]) = (50, 100);
            s.ingest(host, t + i * 1000, h);
        }
        // Stopped all the first minute: its disk image, saved once for it, as the collector does.
        let mut v = vec![ABSENT; VM_METRICS.len()];
        v[VM_METRICS.iter().position(|c| *c == "host_disk_alloc").unwrap()] = 20;
        s.ingest(vm, t + 60_000 - 1, v);
        s.saw(vm, t + 90_000); // still there, as the collector says at each list
        s.flush(t + 90_000).unwrap();
        let to = t + 90_000;
        for res in [Res::Mem, Res::Cpu] {
            let h = saved_history(&mut s, res, to, 1);
            assert_eq!(h.len(), COLUMNS);
            assert_eq!(h.back().unwrap().whole, 0.89); // the newest
            assert_eq!(h.back().unwrap().vms, 0.0); // stopped, it takes none
        }
        // Every column has the stopped VM's image, held since it was saved.
        let disk = saved_history(&mut s, Res::Disk, to, 1);
        assert_eq!(disk.len(), COLUMNS);
        assert!(disk.iter().all(|d| (d.whole, d.vms) == (0.5, 0.2)));
        // Saved longer ago than the span: a fresh start.
        assert!(saved_history(&mut s, Res::Mem, to + SAVED_SPAN.as_millis() as i64 + 60_000, 1).is_empty());
    }

    #[test]
    fn the_top_edge_stays_solid_where_the_vms_are_nearly_all_of_it() {
        // Inside, 32 px: the whole 16, the VMs 15.7, both 16 rounded.
        let i = trace(&[used(0.5, 0.49)]);
        let x = i.width - FRAME - 1;
        let top = H - FRAME - 16;
        assert_eq!(px(&i, x, top)[3], SOLID);
        assert_eq!(px(&i, x, top + FRAME - 1)[3], SOLID);
        assert_eq!(px(&i, x, top + FRAME)[3], PALE);
        // Under a line's worth in all, all solid.
        let i = trace(&[used(0.03, 0.03)]);
        assert_eq!(px(&i, x, H - FRAME - 1)[3], SOLID);
    }

    #[test]
    fn a_share_is_of_the_whole_computer_and_the_vms_never_exceed_it() {
        let s = share(Some(48), Some(64), [16, 8, -1].into_iter()).unwrap();
        assert_eq!(s, Share { whole: 0.75, vms: 0.375, free: 16 });
        // Read a moment apart, the VMs can come out above the computer: they're capped.
        assert_eq!(share(Some(10), Some(100), [30].into_iter()).unwrap().vms, 0.1);
        // And the computer above its total: nothing is left, not less than nothing.
        assert_eq!(share(Some(70), Some(64), std::iter::empty()).unwrap().free, 0);
        assert_eq!(share(None, Some(64), std::iter::empty()), None);
        assert_eq!(share(Some(-1), Some(64), std::iter::empty()), None);
        assert_eq!(share(Some(1), Some(0), std::iter::empty()), None);
    }

    #[test]
    fn memory_and_cpu_warn_past_the_percent_chosen_in_settings() {
        let at = |used, of| share(Some(used), Some(of), std::iter::empty()).unwrap();
        let w = Warn::default();
        assert!(!at(48, 64).hot(Res::Mem.threshold(&w)));
        assert!(at(49, 64).hot(Res::Mem.threshold(&w)));
        assert!(at(49, 64).hot(Res::Cpu.threshold(&w)));
        let w = Warn { memory_pct: Some(50), cpu_pct: None, ..Warn::default() };
        assert!(!at(32, 64).hot(Res::Mem.threshold(&w)));
        assert!(at(33, 64).hot(Res::Mem.threshold(&w)));
        // Never: not even when it's all in use.
        assert!(!at(64, 64).hot(Res::Cpu.threshold(&w)));
    }

    #[test]
    fn the_disk_warns_under_the_free_space_chosen_in_settings_whatever_its_size() {
        const GB: i64 = 1_000_000_000;
        let at = |used, of| share(Some(used * GB), Some(of * GB), std::iter::empty()).unwrap();
        let disk = |gb| Res::Disk.threshold(&Warn { disk_free_gb: gb, ..Warn::default() });
        // 90 % of a 1 TB disk still leaves 100 GB; 86 % of a 256 GB one only 36.
        assert!(!at(900, 1000).hot(disk(Some(50))));
        assert!(at(220, 256).hot(disk(Some(50))));
        assert!(!at(950, 1000).hot(disk(Some(50))), "exactly 50 GB is not under 50 GB");
        assert!(at(951, 1000).hot(disk(Some(50))));
        assert!(at(900, 1000).hot(disk(Some(200))));
        assert!(!at(1000, 1000).hot(disk(None)));
    }

    #[test]
    fn the_figure_is_the_whole_computer_as_a_percent() {
        let s = used(0.704, 0.5);
        assert_eq!(figure(Some(s)), "70%");
        assert_eq!(figure(None), "–");
        assert_eq!(title(Res::Mem, Some(s), false), "70%");
        assert_eq!(title(Res::Cpu, Some(s), true), "cpu 70%");
        assert_eq!(title(Res::Disk, Some(used(1.0, 0.0)), true), "disk 100%");
        assert_eq!(title(Res::Disk, None, true), "disk –");
    }

    fn item(drawing: Drawing, figure: bool) -> Item {
        Item { drawing, figure }
    }

    #[test]
    fn an_item_with_neither_a_drawing_nor_a_figure_is_not_there() {
        assert_eq!(parts(item(Drawing::Off, false), true), None);
        assert_eq!(parts(item(Drawing::Off, false), false), None);
    }

    #[test]
    fn a_name_goes_under_the_figure_or_on_its_side_beside_a_drawing_alone() {
        let p = |d, f, names| parts(item(d, f), names).unwrap();
        let under = p(Drawing::Trace, true, true);
        assert!(under.figure && under.name_under && !under.side_name);
        let side = p(Drawing::Bar, false, true);
        assert!(!side.figure && !side.name_under && side.side_name);
        let figure_alone = p(Drawing::Off, true, true);
        assert!(figure_alone.name_under && !figure_alone.side_name);
        let unnamed = p(Drawing::Trace, true, false);
        assert!(!unnamed.name_under && !unnamed.side_name);
        assert!(!p(Drawing::Trace, false, false).side_name);
    }

    const MEASURES: Measures = Measures { figure: 51.3, name: 24.0, side: 20.0, side_cap: 9.1, side_descent: 2.6 };

    #[test]
    fn the_figure_has_the_room_of_a_hundred_percent_after_the_drawing() {
        let l = layout(parts(item(Drawing::Trace, true), false).unwrap(), MEASURES);
        assert_eq!(l.drawing, Some(0));
        let fig = l.figure.unwrap();
        assert_eq!(fig.x, (TRACE_WIDTH + FIGURE_GAP) as f64);
        assert_eq!(l.width, TRACE_WIDTH + FIGURE_GAP + 52);
        assert_eq!((l.name_under, l.side_name), (None, None));
        // The digits centred top to bottom.
        assert!(fig.y > H as f64 / 2.0 && fig.y < H as f64);
    }

    #[test]
    fn a_name_under_the_figure_shares_its_left_edge_and_the_wider_one_sets_the_room() {
        let l = layout(parts(item(Drawing::Bar, true), true).unwrap(), MEASURES);
        let (fig, name) = (l.figure.unwrap(), l.name_under.unwrap());
        assert_eq!(fig.x, name.x);
        assert!(fig.y < name.y && name.y < H as f64);
        assert_eq!(l.width, BAR_WIDTH + FIGURE_GAP + 52);
        let wide = layout(parts(item(Drawing::Off, true), true).unwrap(), Measures { name: 60.2, ..MEASURES });
        assert_eq!((wide.drawing, wide.figure.unwrap().x, wide.width), (None, 0.0, 61));
    }

    #[test]
    fn a_name_on_its_side_comes_first_centred_top_to_bottom() {
        let l = layout(parts(item(Drawing::Trace, false), true).unwrap(), MEASURES);
        let side = l.side_name.unwrap();
        // Its capitals reach left from the baseline, to the item's edge.
        assert_eq!(side.x, MEASURES.side_cap);
        // It reads upwards, from a start as far from the bottom as its end is from the top.
        assert_eq!(side.y, (H as f64 + MEASURES.side) / 2.0);
        let at = 12 + SIDE_GAP;
        assert_eq!(l.drawing, Some(at));
        assert_eq!(l.width, at + TRACE_WIDTH);
        assert_eq!(l.figure, None);
    }

    #[test]
    fn a_trace_draws_the_vms_pale_under_everything_else_solid_newest_at_the_right() {
        // Inside, 32 px: the whole 16, the VMs 4 of them.
        let i = trace(&[used(0.5, 0.125)]);
        assert_eq!((i.width, i.height, i.rgba.len()), (48, 36, 48 * 36 * 4));
        let x = i.width - FRAME - 1; // the newest column
        let bottom = H - FRAME;
        assert_eq!(px(&i, x, bottom - 1), [0, 0, 0, PALE]); // VMs, at the bottom
        assert_eq!(px(&i, x, bottom - 5), [0, 0, 0, SOLID]); // everything else, above them
        assert_eq!(px(&i, x, bottom - 16), [0, 0, 0, SOLID]); // up to the whole
        assert_eq!(px(&i, x, bottom - 17), [0, 0, 0, 0]); // free
        assert_eq!(px(&i, FRAME, bottom - 1), [0, 0, 0, 0]); // no older measurement yet
        assert_eq!(px(&i, 0, 0)[3], SOLID); // the frame
    }

    #[test]
    fn with_no_vms_running_the_whole_is_solid() {
        let i = trace(&[used(0.5, 0.0)]);
        let x = i.width - FRAME - 1;
        assert_eq!(px(&i, x, H - FRAME - 1)[3], SOLID);
    }

    #[test]
    fn columns_touch_with_no_gap() {
        let full = used(1.0, 0.0);
        let i = trace(&[full; COLUMNS]);
        let y = H / 2;
        assert!((FRAME..i.width - FRAME).all(|x| px(&i, x, y)[3] == SOLID));
    }

    #[test]
    fn a_column_is_one_point_wide() {
        // Two pixels, as the items are drawn at twice the menu bar's points: the newest alone, at the right.
        let mut h = vec![Share::default(); COLUMNS - 1];
        h.push(used(1.0, 0.0));
        let i = trace(&h);
        let inked: Vec<u32> = (FRAME..i.width - FRAME).filter(|&x| px(&i, x, H / 2)[3] == SOLID).collect();
        assert_eq!(inked, [i.width - FRAME - 2, i.width - FRAME - 1]);
    }

    #[test]
    fn only_the_last_columns_are_drawn() {
        let mut h = vec![used(1.0, 1.0)];
        h.extend(std::iter::repeat_n(Share::default(), COLUMNS));
        let i = trace(&h);
        assert!((FRAME..i.width - FRAME).all(|x| px(&i, x, H / 2)[3] == 0));
    }

    #[test]
    fn when_it_warns_it_is_drawn_in_the_warning_colour_and_not_tinted() {
        assert_eq!(ink(true), (HOT, false));
        assert_eq!(ink(false), (INK, true));
        let now = [used(0.9, 0.5)];
        for d in [Drawing::Trace, Drawing::Bar] {
            assert_eq!(&px(&drawing(d, &now, true).unwrap(), 0, 0)[..3], &HOT);
            assert_eq!(&px(&drawing(d, &now, false).unwrap(), 0, 0)[..3], &INK);
        }
        assert_eq!(&trace(&now).rgba[..3], &INK);
    }

    #[test]
    fn an_item_warns_when_its_newest_share_is_past_its_threshold() {
        let past = Threshold::Past(0.75);
        assert!(warns(&[used(0.9, 0.5), used(0.8, 0.5)], past));
        // The newest measurement only.
        assert!(!warns(&[used(0.9, 0.5), used(0.7, 0.5)], past));
        assert!(!warns(&[], past));
        assert!(!warns(&[used(1.0, 1.0)], Threshold::Never));
    }

    #[test]
    fn a_click_shows_the_popover_and_a_second_on_the_same_item_hides_it() {
        let t = Instant::now();
        let none = Popover::default();
        assert_eq!(none.click(Res::Mem, false, t), Click::Show);
        let on_mem = Popover { open_on: Some(Res::Mem), closed: None };
        assert_eq!(on_mem.click(Res::Mem, true, t), Click::Hide);
        // Another item's click moves it there, on that tab.
        assert_eq!(on_mem.click(Res::Cpu, true, t), Click::Show);
    }

    #[test]
    fn the_click_that_took_the_focus_away_leaves_it_hidden() {
        let t = Instant::now();
        let hidden = Popover { open_on: Some(Res::Mem), closed: None }.hidden(t);
        assert_eq!(hidden, Popover { open_on: None, closed: Some((Res::Mem, t)) });
        assert_eq!(hidden.click(Res::Mem, false, t + Duration::from_millis(50)), Click::Nothing);
        assert_eq!(hidden.click(Res::Cpu, false, t + Duration::from_millis(50)), Click::Show);
        assert_eq!(hidden.click(Res::Mem, false, t + CLICK_HID_IT), Click::Show);
        // Hidden again while hidden (it loses the focus as it's hidden): still the first time.
        assert_eq!(hidden.hidden(t + Duration::from_secs(1)), hidden);
    }

    #[test]
    fn a_bar_is_notched_at_quarters() {
        let i = bar(used(1.0, 0.0));
        assert_eq!(i.width, BAR_WIDTH);
        let inside = H - 2 * FRAME;
        let notch = H - FRAME - inside / 2;
        assert_eq!(px(&i, BAR_WIDTH / 2, notch)[3], 0);
        assert_eq!(px(&i, BAR_WIDTH / 2, notch + 3)[3], SOLID);
    }

    #[test]
    fn before_a_measurement_a_drawing_is_its_frame() {
        let i = drawing(Drawing::Bar, &[], false).unwrap();
        assert_eq!(px(&i, 0, H / 2)[3], SOLID);
        assert_eq!(px(&i, BAR_WIDTH / 2, H - FRAME - 1)[3], 0);
        assert_eq!(drawing(Drawing::Off, &[], false), None);
    }

    #[test]
    fn the_app_glyph_is_a_template_image_that_fills_the_height() {
        let g = glyph();
        assert_eq!(g.height, H);
        assert!(g.width > 8 && g.width < H);
        assert!(g.rgba.chunks(4).all(|p| p[..3] == INK));
        let rows: Vec<u32> = (0..H).filter(|&y| (0..g.width).any(|x| px(&g, x, y)[3] > 128)).collect();
        assert!(rows.len() > 20, "{} rows inked", rows.len());
    }

    /// Covered pixels in a region of an item.
    #[cfg(target_os = "macos")]
    fn ink_in(i: &Icon, xs: std::ops::Range<u32>, ys: std::ops::Range<u32>) -> usize {
        ys.flat_map(|y| xs.clone().map(move |x| (x, y))).filter(|&(x, y)| px(i, x, y)[3] > 64).count()
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_item_keeps_its_width_whatever_its_figure() {
        let p = parts(item(Drawing::Trace, true), true).unwrap();
        let at = |w: f32| shown(Res::Cpu, p, &[used(w, 0.0)], false, Bar::Dark).icon.unwrap();
        let (low, high) = (at(0.05), at(1.0));
        assert_eq!(low.width, high.width);
        assert_eq!(shown(Res::Cpu, p, &[], false, Bar::Dark).icon.unwrap().width, low.width);
        // The figure is set to the right of the trace, the name under it.
        let fig = TRACE_WIDTH + FIGURE_GAP..low.width;
        assert!(ink_in(&low, fig.clone(), 0..18) > 40);
        assert!(ink_in(&low, fig, 20..36) > 20);
        assert_eq!(ink_in(&low, TRACE_WIDTH..TRACE_WIDTH + FIGURE_GAP, 0..H), 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_item_is_one_image_its_figure_in_it_tinted_unless_hot() {
        let p = parts(item(Drawing::Bar, true), false).unwrap();
        let cool = shown(Res::Mem, p, &[used(0.4, 0.2)], false, Bar::Dark);
        assert!(cool.template && cool.title.is_none());
        assert_eq!(cool.tooltip.as_deref(), Some("mem: this computer 40 % in use, the VMs 20 %"));
        let hot = shown(Res::Mem, p, &[used(0.9, 0.2)], true, Bar::Dark);
        let icon = hot.icon.unwrap();
        assert!(!hot.template);
        // The text too.
        let fig = BAR_WIDTH + FIGURE_GAP..icon.width;
        assert!(ink_in(&icon, fig.clone(), 0..H) > 40);
        let (x, y) = fig.flat_map(|x| (0..H).map(move |y| (x, y))).find(|&(x, y)| px(&icon, x, y)[3] == 255).unwrap();
        assert_eq!(&px(&icon, x, y)[..3], &HOT);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_name_on_its_side_is_set_left_of_the_drawing() {
        let p = parts(item(Drawing::Trace, false), true).unwrap();
        let i = shown(Res::Disk, p, &[used(0.4, 0.2)], false, Bar::Dark).icon.unwrap();
        let start = layout(p, Measures { figure: 0.0, name: 0.0, side: 0.0, side_cap: 0.0, side_descent: 0.0 });
        assert_eq!(start.width, SIDE_GAP + TRACE_WIDTH);
        let side = i.width - TRACE_WIDTH - SIDE_GAP;
        assert!(side > 6 && side < 20, "{side}");
        assert!(ink_in(&i, 0..side, 0..H) > 30);
        // Taller than it's wide: on its side.
        let rows = (0..H).filter(|&y| ink_in(&i, 0..side, y..y + 1) > 0).count();
        assert!(rows as u32 > side, "{rows} rows");
    }

    /// The colours of a region's opaque pixels, and how many have each.
    #[cfg(target_os = "macos")]
    fn colours_in(i: &Icon, xs: std::ops::Range<u32>, ys: std::ops::Range<u32>) -> Vec<([u8; 3], usize)> {
        let mut seen: Vec<([u8; 3], usize)> = Vec::new();
        for (x, y) in ys.flat_map(|y| xs.clone().map(move |x| (x, y))) {
            let p = px(i, x, y);
            if p[3] == 255 {
                let rgb = [p[0], p[1], p[2]];
                match seen.iter_mut().find(|(c, _)| *c == rgb) {
                    Some((_, n)) => *n += 1,
                    None => seen.push((rgb, 1)),
                }
            }
        }
        seen
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn when_it_warns_the_names_keep_the_menu_bars_own_colour() {
        let hot = [used(0.9, 0.2)];
        for (bar, own, warn) in [(Bar::Dark, WHITE, HOT), (Bar::Light, INK, HOT_ON_LIGHT)] {
            // On its side, left of the drawing; the drawing in the warning colour.
            let p = parts(item(Drawing::Trace, false), true).unwrap();
            let i = shown(Res::Disk, p, &hot, true, bar).icon.unwrap();
            let side = i.width - TRACE_WIDTH - SIDE_GAP;
            assert_eq!(colours_in(&i, 0..side, 0..H).iter().map(|c| c.0).collect::<Vec<_>>(), [own], "{bar:?}");
            assert_eq!(&px(&i, side + SIDE_GAP, 0)[..3], &warn);
            // Under the figure: the figure in the warning colour, the name not.
            let p = parts(item(Drawing::Trace, true), true).unwrap();
            let i = shown(Res::Mem, p, &hot, true, bar).icon.unwrap();
            let fig = TRACE_WIDTH + FIGURE_GAP..i.width;
            assert_eq!(colours_in(&i, fig.clone(), 0..18).iter().map(|c| c.0).collect::<Vec<_>>(), [warn], "{bar:?}");
            assert_eq!(colours_in(&i, fig, 22..H).iter().map(|c| c.0).collect::<Vec<_>>(), [own], "{bar:?}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn highlighted_a_warning_item_is_drawn_as_for_the_other_menu_bar() {
        let hot = [used(0.9, 0.2)];
        let p = parts(item(Drawing::Trace, true), true).unwrap();
        // macOS inverts an item it highlights: on a dark menu bar its names go black, and the
        // warning colour the deeper one, to read on the light highlight; the other way round on a
        // light one.
        for (bar, own, warn) in [(Bar::Dark, INK, HOT_ON_LIGHT), (Bar::Light, WHITE, HOT)] {
            let i = shown(Res::Mem, p, &hot, true, bar).highlighted.expect("an image while highlighted");
            assert_eq!(&px(&i, 0, 0)[..3], &warn, "{bar:?}");
            let fig = TRACE_WIDTH + FIGURE_GAP..i.width;
            assert_eq!(colours_in(&i, fig.clone(), 0..18).iter().map(|c| c.0).collect::<Vec<_>>(), [warn], "{bar:?}");
            assert_eq!(colours_in(&i, fig, 22..H).iter().map(|c| c.0).collect::<Vec<_>>(), [own], "{bar:?}");
        }
        // Not warning, it's a template image, which macOS inverts itself.
        assert_eq!(shown(Res::Mem, p, &[used(0.4, 0.2)], false, Bar::Dark).highlighted, None);
    }

    /// WCAG's contrast ratio between two colours.
    fn contrast(a: [u8; 3], b: [u8; 3]) -> f64 {
        let lum = |c: [u8; 3]| {
            let lin = |v: u8| {
                let v = f64::from(v) / 255.0;
                if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
            };
            0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
        };
        let (x, y) = (lum(a), lum(b));
        (x.max(y) + 0.05) / (x.min(y) + 0.05)
    }

    #[test]
    fn the_warning_colour_reads_as_text_on_either_menu_bar() {
        // A dark menu bar and a light one, as they look over a plain wallpaper.
        let (dark, light) = ([0x1e, 0x1e, 0x1e], [0xf2, 0xf2, 0xf2]);
        assert!(contrast(Bar::Dark.hot(), dark) >= 4.5, "{}", contrast(Bar::Dark.hot(), dark));
        assert!(contrast(Bar::Light.hot(), light) >= 4.5, "{}", contrast(Bar::Light.hot(), light));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_name_on_its_side_runs_most_of_the_items_height() {
        let p = parts(item(Drawing::Bar, false), true).unwrap();
        let i = shown(Res::Cpu, p, &[used(0.4, 0.2)], false, Bar::Dark).icon.unwrap();
        let side = i.width - BAR_WIDTH - SIDE_GAP;
        let rows = (0..H).filter(|&y| ink_in(&i, 0..side, y..y + 1) > 0).count();
        assert!(rows >= 24, "{rows} rows");
    }

    #[test]
    fn an_item_is_painted_in_its_bars_ink_or_warning_colour() {
        assert_eq!(Bar::Dark.paint(false), WHITE);
        assert_eq!(Bar::Light.paint(false), INK);
        assert_eq!(Bar::Dark.paint(true), HOT);
        assert_eq!(Bar::Light.paint(true), HOT_ON_LIGHT);
    }

    #[test]
    fn a_linux_panel_is_dark_unless_the_desktop_says_light_and_gnomes_always_is() {
        // The portal's colour scheme: 1 dark, 2 light, 0 no preference; None, no portal.
        assert_eq!(panel_bar("KDE", Some(2)), Bar::Light);
        assert_eq!(panel_bar("KDE", Some(1)), Bar::Dark);
        assert_eq!(panel_bar("XFCE", Some(0)), Bar::Dark);
        assert_eq!(panel_bar("XFCE", None), Bar::Dark);
        assert_eq!(panel_bar("", None), Bar::Dark);
        // GNOME's top bar is dark in both modes, Ubuntu's too.
        assert_eq!(panel_bar("GNOME", Some(2)), Bar::Dark);
        assert_eq!(panel_bar("ubuntu:GNOME", Some(2)), Bar::Dark);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn elsewhere_the_image_is_the_drawing_and_the_figure_its_title() {
        let now = [used(0.4, 0.2)];
        let s = shown(Res::Mem, parts(item(Drawing::Trace, true), true).unwrap(), &now, false, Bar::Light);
        assert_eq!(s.icon, Some(trace(&now)));
        assert_eq!(s.title.as_deref(), Some("mem 40%"));
        let s = shown(Res::Mem, parts(item(Drawing::Bar, false), true).unwrap(), &now, false, Bar::Light);
        assert_eq!((s.icon, s.title), (Some(bar(now[0])), None));
        // A tray item shows no title without an image: one with only its figure has the app's.
        let s = shown(Res::Cpu, parts(item(Drawing::Off, true), false).unwrap(), &[], false, Bar::Light);
        assert_eq!((s.icon, s.title.as_deref()), (Some(glyph_on(Bar::Light)), Some("–")));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn elsewhere_an_item_is_painted_for_the_panel_as_no_panel_tints_it() {
        let now = [used(0.9, 0.2)];
        let p = parts(item(Drawing::Trace, true), true).unwrap();
        for (bar, hot) in [(Bar::Dark, false), (Bar::Light, false), (Bar::Dark, true), (Bar::Light, true)] {
            let s = shown(Res::Mem, p, &now, hot, bar);
            assert_eq!(s.icon, drawing_in(Drawing::Trace, &now, bar.paint(hot)), "{bar:?}, hot {hot}");
        }
        let off = parts(item(Drawing::Off, true), false).unwrap();
        assert_eq!(shown(Res::Cpu, off, &[], false, Bar::Dark).icon, Some(glyph_on(Bar::Dark)));
        assert!(glyph_on(Bar::Dark).rgba.chunks(4).all(|p| p[..3] == WHITE));
    }

    /// Writes an item's image to `dir/name.rgba`: a header line (width, height, and 1 for a template
    /// image), then its RGBA.
    fn write_rgba(dir: &std::path::Path, name: &str, s: &Shown) {
        let i = s.icon.as_ref().unwrap();
        let mut out = format!("{} {} {}\n", i.width, i.height, s.template as u8).into_bytes();
        out.extend_from_slice(&i.rgba);
        std::fs::write(dir.join(format!("{name}.rgba")), out).unwrap();
    }

    /// The README's menu bar (`just readme-menubar`, tools/menubar-readme.mjs): Settings' default
    /// items, memory at the popover screenshot's 61 % (the VMs 57.1 of its 128 GiB) and CPU past its
    /// warning, on a light and a dark menu bar, as `{light,dark}-{mem,cpu,disk}.rgba` in
    /// `LD_MENUBAR_README`, with the popover's width and gap (`popover.json`) to place it as `place` does.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn menubar_readme() {
        let Ok(dir) = std::env::var("LD_MENUBAR_README") else { return };
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Each column a little off a level: `lift` over the last few, the VMs a share of it.
        let history = |level: f32, vms: f32, lift: f32| -> Vec<Share> {
            (0..COLUMNS)
                .map(|i| {
                    let ripple = 0.03 * ((i as f32) * 1.3).sin();
                    let late = lift * (i as f32 - (COLUMNS - 4) as f32).max(0.0) / 3.0;
                    used(level + ripple + late, vms + ripple / 2.0 + late * 0.7)
                })
                .collect()
        };
        // Memory and CPU end where the popovers under them (light and dark) start, at the fake backend's
        // figures; the disk, under neither, shows the warning colour at the README's 63 %.
        let ending = |mut h: Vec<Share>, last: Share| {
            *h.last_mut().unwrap() = last;
            h
        };
        let mem = ending(history(0.59, 0.43, 0.0), used(0.61, 0.446));
        let cpu = ending(history(0.44, 0.32, 0.0), used(0.48, 0.35));
        let disk = ending(history(0.62, 0.35, 0.0), used(0.63, 0.356));
        let chosen = crate::settings::MenuBar::default();
        for (res, h, hot) in [(Res::Mem, mem, false), (Res::Cpu, cpu, false), (Res::Disk, disk, true)] {
            let p = parts(res.item(&chosen), chosen.names).unwrap();
            for (theme, bar) in [("light", Bar::Light), ("dark", Bar::Dark)] {
                write_rgba(&dir, &format!("{theme}-{}", res.id()), &shown(res, p, &h, hot, bar));
            }
        }
        let popover = serde_json::json!({ "width": POPOVER_WIDTH, "gap": GAP });
        std::fs::write(dir.join("popover.json"), popover.to_string()).unwrap();
    }

    /// Writes every kind of item to `LD_MENUBAR_PREVIEW` (a directory), as raw RGBA with a
    /// one-line header, for a look: `cargo test menubar_preview -- --ignored`.
    #[test]
    #[ignore]
    fn menubar_preview() {
        let Ok(dir) = std::env::var("LD_MENUBAR_PREVIEW") else { return };
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, s: &Shown| write_rgba(&dir, name, s);
        let wave: Vec<Share> = (0..COLUMNS)
            .map(|i| used(0.3 + 0.25 * ((i as f32) * 0.7).sin().abs(), 0.15 + 0.05 * (i % 3) as f32))
            .collect();
        let hot: Vec<Share> = wave.iter().map(|s| used(s.whole + 0.3, s.vms + 0.2)).collect();
        for (res, d) in [(Res::Mem, Drawing::Trace), (Res::Cpu, Drawing::Trace), (Res::Disk, Drawing::Bar)] {
            for (tag, f, names) in
                [("named", true, true), ("plain", true, false), ("side", false, true), ("bare", false, false)]
            {
                let p = parts(item(d, f), names).unwrap();
                write(&format!("{}-{}-{tag}", res.id(), d_name(d)), &shown(res, p, &wave, false, Bar::Dark));
                write(&format!("{}-{}-{tag}-hot", res.id(), d_name(d)), &shown(res, p, &hot, true, Bar::Dark));
                write(&format!("{}-{}-{tag}-hot-light", res.id(), d_name(d)), &shown(res, p, &hot, true, Bar::Light));
                // While highlighted (macOS only).
                for (theme, bar) in [("dark", Bar::Dark), ("light", Bar::Light)] {
                    if let Some(i) = shown(res, p, &hot, true, bar).highlighted {
                        let s = Shown { icon: Some(i), ..Shown::default() };
                        write(&format!("{}-{}-{tag}-hot-{theme}-highlighted", res.id(), d_name(d)), &s);
                    }
                }
            }
            let p = parts(item(Drawing::Off, true), true).unwrap();
            write(&format!("{}-figure-named", res.id()), &shown(res, p, &wave, false, Bar::Dark));
            write(&format!("{}-figure-named-empty", res.id()), &shown(res, p, &[], false, Bar::Dark));
            for w in [0.05, 1.0] {
                let p = parts(item(d, true), true).unwrap();
                write(
                    &format!("{}-width-{}", res.id(), (w * 100.0) as u32),
                    &shown(res, p, &[used(w, 0.0)], false, Bar::Dark),
                );
            }
        }
        let g = glyph();
        write("glyph", &Shown { icon: Some(g), template: true, ..Shown::default() });
    }

    fn d_name(d: Drawing) -> &'static str {
        match d {
            Drawing::Off => "off",
            Drawing::Trace => "trace",
            Drawing::Bar => "bar",
        }
    }

    #[test]
    fn a_vm_s_memory_is_its_share_of_the_use_else_its_footprint() {
        let latest = |kv: &[(&str, i64)]| kv.iter().map(|(k, v)| (k.to_string(), *v)).collect::<HashMap<_, _>>();
        assert_eq!(vm_memory(&latest(&[("host_mem", 25), ("host_rss", 40)])), Some(25));
        assert_eq!(vm_memory(&latest(&[("host_rss", 40)])), Some(40));
        assert_eq!(vm_memory(&latest(&[])), None);
    }
}
