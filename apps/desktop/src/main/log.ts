import log from "electron-log/main";

/**
 * 主进程日志（plan 106）：electron-log 落文件，路径用其 macOS 默认 `~/Library/Logs/<app.name>/main.log`
 * （app.name 取 package.json 的 productName），轮转用默认值。渲染层控制台不采集——不调用 initialize()，
 * 也不往 preload 注入转发。未捕获异常记进日志但不弹框（错误面由渲染层/更新流程自己处理）。
 */
log.transports.file.level = "info";
log.errorHandler.startCatching({ showDialog: false });

export { log };
