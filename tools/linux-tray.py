"""The README's Linux menu bar items in a panel's tray (`just readme-menubar-linux`).

Shows each item's image, as `cargo test menubar_readme` drew it for a Linux panel, through
libayatana-appindicator, as the app does (Tauri's tray-icon hands it a PNG the same way), and runs
until it's killed.

    python3 tools/linux-tray.py <items dir> <light|dark>
"""

import os
import sys
import tempfile

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
gi.require_version("AyatanaAppIndicator3", "0.1")
from gi.repository import AyatanaAppIndicator3 as AppIndicator  # noqa: E402
from gi.repository import GdkPixbuf, GLib, Gtk  # noqa: E402

RESOURCES = ["mem", "cpu", "disk"]
# Each item's menu, as menubar.rs's popover_label has it.
LABELS = {"mem": "Show RAM use details", "cpu": "Show CPU use details", "disk": "Show disk use details"}


def png(items, theme, res, out):
    """An item's image (`write_rgba` in menubar.rs: a header line, then RGBA) as a PNG in `out`."""
    with open(os.path.join(items, f"{theme}-{res}.rgba"), "rb") as f:
        header, rgba = f.read().split(b"\n", 1)
    width, height, _ = (int(n) for n in header.split())
    image = GdkPixbuf.Pixbuf.new_from_bytes(
        GLib.Bytes.new(rgba), GdkPixbuf.Colorspace.RGB, True, 8, width, height, width * 4
    )
    name = f"ld-readme-{theme}-{res}"
    image.savev(os.path.join(out, f"{name}.png"), "png", [], [])
    return name


def main():
    items, theme = sys.argv[1], sys.argv[2]
    out = tempfile.mkdtemp(prefix="linux-tray-")
    shown = []

    def show(res):
        name = png(items, theme, res, out)
        item = AppIndicator.Indicator.new(f"tray-icon tray app {res}", name, AppIndicator.IndicatorCategory.APPLICATION_STATUS)
        item.set_icon_theme_path(out)
        # An indicator with no menu isn't shown.
        menu = Gtk.Menu()
        menu.append(Gtk.MenuItem(label=LABELS[res]))
        menu.show_all()
        item.set_menu(menu)
        item.set_status(AppIndicator.IndicatorStatus.ACTIVE)
        shown.append(item)

    # As the app makes them: right to left (menubar.rs's `apply`), named as Tauri's tray-icon names
    # them, so a panel orders them as it would the app's. A moment apart: a panel orders them as
    # they arrive, and all at once they'd arrive in any order.
    for i, res in enumerate(reversed(RESOURCES)):
        GLib.timeout_add(300 * i, lambda res=res: show(res) and False)
    Gtk.main()


if __name__ == "__main__":
    main()
