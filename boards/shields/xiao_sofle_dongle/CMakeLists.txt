# SPDX-License-Identifier: MIT

target_sources_ifdef(CONFIG_ZMK_SPLIT_BATTERY_HID_REPORT app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../xiao_dongle_battery/battery_hid.c
)
