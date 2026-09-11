#import <AppKit/AppKit.h>
#include <node_api.h>
#include "include/coflux_ghostty.h"
#include <unordered_map>
#include <vector>
#include <cmath>
#include <cstring>

// 所有入口及 Swift 回调均在 Electron/AppKit 主线程。只持稳定 id，不向 JS 暴露指针。
struct Listener { napi_env env; napi_ref callback; napi_async_context context; };
static std::unordered_map<uint64_t, Listener> listeners;

static void emit(uint64_t id, int32_t kind, const uint8_t* bytes, int32_t length, double x, double y) {
    auto found = listeners.find(id);
    if (found == listeners.end()) return;
    auto listener = found->second;
    napi_handle_scope scope;
    if (napi_open_handle_scope(listener.env, &scope) != napi_ok) return;
    napi_value callback, global, args[5], ignored;
    napi_get_reference_value(listener.env, listener.callback, &callback);
    napi_get_global(listener.env, &global);
    napi_create_double(listener.env, double(id), &args[0]);
    napi_create_int32(listener.env, kind, &args[1]);
    napi_create_buffer_copy(listener.env, size_t(length), bytes, nullptr, &args[2]);
    napi_create_double(listener.env, x, &args[3]);
    napi_create_double(listener.env, y, &args[4]);
    napi_make_callback(listener.env, listener.context, global, callback, 5, args, &ignored);
    napi_close_handle_scope(listener.env, scope);
}

