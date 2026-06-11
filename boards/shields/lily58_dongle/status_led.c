/*
 * Force the nice!nano blue LED off on the dongle to avoid blinking.
 */
#include <zephyr/device.h>
#include <zephyr/drivers/led.h>
#include <zephyr/init.h>
#include <zephyr/logging/log.h>
LOG_MODULE_REGISTER(lily58_dongle_led, CONFIG_ZMK_LOG_LEVEL);

#if DT_NODE_EXISTS(DT_ALIAS(led0))
static const struct device *const status_led = DEVICE_DT_GET(DT_ALIAS(led0));
#endif

static int led_init(const struct device *dev) {
    ARG_UNUSED(dev);
#if DT_NODE_EXISTS(DT_ALIAS(led0))
    if (device_is_ready(status_led)) {
        led_off(status_led, 0);
    }
#endif
    return 0;
}

SYS_INIT(led_init, APPLICATION, CONFIG_APPLICATION_INIT_PRIORITY);
