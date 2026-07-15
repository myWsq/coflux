/**
 * 组合根（RavenJS runtime assembly）：创建 Raven app、注册基础设施插件与 HTTP 路由。
 * 不在此调用 ready() —— serve 入口（index.ts）决定何时就绪并负责传输层
 * （WS 升级、预览域反代分流、心跳、信号）。
 */
import { Raven, registerContractRoute } from "@raven.js/core";
import { storePlugin } from "./plugins/store.plugin.js";
import { hubPlugin } from "./plugins/hub.plugin.js";
import { apiAuthPlugin } from "./plugins/api-auth.plugin.js";
import { GetHealthContract } from "./interface/get-health/get-health.contract.js";
import { GetHealthHandler } from "./interface/get-health/get-health.handler.js";
import { GetStateContract } from "./interface/get-state/get-state.contract.js";
import { GetStateHandler } from "./interface/get-state/get-state.handler.js";

export const app = new Raven();

// load 串行：hub 依赖 store 写入的 StoreState，注册顺序即依赖顺序。
app.register(storePlugin()).register(hubPlugin()).register(apiAuthPlugin());

registerContractRoute(app, GetHealthContract, GetHealthHandler);
registerContractRoute(app, GetStateContract, GetStateHandler);
