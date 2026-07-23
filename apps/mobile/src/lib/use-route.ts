import { useEffect, useRef, useState } from "react";

/** 两级导航（plan 032 IA 决策）：列表 ⇄ 详情，不引路由库。
 * 用 History API 的 pushState/popstate 承载"进入详情"这一步，不改变可见 URL——
 * mobile 无需要为详情页配路径（无深链需求），只需要浏览器/系统返回手势能把
 * "进入详情"这一步弹出而不是直接退出整个 app（默认单历史条目 SPA 的行为）。 */
export type Route = { screen: "list" } | { screen: "detail"; workspaceId: string };

function isRoute(value: unknown): value is Route {
  return typeof value === "object" && value !== null && "screen" in value;
}

export function useRoute() {
  const [route, setRouteState] = useState<Route>({ screen: "list" });
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    // 基线历史条目落地为 list：刷新/直接打开时 history.state 为 null。
    if (!history.state) history.replaceState({ screen: "list" } satisfies Route, "");
    const onPopState = (event: PopStateEvent) => {
      setRouteState(isRoute(event.state) ? event.state : { screen: "list" });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function openWorkspace(workspaceId: string) {
    const next: Route = { screen: "detail", workspaceId };
    history.pushState(next, "");
    setRouteState(next);
  }

  /** 详情页返回列表：若本次是靠 pushState 进入的详情（正常路径），交给 history.back()
   * 触发 popstate 收敛；否则（异常直达详情，如未来深链）直接回落 list。 */
  function closeWorkspace() {
    if (routeRef.current.screen === "detail") history.back();
    else setRouteState({ screen: "list" });
  }

  return { route, openWorkspace, closeWorkspace };
}
