#include "pet_mode.h"
#include "pet_care.h"
#include "live_oled.h"
#include "lcd_user.h"
#include <stddef.h>
#include <string.h>

#include "pet_art.inc"

enum {
    SLICE_ROWS = 4,
    FRAME_MS = 48,
    SLEEP_AFTER_MS = 18000,
    ENCODER_HOLD_MS = 1200,
    GROUND = 139,
    WALK_MIN = 46,
    WALK_MAX = 274,
    DIRTY_MARGIN = 38,
    DIRTY_TOP = 73,
    DIRTY_BOTTOM = 147,
    FRUIT_COUNT = 8,
    FRUIT_RADIUS = 9,
    FRUIT_GROUND = 129,
    FALL_MS = 650,
    FRUIT_EAT_MS = 850
};

#define RGB565(r, g, b) (((r) >> 3) << 11 | ((g) >> 2) << 5 | ((b) >> 3))
#define HEX565(rgb) RGB565(((rgb) >> 16) & 255, ((rgb) >> 8) & 255, (rgb) & 255)

#include "pet_scene_art.inc"

_Static_assert(sizeof(fruit_art) / sizeof(fruit_art[0]) == FRUIT_COUNT, "Each key needs fruit art");

typedef struct {
    uint16_t left, right, row, bottom;
    int16_t x, y;
    int8_t direction;
    uint8_t sprite;
    PetAction action;
    uint32_t elapsed;
    PetFloorFood foods[PET_FLOOR_CAPACITY];
    uint8_t food_count, hour, minute, season, scene, visible_toy, using_toy, drop;
    bool bowl;
} PetFrame;

static bool active;
static PetAction action;
static uint32_t action_since, last_input, last_frame, last_motion, frames;
static int16_t x, last_x;
static int8_t direction;
static uint32_t walk_remainder;
static PetFrame frame;
static uint8_t pixels[LCD_WIDTH * SLICE_ROWS * 2];
static uint16_t scene_palette[24];
static uint8_t hour = 8, minute, season;
static uint32_t clock_anchor;
static uint16_t nursery_palette[sizeof(pet_palette) / sizeof(pet_palette[0])];
static bool redraw_scene;
enum { FOOD_FALLING, FOOD_LANDED, FOOD_EATING };
typedef struct {
    uint32_t dropped_at;
    int16_t x;
    uint8_t id, stage, source;
} FloorFood;
typedef struct {
    FloorFood foods[PET_FLOOR_CAPACITY];
    uint8_t count, toy_source;
    uint32_t toy_dropped_at;
    bool toy_falling, awaiting_play;
} PetFloor;
static PetFloor floors[PET_SCENE_COUNT];
static uint8_t fruit, keys_seen;
static uint32_t key_at[PET_KEY_COUNT];

static PetFloor *current_floor(void) { return &floors[pet_care_get()->scene]; }

static bool encoder_down, encoder_rotated, encoder_toggled, encoder_claimed;
static uint32_t encoder_since;

static bool manual_idle;
static PetEvent events[PET_EVENT_CAPACITY];
static uint32_t event_sequence;
static uint8_t event_count;

enum { SOURCE_AUTOMATIC, SOURCE_PHYSICAL, SOURCE_MCP };
enum { TOY_IDLE, TOY_APPROACHING, TOY_USING };
enum { TOY_RABBIT_HUTCH = 1, TOY_CARROT, ANY_SCENE = 255, CARROT_X = 174, CARROT_Y = 131 };
enum { OK = 0, INVALID = 3, BUSY = 4, INACTIVE = 5 };

typedef struct {
    uint8_t id, scene;
    int16_t target_x;
    int8_t facing;
    PetAction activity;
    uint16_t duration_ms;
    int8_t fatigue_delta, mood_delta, affection_delta;
} PetToy;

static const PetToy toys[] = {
    {TOY_RABBIT_HUTCH, PET_NURSERY, 246, -1, PET_SLEEP, 4500, -12, 5, 2},
    {TOY_CARROT, ANY_SCENE, CARROT_X - 23, 1, PET_EAT, 2400, 2, 6, 2}
};
static const PetToy *active_toy;
static uint8_t toy_phase, toy_source, action_source, walk_stops;
static bool bedtime, return_for_garden_food;

static bool hungry(void) { return pet_care_get()->satiety < 100; }

static const PetToy *find_toy(uint8_t id) {
    for (unsigned i = 0; i < sizeof(toys) / sizeof(toys[0]); i++)
        if (toys[i].id == id && (toys[i].scene == ANY_SCENE || toys[i].scene == pet_care_get()->scene)) return toys + i;
    return NULL;
}

static void record_event(PetEventKind kind, uint8_t value, uint8_t source, uint8_t detail) {
    const uint32_t sequence = ++event_sequence;
    events[(sequence - 1) % PET_EVENT_CAPACITY] =
        (PetEvent){sequence, HAL_GetTick(), kind, value, source, detail};
    if (event_count < PET_EVENT_CAPACITY) event_count++;
}

uint8_t pet_mode_events(uint32_t after, PetEvent *out, bool *overrun, bool *more) {
    const uint32_t before_oldest = event_sequence - event_count;
    *overrun = after < before_oldest || after > event_sequence;
    if (*overrun) after = before_oldest;
    const uint32_t available = event_sequence - after;
    *more = available > PET_EVENTS_PER_REPLY;
    const uint8_t count = *more ? PET_EVENTS_PER_REPLY : (uint8_t)available;
    for (uint8_t i = 0; i < count; i++) out[i] = events[(after + i) % PET_EVENT_CAPACITY];
    return count;
}

static void set_action_from(PetAction next, uint32_t now, uint8_t source) {
    action = next;
    action_source = source;
    action_since = now;
    manual_idle = next == PET_IDLE && source == SOURCE_MCP;
    record_event(PET_EVENT_ACTION, next, source, fruit);
}

