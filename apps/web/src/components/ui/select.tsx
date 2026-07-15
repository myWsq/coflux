import { Select as SelectPrimitive } from "@kobalte/core/select";
import { Check, ChevronDown } from "lucide-solid";

import { cn } from "@/lib/utils";

export type SelectOption = { value: string; label: string };

type SimpleSelectProps = {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  class?: string;
  "aria-label"?: string;
};

/**
 * 字符串值单选封装：对外只暴露 value/onChange（string），内部映射 Kobalte 的对象选项模型。
 */
export function SimpleSelect(props: SimpleSelectProps) {
  const selected = () => props.options.find((option) => option.value === props.value) ?? null;

  return (
    <SelectPrimitive<SelectOption>
      options={props.options}
      optionValue="value"
      optionTextValue="label"
      value={selected()}
      onChange={(option) => option && props.onChange(option.value)}
      disallowEmptySelection
      placeholder={props.placeholder}
      itemComponent={(itemProps) => (
        <SelectPrimitive.Item
          item={itemProps.item}
          class="relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
        >
          <span class="absolute left-2 flex size-4 items-center justify-center">
            <SelectPrimitive.ItemIndicator>
              <Check class="size-4" />
            </SelectPrimitive.ItemIndicator>
          </span>
          <SelectPrimitive.ItemLabel>{itemProps.item.rawValue.label}</SelectPrimitive.ItemLabel>
        </SelectPrimitive.Item>
      )}
    >
      <SelectPrimitive.Trigger
        aria-label={props["aria-label"]}
        class={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50",
          props.class,
        )}
      >
        <SelectPrimitive.Value<SelectOption> class="truncate data-[placeholder-shown]:text-muted-foreground">
          {(state) => state.selectedOption()?.label}
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon>
          <ChevronDown class="size-4 text-muted-foreground" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content class="z-[70] max-h-80 min-w-32 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-xl">
          <SelectPrimitive.Listbox class="max-h-80 overflow-y-auto p-1 outline-none" />
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive>
  );
}
