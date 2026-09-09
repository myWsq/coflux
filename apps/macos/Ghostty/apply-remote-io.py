"""在固定 Ghostty 源码上接入无本地 PTY 的原生远程 I/O。"""
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
revision = 'da9e21602f918d47a46399c458937eff7c7a74ac'
assert subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() == revision

def replace(file, old, new):
    p = root / file
    text = p.read_text()
    assert old in text, f'上游边界不匹配: {file}: {old[:60]}'
    p.write_text(text.replace(old, new, 1))

assert not (root / 'src/termio/External.zig').exists(), '补丁已应用；请使用固定提交的干净检出'
(root / 'src/termio/External.zig').write_text('''const std = @import("std");
const renderer = @import("../renderer.zig");
const terminal = @import("../terminal/main.zig");
const termio = @import("../termio.zig");
const ProcessInfo = @import("../pty.zig").ProcessInfo;
const External = @This();

// 回调在 IO 线程执行，宿主须立即复制字节，不得同步重入 surface API。
pub const Options = extern struct {
    userdata: ?*anyopaque = null,
    write: ?*const fn (?*anyopaque, [*]const u8, usize) callconv(.c) void = null,
    resize: ?*const fn (?*anyopaque, u32, u32) callconv(.c) void = null,
};
options: Options,

pub fn deinit(_: *External) void {}
pub fn initTerminal(self: *External, t: *terminal.Terminal) void {
    if (self.options.resize) |cb| cb(self.options.userdata, t.cols, t.rows);
}
pub fn threadEnter(_: *External, _: std.mem.Allocator, _: *termio.Termio, td: *termio.Termio.ThreadData) !void {
    td.backend = .{ .external = {} };
}
pub fn threadExit(_: *External, _: *termio.Termio.ThreadData) void {}
pub fn focusGained(_: *External, _: *termio.Termio.ThreadData, _: bool) !void {}
pub fn resize(self: *External, grid: renderer.GridSize, _: renderer.ScreenSize) !void {
    if (self.options.resize) |cb| cb(self.options.userdata, grid.columns, grid.rows);
}
pub fn queueWrite(self: *External, _: std.mem.Allocator, _: *termio.Termio.ThreadData, data: []const u8, linefeed: bool) !void {
    const cb = self.options.write orelse return;
    if (!linefeed) {
        if (data.len > 0) cb(self.options.userdata, data.ptr, data.len);
        return;
    }
    var start: usize = 0;
    for (data, 0..) |ch, i| {
        if (ch == '\\r') {
            cb(self.options.userdata, data[start .. i + 1].ptr, i + 1 - start);
            cb(self.options.userdata, "\\n", 1);
            start = i + 1;
        }
    }
    if (start < data.len) cb(self.options.userdata, data[start..].ptr, data.len - start);
}
pub fn childExitedAbnormally(_: *External, _: std.mem.Allocator, _: *terminal.Terminal, _: u32, _: u64) !void {}
pub fn getProcessInfo(_: *External, comptime info: ProcessInfo) ?ProcessInfo.Type(info) { return null; }
''')
replace('src/termio.zig', 'pub const Exec =', 'pub const External = @import("termio/External.zig");\npub const Exec =')
replace('src/termio/backend.zig', 'enum { exec }', 'enum { exec, external }')
replace('src/termio/backend.zig', 'exec: termio.Exec.Config,', 'exec: termio.Exec.Config,\n    external: termio.External.Options,')
replace('src/termio/backend.zig', 'exec: termio.Exec,', 'exec: termio.Exec,\n    external: termio.External,')
p = root / 'src/termio/backend.zig'
s = p.read_text()
# 两种 backend 具有同样的接口；保留上游控制流和参数顺序。
import re
s = re.sub(r'(            \.exec => \|\*exec\| (?:try )?exec\.[\s\S]*?,\n)(?=        })',
           lambda m: m[1] + m[1].replace('.exec => |*exec|', '.external => |*external|').replace('exec.', 'external.'), s)
