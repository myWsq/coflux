import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function Label({ className, ...rest }: ComponentProps<"label">) {
  return <label className={cn("text-sm font-medium leading-none text-foreground", className)} {...rest} />;
}
