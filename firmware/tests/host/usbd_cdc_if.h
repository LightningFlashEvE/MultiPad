#ifndef MULTIPAD_TEST_USB_CDC_H
#define MULTIPAD_TEST_USB_CDC_H

#include <stdint.h>

#define USBD_OK 0
uint8_t CDC_Transmit_FS(uint8_t *data, uint16_t length);
uint8_t CDC_TransmitReady_FS(void);

#endif