static void set_action(PetAction next, uint32_t now) {
    set_action_from(next, now, SOURCE_AUTOMATIC);
}

static void end_toy(bool interrupted, uint8_t source, uint32_t now);

static void change_background(uint8_t scene, uint8_t source) {
    const uint8_t previous = pet_care_get()->scene;
    if (scene == previous) return;
    end_toy(true, source, HAL_GetTick());
    if (fruit) {
        if (current_floor()->foods[0].stage == FOOD_EATING) current_floor()->foods[0].stage = FOOD_LANDED;
        fruit = 0;
        set_action_from(PET_IDLE, HAL_GetTick(), source);
    }
    pet_care_set_scene(scene);
    redraw_scene = true;
    record_event(PET_EVENT_SCENE, scene, source, previous);
}

static void end_toy(bool interrupted, uint8_t source, uint32_t now) {
    if (!active_toy) return;
    record_event(PET_EVENT_TOY_FINISHED, active_toy->id, source, interrupted);
    active_toy = NULL;
    toy_phase = TOY_IDLE;
    bedtime = false;
    return_for_garden_food = false;
    last_input = now;
    set_action_from(PET_IDLE, now, source);
}

static void start_toy(const PetToy *toy, bool long_sleep, uint8_t source, uint32_t now) {
    current_floor()->awaiting_play = false;
    active_toy = toy;
    toy_source = source;
    bedtime = long_sleep;
    toy_phase = TOY_APPROACHING;
    direction = x < toy->target_x ? 1 : -1;
    walk_remainder = 0;
    last_input = now;
    record_event(PET_EVENT_TOY_STARTED, toy->id, source, 0);
    set_action_from(PET_WALK, now, source);
}

static void place_toy(uint8_t id, uint8_t source, uint32_t now) {
    const uint8_t scene = pet_care_get()->scene, previous = pet_care_get()->placed[scene];
    PetFloor *floor = current_floor();
    if (previous) {
        end_toy(true, source, now);
        record_event(PET_EVENT_TOY_REMOVED, previous, source, scene);
    }
    pet_care_set_toy(scene, id);
    floor->awaiting_play = floor->toy_falling = id != 0;
    floor->toy_dropped_at = last_input = now;
    floor->toy_source = source;
    if (id) record_event(PET_EVENT_TOY_PLACED, id, source, scene);
}

static uint8_t deploy_toy(uint8_t id, bool only_if_empty, uint8_t source, uint32_t now) {
    if (!find_toy(id)) return INVALID;
    const uint8_t placed = pet_care_get()->placed[pet_care_get()->scene];
    if (only_if_empty && placed) return placed == id ? OK : BUSY;
    place_toy(placed == id ? 0 : id, source, now);
    return OK;
}

static void go_to_bed(uint8_t source, uint32_t now) {
    const bool left_food = pet_care_get()->scene == PET_GARDEN && current_floor()->count;
    change_background(PET_NURSERY, source);
    if (pet_care_get()->placed[PET_NURSERY] != TOY_RABBIT_HUTCH)
        place_toy(TOY_RABBIT_HUTCH, source, now);
    start_toy(find_toy(TOY_RABBIT_HUTCH), true, source, now);
    return_for_garden_food = left_food;
}

static void start_mode(uint32_t now) {
    active = true;
    x = last_x = 78;
    direction = 1;
    frames = walk_remainder = 0;
    last_input = last_frame = last_motion = now;
    fruit = keys_seen = 0;
    redraw_scene = true;
    set_action(PET_WALK, now);
    frame = (PetFrame){0};
}

static void set_mode(bool enabled, uint8_t source, uint32_t now) {
    if (active == enabled) return;
    record_event(PET_EVENT_MODE, enabled, source, 0);
    live_oled_mode_changed();
    if (enabled) {
        start_mode(now);
    } else {
        end_toy(true, source, now);
        if (fruit && current_floor()->foods[0].stage == FOOD_EATING) current_floor()->foods[0].stage = FOOD_LANDED;
        fruit = 0;
        active = false;
        pet_care_save();
        restore_menu_color();
    }
}

bool pet_mode_is_active(void) { return active; }
PetAction pet_mode_action(void) { return active ? action : PET_IDLE; }
uint16_t pet_mode_x(void) { return active ? (uint16_t)x : 0; }
uint32_t pet_mode_frames(void) { return frames; }
uint8_t pet_mode_fruit(void) { return active ? fruit : 0; }
uint8_t pet_mode_hour(void) { return hour; }
uint8_t pet_mode_minute(void) { return minute; }
bool pet_mode_is_bedtime(void) { return bedtime; }
uint8_t pet_mode_season(void) { return season; }
uint8_t pet_mode_queue_depth(void) { return active ? current_floor()->count - (fruit != 0) : 0; }

uint8_t pet_mode_toy_drop(void) {
    const PetFloor *floor = current_floor();
    const uint32_t elapsed = HAL_GetTick() - floor->toy_dropped_at;
    return !floor->toy_falling || elapsed >= FALL_MS ? 100 : elapsed * 100 / FALL_MS;
}

uint8_t pet_mode_foods(PetFloorFood *out) {
    const PetFloor *floor = current_floor();
    uint32_t now = HAL_GetTick();
    for (unsigned i = 0; i < floor->count; i++) {
        const FloorFood *food = floor->foods + i;
        const uint32_t age = now - food->dropped_at;
        const int16_t y = food->stage == FOOD_FALLING && age < FALL_MS
            ? (int16_t)((FRUIT_GROUND + FRUIT_RADIUS) * age * (age + FALL_MS) / (2u * FALL_MS * FALL_MS)) - FRUIT_RADIUS
            : FRUIT_GROUND;
        out[i] = (PetFloorFood){food->x, y, food->id, food->stage};
    }
    return floor->count;
}
uint8_t pet_mode_active_toy(void) { return active_toy ? active_toy->id : 0; }
uint8_t pet_mode_toy_phase(void) { return toy_phase; }

