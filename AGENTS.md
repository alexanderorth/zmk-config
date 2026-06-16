# AGENTS.md

## Project Overview
ZMK firmware configuration for Sofle Choc Pro, Lily58, and Sofle/Lily58 dongles with custom LVGL display widgets.

## West Workspace

The west manifest lives at `config/west.yml` (not repo root). The `self: path: config` directive means west treats `config/` as the application directory.

```bash
west init -l config   # first time only
west update           # pulls zmk v0.3 + zmk-dongle-display
```

External dependency: `zmk-dongle-display` from `lordorth/zmk-dongle-display` (provides the `dongle_display` shield for OLED dongles).

`zephyr/module.yml` sets `board_root: .` so custom board definitions in `boards/arm/` are discovered.

## Build System

### Config auto-discovery
ZMK's build infrastructure for user config repos auto-includes `.conf` files by name matching:
- `config/<board-name>.conf` — auto-included when building for that board (e.g., `config/sofle_choc_pro.conf` applies to both `sofle_choc_pro_left` and `sofle_choc_pro_right`)
- `boards/shields/<shield>/<shield>.conf` — auto-included when building with that shield
- `config/lily58_left.conf` and `config/lily58_right.conf` are per-half overrides (no shared `lily58.conf` auto-include for left/right — they're explicit)

### Canonical builds — `build.yaml`
`build.yaml` is the authoritative build matrix used by CI. Key patterns:
- **Multi-shield**: `shield: sofle_dongle dongle_display` (space-separated, no quotes)
- **ZMK Studio**: `snippet: studio-rpc-usb-uart` + `cmake-args: -DCONFIG_ZMK_STUDIO=y`
- **Peripheral halves**: `cmake-args: -DCONFIG_ZMK_SPLIT_ROLE_CENTRAL=n` (often WITHOUT a shield)
- **Factory reset**: `shield: settings_reset` (universal reset firmware, any board)
- **Debug build**: `cmake-args: -DCONFIG_ZMK_SPLIT_ROLE_CENTRAL=y -DCONFIG_ZMK_USB=y`

### Local build examples
```bash
west build -b sofle_choc_pro_left -- -DSHIELD=settings_reset
west build -b nice_nano_v2 -- -DSHIELD='sofle_dongle dongle_display'
west build -b sofle_choc_pro_left -- -DCONFIG_ZMK_SPLIT_ROLE_CENTRAL=n
west build -t pristine   # clean build
```

Build artifacts: `build/zephyr/zmk.uf2`

### Flashing
- nice!nano v2: double-tap reset to enter bootloader, copy `.uf2` to the USB mass storage device
- Use `west flash` only if your host has the Zephyr toolchain fully installed

## Keymap Architecture

### Dongle keymaps are includes
`config/sofle_dongle.keymap` and `config/lily58_dongle.keymap` are thin wrappers:
```
#include "sofle_choc_pro.keymap"    # sofle_dongle.keymap
#include "lily58.keymap"            # lily58_dongle.keymap (presumed)
```
**When editing key bindings, edit the parent keymap** — the dongle inherits all layers and behaviors automatically.

### ZMK Studio layout
`config/sofle_choc_pro.json` defines the Studio graphical keymap layout. It must stay in sync with the physical matrix defined in the devicetree.

### Layer definitions
- Defined as `#define` constants: `BASE`, `LOWER`, `RAISE`, `ADJUST`
- `conditional_layers` node auto-activates ADJUST when LOWER+RAISE are both held
- Custom hold-tap behaviors (`hml`, `hmr`, etc.) defined in `behaviors` node use `#binding-cells = <2>`

## Display Widgets

### nice_view_disp shield
Custom LVGL widgets in `boards/shields/nice_view_disp/widgets/`. The CMakeLists conditionally compiles based on split role:
- **Central half**: `status.c` (full status: battery, BLE, USB, WPM, layer name, output indicator)
- **Peripheral half**: `art.c` + `peripheral_status.c` (minimal: battery, connection status)

`custom_status_screen.c` is the entrypoint — it implements `zmk_display_status_screen()` and wires up widgets.

### Disabling custom widgets
Set `CONFIG_ZMK_DISPLAY_STATUS_SCREEN_BUILT_IN=y` in your `.conf` to use ZMK's built-in status screen instead. Requires additional font config (see `boards/shields/nice_view_disp/README.md`).

## Code Conventions

### C files
- MIT license header required
- 4-space indentation, no tabs, no trailing whitespace
- Includes order: Zephyr → ZMK → local
- `LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL)` in every widget
- Widget init pattern: `zmk_widget_<name>_init(struct zmk_widget_<name> *widget, lv_obj_t *parent)` returns `int` (0 on success)
- Use `ZMK_SUBSCRIPTION()`, `ZMK_DISPLAY_WIDGET_LISTENER()`, `IS_ENABLED(CONFIG_*)`

### Devicetree files (.dtsi, .dts, .keymap)
- MIT license header + `/dts-v1/;` directive
- Indent with tabs
- Keymap layers use `display-name` property and `//` comment grid showing physical layout

### Configuration files (.conf)
- Kconfig format: `CONFIG_FOO=y` / `# CONFIG_FOO is not set`
- Group related settings with blank line separators

## Testing
No automated tests. Testing requires flashing firmware to hardware.
