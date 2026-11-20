#ifndef MULTIPAD_SCREEN_READBACK_H
#define MULTIPAD_SCREEN_READBACK_H

#include <stdbool.h>
#include <stdint.h>

bool screen_readback_receive(const uint8_t *data, uint32_t length);
void screen_readback_poll(void);
void screen_readback_applied(uint8_t menu);
void screen_readback_invalidate(uint8_t menu);
bool screen_readback_needs_refresh(uint8_t menu);

#endif