bool pet_mode_encoder_button(bool down) {
    const uint32_t now = HAL_GetTick();
    if (down) {
        encoder_down = true;
        encoder_since = now;
        encoder_rotated = encoder_toggled = false;
        encoder_claimed = active;
    } else if (encoder_down) {
        encoder_down = false;
        if (encoder_claimed && active && hungry() && !fruit && (!active_toy || bedtime) && !encoder_toggled && !encoder_rotated &&
            now - encoder_since >= 40) {
            last_input = now;
            if (bedtime) end_toy(true, SOURCE_PHYSICAL, now);
            record_event(PET_EVENT_SNACK, 0, SOURCE_PHYSICAL, 3);
            set_action_from(PET_EAT, now, SOURCE_PHYSICAL);
        }
    }
    return encoder_claimed;
}

void pet_mode_encoder_rotated(void) {
    if (encoder_down) encoder_rotated = true;
}

static bool queue_fruit(uint8_t requested, uint8_t source, uint32_t now) {
    PetFloor *floor = current_floor();
    if (floor->count == PET_FLOOR_CAPACITY) return false;
    if (bedtime && hungry()) end_toy(true, source, now);
    /* Choose the closest free landing site to the original toss, keeping fruit distinct. */
    const int preferred = x + (requested % 2 ? 77 : -77);
    int best = 0, shortest = LCD_WIDTH * 2;
    for (int lane = 0; lane < PET_FLOOR_CAPACITY; lane++) {
        const int candidate = 41 + lane * 34;
        bool free = true;
        for (unsigned i = 0; i < floor->count; i++) if (floor->foods[i].x == candidate) free = false;
        int dist = candidate > preferred ? candidate - preferred : preferred - candidate;
        if (free && dist < shortest) { best = candidate; shortest = dist; }
    }
    floor->foods[floor->count++] = (FloorFood){now, best, requested, FOOD_FALLING, source};
    last_input = now;
    record_event(PET_EVENT_FRUIT_QUEUED, requested, source, pet_mode_queue_depth());
    return true;
}

static uint8_t trigger_key(uint8_t key, uint8_t source, uint32_t now) {
    const uint8_t item = pet_care_get()->bindings[key];
    record_event(PET_EVENT_KEY, key + 1, source, item);
    if (!item) return OK;
    if (item <= FRUIT_COUNT) return queue_fruit(item, source, now) ? OK : BUSY;
    if (item == ITEM_HUTCH) change_background(PET_NURSERY, source);
    return deploy_toy(item == ITEM_HUTCH ? TOY_RABBIT_HUTCH : TOY_CARROT, false, source, now);
}

bool pet_mode_key_down(uint8_t key) {
    if (!active || key >= PET_KEY_COUNT) return false;
    const uint32_t now = HAL_GetTick();
    const uint8_t bit = (uint8_t)(1u << key);
    if (!(keys_seen & bit) || now - key_at[key] >= 65) {
        keys_seen |= bit;
        key_at[key] = now;
        trigger_key(key, SOURCE_PHYSICAL, now);
    }
    return pet_care_get()->bindings[key] != 0;
}

static void set_scene_value(uint8_t value, bool change_season, uint8_t source) {
    uint8_t *current = change_season ? &season : &hour;
    if (*current == value) return;
    record_event(change_season ? PET_EVENT_SEASON : PET_EVENT_HOUR, value, source, *current);
    *current = value;
    redraw_scene = true;
}

static void set_time(uint16_t minutes, uint8_t source) {
    if (minute != minutes % 60) redraw_scene = true;
    minute = minutes % 60;
    set_scene_value(minutes / 60, false, source);
}

void pet_mode_cycle_background(int8_t step) {
    if (!active) return;
    change_background((pet_care_get()->scene + PET_SCENE_COUNT + step) % PET_SCENE_COUNT, SOURCE_PHYSICAL);
    last_input = HAL_GetTick();
}

void pet_mode_adjust_scene(int8_t direction_step, bool change_season) {
    if (!active) return;
    if (change_season) {
        set_scene_value((season + 4 + direction_step) % 4, true, SOURCE_PHYSICAL);
    } else if (!pet_care_get()->follow_time) {
        set_time(((hour + 24 + direction_step) % 24) * 60, SOURCE_PHYSICAL);
    }
}

