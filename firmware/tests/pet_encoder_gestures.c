#ifdef NDEBUG
#undef NDEBUG
#endif
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "encoder1.h"
#include "encoder2.h"
#include "encoder3.h"
#include "encoder_user.h"
#include "pet_care.h"
#include "pet_mode.h"
#include "screen_readback.h"
#include "usbd_cdc_if.h"

static uint32_t now, counter, cursor;
static bool held;
static uint8_t macro;
static unsigned macros, pats, menu_loads, menu_previews;
static PetEvent last_pat;
static uint16_t lcd[172][320], before[172][320];
static unsigned image_restores;
static uint8_t usb_status;
static uint16_t held_buttons, pressed_buttons;

uint32_t HAL_GetTick(void) { return now; }
uint8_t HAL_GPIO_ReadPin(GPIO_TypeDef *port, uint16_t pin) { (void)port; (void)pin; return !held; }
void HAL_GPIO_Init(GPIO_TypeDef *port, GPIO_InitTypeDef *init) { (void)port; (void)init; }
uint32_t get_encoder3_counter(void) { return counter; }
void set_encoder3_counter(uint8_t value) { counter = value; }
void tim4_init(void) {}
void encoder1_init(void) {}
void encoder2_init(void) {}
void encoder1_scan(void) {}
void encoder2_scan(void) {}
void load_menu(uint8_t menu) { (void)menu; menu_loads++; }
void parse_json_value(uint8_t value) { macro = value; macros++; }
void oled_42_show_num(uint8_t n, uint8_t mode, uint8_t i) { (void)n; (void)mode; (void)i; menu_previews++; }
void live_oled_mode_changed(void) {}
void restore_menu_color(void) { image_restores++; }
bool live_oled_read(uint8_t screen, uint32_t offset, uint8_t *pixels, uint16_t size) {
    (void)screen; (void)offset; (void)pixels; (void)size; return false;
}
void load_config(uint8_t *data, uint16_t size) { memset(data, 0, size); }
void load_menu_from_flash(uint8_t menu, uint8_t *data, uint16_t size, uint8_t mode) {
    (void)menu; (void)mode; memset(data, 0, size);
}
void read_color_screen(uint8_t menu, uint32_t offset, uint8_t *data, uint16_t size) {
    (void)menu; (void)offset; memset(data, 0, size);
}
uint8_t CDC_TransmitReady_FS(void) { return 1; }
uint8_t CDC_Transmit_FS(uint8_t *buf, uint16_t length) {
    assert(length >= 21);
    usb_status = buf[6];
    if (buf[7] == 0xfe && length >= 25) {
        held_buttons = (uint16_t)(buf[19] | buf[20] << 8);
        pressed_buttons = (uint16_t)(buf[21] | buf[22] << 8);
    }
    return USBD_OK;
}
void lcd_show_string(uint16_t x, uint16_t y, const uint8_t *str, uint16_t fg, uint16_t bg,
                     uint8_t size, uint8_t mode, uint8_t index) {
    (void)x; (void)y; (void)str; (void)fg; (void)bg; (void)size; (void)mode; (void)index;
}
void lcd_fill(uint16_t x, uint16_t y, uint16_t right, uint16_t bottom, uint16_t color, uint8_t index) {
    assert(right <= 320 && bottom <= 172 && index == 0);
    for (unsigned row = y; row < bottom; row++)
        for (unsigned col = x; col < right; col++) lcd[row][col] = color;
}
void erase_flash_sector(uint32_t sector) { (void)sector; assert(0); }
void write_flash_page(uint8_t *buf, uint32_t addr, uint16_t n) { (void)buf; (void)addr; (void)n; assert(0); }
void read_flash(uint8_t *buf, uint32_t addr, uint16_t n) { (void)buf; (void)addr; (void)n; assert(0); }
void lcd_show_pic_index(uint16_t x, uint16_t y, uint16_t w, uint16_t h, uint8_t *buf, uint8_t i) {
    assert(x + w <= 320 && y + h <= 172 && i == 0);
    for (unsigned j = 0; j < h; j++) for (unsigned k = 0; k < w; k++) {
        unsigned p = 2 * (j*w+k);
        lcd[y+j][x+k] = (uint16_t)(buf[p] << 8 | buf[p+1]);
    }
}

static void advance(unsigned duration) { while (duration--) { now++; pet_mode_poll(); } }
static void scan(bool down, unsigned count) { held = down; counter = count; encoder3_scan(); }