s = s.replace('exec: termio.Exec.ThreadData,', 'exec: termio.Exec.ThreadData,\n    external: void,')
s = s.replace('            .exec => |*exec| exec.deinit(alloc),', '            .exec => |*exec| exec.deinit(alloc),\n            .external => {},')
s = s.replace('            .external => |*external| external.deinit(alloc),\n', '')
p.write_text(s)
replace('src/apprt/embedded.zig', 'const terminal =', 'const termio = @import("../termio.zig");\nconst terminal =')
replace('src/apprt/embedded.zig', '    core_surface: CoreSurface,', '    core_surface: CoreSurface,\n    external_io: ?termio.External.Options = null,')
replace('src/apprt/embedded.zig', '        context: apprt.surface.NewSurfaceContext = .window,', '        context: apprt.surface.NewSurfaceContext = .window,\n        external_io: ?*const termio.External.Options = null,')
replace('src/apprt/embedded.zig', '            .userdata = opts.userdata,', '            .userdata = opts.userdata,\n            .external_io = if (opts.external_io) |io| io.* else null,')
replace('src/apprt/embedded.zig', '    export fn ghostty_surface_free(ptr: *Surface) void {', '''    // 宿主串行调用；processOutput 自身持渲染互斥锁。释放前必须排空宿主输出队列。
    export fn ghostty_surface_feed(surface: *Surface, data: [*]const u8, len: usize) void {
        if (surface.external_io == null or len == 0) return;
        surface.core_surface.io.processOutput(data[0..len]);
    }

    export fn ghostty_surface_free(ptr: *Surface) void {''')
replace('include/ghostty.h', 'typedef struct {\n  ghostty_platform_e platform_tag;', '''typedef struct {
  void* userdata;
  void (*write)(void*, const uint8_t*, size_t);
  void (*resize)(void*, uint32_t, uint32_t);
} ghostty_external_io_s;

typedef struct {
  ghostty_platform_e platform_tag;''')
replace('include/ghostty.h', '  ghostty_surface_context_e context;\n} ghostty_surface_config_s;', '  ghostty_surface_context_e context;\n  const ghostty_external_io_s* external_io;\n} ghostty_surface_config_s;')
replace('include/ghostty.h', 'GHOSTTY_API void ghostty_surface_free(ghostty_surface_t);', 'GHOSTTY_API void ghostty_surface_feed(ghostty_surface_t, const uint8_t*, size_t);\nGHOSTTY_API void ghostty_surface_free(ghostty_surface_t);')
p = root / 'src/Surface.zig'
s = p.read_text()
start = s.index('        var env = rt_surface.defaultTermioEnv()')
end = s.index('        // Initialize our IO mailbox', start)
old = s[start:end]
new = '''        const external_io = if (comptime @hasField(@TypeOf(rt_surface.*), "external_io")) rt_surface.external_io else null;
        var io_backend: termio.Backend = if (external_io) |options|
            .{ .external = .{ .options = options } }
        else exec: {
''' + old.replace('var io_exec =', 'const io_exec =').replace('        errdefer io_exec.deinit();', '        break :exec .{ .exec = io_exec };') + '''        };
        errdefer io_backend.deinit();

'''
s = s[:start] + new + s[end:]
s = s.replace('            .backend = .{ .exec = io_exec },', '            .backend = io_backend,', 1)
s = s.replace('        .exec => |*exec| exec.subprocess.args,', '        .exec => |*exec| exec.subprocess.args,\n        .external => &.{"remote session"},', 1)
p.write_text(s)
print('已应用 Ghostty 原生远程 I/O 补丁')

# 仅对远程工作台使用无修饰键链接命中；不改变鼠标报告字节。
replace('src/Surface.zig', '    const mouse_mods = self.mouseModsWithCapture(self.mouse.mods);', '    const captured_mods = self.mouseModsWithCapture(self.mouse.mods);\n    const mouse_mods = if (self.io.backend == .external and captured_mods.equal(.{}))\n        input.ctrlOrSuper(.{})\n    else captured_mods;')

replace('src/Surface.zig', '    const mouse_pin: terminal.Pin = mouse_pin: {', '    var mouse_pin: terminal.Pin = mouse_pin: {')

replace('src/Surface.zig', '    // Get our comparison mods\n    const captured_mods', '    if (self.io.backend == .external) {\n        if (self.isMouseReporting() and (!self.mouse.mods.shift or self.mouseShiftCapture(false))) return null;\n        if (mouse_pin.rowAndCell().cell.wide == .spacer_tail) {\n            mouse_pin = mouse_pin.leftWrap(1) orelse mouse_pin;\n        }\n    }\n\n    // Get our comparison mods\n    const captured_mods')

