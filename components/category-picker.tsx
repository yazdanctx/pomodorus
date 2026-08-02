"use client";

import { useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronsUpDown,
  Pencil,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { copy, t } from "@/lib/copy";
import { useLocalState } from "@/lib/local/hooks";
import { effectiveCategories } from "@/lib/local/device";
import { createCategory, deleteCategory, updateCategory } from "@/lib/local/store";
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type View =
  | { name: "picker" }
  | { name: "create" }
  | { name: "edit"; category: Category };

/**
 * Why a name was refused. Same treatment as the login page's failures: the
 * theme is monochrome, so it separates itself from the grey around it by being
 * full white, boxed and iconned, and it is announced because it appears after
 * a press rather than beside the field.
 */
function Refusal({ reason }: { reason: string | null }) {
  return (
    <div aria-live="polite">
      {reason && (
        <Alert className="text-foreground">
          <TriangleAlert />
          <AlertDescription className="text-foreground">
            {reason}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

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
  const [refused, setRefused] = useState<string | null>(null);

  const selectedCategory =
    categories.find((c) => c.clientId === selected) ?? null;

  // With no categories the picker view is an empty combobox with a lone
  // "new category" row, so it's replaced by the create form. Deriving this
  // rather than setting the view on open also covers deleting the last
  // category from the edit view.
  const isEmpty = categories.length === 0;
  const showCreate =
    view.name === "create" || (isEmpty && view.name === "picker");

  const backToPicker = () => setView({ name: "picker" });

  // Radix only fires onOpenChange for user-initiated closes, so every
  // programmatic close has to reset the view and search itself.
  function closeAndReset() {
    setOpen(false);
    setView({ name: "picker" });
    setSearch("");
    setRefused(null);
  }

  function createFromSearch() {
    const result = createCategory(search.trim(), true);
    if ("rejected" in result) {
      setRefused(result.rejected);
      return;
    }
    onSelect(result.clientId);
    closeAndReset();
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
              {isEmpty ? copy.categories.firstTitle : copy.categories.pick}
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
        {/* p-20 is 5rem a side: on a 360px phone that leaves the picker about
            150px of usable width, so the phone gets the ordinary dialog inset
            and only the wider frame gets the airy version. */}
        <DialogContent className="p-6 sm:max-w-lg sm:p-20">
          {!showCreate && view.name === "picker" && (
            <>
              <DialogHeader>
                <DialogTitle>{copy.categories.pick}</DialogTitle>
              </DialogHeader>
              <Command className="bg-transparent">
                <div className="mb-2">
                  <CommandInput
                    autoFocus
                    placeholder={copy.categories.search}
                    value={search}
                    onValueChange={(next) => {
                      setSearch(next);
                      // The refusal was about the old text.
                      setRefused(null);
                    }}
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
              <Refusal reason={refused} />
            </>
          )}

          {showCreate && (
            <CreateView
              firstRun={isEmpty}
              onDismiss={isEmpty ? closeAndReset : backToPicker}
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
        variant="outline"
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
  firstRun,
  onDismiss,
  onCreated,
}: {
  firstRun: boolean;
  onDismiss: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [refused, setRefused] = useState<string | null>(null);

  function handleCreate() {
    const result = createCategory(name, isPublic);
    if ("rejected" in result) {
      setRefused(result.rejected);
      return;
    }
    onCreated(result.clientId);
  }

  return (
    <div className="flex flex-col gap-2">
      {/* First run has no picker behind it, so there's nowhere to go back to. */}
      {firstRun ? (
        <DialogHeader>
          <DialogTitle>{copy.categories.firstTitle}</DialogTitle>
          <DialogDescription>{copy.categories.firstHint}</DialogDescription>
        </DialogHeader>
      ) : (
        <BackHeader title={copy.categories.new} onBack={onDismiss} />
      )}
      <div className="flex flex-col gap-4">
        <Input
          autoFocus
          placeholder={copy.categories.namePlaceholder}
          value={name}
          dir="auto"
          maxLength={40}
          onChange={(e) => {
            setName(e.target.value);
            setRefused(null);
          }}
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
        <Refusal reason={refused} />
        <div className="flex gap-2">
          <Button size="sm" onClick={handleCreate} disabled={!name.trim()}>
            {copy.categories.add}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {copy.categories.cancel}
          </Button>
        </div>
      </div>
    </div>
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
  const [refused, setRefused] = useState<string | null>(null);

  function handleSave() {
    const result = updateCategory(category.clientId, name, isPublic);
    if (result !== null) {
      setRefused(result.rejected);
      return;
    }
    onBack();
  }

  return (
    <div className="flex flex-col gap-2">
      <BackHeader title={copy.categories.editTitle} onBack={onBack} />
      <div className="flex flex-col gap-4">
        <Input
          autoFocus
          value={name}
          dir="auto"
          maxLength={40}
          onChange={(e) => {
            setName(e.target.value);
            setRefused(null);
          }}
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
        <Refusal reason={refused} />
        <div className="flex justify-between gap-2">
          <Button size="sm" disabled={!name.trim()} onClick={handleSave}>
            {copy.categories.save}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-muted-foreground"
            onClick={() => {
              deleteCategory(category.clientId);
              onDeleted();
              onBack();
            }}
          >
            {copy.categories.delete}
          </Button>
        </div>
      </div>
    </div>
  );
}
