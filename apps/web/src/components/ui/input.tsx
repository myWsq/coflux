import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function Input({ className, ...rest }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "flex h-8 w-full rounded-md border border-input bg-background px-2.5 py-1 text-base text-foreground shadow-sm transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25",
        className,
      )}
      {...rest}
    />
  );
}