uint8_t pet_mode_control(uint8_t opcode, uint8_t value) {
    enum { MODE = 1, FEED, PLAY, HOUR, SEASON, SCENE, DEPLOY_TOY, BIND_KEY, FOLLOW_CLOCK, PLAY_TOY = 11, TRIGGER_KEY, PLACE_IF_EMPTY, CLOCK_BASE = 16 };
    const uint32_t now = HAL_GetTick();
    if (opcode == MODE && value <= 1) {
        set_mode(value != 0, SOURCE_MCP, now);
        return OK;
    }
    if (!active) return INACTIVE;
    if (opcode >= CLOCK_BASE && opcode <= CLOCK_BASE + 5) {
        const uint16_t minutes = ((opcode - CLOCK_BASE) << 8) | value;
        if (!pet_care_get()->follow_time || minutes >= 1440) return INVALID;
        set_time(minutes, SOURCE_MCP);
        clock_anchor = now;
        return OK;
    }
    switch (opcode) {
        case FEED:
            if (!value || value > FRUIT_COUNT) return INVALID;
            return queue_fruit(value, SOURCE_MCP, now) ? OK : BUSY;
        case PLAY:
            if (value > PET_GAZE_OWNER || value == PET_FALL || value == PET_FETCH) return INVALID;
            if (fruit || (value == PET_EAT && !hungry())) return BUSY;
            if (value == PET_SLEEP) {
                if (!bedtime) {
                    end_toy(true, SOURCE_MCP, now);
                    go_to_bed(SOURCE_MCP, now);
                }
                return OK;
            }
            if (active_toy && !bedtime) return BUSY;
            if (bedtime) end_toy(true, SOURCE_MCP, now);
            last_input = now;
            walk_remainder = 0;
            set_action_from((PetAction)value, now, SOURCE_MCP);
            return OK;
        case HOUR:
            if (value >= 24 || pet_care_get()->follow_time) return INVALID;
            set_time(value * 60, SOURCE_MCP);
            return OK;
        case SEASON:
            if (value >= 4) return INVALID;
            set_scene_value(value, true, SOURCE_MCP);
            return OK;
        case SCENE:
            if (value >= PET_SCENE_COUNT) return INVALID;
            if (value == pet_care_get()->scene) return OK;
            change_background(value, SOURCE_MCP);
            last_input = now;
            return OK;
        case DEPLOY_TOY:
        case PLACE_IF_EMPTY:
            return deploy_toy(value, opcode == PLACE_IF_EMPTY, SOURCE_MCP, now);
        case PLAY_TOY: {
            const PetToy *toy = find_toy(value);
            if (!toy || pet_care_get()->placed[pet_care_get()->scene] != value) return INVALID;
            if (current_floor()->toy_falling || (current_floor()->count && hungry()) || active_toy) return BUSY;
            start_toy(toy, false, SOURCE_MCP, now);
            return OK;
        }
        case TRIGGER_KEY:
            return value < PET_KEY_COUNT ? trigger_key(value, SOURCE_MCP, now) : INVALID;
        case BIND_KEY:
            if ((value >> 4) >= PET_KEY_COUNT || (value & 15) > ITEM_CARROT) return INVALID;
            pet_care_bind(value >> 4, value & 15);
            return OK;
        case FOLLOW_CLOCK:
            if (value > 1) return INVALID;
            if (pet_care_get()->follow_time != (bool)value) {
                pet_care_follow_clock(value != 0);
                clock_anchor = now;
            }
            return OK;
        default:
            return INVALID;
    }
}

static void settle_drops(uint32_t now) {
    for (unsigned room = 0; room < PET_SCENE_COUNT; room++) {
        PetFloor *floor = floors + room;
        if (floor->toy_falling && now - floor->toy_dropped_at >= FALL_MS) floor->toy_falling = false;
        for (unsigned i = 0; i < floor->count; i++) {
            FloorFood *food = floor->foods + i;
            if (food->stage == FOOD_FALLING && now - food->dropped_at >= FALL_MS) {
                food->stage = FOOD_LANDED;
                record_event(PET_EVENT_FRUIT_DROPPED, food->id, food->source, room);
            }
        }
    }
}

static int16_t walking_step(uint32_t step_ms, uint8_t speed) {
    walk_remainder += step_ms * speed;
    const int16_t step = (int16_t)(walk_remainder / 1000);
    walk_remainder %= 1000;
    return direction * step;
}

static bool move_in_garden(uint32_t step_ms, uint8_t speed) {
    x += walking_step(step_ms, speed);
    if ((direction < 0 && x <= WALK_MIN) || (direction > 0 && x >= WALK_MAX)) {
        x = direction < 0 ? WALK_MIN : WALK_MAX;
        direction = -direction;
        return true;
    }
    return false;
}

