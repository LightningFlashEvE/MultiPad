#ifndef MULTIPAD_PET_CARE_H
#define MULTIPAD_PET_CARE_H

#include <stdbool.h>
#include <stdint.h>

enum { PET_GARDEN, PET_NURSERY, PET_SCENE_COUNT };

enum { PET_KEY_COUNT = 8, ITEM_HUTCH = 9, ITEM_CARROT = 10 };

typedef struct {
    uint8_t satiety, sleepiness, mood, affection, scene;
    uint8_t bindings[PET_KEY_COUNT];
    bool follow_time;
    uint8_t placed[PET_SCENE_COUNT];
} PetCare;

void pet_care_init(uint16_t flash_id);
const PetCare *pet_care_get(void);
void pet_care_set_scene(uint8_t scene);
void pet_care_adjust(int satiety, int sleepiness, int mood, int affection);
void pet_care_bind(uint8_t key, uint8_t item);
void pet_care_set_toy(uint8_t scene, uint8_t toy);
void pet_care_follow_clock(bool follow);
void pet_care_tick(uint32_t elapsed_ms, bool sleeping);
void pet_care_save(void);

#endif
