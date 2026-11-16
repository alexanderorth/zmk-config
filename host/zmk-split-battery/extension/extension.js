// SPDX-License-Identifier: MIT
//
// Reads battery percentages directly from a ZMK split keyboard dongle's
// vendor HID interface and renders them as two stacked lines in the
// GNOME panel — modeled after macOS-style multi-device battery menulets.
//
// Discovery: scans /sys/class/hidraw/* for an interface whose
// report_descriptor starts with the Vendor Usage Page prefix
// 0x06 0x00 0xFF (matching the firmware patch in firmware/battery_hid.c).
// Each input report is 27 bytes:
//   [0] report id 0x01
//   [1] left %, [2] right % (0xFF = unknown)
//   [3] HID modifier mask
//   [4] highest active layer index
//   [5..8] active layer bitmask, 32 bits LE
//   [9] output transport (1 = USB, 2 = BLE)
//   [10] WPM
//   [11..26] highest layer name, UTF-8, NUL padded

import GObject from "gi://GObject";
import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Cairo from "gi://cairo";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

// Make Gio.File.load_contents_async() return a Promise so the discovery
// path can stay non-blocking (sync file IO is flagged by shexli /
// extensions.gnome.org reviewers as it stalls the GNOME Shell main loop).
Gio._promisify(Gio.File.prototype, "load_contents_async");

// 0x1d50:0x615e is OpenMoko's allocation for ZMK Project — many ZMK
// keyboards (totem, corne, sofle, lily58, …) share this VID:PID, so
// this extension works across them out of the box. Edit here if your
// dongle uses different IDs.
const VENDOR_ID = 0x1d50;
const PRODUCT_ID = 0x615e;
const REPORT_ID = 0x01;
const REPORT_LEN = 27;
const UNKNOWN = 0xff;
const VENDOR_USAGE_PAGE_PREFIX = [0x06, 0x00, 0xff];

const RETRY_SECONDS = 2;

const fmtPct = (level) => (level === UNKNOWN ? "—" : `${level}%`);

const MODIFIERS = [
    ["LCTRL", 0x01],
    ["LSHIFT", 0x02],
    ["LALT", 0x04],
    ["LGUI", 0x08],
    ["RCTRL", 0x10],
    ["RSHIFT", 0x20],
    ["RALT", 0x40],
    ["RGUI", 0x80],
];

const fmtMods = (mask) =>
    mask === 0
        ? "—"
        : MODIFIERS.filter(([, bit]) => mask & bit)
              .map(([name]) => name)
              .join(" ");

const fmtOutput = (value) =>
    ({ 1: "USB", 2: "BLE" })[value] ?? "—";

const decodeName = (data, offset, length) => {
    const slice = data.subarray(offset, offset + length);
    const end = slice.indexOf(0);
    const bytes = end === -1 ? slice : slice.subarray(0, end);
    try {
        return new TextDecoder().decode(bytes);
    } catch {
        return "";
    }
};

const menuIconForLevel = (level) => {
    if (level === UNKNOWN) return "battery-missing-symbolic";
    if (level < 10) return "battery-empty-symbolic";
    if (level < 30) return "battery-low-symbolic";
    if (level < 60) return "battery-good-symbolic";
    return "battery-full-symbolic";
};

// Which of the three stacked layers to fill: [top, middle, bottom].
// Base is the middle sheet, lower the bottom, raise the top, adjust all.
// Returns null for layers we have no picture for; the panel then shows
// the layer index instead.
const layerStackFor = (index, name) => {
    const value = (name || "").toLowerCase();
    if (index === 0 || index === 0xff || value === "default" || value === "base")
        return [false, true, false];
    if (value.includes("lower")) return [false, false, true];
    if (value.includes("raise") || value.includes("upper")) return [true, false, false];
    if (value.includes("adjust")) return [true, true, true];
    return null;
};

// Draws three stacked sheets (a diamond with two chevrons below it),
// back to front. Each sheet clears a thin gap around itself first so the
// sheets stay apart at 16 px. Filled sheets are opaque, others faint.
const drawLayerStack = (area, filled) => {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    const fg = area.get_theme_node().get_foreground_color();
    const s = Math.min(w, h) / 16;

    const left = 1 * s;
    const right = 15 * s;
    const mid = 8 * s;
    const half = 2.6 * s; // half the diamond height
    const step = 4 * s; // vertical distance between sheets
    const top = 8 * s - step; // centre line of the top sheet
    const gap = 1.3 * s;

    const diamond = (cy) => {
        cr.moveTo(left, cy);
        cr.lineTo(mid, cy - half);
        cr.lineTo(right, cy);
        cr.lineTo(mid, cy + half);
        cr.closePath();
    };

    cr.setLineJoin(Cairo.LineJoin.ROUND);
    for (let i = 2; i >= 0; i--) {
        const cy = top + i * step;
        cr.setOperator(Cairo.Operator.CLEAR);
        diamond(cy);
        cr.setLineWidth(2 * gap);
        cr.fillPreserve();
        cr.stroke();

        cr.setOperator(Cairo.Operator.OVER);
        const alpha = (fg.alpha / 255) * (filled[i] ? 1 : 0.35);
        cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, alpha);
        diamond(cy);
        cr.setLineWidth(0.4 * s); // softens the corners slightly
        cr.fillPreserve();
        cr.stroke();
    }
    cr.$dispose();
};

