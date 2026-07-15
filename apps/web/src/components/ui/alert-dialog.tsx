import type { JSX, ParentProps } from "solid-js";
import { AlertDialog as AlertDialogPrimitive } from "@kobalte/core/alert-dialog";

import { cn } from "@/lib/utils";

type AlertDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: JSX.Element;
};

export function AlertDialog(props: AlertDialogProps) {
  return (
    <AlertDialogPrimitive open={props.open} onOpenChange={props.onOpenChange}>
      {props.children}
    </AlertDialogPrimitive>
  );
}

export function AlertDialogContent(props: ParentProps<{ class?: string }>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay class="fixed inset-0 z-50 bg-black/65 backdrop-blur-[2px]" />
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <AlertDialogPrimitive.Content
          class={cn(
            "relative grid w-full max-w-md gap-5 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-2xl outline-none",
            props.class,
          )}
        >
          {props.children}
        </AlertDialogPrimitive.Content>
      </div>
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogHeader(props: ParentProps<{ class?: string }>) {
  return <div class={cn("flex flex-col gap-2 text-left", props.class)}>{props.children}</div>;
}

export function AlertDialogFooter(props: ParentProps<{ class?: string }>) {
  return <div class={cn("flex justify-end gap-2", props.class)}>{props.children}</div>;
}

export function AlertDialogTitle(props: ParentProps<{ class?: string }>) {
  return <AlertDialogPrimitive.Title class={cn("text-base font-semibold", props.class)}>{props.children}</AlertDialogPrimitive.Title>;
}

export function AlertDialogDescription(props: ParentProps<{ class?: string }>) {
  return (
    <AlertDialogPrimitive.Description class={cn("text-sm leading-6 text-muted-foreground", props.class)}>
      {props.children}
    </AlertDialogPrimitive.Description>
  );
}
