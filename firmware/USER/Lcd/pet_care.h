#ifndef MULTIPAD_PET_CARE_H
#define MULTIPAD_PET_CARE_H

#include <stdbool.h>
#include <stdint.h>

enum { PET_GARDEN, PET_TOY_FACTORY, PET_SCENE_COUNT };

typedef struct {
    uint8_t satiety, sleepiness, mood, affection, scene;
} PetCare;

void pet_care_init(uint16_t flash_id);
const PetCare *pet_care_get(void);
void pet_care_set_scene(uint8_t scene);
void pet_care_adjust(int satiety, int sleepiness, int mood, int affection);
void pet_care_tick(uint32_t elapsed_ms, bool sleeping);
void pet_care_save(void);

#endif
