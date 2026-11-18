#!/bin/sh
# The README's Linux menu bar (`just readme-menubar-linux`): the items `cargo test menubar_readme`
# drew, in a real panel's tray (xfce4-panel, whose tray is a StatusNotifierItem host, as KDE's and
# GNOME's AppIndicator extension are), beside a clock at the README's moment, in Adwaita light or
# dark, under Xvfb. Writes the panel, as wide as the picture, as a PNG at twice its size (GDK_SCALE),
# as the macOS pictures are.
#
#   sh tools/linux-panel.sh <items dir> <light|dark> <out.png> <width in points>
#
# Needs xfce4-panel, python3-gi, faketime, Xvfb and ImageMagick (the dev box has them).
set -eu
items=$1 theme=$2 out=$3 width=$4
# As tall as a GNOME top bar, about, in points; drawn at twice that.
SIZE=32
SCALE=2
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
display=":$((90 + $$ % 9))"
trap 'kill $(cat "$work"/pids 2>/dev/null) 2>/dev/null || true; rm -rf "$work"' EXIT

# One panel along the top: room, the tray, a gap, the clock.
mkdir -p "$work/home/.config/xfce4/xfconf/xfce-perchannel-xml"
cat >"$work/home/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-panel" version="1.0">
  <property name="configver" type="int" value="2"/>
  <property name="panels" type="array">
    <value type="int" value="1"/>
    <property name="panel-1" type="empty">
      <property name="position" type="string" value="p=6;x=0;y=0"/>
      <property name="length" type="double" value="100"/>
      <property name="position-locked" type="bool" value="true"/>
      <property name="size" type="uint" value="$SIZE"/>
      <property name="plugin-ids" type="array">
        <value type="int" value="1"/><value type="int" value="2"/><value type="int" value="3"/><value type="int" value="4"/>
      </property>
    </property>
  </property>
  <property name="plugins" type="empty">
    <property name="plugin-1" type="string" value="separator">
      <property name="expand" type="bool" value="true"/>
      <property name="style" type="uint" value="0"/>
    </property>
    <property name="plugin-2" type="string" value="systray"/>
    <property name="plugin-3" type="string" value="separator">
      <property name="style" type="uint" value="0"/>
    </property>
    <property name="plugin-4" type="string" value="clock">
      <property name="mode" type="uint" value="2"/>
      <property name="digital-layout" type="uint" value="3"/>
      <property name="digital-time-format" type="string" value="%a %-d %b %H:%M"/>
    </property>
  </property>
</channel>
EOF

gtk_theme=Adwaita
[ "$theme" = dark ] && gtk_theme=Adwaita:dark

# Whether the tray shows all three items: the shapes in ink at least half the panel's height (the
# clock's letters are shorter) hold three. The panel fits each item in a square, so a trace is
# about 22x17 and the disk's bar 6x22, and traces side by side touch: a shape holds as many as fit
# across it at a trace's 4:3, and one at least. A shape touching the picture's edge is the
# background (a capture with no panel in it is all background), never an item.
all_shown() { # png
  n=$(magick "$1" -colorspace gray -threshold 50% $([ "$theme" = light ] && echo -negate) \
    -define connected-components:verbose=true -connected-components 8 null: |
    awk -v min=$((SIZE * SCALE / 2)) -v w=$((width * SCALE)) -v h=$((SIZE * SCALE)) '
      $NF ~ /gray\(255\)/ {
        split($2, a, /[x+]/)  # width, height, x, y
        if (a[3] == 0 || a[4] == 0 || a[3] + a[1] >= w || a[4] + a[2] >= h) next
        if (a[2] >= min) { k = int(a[1] / (a[2] * 4 / 3) + 0.5); n += k > 1 ? k : 1 }
      }
      END { print n + 0 }')
  [ "$n" -ge 3 ] || { echo "The panel shows $n of the 3 items." >&2; return 1; }
}

for attempt in 1 2 3 4; do
  : >"$work/pids"
  Xvfb "$display" -screen 0 "$((width * SCALE))x400x24" -nolisten tcp >/dev/null 2>&1 &
  echo $! >>"$work/pids"
  sleep 1
  DISPLAY=$display HOME=$work/home XDG_CONFIG_HOME=$work/home/.config GTK_THEME=$gtk_theme GDK_SCALE=$SCALE TZ=UTC NO_AT_BRIDGE=1 \
    dbus-run-session -- sh -c '
      faketime "2026-11-10 14:30:00" xfce4-panel --disable-wm-check >"$4/panel.log" 2>&1 & echo $! >>"$4/pids"
      # Its tray up (the watcher items register with), then the items, one by one as the app adds
      # them: registered before it, they would all arrive together as it came up, in any order.
      for i in $(seq 50); do
        dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
          org.freedesktop.DBus.NameHasOwner string:org.kde.StatusNotifierWatcher 2>/dev/null | grep -q true && break
        sleep 0.2
      done
      sleep 1
      python3 "$1/tools/linux-tray.py" "$2" "$3" >"$4/tray.log" 2>&1 & echo $! >>"$4/pids"
      sleep 4
      import -window root -crop "$(($5 * '"$SCALE"'))x'"$((SIZE * SCALE))"'+0+0" +repage "$4/panel.png"
    ' sh "$root" "$items" "$theme" "$work" "$width" >"$work/session.log" 2>&1 </dev/null
  kill $(cat "$work/pids") 2>/dev/null || true
  sleep 1
  if all_shown "$work/panel.png"; then
    cp "$work/panel.png" "$out"
    exit 0
  fi
  echo "Again (attempt $attempt)." >&2
done
echo "The panel didn't show all 3 items in 4 attempts (logs: $work, kept)." >&2
trap - EXIT
exit 1