static void update_action(uint32_t now, uint32_t step_ms) {
    const uint32_t elapsed = now - action_since;
    PetFloor *floor = current_floor();
    if (bedtime && hungry() && !floor->count && return_for_garden_food && floors[PET_GARDEN].count) {
        change_background(PET_GARDEN, SOURCE_AUTOMATIC);
        floor = current_floor();
    }
    if (bedtime && hungry() && floor->count && floor->foods[0].stage == FOOD_LANDED)
        end_toy(true, SOURCE_AUTOMATIC, now);
    if (active_toy) {
        if (toy_phase == TOY_APPROACHING) {
            x += walking_step(step_ms, 78);
            if ((direction > 0 && x >= active_toy->target_x) ||
                (direction < 0 && x <= active_toy->target_x)) {
                x = active_toy->target_x;
                if (floor->toy_falling) return;
                direction = active_toy->facing;
                toy_phase = TOY_USING;
                set_action(active_toy->activity, now);
            }
        } else if (!bedtime && elapsed >= active_toy->duration_ms) {
            pet_care_adjust(0, active_toy->fatigue_delta, active_toy->mood_delta, active_toy->affection_delta);
            pet_care_save();
            end_toy(false, toy_source, now);
        }
        return;
    }
    if (!fruit && hungry() && floor->count && floor->foods[0].stage == FOOD_LANDED) {
        fruit = floor->foods[0].id;
        direction = floor->foods[0].x >= x ? 1 : -1;
        walk_remainder = 0;
        set_action(PET_FETCH, now);
        return;
    }
    if (!fruit && !floor->toy_falling && floor->awaiting_play && !(floor->count && hungry())) {
        const PetToy *toy = find_toy(pet_care_get()->placed[pet_care_get()->scene]);
        if (toy) { start_toy(toy, false, floor->toy_source, now); return; }
    }
    switch (action) {
        case PET_SLEEP:
            return;
        case PET_FALL: /* The old protocol used an exclusive action during a drop. */
            return;
        case PET_FETCH: {
            const int16_t feeding_distance = RABBIT_FRUIT_CONTACT_X - RABBIT_ANCHOR_X + FRUIT_RADIUS;
            const int16_t target = floor->foods[0].x - direction * feeding_distance;
            x += walking_step(step_ms, 88);
            if ((direction > 0 && x >= target) || (direction < 0 && x <= target)) {
                x = target;
                floor->foods[0].stage = FOOD_EATING;
                set_action(PET_EAT, now);
            }
            return;
        }
        case PET_EAT:
            if (elapsed >= (fruit ? FRUIT_EAT_MS : 2100u)) {
                if (fruit) {
                    pet_care_adjust(12, 0, 3, 2);
                    pet_care_save();
                    record_event(PET_EVENT_FRUIT_EATEN, fruit, floor->foods[0].source, pet_care_get()->scene);
                    floor->count--;
                    memmove(floor->foods, floor->foods + 1, floor->count * sizeof(FloorFood));
                } else if (action_source == SOURCE_PHYSICAL) {
                    pet_care_adjust(4, 0, 1, 1);
                    pet_care_save();
                }
                fruit = 0;
                last_input = now;
                set_action(PET_IDLE, now);
            }
            return;
        case PET_TRIP_ANGRY:
        case PET_GAZE_OWNER:
            if (elapsed >= (action == PET_TRIP_ANGRY ? 2050u : 3000u)) {
                if (action == PET_TRIP_ANGRY) pet_care_adjust(0, 1, -4, 0);
                else pet_care_adjust(0, 0, 1, action_source == SOURCE_MCP ? 1 : 0);
                pet_care_save();
                set_action(PET_IDLE, now);
            }
            return;
        case PET_JUMP:
        case PET_BLINK:
        case PET_DAYDREAM: {
            const uint32_t duration = action == PET_JUMP ? 500u : action == PET_BLINK ? 125u : 1750u;
            if (elapsed >= duration) set_action(PET_IDLE, now);
            return;
        }
        case PET_RUN:
        case PET_FLEE:
            if (elapsed >= 2300) set_action(PET_IDLE, now);
            else if (action == PET_RUN || elapsed >= 250) move_in_garden(step_ms, action == PET_RUN ? 110 : 145);
            return;
        case PET_IDLE:
        case PET_WALK:
            break;
    }

    if ((!floor->count || !hungry()) && now - last_input >= SLEEP_AFTER_MS) {
        go_to_bed(SOURCE_AUTOMATIC, now);
    } else if (action == PET_IDLE) {
        if (elapsed >= 1700) set_action(PET_WALK, now);
    } else {
        if (move_in_garden(step_ms, 37) || elapsed >= 3600) {
            /* A short look toward the owner between walks. Most pauses stay idle. */
            set_action(++walk_stops % 4 == 2 ? PET_GAZE_OWNER : PET_IDLE, now);
        }
    }
}

static uint16_t blend(uint16_t from, uint16_t to, uint8_t part, uint8_t total) {
    const uint8_t rest = total - part;
    const uint16_t red = (((from >> 11) * rest + (to >> 11) * part) / total) << 11;
    const uint16_t green = ((((from >> 5) & 63) * rest + ((to >> 5) & 63) * part) / total) << 5;
    const uint16_t blue = ((from & 31) * rest + (to & 31) * part) / total;
    return red | green | blue;
}

static uint16_t nursery_light(uint16_t color) {
    static const uint16_t seasons[] = {0, HEX565(0xffdb82), HEX565(0xdd975e), HEX565(0xb6d7f1)};
    if (season) color = blend(color, seasons[season], 1, 8);
    const uint8_t shade = hour < 6 || hour >= 20 ? 2 : hour == 6 || hour == 19 ? 1 : 0;
    return shade ? blend(color, HEX565(0x3f486a), shade, 4) : color;
}

static void update_palette(void) {
    if (pet_care_get()->scene == PET_NURSERY) {
        for (unsigned i = 0; i < sizeof(pet_palette) / sizeof(pet_palette[0]); i++)
            nursery_palette[i] = nursery_light(pet_palette[i]);
        return;
    }
    const uint8_t start = hour / 3;
    const uint8_t end = (start + 1) % 8;
    const uint8_t night = hour < 6 ? 6 - hour : hour > 18 ? hour - 18 : 0;
    /* The original garden stores its base sky color before the other bands. */
    static const uint8_t sky_entries[] = {2, 3, 1, 4};
    for (uint8_t index = 0; index < 4; index++) {
        scene_palette[sky_entries[index]] = blend(sky_at_hour[start][index],
                                                  sky_at_hour[end][index], hour % 3, 3);
    }
    scene_palette[6] = blend(scene_palette[3], HEX565(0xffeade), 3, 8);
    scene_palette[7] = blend(scene_palette[6], HEX565(0xfffbf1), 2, 8);
    for (uint8_t index = 8; index < 24; index++) {
        scene_palette[index] = blend(garden_at_season[season][index - 8],
                                    HEX565(0x262446), night, 10);
    }
}

static RabbitClipId action_clip(uint32_t elapsed) {
    switch (action) {
        case PET_IDLE:
            if (manual_idle) return RABBIT_IDLE;
            return elapsed >= 1400 && elapsed < 1525 ? RABBIT_BLINK : RABBIT_DAYDREAM;
        case PET_WALK:
        case PET_FETCH: return RABBIT_WALK;
        case PET_SLEEP: return RABBIT_SLEEP;
        case PET_EAT: return RABBIT_EAT;
        case PET_FALL:
        case PET_JUMP: return RABBIT_JUMP;
        case PET_RUN: return RABBIT_RUN;
        case PET_BLINK: return RABBIT_BLINK;
        case PET_DAYDREAM: return RABBIT_DAYDREAM;
        case PET_FLEE: return RABBIT_FLEE;
        case PET_TRIP_ANGRY: return RABBIT_TRIP_ANGRY;
        case PET_GAZE_OWNER: return RABBIT_GAZE_OWNER;
    }
    return RABBIT_IDLE;
}

