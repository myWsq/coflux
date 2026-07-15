import type { JSX, ParentProps } from "solid-js";
import { Dialog as DialogPrimitive } from "@kobalte/core/dialog";
import { X } from "lucide-solid";

import { cn } from "@/lib/utils";

type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: JSX.Element;
};

export function Dialog(props: DialogProps) {
  return (
    <DialogPrimitive open={props.open} onOpenChange={props.onOpenChange}>
      {props.children}
    </DialogPrimitive>
  );
}

export function DialogContent(props: ParentProps<{ class?: string }>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay class="fixed inset-0 z-50 bg-black/65 backdrop-blur-[2px]" />
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <DialogPrimitive.Content
          class={cn(
            "relative grid w-full max-w-lg gap-5 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-2xl outline-none",
            props.class,
          )}
        >
          {props.children}
          <DialogPrimitive.CloseButton class="absolute right-4 top-4 rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X class="size-4" />
            <span class="sr-only">关闭</span>
          </DialogPrimitive.CloseButton>
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader(props: ParentProps<{ class?: string }>) {
  return <div class={cn("flex flex-col gap-1.5 text-left", props.class)}>{props.children}</div>;
}

export function DialogFooter(props: ParentProps<{ class?: string }>) {
  return <div class={cn("flex flex-row justify-end gap-2", props.class)}>{props.children}</div>;
}

export function DialogTitle(props: ParentProps<{ class?: string }>) {
  return <DialogPrimitive.Title class={cn("text-base font-semibold tracking-tight", props.class)}>{props.children}</DialogPrimitive.Title>;
}

export function DialogDescription(props: ParentProps<{ class?: string }>) {
  return <DialogPrimitive.Description class={cn("text-sm leading-6 text-muted-foreground", props.class)}>{props.children}</DialogPrimitive.Description>;
}
