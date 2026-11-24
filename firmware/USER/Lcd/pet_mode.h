#ifndef MULTIPAD_PET_MODE_H
#define MULTIPAD_PET_MODE_H

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    PET_IDLE,
    PET_WALK,
    PET_SLEEP,
    PET_EAT,
    PET_FALL,
    PET_FETCH,
    PET_RUN,
    PET_JUMP,
    PET_DAYDREAM,
    PET_FLEE,
    PET_BLINK
} PetAction;

typedef enum {
    PET_EVENT_MODE = 1,
    PET_EVENT_ACTION,
    PET_EVENT_FRUIT_QUEUED,
    PET_EVENT_FRUIT_DROPPED,
    PET_EVENT_FRUIT_EATEN,
    PET_EVENT_HOUR,
    PET_EVENT_SEASON,
    PET_EVENT_KEY,
    PET_EVENT_SNACK
} PetEventKind;

typedef struct {
    uint32_t sequence, time_ms;
    uint8_t kind, value, source, detail;
} PetEvent;

enum { PET_EVENT_CAPACITY = 64, PET_EVENTS_PER_REPLY = 16, PET_API_CAPABILITY = 0x50 };

bool pet_mode_is_active(void);
bool pet_mode_encoder_button(bool down);
void pet_mode_encoder_rotated(void);
void pet_mode_key_down(uint8_t key);
void pet_mode_adjust_scene(int8_t direction, bool change_season);
void pet_mode_poll(void);

/* USB diagnostics report the action, position and completed LCD frame count. */
PetAction pet_mode_action(void);
uint16_t pet_mode_x(void);
uint32_t pet_mode_frames(void);
uint8_t pet_mode_fruit(void);
uint8_t pet_mode_hour(void);
uint8_t pet_mode_season(void);
uint8_t pet_mode_queue_depth(void);
uint8_t pet_mode_control(uint8_t opcode, uint8_t value);
uint8_t pet_mode_events(uint32_t after, PetEvent *out, bool *overrun, bool *more);

#endif