static uint8_t sprite_frame(RabbitClipId id, uint32_t elapsed) {
    const RabbitClip *clip = &rabbit_clips[id];
    uint32_t tick = (elapsed / 1000) * RABBIT_TICK_RATE + (elapsed % 1000) * RABBIT_TICK_RATE / 1000;
    if (tick >= clip->duration) {
        if (!clip->loop) return clip->first + clip->count - 1;
        tick = clip->loop_start + (tick - clip->loop_start) % (clip->duration - clip->loop_start);
    }
    for (uint8_t index = 0; index < clip->count; index++) {
        if (tick < clip->ticks[index]) return clip->first + index;
        tick -= clip->ticks[index];
    }
    return clip->first;
}

typedef struct { int16_t left, top, right; } DirtyArea;

static void include_rect(DirtyArea *area, int x0, int y0, int width) {
    if (x0 < area->left) area->left = x0;
    if (x0 + width > area->right) area->right = x0 + width;
    if (y0 < area->top) area->top = y0;
}

static int drop_offset(uint8_t progress) {
    return -(146 * (100 - progress) + 50) / 100;
}

static void include_toy(DirtyArea *area, const PetFrame *f) {
    if (f->visible_toy == TOY_RABBIT_HUTCH)
        include_rect(area, 205, 73 + drop_offset(f->drop), 81);
    if (f->visible_toy == TOY_CARROT)
        include_rect(area, CARROT_X - 10, CARROT_Y - 12 + drop_offset(f->drop), 28);
}

static void begin_frame(uint32_t now) {
    const uint32_t elapsed = now - action_since;
    DirtyArea area = {(x < last_x ? x : last_x) - DIRTY_MARGIN, DIRTY_TOP,
                      (x > last_x ? x : last_x) + DIRTY_MARGIN};
    const uint8_t scene = pet_care_get()->scene;
    const uint8_t using = toy_phase == TOY_USING ? active_toy->id : 0;
    PetFrame next = {
        .bottom = DIRTY_BOTTOM, .x = x, .y = GROUND + (using == TOY_RABBIT_HUTCH ? 3 : 0),
        .direction = direction, .sprite = sprite_frame(action_clip(elapsed), elapsed),
        .action = action, .elapsed = elapsed, .hour = hour, .minute = minute, .season = season,
        .scene = scene, .visible_toy = pet_care_get()->placed[scene], .using_toy = using,
        .drop = pet_mode_toy_drop(), .bowl = action == PET_EAT && !fruit && !active_toy
    };
    if (next.visible_toy != frame.visible_toy || next.drop != frame.drop) {
        include_toy(&area, &frame);
        include_toy(&area, &next);
    }
    next.food_count = pet_mode_foods(next.foods);
    for (unsigned i = 0; i < next.food_count || i < frame.food_count; i++) {
        const PetFloorFood *old = frame.foods + i, *fresh = next.foods + i;
        /* Stationary items are repainted automatically wherever the rabbit walks. */
        if (i < next.food_count && i < frame.food_count &&
            old->id == fresh->id && old->x == fresh->x && old->y == fresh->y) continue;
        if (i < next.food_count) include_rect(&area, fresh->x - FRUIT_RADIUS, fresh->y - FRUIT_RADIUS, 2 * FRUIT_RADIUS);
        if (i < frame.food_count) include_rect(&area, old->x - FRUIT_RADIUS, old->y - FRUIT_RADIUS, 2 * FRUIT_RADIUS);
    }
    next.left = area.left > 0 ? area.left : 0;
    next.right = area.right < LCD_WIDTH ? area.right : LCD_WIDTH;
    next.row = area.top > 0 ? area.top : 0;
    frame = next;
    if (redraw_scene) {
        update_palette();
        frame.left = frame.row = 0;
        frame.right = LCD_WIDTH;
        frame.bottom = LCD_HEIGHT;
        redraw_scene = false;
    }
    last_x = x;
    last_frame = now;
}

static void paint_span(uint8_t *line, int16_t left, int16_t right, uint16_t color) {
    if (left < frame.left) left = frame.left;
    if (right > frame.right) right = frame.right;
    for (int16_t column = left; column < right; column++) {
        uint16_t offset = (column - frame.left) * 2;
        line[offset] = color >> 8;
        line[offset + 1] = color;
    }
}

static void paint_rect(uint8_t *line, uint16_t row, int16_t left, int16_t top,
                       uint8_t width, uint8_t height, uint16_t color) {
    if (row >= top && row < top + height) paint_span(line, left, left + width, color);
}

static void paint_rabbit(uint8_t *line, uint16_t row) {
    const int16_t sprite_y = row - frame.y + RABBIT_ANCHOR_Y;
    if (sprite_y < 0 || sprite_y >= RABBIT_HEIGHT) return;
    const uint16_t row_index = frame.sprite * RABBIT_HEIGHT + sprite_y;
    uint8_t offset = 0;
    for (uint16_t run = rabbit_rows[row_index]; run < rabbit_rows[row_index + 1]; run++) {
        const uint8_t count = rabbit_runs[run * 2];
        const uint8_t color = rabbit_runs[run * 2 + 1];
        if (color) {
            const int16_t left = frame.direction > 0 ? frame.x - RABBIT_ANCHOR_X + offset :
                                 frame.x + RABBIT_ANCHOR_X - offset - count;
            paint_span(line, left, left + count, pet_palette[color]);
        }
        offset += count;
    }
}

static void paint_hutch(uint8_t *line, uint16_t row) {
    const int local = (int)row - 73 - drop_offset(frame.drop);
    if (local < 0 || local >= 74) return;
    int col = 205;
    for (uint16_t run = hutch_rows[local]; run < hutch_rows[local + 1]; run++) {
        const int end = col + hutch_runs[run * 2];
        uint8_t color = hutch_runs[run * 2 + 1];
        if (color) paint_span(line, col, end, nursery_palette[color]);
        col = end;
    }
}

