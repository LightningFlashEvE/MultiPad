#include "screen_readback.h"
#include "flash_user.h"
#include "usbd_cdc_if.h"
#include <string.h>

enum {
    REQUEST_SIZE = 17,
    HEADER_SIZE = 19,
    CHECKSUM_SIZE = 2,
    MAX_CHUNK = 224,
    COLOR_SIZE = 320 * 172 * 2,
    OLED_SIZE = 72 * 40 / 8,
    BUTTON_STATE = 0xfe,
    SCREEN_INFO = 0xff,
    STATUS_OK = 0,
    STATUS_EMPTY,
    STATUS_STALE,
    STATUS_INVALID,
};

static const uint8_t request_magic[] = {0xaa, 0xbb, 0xc1, 0x53};
static const uint8_t response_magic[] = {0x4d, 0x50, 0x53, 1};
static uint8_t request[REQUEST_SIZE];
static volatile bool request_pending;
static uint8_t response[HEADER_SIZE + MAX_CHUNK + CHECKSUM_SIZE];
static uint8_t active_menu;
static bool pixels_dirty;
static uint32_t generation;
static uint16_t held_buttons;
static uint16_t pressed_buttons;

void button_readback_record(uint8_t index, bool down) {
    uint16_t bit = (uint16_t)(1u << index);
    if (down) {
        held_buttons |= bit;
        pressed_buttons |= bit;
    } else {
        held_buttons &= (uint16_t)~bit;
    }
}

static uint16_t read_u16(const uint8_t *data) {
    return (uint16_t)(data[0] | (uint16_t)data[1] << 8);
}

static uint32_t read_u32(const uint8_t *data) {
    return read_u16(data) | (uint32_t)read_u16(data + 2) << 16;
}

static void write_u16(uint8_t *data, uint16_t value) {
    data[0] = (uint8_t)value;
    data[1] = (uint8_t)(value >> 8);
}

static void write_u32(uint8_t *data, uint32_t value) {
    write_u16(data, (uint16_t)value);
    write_u16(data + 2, (uint16_t)(value >> 16));
}

static uint16_t crc16(const uint8_t *data, uint16_t length) {
    uint16_t crc = 0xffff;
    while (length--) {
        crc ^= (uint16_t)*data++ << 8;
        for (uint8_t bit = 0; bit < 8; bit++) {
            crc = (uint16_t)((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1);
        }
    }
    return crc;
}

bool screen_readback_receive(const uint8_t *data, uint32_t length) {
    if (length != REQUEST_SIZE || memcmp(data, request_magic, sizeof(request_magic)) != 0) {
        return false;
    }
    if (!request_pending) {
        memcpy(request, data, REQUEST_SIZE);
        request_pending = true;
    }
    return true;
}

void screen_readback_applied(uint8_t menu) {
    active_menu = menu;
    pixels_dirty = false;
    generation++;
}

void screen_readback_invalidate(uint8_t menu) {
    if (menu == active_menu && !pixels_dirty) {
        pixels_dirty = true;
        generation++;
    }
}

bool screen_readback_needs_refresh(uint8_t menu) {
    return menu == active_menu && pixels_dirty;
}

void screen_readback_poll(void) {
    if (!request_pending || !CDC_TransmitReady_FS()) return;

    uint16_t id = read_u16(request + 4);
    uint32_t requested_generation = read_u32(request + 6);
    uint8_t screen = request[10];
    uint32_t offset = read_u32(request + 11);
    uint16_t length = read_u16(request + 15);
    uint8_t status = STATUS_OK;
    uint8_t *pixels = response + HEADER_SIZE;

    if (screen == BUTTON_STATE) {
        if (offset != 0 || length != 0) {
            status = STATUS_INVALID;
        } else {
            write_u16(pixels, held_buttons);
            write_u16(pixels + 2, pressed_buttons);
            length = 4;
        }
    } else if (active_menu == 0 || pixels_dirty) {
        status = STATUS_EMPTY;
    } else if (screen == SCREEN_INFO) {
        if (offset != 0 || length != 0) status = STATUS_INVALID;
    } else if (requested_generation != generation) {
        status = STATUS_STALE;
    } else if (screen > 2 || length == 0 || length > MAX_CHUNK) {
        status = STATUS_INVALID;
    } else {
        uint32_t size = screen == 0 ? COLOR_SIZE : OLED_SIZE;
        if (offset >= size || length > size - offset) {
            status = STATUS_INVALID;
        } else if (screen == 0) {
            read_color_screen(active_menu, offset, pixels, length);
        } else {
            uint8_t oled[2 * OLED_SIZE];
            load_menu_from_flash(active_menu, oled, sizeof(oled), 1);
            memcpy(pixels, oled + (screen - 1) * OLED_SIZE + offset, length);
        }
    }
    if (status != STATUS_OK) length = 0;

    memcpy(response, response_magic, sizeof(response_magic));
    write_u16(response + 4, id);
    response[6] = status;
    response[7] = screen;
    write_u32(response + 8, generation);
    write_u32(response + 12, offset);
    write_u16(response + 16, length);
    response[18] = active_menu;
    uint16_t size = HEADER_SIZE + length;
    write_u16(response + size, crc16(response, size));
    if (CDC_Transmit_FS(response, size + CHECKSUM_SIZE) == USBD_OK) {
        if (screen == BUTTON_STATE && status == STATUS_OK) pressed_buttons = 0;
        request_pending = false;
    }
}
