import type { ReactNode } from "react";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

type AlertDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
};

export function AlertDialog({ open, onOpenChange, children }: AlertDialogProps) {
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </AlertDialogPrimitive.Root>
  );
}

export function AlertDialogContent({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/65 backdrop-blur-[2px]" />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <AlertDialogPrimitive.Content
          className={cn(
            "relative grid w-full max-w-md gap-5 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-2xl outline-none",
            className,
          )}
        >
          {children}
        </AlertDialogPrimitive.Content>
      </div>
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogHeader({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex flex-col gap-2 text-left", className)}>{children}</div>;
}

export function AlertDialogFooter({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex justify-end gap-2", className)}>{children}</div>;
}

export function AlertDialogTitle({ className, children }: { className?: string; children: ReactNode }) {
  return <AlertDialogPrimitive.Title className={cn("text-base font-semibold", className)}>{children}</AlertDialogPrimitive.Title>;
}

export function AlertDialogDescription({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <AlertDialogPrimitive.Description className={cn("text-sm leading-6 text-muted-foreground", className)}>
      {children}
    </AlertDialogPrimitive.Description>
  );
}
