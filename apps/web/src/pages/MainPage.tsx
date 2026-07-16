import { useEffect, useState } from "react";

import { Workbench } from "@/components/workbench/workbench";
import { createCofluxClient } from "@/client/store";

export function MainPage() {
  // 一次性初始化（组件体每次渲染都跑，createCofluxClient 内部含副作用/命令式资源，
  // 必须用 useState 惰性初始化保证只创建一次）。
  const [client] = useState(() => createCofluxClient());
  useEffect(() => () => client.disconnect(), [client]);
  return <Workbench client={client} />;
}