static void paint_carrot(uint8_t *line, uint16_t row) {
    static const char shape[][11] = {
        "......g.g.", "......gg.g", "....xxggg.", "...xhhfx..", "..xhffffx.",
        ".xfffffx..", ".xfffx....", "xfffx.....", "xxx......."
    };
    static const uint8_t nudge_x[] = {0,2,4,2}, lift[] = {0,3,2,0};
    const unsigned phase = frame.using_toy == TOY_CARROT ? frame.elapsed / 120 % 4 : 0;
    const int top = CARROT_Y - 8 - lift[phase] + drop_offset(frame.drop);
    const int left = CARROT_X - 9 + nudge_x[phase];
    if ((int)row < top || (int)row >= top + 18) return;
    const char *art = shape[((int)row - top) / 2];
    for (int i = 0; i < 10; i++) {
        uint16_t color;
        switch (art[i]) {
            case 'g': color = HEX565(0x60996c); break;
            case 'h': color = HEX565(0xffcc80); break;
            case 'f': color = HEX565(0xf29a57); break;
            case 'x': color = HEX565(0xa7654a); break;
            default: continue;
        }
        paint_span(line, left + i*2, left + i*2 + 2, color);
    }
}

static void paint_fruit(uint8_t *line, uint16_t row, const PetFloorFood *food) {
    const int16_t local_y = (int16_t)row - food->y + FRUIT_RADIUS;
    if (local_y < 0 || local_y >= FRUIT_RADIUS * 2) return;
    const uint8_t fruit_index = food->id - 1;
    const char *shape = fruit_art[fruit_index].rows[local_y / 2];
    for (uint8_t column = 0; column < 9; column++) {
        uint16_t color;
        switch (shape[column]) {
            case 'x': color = HEX565(0x3f2b40); break;
            case 'f': color = fruit_art[fruit_index].body; break;
            case 'h': color = fruit_art[fruit_index].light; break;
            case 'g': color = HEX565(0x76a94e); break;
            default: continue;
        }
        const int16_t left = food->x - FRUIT_RADIUS + column * 2;
        paint_span(line, left, left + 2, color);
    }
}

static uint16_t sky_color(uint16_t row) {
    return scene_palette[row < 23 ? 2 : row < 44 ? 3 : row < 66 ? 1 : 4];
}

static void paint_sky(uint8_t *line, uint16_t row) {
    const bool daylight = frame.hour >= 6 && frame.hour <= 18;
    int16_t body_x = 236, body_y = 43;
    uint8_t radius = 11;
    if (daylight) {
        const uint8_t progress = frame.hour - 6;
        body_x = 37 + 20 * progress;
        body_y = 63 - (unsigned)progress * (12 - progress);
        radius = 15;
    }
    const int16_t dy = (int16_t)row - body_y;
    if (dy >= -(int16_t)radius && dy <= radius) {
        int16_t half = radius;
        while (half * half + dy * dy > radius * radius) half--;
        const uint16_t color = daylight ? HEX565(0xffe7b1) : HEX565(0xf4e6d1);
        paint_span(line, body_x - half, body_x + half + 1, color);
        const int16_t cut_y = dy + 3;
        if (!daylight && cut_y >= -10 && cut_y <= 10) {
            int16_t cut_half = 10;
            while (cut_half * cut_half + cut_y * cut_y > 100) cut_half--;
            const int16_t cut_left = body_x + 6 - cut_half;
            const int16_t left = cut_left > body_x - half ? cut_left : body_x - half;
            const int16_t cut_right = body_x + 6 + cut_half;
            const int16_t right = cut_right < body_x + half ? cut_right : body_x + half;
            paint_span(line, left, right + 1, sky_color(row));
        }
    }
    if (!daylight && row >= 28 && row <= 66) {
        static const uint16_t stars[][2] = {{27, 47}, {51, 32}, {85, 49}, {128, 35},
                                           {162, 65}, {184, 46}, {266, 60}, {292, 35}};
        for (uint8_t i = 0; i < sizeof(stars) / sizeof(stars[0]); i++) {
            paint_rect(line, row, stars[i][0], stars[i][1], 2, 2, HEX565(0xedddc8));
        }
    }
}

static void paint_controls(uint8_t *line, uint16_t row) {
    if (row < 8 || row >= 27) return;
    const uint16_t ink = HEX565(0x3b314b);
    paint_rect(line, row, 8, 8, 49, 19, ink);
    paint_rect(line, row, 285, 8, 27, 19, ink);

    if (row >= 12 && row < 22) {
        const uint8_t digit_row = (row - 12) / 2;
        const uint8_t hour_digits[] = {frame.hour / 10, frame.hour % 10, frame.minute / 10, frame.minute % 10};
        const uint8_t lefts[] = {15, 23, 35, 43};
        const uint16_t time_color = HEX565(0xffe8c6);
        for (uint8_t index = 0; index < 4; index++) {
            for (uint8_t column = 0; column < 3; column++) {
                if ((digits[hour_digits[index]] >> (14 - digit_row * 3 - column)) & 1) {
                    const uint8_t left = lefts[index] + 2 * column;
                    paint_span(line, left, left + 2, time_color);
                }
            }
        }
        paint_rect(line, row, 31, 14, 2, 2, time_color);
        paint_rect(line, row, 31, 18, 2, 2, time_color);
    }

    if (row >= 10 && row < 24) {
        static const uint16_t icon_colors[] = {
            HEX565(0xf5aec6), HEX565(0xffdb85), HEX565(0xf7ab6f), HEX565(0xdbf1ff)
        };
        const char *icon = season_icons[frame.season][(row - 10) / 2];
        for (uint8_t column = 0; column < 7; column++) {
            if (icon[column] == 'x') paint_span(line, 292 + column * 2, 294 + column * 2,
                                               icon_colors[frame.season]);
        }
    }
}

