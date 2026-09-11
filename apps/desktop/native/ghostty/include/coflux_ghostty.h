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
void coflux_ghostty_access(uint64_t, int32_t, uint64_t);
void coflux_ghostty_reset(uint64_t);
int32_t coflux_ghostty_grid(uint64_t, int32_t*, int32_t*);
int32_t coflux_ghostty_dump(uint64_t, uint8_t*, int32_t);
void coflux_ghostty_clipboard(uint64_t, int32_t);
int32_t coflux_ghostty_has_focus(uint64_t);
double coflux_ghostty_allocated_bytes(uint64_t);
void coflux_ghostty_test_command_key(uint64_t, uint16_t, double);
#ifdef __cplusplus
}
#endif
