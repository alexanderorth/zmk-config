# ZMK Split Battery (patched)

Local copy of [bogamie/zmk-split-battery-tray](https://github.com/bogamie/zmk-split-battery-tray) 0.1.0, extended to match the 27-byte report emitted by `boards/shields/xiao_dongle_battery/battery_hid.c`.

Changes from upstream:

- `REPORT_LEN` is 27 and the parser reads modifiers, highest layer, output transport and WPM.
- The menu shows layer name and index, modifier keys, output transport and WPM in addition to the two battery percentages.
- Panel indicator is one compact row: left|right battery (yellow below 20 %, red below 10 %), the four modifiers (lit while held) and the active layer drawn as three stacked sheets (base lights the middle one, lower the bottom, raise the top, adjust all; other layers show their index). All slots have fixed widths so the indicator never resizes.

Install with `./install.sh`. This replaces the extension installed from extensions.gnome.org under the same UUID. A later update from the site will overwrite it, so rerun `install.sh` afterwards.

Requires the matching dongle firmware. Older firmware sends 3-byte reports, which this version ignores.
