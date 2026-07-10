import { Workbench } from "@/components/workbench/workbench";
import { useCofluxClient } from "@/hooks/use-coflux-client";

export function MainPage() {
  const client = useCofluxClient();
  return <Workbench client={client} />;
}
