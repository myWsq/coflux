#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef void (*coflux_ghostty_callback)(uint64_t, int32_t, const uint8_t*, int32_t, double, double);
uint64_t coflux_ghostty_create(void*, double, double, double, double, double, coflux_ghostty_callback);
void coflux_ghostty_destroy(uint64_t);
void coflux_ghostty_frame(uint64_t, double, double, double, double, double);
void coflux_ghostty_visible(uint64_t, int32_t);
void coflux_ghostty_focus(uint64_t, int32_t);
int32_t coflux_ghostty_write(uint64_t, const uint8_t*, int32_t, int32_t);
void coflux_ghostty_pump(void);
#ifdef __cplusplus
}
#endif