static uint8_t send_screen_request(uint8_t screen, uint8_t menu) {
    uint8_t request[17] = {0xaa, 0xbb, 0xc1, 0x53, 1, 0, 50, 60, 70, 0, screen, menu};
    assert(screen_readback_receive(request, sizeof(request)));
    usb_status = 0xff;
    screen_readback_poll();
    assert(usb_status != 0xff);
    return usb_status;
}

static uint8_t send_performance(uint8_t menu) { return send_screen_request(0xf9, menu); }

static void restore_performance_without_image(void) {
    assert(pet_mode_is_active());
    screen_readback_applied(1);
    memcpy(before, lcd, sizeof(lcd));
    unsigned restores = image_restores;
    assert(send_performance(1) == 0);
    assert(memcmp(lcd, before, sizeof(lcd)) == 0);
    assert(pet_mode_control(1, 0) == 0 && image_restores == restores);
    assert(lcd[53][82] == 0x5f18 && lcd[53][157] == 0x5f18 && lcd[53][158] == 0x324c);

    assert(pet_mode_control(1, 1) == 0);
    assert(send_performance(2) == 2);
    assert(send_performance(0) == 0 && image_restores == restores);
    assert(pet_mode_control(1, 0) == 0 && image_restores == restores + 1);
    restores = image_restores;

    assert(pet_mode_control(1, 1) == 0 && send_performance(1) == 0);
    now += 7000;
    assert(pet_mode_control(1, 0) == 0 && image_restores == restores + 1);
}

static void read_pats(void) {
    PetEvent events[PET_EVENTS_PER_REPLY];
    bool overrun, more;
    do {
        unsigned count = pet_mode_events(cursor, events, &overrun, &more);
        assert(!overrun);
        for (unsigned i = 0; i < count; i++) {
            cursor = events[i].sequence;
            if (events[i].kind == PET_EVENT_HEAD_PETTED) { last_pat = events[i]; pats++; }
        }
    } while (more);
}

static void expect_pat(unsigned count, uint8_t kind, uint8_t source) {
    read_pats();
    assert(pats == count && last_pat.value == kind && last_pat.source == source && last_pat.detail == 3);
}

static void expect_reaction(uint8_t ticks, uint8_t kind) {
    uint8_t actual_kind;
    assert(pet_mode_head_pat_ticks(&actual_kind) == ticks && actual_kind == kind);
}

static void gestures_and_framebuffer(void) {
    assert(pet_mode_control(1, 1) == 0);
    assert(pet_mode_control(3, PET_IDLE) == 0);
    advance(90);
    memcpy(before, lcd, sizeof(lcd));
    scan(true, 0); advance(65); scan(false, 0);
    expect_pat(1, 0, 1); expect_reaction(120, 0);
    const PetCare *care = pet_care_get();
    assert(care->affection == 36 && care->mood == 70 && care->satiety == 65);
    advance(140); assert(memcmp(lcd, before, sizeof(lcd)) != 0);
    advance(1160); expect_reaction(0, 0);
    assert(memcmp(lcd, before, sizeof(lcd)) == 0); /* Entire overlay cleared. */
    scan(true, 0); advance(1500); assert(pet_mode_is_active());
    scan(true, 124); expect_pat(2, 1, 1); expect_reaction(120, 1);
    unsigned phase = pet_mode_pat_phase();
    int held_x = pet_mode_x();
    advance(110);
    assert(pet_mode_pat_phase() == phase && pet_mode_x() == held_x);
    scan(true, 4);
    assert(pet_mode_pat_phase() != phase); expect_pat(3, 2, 1);
    unsigned reversed = pet_mode_pat_phase();
    advance(1250); assert(pet_mode_pat_phase() == reversed && pet_mode_x() == held_x); encoder3_callback(CLOCKWISE); /* Ordinary direction reported during an owned press. */
    expect_pat(4, 1, 1); expect_reaction(120, 1);
    scan(false, 0); expect_pat(4, 1, 1);
    assert(care->affection == 37 && macros == 0 && pet_mode_is_active());
    scan(false, 4); assert(macros == 1 && macro == 28 + ANTICLOCKWISE);
    scan(true, 0); advance(1300); assert(pet_mode_is_active()); scan(false, 0);
    assert(!pet_mode_is_active() && macros == 1); expect_pat(4, 1, 1);
    scan(true, 124); scan(false, 0); assert(macros == 4 && macro == 28 + ENCODER_UP);
    scan(true, 0); advance(1250); assert(pet_mode_is_active()); scan(false, 0);
    assert(macros == 6 && macro == 28 + ENCODER_UP); /* Pair an already-sent work DOWN. */
    scan(true, 0); assert(pet_mode_control(1, 0) == 0); assert(pet_mode_control(1, 1) == 0);
    scan(true, 124); scan(false, 0); expect_pat(4, 1, 1); assert(macros == 6);
}

