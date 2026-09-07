/**
 * The model picker.
 *
 * A `Select` was the wrong control for this. The gateway returns 57 models
 * across five providers, and a native-style dropdown makes that a scrolling
 * wall: the owner's report was "I'm missing Claude and GPT and can't scroll so
 * I don't know if they're there" — and they WERE there, three groups above
 * where the list happened to open. A control whose contents you cannot survey
 * is not a menu, however correctly it is ordered.
 *
 * So: a combobox. Type to filter, provider marks so a row is findable by
 * shape as well as by reading, and a count so the operator knows the size of
 * what they are looking at rather than inferring it from a scrollbar.
 *
 * The search matches the id as well as the label, because half of these models
 * are known by their id (`GLM-4-32B`, `gpt-5.5`) and being unable to type the
 * name you actually know is the same failure in a new coat.
 */

import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ProviderMark } from '@/components/app/provider-mark';
import { cn } from '@/lib/utils';
import type { PickerModels } from '@/lib/model-picker';

export function ModelSelect({
  value,
  picker,
  /** True when `value` is not something the account can reach. */
  unreachable,
  onChange,
  id,
}: {
  value: string;
  picker: PickerModels;
  unreachable: boolean;
  onChange: (model: string) => void;
  id?: string;
}) {
  const [open, setOpen] = useState(false);

  /** The label to show on the trigger, and which provider's mark to use. */
  const selected = useMemo(() => {
    for (const group of picker.groups) {
      const hit = group.models.find((model) => model.id === value);
      if (hit) return { name: hit.name, provider: group.provider };
    }
    // Not in the catalogue: still show what it is set to, or the operator
    // cannot see the thing the warning underneath is talking about.
    return { name: value, provider: undefined };
  }, [picker.groups, value]);

  const total = picker.groups.reduce(
    (sum, group) => sum + group.models.length,
    0,
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'w-full justify-between font-normal',
            unreachable && 'border-destructive/60',
          )}
          data-testid="select-model"
        >
          <span className="flex min-w-0 items-center gap-2">
            <ProviderMark
              provider={selected.provider}
              className="h-4 w-4"
            />
            <span className="truncate">{selected.name}</span>
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        <Command
          // The id is as searchable as the label: half these models are known
          // by their id, and cmdk filters on the value it is given.
          filter={(itemValue, search) =>
            itemValue.toLowerCase().includes(search.toLowerCase().trim())
              ? 1
              : 0
          }
        >
          <div className="flex items-center border-b px-3">
            <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
            <CommandInput
              placeholder={`Search ${total} models…`}
              className="h-10 border-0 focus:ring-0"
              data-testid="input-model-search"
            />
          </div>
          {/*
            A bounded, scrollable list with a real height rather than "as tall
            as it wants to be". The old control grew to the window and the tail
            was unreachable in practice even when it technically scrolled.
          */}
          <CommandList className="max-h-[320px]">
            <CommandEmpty>No model matches that.</CommandEmpty>
            {picker.groups.map((group) => (
              <CommandGroup
                key={group.label}
                heading={
                  <span className="flex items-center gap-1.5">
                    <ProviderMark
                      provider={group.provider}
                      className="h-3.5 w-3.5"
                    />
                    {group.label}
                    <span className="text-[10px] tabular-nums opacity-60">
                      {group.models.length}
                    </span>
                  </span>
                }
              >
                {group.models.map((model) => (
                  <CommandItem
                    key={model.id}
                    // What cmdk filters against, so typing either works.
                    value={`${model.name} ${model.id}`}
                    onSelect={() => {
                      onChange(model.id);
                      setOpen(false);
                    }}
                    data-testid={`model-${model.id}`}
                  >
                    <ProviderMark
                      provider={group.provider}
                      className="mr-2 h-4 w-4"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {model.name}
                    </span>
                    {/*
                      Shown only when it differs from the label, so an id the
                      operator might type is visible without repeating the
                      name back at them.
                    */}
                    {model.name !== model.id ? (
                      <span className="ml-2 truncate text-[10px] text-muted-foreground">
                        {model.id}
                      </span>
                    ) : null}
                    {value === model.id ? (
                      <Check className="ml-2 h-4 w-4 shrink-0" />
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
