import { LegacyWorkbench } from "@/components/legacy-workbench";
import { useCofluxClient } from "@/hooks/use-coflux-client";

export function MainPage() {
  const client = useCofluxClient();
  return <LegacyWorkbench client={client} />;
}