static void concurrent_activities(void) {
    assert(pet_mode_control(3, PET_SLEEP) == 0); advance(3500);
    assert(pet_mode_is_bedtime() && pet_mode_action() == PET_SLEEP);
    uint8_t mood = pet_care_get()->mood, satiety = pet_care_get()->satiety;
    assert(pet_mode_control(22, 1) == 0); expect_pat(5, 1, 2);
    assert(pet_mode_is_bedtime() && pet_mode_action() == PET_SLEEP);
    advance(1350); assert(pet_mode_control(22, 4) == 0); expect_pat(6, 2, 2);
    assert(pet_care_get()->mood == mood && pet_care_get()->satiety == satiety);
    assert(pet_mode_control(22, 5) == 0); expect_pat(6, 2, 2);
    assert(pet_mode_control(2, 1) == 0);
    for (unsigned i = 0; i < 5000 && pet_mode_action() != PET_EAT; i++) advance(1);
    assert(pet_mode_action() == PET_EAT && pet_mode_fruit() == 1);
    scan(true, 4); scan(false, 0); expect_pat(7, 2, 1);
    assert(pet_mode_action() == PET_EAT && pet_mode_fruit() == 1);
    uint8_t affection = pet_care_get()->affection;
    advance(1200);
    assert(pet_care_get()->satiety == satiety + 12);
    assert(pet_care_get()->mood == mood + 3 && pet_care_get()->affection == affection + 1);
    assert(pet_mode_control(7, 2) == 0);
    for (unsigned i = 0; i < 5000 && pet_mode_toy_phase() != 2; i++) advance(1);
    assert(pet_mode_active_toy() == 2 && pet_mode_toy_phase() == 2);
    scan(true, 0); advance(80); scan(false, 0); expect_pat(8, 0, 1);
    assert(pet_mode_active_toy() == 2 && pet_mode_toy_phase() == 2);
    affection = pet_care_get()->affection;
    advance(4000);
    assert(pet_mode_active_toy() == 0);
    assert(pet_care_get()->mood == mood + 9 && pet_care_get()->affection == affection + 1);
    affection = pet_care_get()->affection;
    assert(pet_mode_control(3, PET_GAZE_OWNER) == 0);
    advance(8500);
    assert(pet_care_get()->mood == mood + 9 && pet_care_get()->affection == affection);
}

static void table_and_food_positions(void) {
    pet_mode_control(1, 0);
    pet_mode_control(1, 1);
    pet_mode_control(6, 0);
    assert(pet_mode_control(3, PET_INSPECT_TABLE) == 3);
    pet_mode_control(6, 1);
    assert(pet_mode_control(3, PET_INSPECT_TABLE) == 0);
    advance(2900);
    assert(pet_mode_action() == PET_INSPECT_TABLE && pet_mode_active_toy() == 3);
    assert(pet_mode_x() == 98 && pet_mode_y() == 116);
    advance(4200);
    assert(pet_mode_active_toy() == 0 && pet_mode_y() == 139);
    assert(pet_mode_control(3, PET_STAND_WATCH) == 0);
    advance(3200);
    assert(pet_mode_action() == PET_STAND_WATCH && pet_mode_y() == 139);
    advance(780);
    assert(pet_mode_action() != PET_STAND_WATCH);
    pet_care_adjust(-100, 0, 0, 0);
    assert(pet_care_get()->satiety == 0);
    assert(pet_mode_control(2, 1) == 0 && pet_mode_control(2, 2) == 0);
    for (unsigned id = 1; id <= 2; id++) {
        for (unsigned t = 0; t < 6000 && pet_mode_action() != PET_EAT; t++) advance(1);
        PetFloorFood food[PET_FLOOR_CAPACITY];
        assert(pet_mode_foods(food) > 0 && food[0].id == id && pet_mode_fruit() == id);
        int distance = food[0].x - pet_mode_x();
        assert(distance == (id == 1 ? 28 : -28));
        advance(851);
        assert(pet_care_get()->satiety == 12 * id);
    }
}