// Panel shows the number only; the keyboard icon makes "%" redundant.
const fmtPanelPct = (level) => (level === UNKNOWN ? "—" : String(level));

const LOW_PCT = 20;
const CRITICAL_PCT = 10;

const setLevelClass = (label, level) => {
    label.remove_style_class_name("low");
    label.remove_style_class_name("critical");
    if (level === UNKNOWN) return;
    if (level < CRITICAL_PCT) label.add_style_class_name("critical");
    else if (level < LOW_PCT) label.add_style_class_name("low");
};

const expectedHidId = () => {
    const vid = VENDOR_ID.toString(16).toUpperCase().padStart(8, "0");
    const pid = PRODUCT_ID.toString(16).toUpperCase().padStart(8, "0");
    return `HID_ID=0003:${vid}:${pid}`;
};

const SplitBatteryIndicator = GObject.registerClass(
    class SplitBatteryIndicator extends PanelMenu.Button {
        _init(settings) {
            // menuAlignment 0.5 => popup centered under the indicator
            super._init(0.5, "ZMK Split Battery");

            this._settings = settings;
            this.add_style_class_name("split-battery-indicator");

            // One row at panel size, fixed width so the panel never shifts:
            //   89|93 ⌃⇧⌥❖ [layer]
            const box = new St.BoxLayout({
                vertical: false,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: "split-battery-box",
            });

            const makePct = () =>
                new St.Label({
                    text: "—",
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: "split-battery-pct",
                });
            this._leftLabel = makePct();
            this._rightLabel = makePct();
            box.add_child(this._leftLabel);
            box.add_child(
                new St.Label({
                    text: "|",
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: "split-battery-sep",
                }),
            );
            box.add_child(this._rightLabel);

            const modBox = new St.BoxLayout({
                vertical: false,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: "split-battery-mods",
            });
            this._modLabels = ["⌃", "⇧", "⌥", "❖"].map((symbol) => {
                const label = new St.Label({
                    text: symbol,
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: "split-battery-mod",
                });
                modBox.add_child(label);
                return label;
            });
            box.add_child(modBox);

            // Layer slot, fixed size: the stacked-sheets picture for base,
            // lower, raise and adjust, the layer index for anything else.
            // Children toggle opacity, not visibility, so the slot never
            // changes width.
            const layerSlot = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                y_align: Clutter.ActorAlign.CENTER,
                style_class: "split-battery-layer",
            });
            this._layerStack = [false, true, false];
            this._layerArea = new St.DrawingArea({
                style_class: "split-battery-layer-icon",
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._layerArea.connect("repaint", (area) =>
                drawLayerStack(area, this._layerStack ?? [false, false, false]),
            );
            this._layerIndexLabel = new St.Label({
                text: "",
                style_class: "split-battery-layer-index",
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                opacity: 0,
            });
            layerSlot.add_child(this._layerArea);
            layerSlot.add_child(this._layerIndexLabel);
            box.add_child(layerSlot);

            this.add_child(box);

            // Section header that doubles as the connection status.
            this._headerItem = new PopupMenu.PopupSeparatorMenuItem(
                "Searching for dongle…",
            );

            const makeMenuRow = (prefixText) => {
                const item = new PopupMenu.PopupBaseMenuItem({
                    reactive: false,
                });
                item.add_style_class_name("split-battery-info-item");
                const icon = new St.Icon({
                    icon_name: menuIconForLevel(UNKNOWN),
                    style_class: "split-battery-menu-icon",
                });
                const prefix = new St.Label({
                    text: prefixText,
                    style_class: "split-battery-menu-prefix",
                    y_align: Clutter.ActorAlign.CENTER,
                });
                const pct = new St.Label({
                    text: "—",
                    style_class: "split-battery-menu-pct",
                    y_align: Clutter.ActorAlign.CENTER,
                });
                item.add_child(icon);
                item.add_child(prefix);
                item.add_child(pct);
                return { item, icon, pct };
            };

            const leftRow = makeMenuRow("Left");
            const rightRow = makeMenuRow("Right");
            this._leftItem = leftRow.item;
            this._rightItem = rightRow.item;
            this._leftMenuIcon = leftRow.icon;
            this._rightMenuIcon = rightRow.icon;
            this._leftMenuPct = leftRow.pct;
            this._rightMenuPct = rightRow.pct;

            const makeInfoRow = (labelText) => {
                const item = new PopupMenu.PopupBaseMenuItem({
                    reactive: false,
                });
                item.add_style_class_name("split-battery-info-item");
                const label = new St.Label({
                    text: labelText,
                    style_class: "split-battery-menu-prefix",
                    y_align: Clutter.ActorAlign.CENTER,
                });
                const value = new St.Label({
                    text: "—",
                    style_class: "split-battery-menu-pct",
                    y_align: Clutter.ActorAlign.CENTER,
                    x_expand: true,
                    x_align: Clutter.ActorAlign.END,
                });
                item.add_child(label);
                item.add_child(value);
                return { item, value };
            };

            const layerRow = makeInfoRow("Layer");
            const modsRow = makeInfoRow("Mods");
            const outputRow = makeInfoRow("Output");
            const wpmRow = makeInfoRow("WPM");
            this._layerValue = layerRow.value;
            this._modsValue = modsRow.value;
            this._outputValue = outputRow.value;
            this._wpmValue = wpmRow.value;

            this.menu.addMenuItem(this._headerItem);
            this.menu.addMenuItem(this._leftItem);
            this.menu.addMenuItem(this._rightItem);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this.menu.addMenuItem(layerRow.item);
            this.menu.addMenuItem(modsRow.item);
            this.menu.addMenuItem(outputRow.item);
            this.menu.addMenuItem(wpmRow.item);

            this._left = UNKNOWN;
            this._right = UNKNOWN;
            this._layerIndex = 0xff;
            this._layerName = "";
            this._mods = 0;
            this._output = 0;
            this._wpm = 0;
            this._stream = null;
            this._cancellable = new Gio.Cancellable();
            this._retryId = 0;
            this._destroyed = false;

            this._settingsHandlerId = this._settings.connect(
                "changed",
                () => this._applyVisibility(),
            );

            // Initial visibility: respect the "hide when disconnected"
            // setting until a dongle is actually opened.
            this._connected = false;
            this._applyVisibility();

            this._findAndOpen();
        }

        _setStatus(text) {
            this._headerItem.label.set_text(text);
        }

        _applyVisibility() {
            const hideOnDisconnect = this._settings.get_boolean(
                "hide-when-disconnected",
            );
            this.visible = this._connected || !hideOnDisconnect;
        }

        _refresh() {
            this._leftLabel.set_text(fmtPanelPct(this._left));
            this._rightLabel.set_text(fmtPanelPct(this._right));
            setLevelClass(this._leftLabel, this._left);
            setLevelClass(this._rightLabel, this._right);
            this._leftMenuPct.set_text(fmtPct(this._left));
            this._rightMenuPct.set_text(fmtPct(this._right));
            this._leftMenuIcon.set_icon_name(menuIconForLevel(this._left));
            this._rightMenuIcon.set_icon_name(menuIconForLevel(this._right));
        }

        _refreshInfo() {
            const name = this._layerName || "—";
            this._layerValue.set_text(
                this._layerIndex === 0xff
                    ? "—"
                    : `${name} (${this._layerIndex})`,
            );
            this._modsValue.set_text(fmtMods(this._mods));
            this._outputValue.set_text(fmtOutput(this._output));
            this._wpmValue.set_text(String(this._wpm));

            const active = [
                Boolean(this._mods & (0x01 | 0x10)),
                Boolean(this._mods & (0x02 | 0x20)),
                Boolean(this._mods & (0x04 | 0x40)),
                Boolean(this._mods & (0x08 | 0x80)),
            ];
            this._modLabels.forEach((label, index) => {
                if (active[index]) label.add_style_pseudo_class("active");
                else label.remove_style_pseudo_class("active");
            });

            const stack = layerStackFor(this._layerIndex, this._layerName);
            if (String(stack) !== String(this._layerStack)) {
                this._layerStack = stack;
                this._layerArea.queue_repaint();
            }
            this._layerArea.opacity = stack ? 255 : 0;
            this._layerIndexLabel.opacity = stack ? 0 : 255;
            this._layerIndexLabel.set_text(String(this._layerIndex));
        }

        async _loadBytes(path) {
            const file = Gio.File.new_for_path(path);
            const [contents] = await file.load_contents_async(
                this._cancellable,
            );
            return contents;
        }

        async _findHidraw() {
            const target = expectedHidId();
            const dir = Gio.File.new_for_path("/sys/class/hidraw");
            let enumerator;
            try {
                enumerator = dir.enumerate_children(
                    "standard::name",
                    Gio.FileQueryInfoFlags.NONE,
                    null,
                );
            } catch {
                return null;
            }
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (!name.startsWith("hidraw")) continue;

                let uevent;
                try {
                    const bytes = await this._loadBytes(
                        `/sys/class/hidraw/${name}/device/uevent`,
                    );
                    uevent = new TextDecoder().decode(bytes);
                } catch {
                    continue;
                }
                if (!uevent.includes(target)) continue;

                let desc;
                try {
                    desc = await this._loadBytes(
                        `/sys/class/hidraw/${name}/device/report_descriptor`,
                    );
                } catch {
                    continue;
                }
                if (desc.length < VENDOR_USAGE_PAGE_PREFIX.length) continue;
                const matches = VENDOR_USAGE_PAGE_PREFIX.every(
                    (b, i) => desc[i] === b,
                );
                if (matches) {
                    const nameMatch = uevent.match(/^HID_NAME=(.+)$/m);
                    const raw = nameMatch ? nameMatch[1].trim() : "";
                    // Strip the boilerplate "ZMK Project " prefix that
                    // ZMK adds to the USB iProduct string, so the menu
                    // header just reads e.g. "TOTEM". Cap length to
                    // avoid a hostile USB descriptor blowing up the
                    // menu layout.
                    const stripped = raw.replace(/^ZMK Project\s+/i, "");
                    const deviceName = (
                        stripped ||
                        raw ||
                        "ZMK keyboard"
                    ).slice(0, 64);
                    return { path: `/dev/${name}`, deviceName };
                }
            }
            return null;
        }

        _scheduleRetry() {
            if (this._destroyed || this._retryId) return;
            this._retryId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                RETRY_SECONDS,
                () => {
                    this._retryId = 0;
                    this._findAndOpen();
                    return GLib.SOURCE_REMOVE;
                },
            );
        }

        async _findAndOpen() {
            if (this._destroyed) return;
            const found = await this._findHidraw();
            if (this._destroyed) return;
            if (!found) {
                this._setStatus("Searching for dongle…");
                this._connected = false;
                this._applyVisibility();
                this._scheduleRetry();
                return;
            }
            const { path, deviceName } = found;
            try {
                const file = Gio.File.new_for_path(path);
                this._stream = file.read(this._cancellable);
            } catch (e) {
                console.error(
                    `zmk-split-battery: open ${path} failed: ${e}`,
                );
                this._setStatus(`Open failed: ${e.message}`);
                this._connected = false;
                this._applyVisibility();
                this._scheduleRetry();
                return;
            }
            this._setStatus(deviceName);
            this._connected = true;
            this._applyVisibility();
            this._readNext();
        }

        _readNext() {
            if (!this._stream || this._destroyed) return;
            this._stream.read_bytes_async(
                REPORT_LEN,
                GLib.PRIORITY_DEFAULT,
                this._cancellable,
                (src, res) => {
                    if (this._destroyed) return;
                    let bytes;
                    try {
                        bytes = src.read_bytes_finish(res);
                    } catch (e) {
                        if (
                            !e.matches?.(
                                Gio.IOErrorEnum,
                                Gio.IOErrorEnum.CANCELLED,
                            )
                        ) {
                            console.error(
                                `zmk-split-battery: read error: ${e}`,
                            );
                        }
                        this._closeStream();
                        this._setStatus("Disconnected, retrying…");
                        this._connected = false;
                        this._applyVisibility();
                        this._scheduleRetry();
                        return;
                    }
                    if (!bytes || bytes.get_size() === 0) {
                        this._closeStream();
                        this._setStatus("Disconnected, retrying…");
                        this._connected = false;
                        this._applyVisibility();
                        this._scheduleRetry();
                        return;
                    }
                    const data = bytes.get_data();
                    if (data.length >= REPORT_LEN && data[0] === REPORT_ID) {
                        const a = data[1];
                        const b = data[2];
                        const swap = this._settings.get_boolean("swap-lr");
                        this._left = swap ? b : a;
                        this._right = swap ? a : b;
                        this._mods = data[3];
                        this._layerIndex = data[4];
                        this._output = data[9];
                        this._wpm = data[10];
                        this._layerName = decodeName(data, 11, 16);
                        this._refresh();
                        this._refreshInfo();
                    }
                    this._readNext();
                },
            );
        }

        _closeStream() {
            if (this._stream) {
                try {
                    this._stream.close(null);
                } catch {
                    // ignore
                }
                this._stream = null;
            }
        }

        destroy() {
            this._destroyed = true;
            if (this._retryId) {
                GLib.Source.remove(this._retryId);
                this._retryId = 0;
            }
            if (this._settingsHandlerId) {
                this._settings.disconnect(this._settingsHandlerId);
                this._settingsHandlerId = 0;
            }
            this._cancellable.cancel();
            this._closeStream();
            super.destroy();
        }
    },
);

export default class SplitBatteryExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new SplitBatteryIndicator(this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
