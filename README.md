# ZMK Keyboard Firmware Configuration

Custom ZMK firmware configuration for Sofle Choc Pro, Lily58, and Sofle Dongle keyboards with custom OLED display widgets.

## Supported Keyboards

- **Sofle Choc Pro** - Split ergonomic keyboard with custom display widgets
- **Lily58** - 58-key split keyboard
- **Sofle Dongle** - Central wireless receiver for split keyboards

## Features

- Custom OLED display widgets showing:
  - Battery level and charging status
  - Connection status (USB/BLE)
  - Active layer
  - WPM (words per minute) graph
  - BLE profile selection
- Split keyboard support with peripheral firmware
- Multiple keymaps with conditional layers
- Hold-tap behaviors for optimized typing

## Quick Start

Firmware builds automatically via GitHub Actions when you push to this repository.

1. Make changes to keymaps or configuration
2. Commit and push:
   ```bash
   git add .
   git commit -m "Update keymap"
   git push
   ```
3. Wait for the build to complete (check Actions tab)
4. Download the firmware from the Actions artifacts

## Building via GitHub Actions

The build pipeline is triggered automatically on:
- Push to any branch
- Pull requests
- Manual workflow dispatch

Build matrix is defined in `build.yaml`. The workflow:
- Builds all firmware variants
- Organizes artifacts into downloadable zip files
- Provides four firmware packages:
  - `lily58_firmware.zip` - Lily58 keyboard
  - `sofle_standard_firmware.zip` - Sofle Choc Pro with display
  - `sofle_dongle_firmware.zip` - Sofle Dongle
  - `sofle_dongle_oled_firmware.zip` - Sofle Dongle with OLED display

### Downloading Firmware

1. Go to the **Actions** tab in this repository
2. Select the most recent workflow run
3. Scroll to the bottom to find the artifacts
4. Download the firmware zip for your keyboard

### Local Building (Optional)

If you need to build locally, see [AGENTS.md](AGENTS.md) for build commands.

## Flashing Firmware

### UF2 Method (nice!nano v2)
1. Put your keyboard into bootloader mode (double-click reset button or press reset key combo)
2. A USB drive named `NRF52BOOT` or similar will appear
3. Copy the `.uf2` file from `build/zephyr/zmk.uf2` to the USB drive
4. The keyboard will flash and restart automatically

### Using West (if supported)
```bash
west flash
```

## Customization

### Display Rotation
Rotate the OLED display 180° by adding to your `.conf` file:
```
CONFIG_NICE_VIEW_DISP_ROTATE_180=y
```

### Keymaps
Keymaps are located in:
- `config/sofle_choc_pro.keymap`
- `config/lily58.keymap`
- `config/sofle_dongle.keymap`

### Configuration Files
Shield-specific configs:
- `boards/shields/nice_view_disp/nice_view_disp.conf`
- `boards/shields/sofle_dongle/sofle_dongle.conf`

## Project Structure

```
├── boards/
│   ├── arm/sofle_choc_pro/    # Sofle Choc Pro board definitions
│   └── shields/                # Shield definitions
│       ├── nice_view_disp/     # Display shield with custom widgets
│       └── sofle_dongle/       # Dongle shield
├── config/                     # Shared keymaps and configs
└── zephyr/                    # Zephyr module manifest
```

## Display Widgets

The custom display widgets are located in `boards/shields/nice_view_disp/widgets/`:

- **status.c** - Central widget showing battery, layers, WPM, BLE profiles
- **peripheral_status.c** - Peripheral widget showing battery and connection
- **util.c** - Utility functions for drawing

## Troubleshooting

### Build Fails
- Run `west build -t pristine` and rebuild
- Ensure `west update` was run after cloning
- Check that all dependencies are installed

### Display Not Working
- Verify `CONFIG_ZMK_DISPLAY=y` is set in config
- Check SPI pin definitions in devicetree overlay
- Try enabling built-in screen: `CONFIG_ZMK_DISPLAY_STATUS_SCREEN_BUILT_IN=y`

### Peripheral Won't Connect
- Ensure peripheral firmware has `-DCONFIG_ZMK_SPLIT_ROLE_CENTRAL=n`
- Reset pairing by flashing `settings_reset` shield

## CI/CD

Firmware builds automatically via GitHub Actions. Download pre-built firmware from the Actions tab.

## License

SPDX-License-Identifier: MIT

## Resources

- [ZMK Documentation](https://zmk.dev/)
- [ZMK Discord](https://zmk.dev/discord)
- [nice!view Documentation](https://github.com/petejohanson/nice-view)