static void ambient_light_uses_manual_time_and_synced_minutes(void) {
    assert(pet_mode_control(6, 1) == 0);
    assert(pet_mode_control(4, 17) == 0);
    advance(150);
    const uint16_t daylight_wall = lcd[45][10], daylight_window = lcd[28][124];

    assert(pet_mode_control(9, 1) == 0);
    const uint16_t dusk = 17 * 60 + 30;
    assert(pet_mode_control(16 + (dusk >> 8), dusk & 255) == 0);
    advance(150);
    const uint16_t dusk_wall = lcd[45][10];
    assert(pet_mode_hour() == 17 && pet_mode_minute() == 30);
    assert(dusk_wall < daylight_wall && lcd[28][124] != daylight_window);

    assert(pet_mode_control(9, 0) == 0);
    assert(pet_mode_control(4, 23) == 0);
    advance(150);
    assert(lcd[45][10] < dusk_wall);
    assert(pet_mode_control(6, 0) == 0);
    advance(150);
    const uint16_t night_garden = lcd[150][10];
    assert(pet_mode_control(4, 12) == 0);
    advance(150);
    assert(lcd[150][10] > night_garden);
}

static void pendant_lamp_brightens_only_the_room_at_night(void) {
    assert(pet_mode_control(6, 1) == 0);
    assert(pet_mode_control(4, 20) == 0);
    advance(150);
    const uint16_t dark_wall = lcd[45][10], night_window = lcd[28][124];
    assert(pet_mode_control(28, 2) == 3);
    assert(pet_mode_control(28, 1) == 0);
    advance(150);
    const uint16_t lit_bulb = lcd[31][222];
    assert(lcd[45][10] > dark_wall && lcd[28][124] == night_window);

    assert(pet_mode_control(4, 6) == 0);
    advance(150);
    const uint16_t unlit_bulb = lcd[31][222], dawn_wall = lcd[45][10];
    assert(unlit_bulb != lit_bulb);
    assert(pet_mode_control(4, 18) == 0);
    advance(150);
    assert(lcd[31][222] == unlit_bulb);
    assert(pet_mode_control(4, 19) == 0);
    advance(150);
    assert(lcd[31][222] == lit_bulb);
    assert(pet_mode_control(4, 6) == 0);
    assert(pet_mode_control(28, 0) == 0);
    advance(150);
    assert(lcd[45][10] == dawn_wall && lcd[31][222] != unlit_bulb);
}

static void lamp_manual_override_expires_at_clock_boundaries(void) {
    assert(pet_mode_control(9, 0) == 0);
    assert(pet_mode_control(4, 15) == 0 && pet_mode_control(28, 1) == 0);
    assert(!pet_mode_lamp_is_lit());
    encoder2_callback(ENCODER_DOWN);
    encoder2_callback(ENCODER_UP);
    assert(pet_mode_lamp_is_lit());
    assert(pet_mode_control(4, 16) == 0 && pet_mode_lamp_is_lit());
    assert(pet_mode_control(4, 19) == 0 && pet_mode_lamp_is_lit());
    assert(pet_mode_control(4, 23) == 0 && pet_mode_lamp_is_lit());
    assert(pet_mode_control(4, 0) == 0 && pet_mode_lamp_is_lit());
    assert(pet_mode_control(4, 6) == 0 && !pet_mode_lamp_is_lit());

    const uint8_t scene = pet_care_get()->scene;
    encoder2_callback(ENCODER_DOWN);
    encoder2_callback(UP_CLOCKWISE);
    encoder2_callback(ENCODER_UP);
    assert(!pet_mode_lamp_is_lit() && pet_care_get()->scene != scene);
    assert(pet_mode_control(6, scene) == 0);

    assert(pet_mode_control(9, 1) == 0);
    assert(pet_mode_control(20, 115) == 0); /* 18:59 */
    assert(!pet_mode_lamp_is_lit());
    advance(60000);
    assert(pet_mode_hour() == 19 && pet_mode_lamp_is_lit());
    assert(pet_mode_control(32, 0) == 0 && !pet_mode_lamp_is_lit());
    assert(pet_mode_control(17, 103) == 0); /* 05:59 */
    assert(!pet_mode_lamp_is_lit());
    assert(pet_mode_control(32, 0) == 0 && pet_mode_lamp_is_lit());
    advance(60000);
    assert(pet_mode_hour() == 6 && !pet_mode_lamp_is_lit());
    assert(pet_mode_control(9, 0) == 0);
    assert(pet_mode_control(28, 0) == 0 && pet_mode_control(32, 0) != 0);
}

