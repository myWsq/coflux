/**
 * server 直出的浏览器页面契约：设备授权、端口预览门禁。
 * schemas 全部留空：输入是路径参数 / query / urlencoded 表单，输出是 HTML 或 302/303，错误也必须是
 * 页面而非 Raven 校验信封，故 handler 自己取输入并直接构造 Response。
 *
 * 三个 GET 入口的路径与参数名固定（daemon、CLI、黑盒 `tokenFromUrl`、文档都按这个形状），只是基址自
 * plan 107 起从冻结的 web 换成 `config.publicUrl`；登录 / 确认 / 决定的 POST 路由挂在各自入口之下，
 * 以便页面会话 cookie 按 Path 隔离。
 */
import { defineContract } from "@raven.js/core/contract";

/** 设备授权页：`cofluxd up` 打印的链接。无会话 → 登录表单；有会话 → 设备卡片。 */
export const GetAuthorizePageContract = defineContract({
  method: "GET",
  path: "/authorize/:token",
  schemas: {},
});

export const PostAuthorizeLoginContract = defineContract({
  method: "POST",
  path: "/authorize/:token/login",
  schemas: {},
});

/** 「授权此设备」：兑现一次性 token，渲染完成页。 */
export const PostAuthorizeConfirmContract = defineContract({
  method: "POST",
  path: "/authorize/:token/confirm",
  schemas: {},
});

/** 端口预览门禁：预览域无 cookie 时 302 到这里（`?to=<原始 URL>`）。有会话即签 code 并 302 到预览域回调。 */
export const GetProxyAuthPageContract = defineContract({
  method: "GET",
  path: "/proxy-auth",
  schemas: {},
});

export const PostProxyAuthLoginContract = defineContract({
  method: "POST",
  path: "/proxy-auth/login",
  schemas: {},
});
