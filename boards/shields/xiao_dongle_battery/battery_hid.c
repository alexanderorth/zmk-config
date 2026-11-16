/*
 * Custom USB HID interface that exposes split keyboard state to the host.
 * Used by the zmk-split-battery GNOME Shell extension on Linux.
 *
 * Lives on the dongle (central) build only. Reports are sent when state
 * changes (layer, modifiers, battery, key events) plus a slow keepalive,
 * so the host sees layer and modifier changes without polling latency.
 *
 * Report layout (Report ID 0x01, 27 bytes):
 *     byte  0    : report id (0x01)
 *     byte  1    : left battery state of charge  (0..100, 0xFF = unknown)
 *     byte  2    : right battery state of charge (0..100, 0xFF = unknown)
 *     byte  3    : HID modifier bitmask
 *     byte  4    : highest active layer index
 *     bytes 5-8  : active layer bitmask, 32 bits little endian
 *     byte  9    : output transport (1 = USB, 2 = BLE)
 *     byte 10    : words per minute
 *     bytes 11-26: highest layer name, UTF-8, NUL padded
 */

#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/init.h>
#include <zephyr/device.h>
#include <zephyr/usb/usb_device.h>
#include <zephyr/usb/class/usb_hid.h>
#include <zephyr/logging/log.h>

#include <zmk/event_manager.h>
#include <zmk/events/battery_state_changed.h>
#include <zmk/events/keycode_state_changed.h>
#include <zmk/events/layer_state_changed.h>
#include <zmk/events/modifiers_state_changed.h>
#include <zmk/endpoints.h>
#include <zmk/hid.h>
#include <zmk/keymap.h>
#include <zmk/wpm.h>

LOG_MODULE_REGISTER(zmk_split_battery, CONFIG_ZMK_LOG_LEVEL);

#define REPORT_ID          0x01
#define BATTERY_UNKNOWN    0xFF
#define LAYER_NAME_LEN     16
#define REPORT_LEN         (1 + 2 + 1 + 1 + 4 + 1 + 1 + LAYER_NAME_LEN)

static const uint8_t hid_report_desc[] = {
    0x06, 0x00, 0xFF,        /* Usage Page (Vendor-Defined 0xFF00) */
    0x09, 0x01,              /* Usage (0x01) — split keyboard state  */
    0xA1, 0x01,              /* Collection (Application)             */
    0x85, REPORT_ID,         /*   Report ID (1)                      */
    0x15, 0x00,              /*   Logical Minimum (0)                */
    0x26, 0xFF, 0x00,        /*   Logical Maximum (255)              */
    0x75, 0x08,              /*   Report Size (8)                    */
    0x95, REPORT_LEN - 1,    /*   Report Count (26)                  */
    0x09, 0x01,              /*   Usage (0x01) — state blob          */
    0x81, 0x02,              /*   Input (Data, Variable, Absolute)   */
    0xC0,                    /* End Collection                       */
};

static const struct device *hid_dev;
static K_SEM_DEFINE(report_sem, 1, 1);
static uint8_t levels[2] = { BATTERY_UNKNOWN, BATTERY_UNKNOWN };