static void dance_and_window(void) {
    assert(pet_mode_control(3, PET_BINKY) == 0);
    const int origin = pet_mode_x(), facing = (pet_mode_room_flags() & 1) ? 1 : -1;
    advance(300);
    assert((pet_mode_x() - origin) * facing > 0 && (pet_mode_room_flags() & 1) == (facing > 0));
    advance(340);
    assert(pet_mode_action() == PET_BINKY && (pet_mode_room_flags() & 1) == (facing < 0));
    advance(530);
    assert(pet_mode_action() == PET_IDLE && pet_mode_x() == origin + 36 * facing);
    assert((pet_mode_room_flags() & 1) == (facing < 0));

    assert(pet_mode_control(9, 0) == 0);
    assert(pet_mode_control(4, 10) == 0);
    advance(150);
    const uint16_t sky = lcd[28][124], frame_colour = lcd[28][137];
    assert(pet_mode_control(4, 15) == 0);
    advance(150);
    assert(sky != lcd[28][124] && frame_colour == lcd[28][137]);
}

static void small_encoders_keep_work_layers_out_of_pet_mode(void) {
    const unsigned before = macros;
    assert(pet_mode_control(1, 1) == 0);
    set_menu_index(3);
    encoder1_callback(ENCODER_DOWN);
    encoder1_callback(ENCODER_UP);
    encoder2_callback(ENCODER_DOWN);
    encoder2_callback(ENCODER_UP);
    assert(send_screen_request(0xfe, 0) == 0);
    assert(macros == before && (pressed_buttons & 0x300) == 0x300 && (held_buttons & 0x300) == 0);

    encoder1_callback(ENCODER_DOWN);
    encoder1_callback(DOWN_ANTICLOCKWISE);
    encoder1_callback(UP_CLOCKWISE);
    encoder1_callback(ENCODER_UP);
    advance(350);
    encoder_scan_user();
    assert(get_menu_index() == 3 && !menu_previews && !menu_loads && macros == before);

    assert(pet_mode_control(9, 0) == 0);
    const uint8_t season = pet_mode_season();
    const uint8_t scene = pet_care_get()->scene;
    assert(pet_mode_control(4, 23) == 0);
    encoder1_callback(ANTICLOCKWISE); /* Physical clockwise on the left encoder. */
    assert(pet_mode_hour() == 0);
    encoder1_callback(CLOCKWISE);
    assert(pet_mode_hour() == 23);
    encoder2_callback(CLOCKWISE);
    assert(pet_mode_season() == (season + 1) % 4);
    encoder2_callback(ENCODER_DOWN);
    encoder2_callback(UP_CLOCKWISE);
    encoder2_callback(ENCODER_UP);
    assert(pet_care_get()->scene != scene && macros == before);

    encoder1_callback(ENCODER_DOWN);
    assert(pet_mode_control(1, 0) == 0);
    encoder1_callback(UP_CLOCKWISE);
    encoder1_callback(ENCODER_UP);
    assert(get_menu_index() == 3 && macros == before);

    encoder1_callback(ENCODER_DOWN);
    encoder1_callback(UP_CLOCKWISE);
    encoder1_callback(ENCODER_UP);
    assert(get_menu_index() == 4 && menu_previews == 1 && macros == before + 2);
    assert(pet_mode_control(1, 1) == 0);
    advance(350);
    encoder_scan_user();
    assert(menu_loads == 0);
    assert(pet_mode_control(1, 0) == 0);
    encoder_scan_user();
    assert(menu_loads == 1);
}

