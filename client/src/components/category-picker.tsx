import { useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronsUpDown,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import { Failure } from "@/components/failure";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { messageFor } from "@/lib/api";
import type { Category } from "@/lib/categories";
import { copy, t } from "@/lib/copy";

type View =
  | { name: "picker" }
  | { name: "create" }
  | { name: "edit"; category: Category };

export type CategoryActions = {
  create: (name: string, isPublic: boolean) => Promise<Category>;
  update: (id: string, name: string, isPublic: boolean) => Promise<Category>;
  remove: (id: string) => Promise<void>;
};

/**
 * The combobox the start screen makes you go through before you can begin, and
 * the three little screens behind it: pick, create, edit.
 *
 * A category is created inline rather than on a settings page, because a new
 * kind of work turning into a detour is how a timer stops getting used.
 */
export function CategoryPicker({
  categories,
  selected,
  onSelect,
  actions,
  disabled = false,
}: {
  categories: Category[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  actions: CategoryActions;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ name: "picker" });
  const [search, setSearch] = useState("");
  const [refused, setRefused] = useState<string | null>(null);

  const selectedCategory = categories.find((c) => c.id === selected) ?? null;

  // With nothing to pick from, the picker view is an empty list and a lone
  // "new task" row — so it is replaced by the create form outright. Derived
  // rather than set when the dialog opens, which also covers deleting the last
  // category from the edit view.
  const isEmpty = categories.length === 0;
  const showCreate =
    view.name === "create" || (isEmpty && view.name === "picker");

  const backToPicker = () => {
    setView({ name: "picker" });
    setRefused(null);
  };

  function closeAndReset() {
    setOpen(false);
    setView({ name: "picker" });
    setSearch("");
    setRefused(null);
  }

  async function createFromSearch() {
    try {
      const made = await actions.create(search.trim(), true);
      onSelect(made.id);
      closeAndReset();
    } catch (failure) {
      setRefused(messageFor(failure));
    }
  }

  return (
    <>
      <Button
        variant="outline"
        role="combobox"
        aria-expanded={open}
        disabled={disabled}
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
          if (!next) closeAndReset();
        }}
      >
        <DialogContent>
          {!showCreate && view.name === "picker" && (
            <>
              <DialogHeader className="flex-row items-center justify-between gap-2">
                <DialogTitle>{copy.categories.pick}</DialogTitle>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setView({ name: "create" })}
                >
                  <Plus />
                  {copy.categories.new}
                </Button>
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

                {/* The bordered box is the scroller: five rows of 40px plus
                    its own padding, so a longer list scrolls inside a border
                    that stays put. */}
                <CommandList className="max-h-54 border p-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-border">
                  <CommandEmpty>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void createFromSearch()}
                    >
                      <Plus />
                      <span className="truncate">
                        {t(copy.categories.createNamed, {
                          name: search.trim(),
                        })}
                      </span>
                    </Button>
                  </CommandEmpty>
                  <CommandGroup className="p-0">
                    {categories.map((category) => (
                      <CommandItem
                        key={category.id}
                        value={category.name}
                        onSelect={() => {
                          onSelect(category.id);
                          closeAndReset();
                        }}
                      >
                        <Check
                          className={
                            selected === category.id
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
                          onClick={(event) => {
                            event.stopPropagation();
                            setView({ name: "edit", category });
                          }}
                        >
                          <Pencil />
                        </Button>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
              <Failure message={refused} />
            </>
          )}

          {showCreate && (
            <CreateView
              firstRun={isEmpty}
              create={actions.create}
              onDismiss={isEmpty ? closeAndReset : backToPicker}
              onCreated={(id) => {
                onSelect(id);
                closeAndReset();
              }}
            />
          )}

          {view.name === "edit" && (
            <EditView
              key={view.category.id}
              category={view.category}
              actions={actions}
              onBack={backToPicker}
              onDeleted={() => {
                if (selected === view.category.id) onSelect(null);
              }}
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
  create,
  onDismiss,
  onCreated,
}: {
  firstRun: boolean;
  create: CategoryActions["create"];
  onDismiss: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [refused, setRefused] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit() {
    setPending(true);
    try {
      const made = await create(name.trim(), isPublic);
      onCreated(made.id);
    } catch (failure) {
      setRefused(messageFor(failure));
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {/* First run has no picker behind it, so there is nowhere to go back to. */}
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
          aria-label={copy.categories.namePlaceholder}
          placeholder={copy.categories.namePlaceholder}
          value={name}
          dir="auto"
          maxLength={40}
          onChange={(event) => {
            setName(event.target.value);
            setRefused(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
        />
        <div className="flex items-center gap-2">
          <Checkbox
            id="new-public"
            checked={isPublic}
            onCheckedChange={(next) => setIsPublic(next === true)}
          />
          <Label htmlFor="new-public" className="text-sm text-muted-foreground">
            {copy.categories.publicLabel}
          </Label>
        </div>
        <Failure message={refused} />
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={!name.trim() || pending}
          >
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
  actions,
  onBack,
  onDeleted,
}: {
  category: Category;
  actions: CategoryActions;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [isPublic, setIsPublic] = useState(category.isPublic);
  const [refused, setRefused] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save() {
    setPending(true);
    try {
      await actions.update(category.id, name.trim(), isPublic);
      onBack();
    } catch (failure) {
      setRefused(messageFor(failure));
      setPending(false);
    }
  }

  async function remove() {
    setPending(true);
    try {
      await actions.remove(category.id);
      onDeleted();
      onBack();
    } catch (failure) {
      setRefused(messageFor(failure));
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <BackHeader title={copy.categories.editTitle} onBack={onBack} />
      <div className="flex flex-col gap-4">
        <Input
          autoFocus
          // Labelled by what it holds, not by the screen it is on: the dialog
          // title already says «ادیت تسک», and reusing it here would make two
          // things answer to one name.
          aria-label={copy.categories.namePlaceholder}
          value={name}
          dir="auto"
          maxLength={40}
          onChange={(event) => {
            setName(event.target.value);
            setRefused(null);
          }}
        />
        <div className="flex items-center gap-2">
          <Checkbox
            id={`public-${category.id}`}
            checked={isPublic}
            onCheckedChange={(next) => setIsPublic(next === true)}
          />
          <Label
            htmlFor={`public-${category.id}`}
            className="text-sm text-muted-foreground"
          >
            {copy.categories.publicLabel}
          </Label>
        </div>
        <Failure message={refused} />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!name.trim() || pending}
            onClick={() => void save()}
          >
            {copy.categories.save}
          </Button>
          {/* The one place the app spends a hue outside the ringing timer:
              deleting a category takes its sessions with it, and there is no
              undo. */}
          <Button
            size="sm"
            variant="ghost"
            className="text-rose-500 hover:text-rose-500"
            disabled={pending}
            onClick={() => void remove()}
          >
            <Trash2 />
            {copy.categories.delete}
          </Button>
        </div>
      </div>
    </div>
  );
}
