"use client";

import { useState } from "react";
import { ArrowRight, Check, ChevronsUpDown, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { copy, t } from "@/lib/copy";
import { useLocalState } from "@/lib/local/hooks";
import {
  createCategory,
  deleteCategory,
  effectiveCategories,
  updateCategory,
} from "@/lib/local/store";
import type { Category } from "@/lib/local/types";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type View =
  | { name: "picker" }
  | { name: "create" }
  | { name: "edit"; category: Category };

export function CategoryPicker({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  // Local-first: the list is the cached server mirror with pending local
  // edits applied, and every write goes through the local queue — so the
  // picker behaves identically online and offline.
  const categories = effectiveCategories(useLocalState());
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ name: "picker" });
  const [search, setSearch] = useState("");

  const selectedCategory = categories.find((c) => c.clientId === selected) ?? null;

  const backToPicker = () => setView({ name: "picker" });

  // Radix only fires onOpenChange for user-initiated closes, so every
  // programmatic close has to reset the view and search itself.
  function closeAndReset() {
    setOpen(false);
    setView({ name: "picker" });
    setSearch("");
  }

  function createFromSearch() {
    const trimmed = search.trim();
    if (!trimmed) return;
    try {
      onSelect(createCategory(trimmed, true));
      closeAndReset();
    } catch {}
  }

  return (
    <>
      <Button
        variant="outline"
        role="combobox"
        aria-expanded={open}
        className="w-full justify-between"
        onClick={() => setOpen(true)}
      >
        <span className="truncate">
          {selectedCategory ? (
            <>
              {selectedCategory.name}
              {!selectedCategory.isPublic && (
                <span className="ms-1 text-xs opacity-60">
                  {copy.categories.privateBadge}
                </span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">
              {copy.categories.pick}
            </span>
          )}
        </span>
        <ChevronsUpDown className="opacity-50" />
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setView({ name: "picker" });
            setSearch("");
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          {view.name === "picker" && (
            <>
              <DialogHeader>
                <DialogTitle>{copy.categories.pick}</DialogTitle>
              </DialogHeader>
              <Command className="bg-transparent p-0">
                <div className="mb-2">
                  <CommandInput
                    autoFocus
                    placeholder={copy.categories.search}
                    value={search}
                    onValueChange={setSearch}
                  />
                </div>

                <CommandList>
                  <CommandEmpty>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={createFromSearch}
                    >
                      <Plus />
                      <span className="truncate">
                        {t(copy.categories.createNamed, {
                          name: search.trim(),
                        })}
                      </span>
                    </Button>
                  </CommandEmpty>
                  <CommandGroup className="p-2 border">
                    {categories.map((category) => (
                      <CommandItem
                        key={category.clientId}
                        value={category.name}
                        className="[&>svg:last-child]:hidden"
                        onSelect={() => {
                          onSelect(category.clientId);
                          closeAndReset();
                        }}
                      >
                        <Check
                          className={
                            selected === category.clientId
                              ? "opacity-100"
                              : "opacity-0"
                          }
                        />
                        <span className="flex-1 truncate">{category.name}</span>
                        {!category.isPublic && (
                          <span className="text-xs text-muted-foreground">
                            {copy.categories.privateBadge}
                          </span>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t(copy.categories.editAria, {
                            name: category.name,
                          })}
                          className="text-muted-foreground hover:text-foreground"
                          onClick={(e) => {
                            e.stopPropagation();
                            setView({ name: "edit", category });
                          }}
                        >
                          <Pencil />
                        </Button>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  <CommandGroup forceMount className="mt-2">
                    <CommandItem
                      forceMount
                      onSelect={() => setView({ name: "create" })}
                    >
                      <Plus />
                      {copy.categories.new}
                    </CommandItem>
                  </CommandGroup>
                </CommandList>
              </Command>
            </>
          )}

          {view.name === "create" && (
            <CreateView
              onBack={backToPicker}
              onCreated={(id) => {
                onSelect(id);
                closeAndReset();
              }}
            />
          )}

          {view.name === "edit" && (
            <EditView
              key={view.category.clientId}
              category={view.category}
              onBack={backToPicker}
              onDeleted={() =>
                selected === view.category.clientId && onSelect(null)
              }
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function BackHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <DialogHeader className="flex-row items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={copy.categories.back}
        onClick={onBack}
      >
        <ArrowRight />
      </Button>
      <DialogTitle>{title}</DialogTitle>
    </DialogHeader>
  );
}

function CreateView({
  onBack,
  onCreated,
}: {
  onBack: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(true);

  function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      onCreated(createCategory(trimmed, isPublic));
    } catch {}
  }

  return (
    <>
      <BackHeader title={copy.categories.new} onBack={onBack} />
      <div className="flex flex-col gap-4">
        <Input
          autoFocus
          placeholder={copy.categories.namePlaceholder}
          value={name}
          dir="auto"
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
        />
        <div className="flex items-center justify-between">
          <Label htmlFor="new-public" className="text-sm text-muted-foreground">
            {copy.categories.publicLabel}
          </Label>
          <Switch
            id="new-public"
            checked={isPublic}
            onCheckedChange={setIsPublic}
          />
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={handleCreate} disabled={!name.trim()}>
            {copy.categories.add}
          </Button>
          <Button size="sm" variant="ghost" onClick={onBack}>
            {copy.categories.cancel}
          </Button>
        </div>
      </div>
    </>
  );
}

function EditView({
  category,
  onBack,
  onDeleted,
}: {
  category: Category;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [isPublic, setIsPublic] = useState(category.isPublic);

  return (
    <>
      <BackHeader title={copy.categories.editTitle} onBack={onBack} />
      <div className="flex flex-col gap-4">
        <Input
          autoFocus
          value={name}
          dir="auto"
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="flex items-center justify-between">
          <Label
            htmlFor={`public-${category.clientId}`}
            className="text-sm text-muted-foreground"
          >
            {copy.categories.publicLabel}
          </Label>
          <Switch
            id={`public-${category.clientId}`}
            checked={isPublic}
            onCheckedChange={setIsPublic}
          />
        </div>
        <div className="flex justify-between gap-2">
          <Button
            size="sm"
            disabled={!name.trim()}
            onClick={() => {
              try {
                updateCategory(category.clientId, name.trim(), isPublic);
              } catch {}
              onBack();
            }}
          >
            {copy.categories.save}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-muted-foreground"
            onClick={() => {
              try {
                deleteCategory(category.clientId);
                onDeleted();
              } catch {}
              onBack();
            }}
          >
            {copy.categories.delete}
          </Button>
        </div>
      </div>
    </>
  );
}