static napi_value fail(napi_env env, const char* message) {
    napi_throw_error(env, nullptr, message);
    return nullptr;
}
static bool number(napi_env env, napi_value value, double& out) {
    return napi_get_value_double(env, value, &out) == napi_ok && std::isfinite(out);
}
static napi_value dispatch(napi_env env, napi_callback_info info) {
    if (![NSThread isMainThread]) return fail(env, "Ghostty 只能从主线程调用");
    size_t argc = 8;
    napi_value args[8], result;
    void* verb;
    napi_get_cb_info(env, info, &argc, args, nullptr, &verb);
    const auto op = reinterpret_cast<uintptr_t>(verb);
    napi_get_undefined(env, &result);
    if (op == 8) { coflux_ghostty_pump(); return result; }
    double idValue;
    if (op == 0) {
        if (argc != 7) return fail(env, "create 需要窗口句柄、矩形、比例和回调");
        void* handleBytes; size_t handleSize;
        bool isBuffer = false;
        napi_is_buffer(env, args[0], &isBuffer);
        if (!isBuffer || napi_get_buffer_info(env, args[0], &handleBytes, &handleSize) != napi_ok || handleSize != sizeof(void*))
            return fail(env, "窗口句柄必须是指针大小的 Buffer");
        double values[5];
        for (int i = 0; i < 5; ++i) if (!number(env, args[i + 1], values[i])) return fail(env, "矩形与比例必须是有限数");
        napi_valuetype type;
        napi_typeof(env, args[6], &type);
        if (type != napi_function) return fail(env, "缺少事件回调");
        void* handle; memcpy(&handle, handleBytes, sizeof(handle));
        uint64_t id = coflux_ghostty_create(handle, values[0], values[1], values[2], values[3], values[4], emit);
        if (!id) return fail(env, "Ghostty surface 创建失败");
        napi_ref callback;
        napi_create_reference(env, args[6], 1, &callback);
        napi_value resource, name;
        napi_create_object(env, &resource);
        napi_create_string_utf8(env, "coflux:ghostty", NAPI_AUTO_LENGTH, &name);
        napi_async_context context;
        napi_async_init(env, resource, name, &context);
        listeners.emplace(id, Listener{env, callback, context});
        napi_create_double(env, double(id), &result);
        return result;
    }
    if (argc < 1 || !number(env, args[0], idValue) || idValue < 1 || idValue > 9007199254740991.0 || floor(idValue) != idValue)
        return fail(env, "无效 surface id");
    uint64_t id = uint64_t(idValue);
    auto found = listeners.find(id);
    if (found == listeners.end() || found->second.env != env) return result;
    if (op == 1) {
        napi_delete_reference(env, found->second.callback);
        napi_async_destroy(env, found->second.context);
        listeners.erase(found);
        coflux_ghostty_destroy(id);
    } else if (op == 2) {
        if (argc != 6) return fail(env, "setFrame 参数不完整");
        double values[5];
        for (int i = 0; i < 5; ++i) if (!number(env, args[i + 1], values[i])) return fail(env, "无效矩形");
        coflux_ghostty_frame(id, values[0], values[1], values[2], values[3], values[4]);
    } else if (op == 3 || op == 4) {
        bool value;
        if (argc != 2 || napi_get_value_bool(env, args[1], &value) != napi_ok) return fail(env, "需要布尔值");
        if (op == 3) coflux_ghostty_visible(id, value);
        else coflux_ghostty_focus(id, value);
    } else if (op == 7) {
        coflux_ghostty_reset(id);
    } else if (op == 16) {
        int32_t columns, rows;
        if (!coflux_ghostty_grid(id, &columns, &rows)) return fail(env, "surface 正忙或已销毁");
        napi_create_object(env, &result);
        napi_value value;
        napi_create_int32(env, columns, &value);
        napi_set_named_property(env, result, "columns", value);
        napi_create_int32(env, rows, &value);
        napi_set_named_property(env, result, "rows", value);
    } else if (op == 9) {
        const int32_t size = coflux_ghostty_dump(id, nullptr, 0);
        if (size < 0 || size > 16 * 1024 * 1024) return fail(env, "surface 正忙或文本过大");
        std::vector<uint8_t> bytes(size_t(size) + 1);
        const int32_t copied = coflux_ghostty_dump(id, bytes.data(), size);
        if (copied != size) return fail(env, "读取 surface 期间尺寸改变");
        napi_create_string_utf8(env, reinterpret_cast<const char*>(bytes.data()), size_t(size), &result);
    } else if (op == 10) {
        bool allowed; double epoch;
        if (argc != 3 || napi_get_value_bool(env, args[1], &allowed) != napi_ok || !number(env, args[2], epoch) || epoch < 0 || epoch > 9007199254740991.0 || floor(epoch) != epoch)
            return fail(env, "无效输入门禁");
        coflux_ghostty_access(id, allowed, uint64_t(epoch));
    } else if (op == 11 || op == 12) {
        coflux_ghostty_clipboard(id, op == 12);
    } else if (op == 15) {
        double code, timestamp;
        if (argc != 3 || !number(env, args[1], code) || !number(env, args[2], timestamp) || code < 0 || code > 127 || floor(code) != code)
            return fail(env, "无效验收按键");
        coflux_ghostty_test_command_key(id, uint16_t(code), timestamp);
    } else if (op == 14) {
        napi_create_double(env, coflux_ghostty_allocated_bytes(id), &result);
    } else if (op == 13) {
        napi_get_boolean(env, coflux_ghostty_has_focus(id) != 0, &result);
    } else {
        bool isBuffer = false; void* bytes; size_t size;
        if (argc != 2) return fail(env, "write/replay 参数不完整");
        napi_is_buffer(env, args[1], &isBuffer);
        if (!isBuffer || napi_get_buffer_info(env, args[1], &bytes, &size) != napi_ok || size > (1 << 20))
            return fail(env, "每块必须是至多 1 MiB 的 Buffer");
        const bool accepted = coflux_ghostty_write(id, static_cast<const uint8_t*>(bytes), int32_t(size), op == 6);
        napi_get_boolean(env, accepted, &result);
    }
    return result;
}

static void cleanup(void* data) {
    auto env = static_cast<napi_env>(data);
    std::vector<uint64_t> ids;
    for (auto& [id, listener] : listeners) if (listener.env == env) ids.push_back(id);
    for (auto id : ids) {
        napi_delete_reference(env, listeners.at(id).callback);
        napi_async_destroy(env, listeners.at(id).context);
        listeners.erase(id);
        coflux_ghostty_destroy(id);
    }
}
static napi_value init(napi_env env, napi_value exports) {
    const char* names[] = {"create", "destroy", "setFrame", "setVisible", "setFocus", "write", "replay", "reset", "pump", "dump", "setAccess", "copy", "paste", "hasFocus", "allocatedBytes", "testCommandKey", "grid"};
    for (uintptr_t i = 0; i < 17; ++i) {
        napi_value method;
        napi_create_function(env, names[i], NAPI_AUTO_LENGTH, dispatch, reinterpret_cast<void*>(i), &method);
        napi_set_named_property(env, exports, names[i], method);
    }
    napi_add_env_cleanup_hook(env, cleanup, env);
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
