#include "pet_care.h"
#include "flash.h"
#include <string.h>

/* External SPI flash. Menu 10's last color sector is 10 * 27 + 22 + 26 = 318.
 * The alternate sector retains a complete record during erase or power loss. */
enum { FIRST_SECTOR = 319, SECTOR_BYTES = 4096, RECORD_BYTES = 16,
       PER_SECTOR = SECTOR_BYTES / RECORD_BYTES, SLOTS = 2 * PER_SECTOR };
static const uint8_t signature[] = {'P', 'E', 'T', 1};
static PetCare care = {65, 25, 70, 35, PET_GARDEN};
static uint32_t sequence, metabolism_ms, fatigue_ms;
static uint16_t next_slot;
static uint8_t unsaved_minutes;
static bool dirty, journal_available;

static uint16_t crc16(const uint8_t *data) {
    uint16_t crc = 0xffff;
    for (unsigned i = 0; i < RECORD_BYTES - 2; i++) {
        crc ^= (uint16_t)data[i] << 8;
        for (unsigned bit = 0; bit < 8; bit++)
            crc = (uint16_t)((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1);
    }
    return crc;
}

static uint32_t address(uint16_t slot) {
    return FIRST_SECTOR * SECTOR_BYTES + slot * RECORD_BYTES;
}

static bool valid(const uint8_t *record) {
    return memcmp(record, signature, sizeof(signature)) == 0 &&
           record[8] <= 100 && record[9] <= 100 && record[10] <= 100 &&
           record[11] <= 100 && record[12] < PET_SCENE_COUNT &&
           crc16(record) == (record[14] | record[15] << 8);
}

void pet_care_init(uint16_t flash_id) {
    switch (flash_id) {
        case W25Q16: case W25Q32: case W25Q64: case W25Q128: case W25Q256:
        case BY25Q64: case BY25Q128: case NM25Q64: case NM25Q128:
            journal_available = true;
            break;
        default:
            journal_available = false;
            return;
    }
    bool found = false;
    uint8_t group[256];
    for (uint16_t base = 0; base < SLOTS; base += sizeof(group) / RECORD_BYTES) {
        read_flash(group, address(base), sizeof(group));
        for (unsigned i = 0; i < sizeof(group); i += RECORD_BYTES) {
            const uint8_t *record = group + i;
            if (!valid(record)) continue;
            uint32_t serial;
            memcpy(&serial, record + 4, sizeof(serial));
            if (found && (int32_t)(serial - sequence) <= 0) continue;
            found = true;
            sequence = serial;
            care = (PetCare){record[8], record[9], record[10], record[11], record[12]};
            next_slot = (base + i / RECORD_BYTES + 1) % SLOTS;
        }
    }
}

const PetCare *pet_care_get(void) { return &care; }

void pet_care_set_scene(uint8_t scene) {
    if (scene == care.scene || scene >= PET_SCENE_COUNT) return;
    care.scene = scene;
    dirty = true;
    pet_care_save();
}

static void adjust(uint8_t *value, int delta) {
    const int sum = *value + delta;
    const uint8_t result = sum < 0 ? 0 : sum > 100 ? 100 : sum;
    if (result != *value) dirty = true;
    *value = result;
}

void pet_care_adjust(int satiety, int sleepiness, int mood, int affection) {
    adjust(&care.satiety, satiety);
    adjust(&care.sleepiness, sleepiness);
    adjust(&care.mood, mood);
    adjust(&care.affection, affection);
}

void pet_care_tick(uint32_t elapsed_ms, bool sleeping) {
    /* Charge time only while this pet is on screen. Separate fatigue progress
     * avoids attributing a whole minute to a sleep entered on its last tick. */
    if (elapsed_ms > 60000) elapsed_ms = 60000;
    static bool was_sleeping;
    if (was_sleeping != sleeping) {
        fatigue_ms = 0;
        was_sleeping = sleeping;
    }
    const uint32_t fatigue_interval = sleeping ? 20000 : 60000;
    fatigue_ms += elapsed_ms;
    while (fatigue_ms >= fatigue_interval) {
        fatigue_ms -= fatigue_interval;
        adjust(&care.sleepiness, sleeping ? -1 : 1);
    }
    metabolism_ms += elapsed_ms;
    if (metabolism_ms < 60000) return;
    metabolism_ms -= 60000;
    pet_care_adjust(-1, 0, care.satiety < 25 || care.sleepiness > 85 ? -1 : 0, 0);
    if (++unsaved_minutes >= 5) pet_care_save();
}

void pet_care_save(void) {
    unsaved_minutes = 0;
    if (!dirty || !journal_available) return;
    uint8_t previous[RECORD_BYTES], record[RECORD_BYTES] = {0};
    /* Skip a torn append. Never erase the sector holding the last valid record. */
    while (next_slot % PER_SECTOR) {
        read_flash(previous, address(next_slot), sizeof(previous));
        unsigned i = 0;
        while (i < sizeof(previous) && previous[i] == 0xff) i++;
        if (i == sizeof(previous)) break;
        next_slot = (next_slot + 1) % SLOTS;
    }
    if (!(next_slot % PER_SECTOR)) erase_flash_sector(FIRST_SECTOR + next_slot / PER_SECTOR);
    memcpy(record, signature, sizeof(signature));
    uint32_t serial = sequence + 1;
    memcpy(record + 4, &serial, sizeof(serial));
    record[8] = care.satiety;
    record[9] = care.sleepiness;
    record[10] = care.mood;
    record[11] = care.affection;
    record[12] = care.scene;
    uint16_t crc = crc16(record);
    record[14] = (uint8_t)crc;
    record[15] = (uint8_t)(crc >> 8);
    write_to_flash(record, address(next_slot), sizeof(record));
    read_flash(previous, address(next_slot), sizeof(previous));
    if (memcmp(previous, record, sizeof(record)) == 0) {
        sequence = serial;
        dirty = false;
        next_slot = (next_slot + 1) % SLOTS;
    }
}
