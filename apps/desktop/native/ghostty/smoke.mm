#import <AppKit/AppKit.h>
#include "include/coflux_ghostty.h"
#include <chrono>
#include <cstdio>
#include <cstring>

static bool ready = false;
static bool parsed = false;
static bool failed = false;
static void event(uint64_t, int32_t kind, const uint8_t* bytes, int32_t length, double, double) {
    if (kind == 1) ready = true;
    if (kind == 6) parsed = true;
    if (kind == 5) {
        failed = true;
        fprintf(stderr, "原生错误：%.*s\n", length, bytes);
    }
}

static bool waitFor(bool& value) {
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (!value && !failed && std::chrono::steady_clock::now() < deadline) coflux_ghostty_pump();
    return value && !failed;
}

int main() {
    @autoreleasepool {
        const char* output = "👨‍👩‍👧 🇯🇵 👋🏽 e\xcc\x81\r\n";
        for (int round = 0; round < 50; ++round) {
            ready = parsed = false;
            uint64_t id = coflux_ghostty_create(nullptr, 0, 0, 800, 480, 2, event);
            if (!id || !waitFor(ready)) return 1;
            if (!coflux_ghostty_write(id, reinterpret_cast<const uint8_t*>(output), int32_t(strlen(output)), 0)) return 2;
            if (!waitFor(parsed)) return 3;
            coflux_ghostty_destroy(id);
            // 留给已排队回调一个运行机会，不复用失效的 id。
            for (int i = 0; i < 5; ++i) coflux_ghostty_pump();
            printf("round=%d created/written/destroyed\n", round + 1);
        }
    }
    return 0;
}
