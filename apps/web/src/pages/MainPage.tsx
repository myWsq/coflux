import { Workbench } from "@/components/workbench/workbench";
import { createCofluxClient } from "@/client/store";

export function MainPage() {
  const client = createCofluxClient();
  return <Workbench client={client} />;
}