static void paint_row(uint8_t *line, uint16_t row) {
    const bool nursery = frame.scene == PET_NURSERY;
    const uint16_t *rows = nursery ? nursery_rows : garden_rows;
    const uint8_t *runs = nursery ? nursery_runs : garden_runs;
    uint16_t x_pos = 0;
    for (uint16_t run = rows[row]; run < rows[row + 1]; run++) {
        const uint16_t end = x_pos + runs[run * 2];
        const uint8_t color = runs[run * 2 + 1];
        paint_span(line, x_pos, end, nursery ? nursery_palette[color] :
                                     color == 5 ? sky_color(row) : scene_palette[color]);
        x_pos = end;
    }
    if (!nursery) paint_sky(line, row);
    else if ((frame.hour < 6 || frame.hour >= 20) && row >= 24 && row < 44) {
        /* The nursery sun sits behind the window's horizontal mullion at row 44. */
        const uint16_t sky = nursery_light(row < 40 ? HEX565(0xa7d4dd) : HEX565(0xbee1e1));
        paint_span(line, 147, 168, sky);
        const int dy = (int)row - 34;
        for (int dx = -7; dx <= 7; dx++) {
            if (dx * dx + dy * dy <= 49 && (dx - 3)*(dx - 3) + (dy + 3)*(dy + 3) > 36)
                paint_span(line, 157 + dx, 158 + dx, HEX565(0xffeac4));
        }
    }

    if (nursery) {
        if (!frame.using_toy && row >= 138 && row <= 141) {
            static const uint8_t radii[] = {14, 19, 18, 12};
            const int radius = radii[row - 138];
            for (int col = frame.x - radius; col < frame.x + radius; col++) {
                if (col < frame.left || col >= frame.right) continue;
                uint8_t *pixel = line + (col - frame.left) * 2;
                uint16_t shade = blend(((uint16_t)pixel[0] << 8) | pixel[1], HEX565(0x826c6b), 1, 5);
                pixel[0] = shade >> 8;
                pixel[1] = (uint8_t)shade;
            }
        }
    } else {
        const uint16_t shadow = blend(scene_palette[15], scene_palette[18], 2, 3);
        paint_rect(line, row, frame.x - 23, 138, 46, 3, shadow);
        paint_rect(line, row, frame.x - 18, 141, 36, 1, shadow);
    }
    if (frame.bowl) {
        const int16_t bowl = frame.x + frame.direction * 29 - 6;
        paint_rect(line, row, bowl, 134, 12, 5, RGB565(91, 69, 81));
        paint_rect(line, row, bowl + 1, 135, 10, 3, RGB565(246, 184, 134));
        paint_rect(line, row, bowl + 5, 132, 4, 2, RGB565(104, 68, 75));
    }
    if (frame.visible_toy == TOY_RABBIT_HUTCH) paint_hutch(line, row);
    if (frame.visible_toy == TOY_CARROT) paint_carrot(line, row);
    paint_rabbit(line, row);
    if (frame.using_toy == TOY_RABBIT_HUTCH) {
        paint_rect(line, row, 226, 136, 40, 2, nursery_light(HEX565(0xf8c3ae)));
        paint_rect(line, row, 226, 138, 40, 2, nursery_light(HEX565(0xc38277)));
    }
    for (unsigned i = 0; i < frame.food_count; i++) paint_fruit(line, row, frame.foods + i);

    const uint16_t accent = RGB565(255, 243, 201);
    if (frame.action == PET_SLEEP) {
        const int16_t sign_x = frame.x + frame.direction * 25;
        const int16_t top = 102 - (int16_t)(frame.elapsed % 1500 / 140);
        paint_rect(line, row, sign_x, top, 6, 2, accent);
        paint_rect(line, row, sign_x + 2, top + 2, 2, 2, accent);
        paint_rect(line, row, sign_x, top + 4, 6, 2, accent);
    } else if (frame.action == PET_EAT || (frame.action == PET_FALL && frame.elapsed < 360)) {
        const int16_t star_x = frame.x + frame.direction * 23;
        const int16_t top = (frame.action == PET_FALL ? 82 : 103) - frame.elapsed / 90 % 5;
        paint_rect(line, row, star_x + 2, top, 2, 8, accent);
        paint_rect(line, row, star_x - 1, top + 3, 8, 2, accent);
    }
    paint_controls(line, row);
}

static void draw_slice(void) {
    const uint16_t first_row = frame.row;
    const uint16_t width = frame.right - frame.left;
    for (; frame.row < frame.bottom && frame.row - first_row < SLICE_ROWS; frame.row++) {
        paint_row(pixels + (frame.row - first_row) * width * 2, frame.row);
    }
    lcd_show_pic_index(frame.left, first_row, width, frame.row - first_row, pixels, 0);
    if (frame.row == frame.bottom) frames++;
}

void pet_mode_poll(void) {
    const uint32_t now = HAL_GetTick();
    if (pet_care_get()->follow_time && now - clock_anchor >= 60000u) {
        const uint32_t elapsed_minutes = (now - clock_anchor) / 60000u;
        clock_anchor += elapsed_minutes * 60000u;
        set_time((hour * 60u + minute + elapsed_minutes) % 1440u, SOURCE_AUTOMATIC);
    }
    if (encoder_down && !encoder_toggled && !encoder_rotated && now - encoder_since >= ENCODER_HOLD_MS) {
        encoder_toggled = true;
        set_mode(!active, SOURCE_PHYSICAL, now);
    }
    if (!active) return;

    const uint32_t step_ms = now - last_motion;
    last_motion = now;
    pet_care_tick(step_ms, action == PET_SLEEP);
    settle_drops(now);
    update_action(now, step_ms > 60 ? 60 : step_ms);
    if (frame.row == frame.bottom && (redraw_scene || now - last_frame >= FRAME_MS)) begin_frame(now);
    if (frame.row < frame.bottom) draw_slice();
}
