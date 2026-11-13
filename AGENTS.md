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
ZMK's build infrastructure for user config repos auto-includes `.conf` files from `ZMK_CONFIG`, see `zmk/app/keymap-module/modules/modules.cmake`. The matching is more permissive than "exact board or shield name":

- Shield candidates are derived by splitting the shield name on `_` and dropping trailing segments. `lily58_left` produces the candidates `lily58` and `lily58_left`; `xiao_sofle_dongle` produces `xiao_sofle` and `xiao`.
- For every candidate `s` it looks for `config/<s>_<board>.conf` and `config/<s>.conf`. For the board it looks for `config/<board-dir>.conf` and `config/<board>.conf`.
- Every candidate that exists is appended, so later matches override earlier ones.

Consequences worth remembering:
- `config/lily58.conf` **is** auto-included for `lily58_left` and `lily58_right` builds through the `lily58` candidate. It is not inert.
- `config/sofle_choc_pro.conf` applies to `sofle_choc_pro_left` and `sofle_choc_pro_right` through the board-directory candidate.
- A new shield whose name starts with an existing shield name inherits that shield's config. Name shields accordingly.
- `config/lily58_left.conf` and `config/lily58_right.conf` are appended after `config/lily58.conf`, so they override it.

Display settings belong in the display shield (for example `boards/shields/nice_view_disp/nice_view_disp.conf`), not in shared keyboard configs, so that display and display-less builds of the same keyboard can coexist.

### Canonical builds — `build.yaml`
`build.yaml` is the authoritative build matrix used by CI. Key patterns:
- **Multi-shield**: `shield: sofle_dongle dongle_display` (space-separated, no quotes)
- **ZMK Studio**: `snippet: studio-rpc-usb-uart` + `cmake-args: -DCONFIG_ZMK_STUDIO=y`
- **Peripheral halves**: `cmake-args: -DCONFIG_ZMK_SPLIT_ROLE_CENTRAL=n` (often WITHOUT a shield)
- **Factory reset**: `shield: settings_reset` (universal reset firmware, any board)
- **Debug build**: `cmake-args: -DCONFIG_ZMK_SPLIT_ROLE_CENTRAL=y -DCONFIG_ZMK_USB=y`

### Local build examples

The config repo contains `zephyr/module.yml` with `board_root: .`, so it must be passed as an extra Zephyr module. `ZMK_CONFIG` points at the `config/` subdirectory. Do not copy the repo into the west workspace root: its `zephyr/` directory collides with the Zephyr project checkout.

Verified against the ZMK build image:

```bash
docker run --rm \
  -v ~/zmk-workspace:/workspace \
  -v ~/not_work/projects/zmk-config:/repo \
  -w /workspace zmkfirmware/zmk-build-arm:stable \
  bash -lc 'west build -s zmk/app -d build/xiao \
    -b seeeduino_xiao_ble -- \
    -DSHIELD=xiao_sofle_dongle \
    -DZMK_CONFIG=/repo/config \
    -DZMK_EXTRA_MODULES=/repo \
    -DZephyr_DIR=/workspace/zephyr/share/zephyr-package/cmake'
```

- `-DZMK_EXTRA_MODULES` is required for the custom boards and shields under `boards/`.
- Mirror `snippet` and `cmake-args` from the `build.yaml` entry, otherwise the binary will not match CI.
- Builds are reproducible: the Lily58 nice!view build and the Sofle Studio build both matched the 2026-07-26 firmware byte for byte.
- `west update lvgl` fails because it is an imported project. Run a full `west update`.

Build artifacts: `build/zephyr/zmk.uf2`

### Flashing
- nice!nano v2: double-tap reset to enter bootloader, copy `.uf2` to the USB mass storage device
- Use `west flash` only if your host has the Zephyr toolchain fully installed

## Keymap Architecture

### Dongle keymaps are includes
`config/sofle_dongle.keymap` and `config/xiao_sofle_dongle.keymap` are thin wrappers:
```
#include "sofle_choc_pro.keymap"
```
**When editing key bindings, edit the parent keymap** — the dongle inherits all layers and behaviors automatically.

Keymap lookup uses the same candidate logic as config lookup, and `config/` is searched before the shield directory. For the `lily58_dongle` shield the candidate list is `lily58`, then `lily58_dongle`, so `config/lily58.keymap` is selected first and `config/lily58_dongle.keymap` is never used. It is kept only as documentation.

### XIAO dongles (no display)
`boards/shields/xiao_sofle_dongle` and `boards/shields/xiao_lily58_dongle` target the Seeed XIAO nRF52840 (`board: seeeduino_xiao_ble`). They are display-less and do not reference `pro_micro` nodes, unlike the nice!nano dongle shields. Keymaps live in `config/xiao_*_dongle.keymap` and include the parent keymap.

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