int main(void) {
    pet_care_init(0); /* In-memory care. Separate NOR tests exercise durable storage. */
    gestures_and_framebuffer();
    concurrent_activities();
    table_and_food_positions();
    dance_and_window();
    pendant_lamp_brightens_only_the_room_at_night();
    lamp_manual_override_expires_at_clock_boundaries();
    ambient_light_uses_manual_time_and_synced_minutes();
    assert(pet_mode_control(6, 1) == 0);
    const PetAction grooming[] = {PET_GROOM_FUR, PET_GROOM_EAR};
    for (unsigned i = 0; i < 2; ++i) {
        int x = pet_mode_x(), affection = pet_care_get()->affection;
        assert(pet_mode_control(3, grooming[i]) == 0);
        advance(400);
        memcpy(before, lcd, sizeof(lcd));
        advance(410);
        assert(pet_mode_action() == grooming[i] && memcmp(before, lcd, sizeof(lcd)) != 0);
        advance(i ? 2250 : 1750);
        assert(pet_mode_action() == PET_IDLE && pet_mode_x() == x && pet_care_get()->affection == affection);
    }
    pet_care_adjust(100, 100, 0, 0);
    bool saw_lookout = false, saw_table = false;
    for (unsigned i = 0; i < 2400 && !(saw_lookout && saw_table); i++) {
        advance(75);
        saw_lookout |= pet_mode_action() == PET_STAND_WATCH;
        saw_table |= pet_mode_action() == PET_INSPECT_TABLE;
    }
    assert(saw_lookout && saw_table);
    assert(pet_mode_control(6, 0) == 0 && pet_mode_control(6, 1) == 0);
    assert(pet_mode_control(3, PET_INSPECT_TABLE) == 0);
    pet_care_adjust(-100, 0, 0, 0);
    assert(pet_mode_active_toy() != 0);
    assert(pet_mode_control(2, 1) == 0);
    advance(675);
    assert(pet_mode_active_toy() == 0 && pet_mode_fruit() == 1);
    advance(4500);
    assert(pet_care_get()->satiety == 12);
    assert(pet_mode_queue_depth() == 0);
    assert(pet_mode_control(1, 0) == 0 && pet_mode_control(1, 1) == 0);
    for (unsigned i = 0; i < 7000 && pet_mode_action() != PET_DAYDREAM; ++i) advance(1);
    assert(pet_mode_action() == PET_DAYDREAM);
    const int daydream_x = pet_mode_x();
    advance(14999);
    assert(pet_mode_action() == PET_DAYDREAM && pet_mode_x() == daydream_x);
    advance(1);
    assert(pet_mode_action() == PET_IDLE);
    assert(pet_mode_control(3, PET_GAZE_OWNER) == 0);
    advance(7999);
    assert(pet_mode_action() == PET_GAZE_OWNER);
    advance(1);
    assert(pet_mode_action() == PET_IDLE);
    assert(pet_mode_play_timed(PET_GROOM_FUR | (9u << 5)) == 0);
    advance(8999);
    assert(pet_mode_action() == PET_GROOM_FUR && pet_mode_timed_remaining() == 1);
    advance(1);
    assert(pet_mode_action() == PET_IDLE && pet_mode_timed_remaining() == 0);
    assert(pet_mode_play_timed(PET_BLINK | (5u << 5)) == 3);
    pet_care_adjust(0, -100, 0, 0);
    assert(pet_mode_play_timed(PET_SLEEP | (5u << 5) | (60u << 14)) == 0);
    assert(pet_mode_timed_remaining() == 5);
    for (unsigned i = 0; i < 5000 && pet_mode_action() != PET_SLEEP; ++i) advance(1);
    assert(pet_mode_action() == PET_SLEEP && pet_mode_timed_remaining() == 5);
    advance(4999);
    assert(pet_mode_action() == PET_SLEEP);
    advance(1);
    assert(pet_mode_action() == PET_IDLE && pet_mode_timed_remaining() == 0);
    assert(pet_care_get()->energy < 60);
    pet_care_adjust(0, 59 - pet_care_get()->energy, 0, 0);
    assert(pet_care_get()->energy == 59);
    assert(pet_mode_play_timed(PET_SLEEP | (90u << 5) | (60u << 14)) == 0);
    for (unsigned i = 0; i < 5000 && pet_mode_action() != PET_SLEEP; ++i) advance(1);
    assert(pet_mode_action() == PET_SLEEP);
    advance(PET_SLEEP_RECOVERY_MS - 1);
    assert(pet_mode_action() == PET_SLEEP && pet_care_get()->energy == 59);
    advance(1);
    assert(pet_mode_action() != PET_SLEEP && pet_mode_timed_remaining() == 0);
    assert(pet_care_get()->energy == 60);
    small_encoders_keep_work_layers_out_of_pet_mode();
    assert(pet_mode_control(1, 1) == 0);
    restore_performance_without_image();
    puts("Pet encoder gesture and performance transition tests passed");
    return 0;
}