static void state_work_handler(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(state_work, state_work_handler);

static void keepalive_work_handler(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(keepalive_work, keepalive_work_handler);

static void int_in_ready_cb(const struct device *dev)
{
    ARG_UNUSED(dev);
    k_sem_give(&report_sem);
}

static const struct hid_ops ops = {
    .int_in_ready = int_in_ready_cb,
};

static void build_report(uint8_t *buf)
{
    zmk_keymap_layer_index_t highest = zmk_keymap_highest_layer_active();
    zmk_keymap_layers_state_t layer_state = zmk_keymap_layer_state();
    struct zmk_hid_keyboard_report *keyboard_report = zmk_hid_get_keyboard_report();
    struct zmk_endpoint_instance endpoint = zmk_endpoints_selected();

    buf[0] = REPORT_ID;
    buf[1] = levels[0];
    buf[2] = levels[1];
    buf[3] = keyboard_report ? keyboard_report->body.modifiers : 0;
    buf[4] = highest;
    memcpy(&buf[5], &layer_state, sizeof(layer_state));
    buf[9] = (uint8_t)(endpoint.transport + 1);
#if IS_ENABLED(CONFIG_ZMK_WPM)
    buf[10] = (uint8_t)zmk_wpm_get_state();
#else
    buf[10] = 0;
#endif

    memset(&buf[11], 0, LAYER_NAME_LEN);
    const char *name = zmk_keymap_layer_name(zmk_keymap_layer_index_to_id(highest));
    if (name) {
        strncpy((char *)&buf[11], name, LAYER_NAME_LEN - 1);
    }
}

static int send_report(void)
{
    if (!hid_dev) {
        return -ENODEV;
    }

    uint8_t buf[REPORT_LEN];
    build_report(buf);

    if (k_sem_take(&report_sem, K_NO_WAIT) != 0) {
        return -EBUSY;
    }

    int err = hid_int_ep_write(hid_dev, buf, sizeof(buf), NULL);
    if (err) {
        k_sem_give(&report_sem);
    }
    return err;
}

static void state_work_handler(struct k_work *work)
{
    ARG_UNUSED(work);

    int err = send_report();
    if (err) {
        LOG_WRN("state report failed: %d", err);
    }
    if (err == -EBUSY || err == -ENODEV) {
        k_work_reschedule(&state_work, K_MSEC(5));
    }
}

static void keepalive_work_handler(struct k_work *work)
{
    ARG_UNUSED(work);
    static int runs;

    if (runs++ == 0) {
        LOG_INF("battery keepalive started");
    }

    k_work_reschedule(&state_work, K_NO_WAIT);
    k_work_reschedule(&keepalive_work, K_SECONDS(5));
}

static int zmk_split_battery_hid_init(void)
{
    hid_dev = device_get_binding("HID_1");
    if (!hid_dev) {
        LOG_ERR("device_get_binding(HID_1) returned NULL — "
                "is CONFIG_USB_HID_DEVICE_COUNT >= 2?");
        return -ENODEV;
    }
    usb_hid_register_device(hid_dev, hid_report_desc, sizeof(hid_report_desc), &ops);
    int err = usb_hid_init(hid_dev);
    if (err) {
        LOG_ERR("usb_hid_init(HID_1) failed: %d", err);
        return err;
    }
    LOG_INF("split battery HID interface initialized on HID_1");
    k_work_reschedule(&keepalive_work, K_SECONDS(1));
    return 0;
}

SYS_INIT(zmk_split_battery_hid_init, APPLICATION, 91);

static int battery_listener(const zmk_event_t *eh)
{
    const struct zmk_peripheral_battery_state_changed *ev =
        as_zmk_peripheral_battery_state_changed(eh);
    if (!ev) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    if (ev->source < ARRAY_SIZE(levels)) {
        levels[ev->source] = ev->state_of_charge;
        k_work_reschedule(&state_work, K_NO_WAIT);
    } else {
        LOG_WRN("battery event from unexpected source=%u", ev->source);
    }
    return ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(zmk_split_battery_listener, battery_listener);
ZMK_SUBSCRIPTION(zmk_split_battery_listener, zmk_peripheral_battery_state_changed);

static int state_listener(const zmk_event_t *eh)
{
    ARG_UNUSED(eh);
    k_work_reschedule(&state_work, K_NO_WAIT);
    return ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(zmk_split_battery_layer_listener, state_listener);
ZMK_SUBSCRIPTION(zmk_split_battery_layer_listener, zmk_layer_state_changed);

ZMK_LISTENER(zmk_split_battery_mod_listener, state_listener);
ZMK_SUBSCRIPTION(zmk_split_battery_mod_listener, zmk_modifiers_state_changed);

ZMK_LISTENER(zmk_split_battery_key_listener, state_listener);
ZMK_SUBSCRIPTION(zmk_split_battery_key_listener, zmk_keycode_state_changed);