replace('src/apprt/embedded.zig', '        const pos = self.cursorPosToPixels(.{', '        var pos = self.cursorPosToPixels(.{')

replace('src/apprt/embedded.zig', '        // There are cases where the platform reports a mouse motion event', '        // 远程工作台把宽字符后半格映射到所属字符，保持按下/松开的选区手势一致。\n        // 应用接管鼠标时仍保留原始栅格坐标。\n        if (self.external_io != null) {\n            const remote_core = &self.core_surface;\n            remote_core.renderer_state.mutex.lockUncancelable(global.io());\n            defer remote_core.renderer_state.mutex.unlock(global.io());\n            if (remote_core.io.terminal.flags.mouse_event == .none) {\n                const point = remote_core.posToViewport(pos.x, pos.y);\n                if (remote_core.io.terminal.screens.active.pages.pin(.{ .viewport = point })) |pin| {\n                    if (pin.rowAndCell().cell.wide == .spacer_tail) {\n                        pos.x -= @floatFromInt(remote_core.size.cell.width);\n                    }\n                }\n            }\n        }\n\n        // There are cases where the platform reports a mouse motion event')

replace('src/termio/message.zig', '    /// Resize the window.', '    /// 宿主在初始尺寸/滚动操作后同步输出顺序。\n    external_fence: *std.Io.Event,\n\n    /// Resize the window.')

replace('src/termio/message.zig', '        switch (self.*) {\n            .change_config', '        switch (self.*) {\n            .external_fence => |event| event.set(@import("../global.zig").io()),\n            .change_config')

replace('src/termio/Thread.zig', '            .resize => |v| self.handleResize(cb, v),', '            .resize => |v| self.handleResize(cb, v),\n            .external_fence => |event| {\n                defer event.set(global.io());\n                // resize 默认合并到定时器；远程输出进入前必须先落实最新尺寸。\n                if (self.coalesce_data.resize) |size| {\n                    self.coalesce_data.resize = null;\n                    try io.resize(data, size);\n                }\n            },')

replace('src/apprt/embedded.zig', '    external_io: ?termio.External.Options = null,', '    external_io: ?termio.External.Options = null,\n    external_resize_pending: bool = true,')

replace('src/apprt/embedded.zig', '    pub fn updateContentScale(self: *Surface, x: f64, y: f64) void {', '    pub fn updateContentScale(self: *Surface, x: f64, y: f64) void {\n        self.external_resize_pending = true;')

replace('src/apprt/embedded.zig', '        if (self.size.width == width and self.size.height == height) return;', '        if (self.size.width == width and self.size.height == height) return;\n        self.external_resize_pending = true;')

replace('src/apprt/embedded.zig', '        surface.core_surface.io.processOutput(data[0..len]);', '        if (surface.external_resize_pending) ghostty_surface_sync(surface);\n        surface.core_surface.io.processOutput(data[0..len]);')

replace('src/apprt/embedded.zig', '    export fn ghostty_surface_feed(surface:', '    export fn ghostty_surface_sync(surface: *Surface) void {\n        if (surface.external_io == null) return;\n        var event: std.Io.Event = .unset;\n        surface.core_surface.io.mailbox.send(.{ .external_fence = &event }, null);\n        surface.core_surface.io.mailbox.notify();\n        event.waitUncancelable(global.io());\n        surface.external_resize_pending = false;\n    }\n\n    export fn ghostty_surface_scrollbar_state(surface: *Surface) terminal.Scrollbar.C {\n        if (surface.external_resize_pending) ghostty_surface_sync(surface);\n        const renderer_state = &surface.core_surface.renderer_state;\n        renderer_state.mutex.lockUncancelable(global.io());\n        defer renderer_state.mutex.unlock(global.io());\n        return renderer_state.terminal.screens.active.pages.scrollbar().cval();\n    }\n\n    export fn ghostty_surface_feed(surface:')

replace('include/ghostty.h', 'GHOSTTY_API void ghostty_surface_feed(ghostty_surface_t, const uint8_t*, size_t);', 'GHOSTTY_API void ghostty_surface_feed(ghostty_surface_t, const uint8_t*, size_t);\nGHOSTTY_API void ghostty_surface_sync(ghostty_surface_t);\nGHOSTTY_API ghostty_action_scrollbar_s ghostty_surface_scrollbar_state(ghostty_surface_t);')
