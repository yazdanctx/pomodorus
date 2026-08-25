import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  CategoryPicker,
  type CategoryActions,
} from "@/components/category-picker";
import { ApiError } from "@/lib/api";
import type { Category } from "@/lib/categories";
import { copy, t } from "@/lib/copy";
import { renderAt } from "@/test/render";

const درس: Category = { id: "c1", name: "درس", isPublic: true };
const خصوصی: Category = { id: "c2", name: "یه چیزی", isPublic: false };

/**
 * The picker is given its list and its actions, so a test supplies both and
 * asserts what is on screen — never how the request was shaped.
 */
function renderPicker(
  categories: Category[],
  actions: Partial<CategoryActions> = {},
) {
  const onSelect = vi.fn();
  const full: CategoryActions = {
    create: vi.fn(async (name: string, isPublic: boolean) => ({
      id: "new",
      name,
      isPublic,
    })),
    update: vi.fn(async (id: string, name: string, isPublic: boolean) => ({
      id,
      name,
      isPublic,
    })),
    remove: vi.fn(async () => {}),
    ...actions,
  };

  function Harness() {
    const [selected, setSelected] = useState<string | null>(null);
    return (
      <CategoryPicker
        categories={categories}
        selected={selected}
        onSelect={(id) => {
          setSelected(id);
          onSelect(id);
        }}
        actions={full}
      />
    );
  }

  renderAt(<Harness />);
  return { onSelect, actions: full, user: userEvent.setup() };
}

const openPicker = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("combobox"));

describe("the category picker", () => {
  it("opens straight into the create form when there is nothing yet", async () => {
    const { user } = renderPicker([]);

    await openPicker(user);

    // No list to search through, so the search field would be furniture.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(copy.categories.firstTitle)).toBeTruthy();
    expect(within(dialog).getByText(copy.categories.firstHint)).toBeTruthy();
    expect(screen.queryByPlaceholderText(copy.categories.search)).toBeNull();
  });

  it("says so on the trigger when there is nothing to pick", () => {
    renderPicker([]);

    expect(screen.getByRole("combobox").textContent).toContain(
      copy.categories.firstTitle,
    );
  });

  it("selects a category and closes", async () => {
    const { user, onSelect } = renderPicker([درس]);

    await openPicker(user);
    await user.click(await screen.findByText("درس"));

    expect(onSelect).toHaveBeenCalledWith("c1");
    expect(screen.getByRole("combobox").textContent).toContain("درس");
  });

  it("badges a private category in the list and on the trigger", async () => {
    const { user } = renderPicker([خصوصی]);

    await openPicker(user);
    await user.click(await screen.findByText("یه چیزی"));

    expect(screen.getByRole("combobox").textContent).toContain(
      copy.categories.privateBadge,
    );
  });

  it("creates inline and selects what it created", async () => {
    const create = vi.fn(async (name: string, isPublic: boolean) => ({
      id: "made",
      name,
      isPublic,
    }));
    const { user, onSelect } = renderPicker([], { create });

    await openPicker(user);
    await user.type(
      screen.getByLabelText(copy.categories.namePlaceholder),
      "کد نویسی",
    );
    await user.click(screen.getByRole("button", { name: copy.categories.add }));

    expect(create).toHaveBeenCalledWith("کد نویسی", true);
    expect(onSelect).toHaveBeenCalledWith("made");
  });

  it("can create a private one", async () => {
    const create = vi.fn(async (name: string, isPublic: boolean) => ({
      id: "made",
      name,
      isPublic,
    }));
    const { user } = renderPicker([], { create });

    await openPicker(user);
    await user.type(
      screen.getByLabelText(copy.categories.namePlaceholder),
      "یه چیزی",
    );
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: copy.categories.add }));

    expect(create).toHaveBeenCalledWith("یه چیزی", false);
  });

  it("shows why a name was refused, and stays on the form", async () => {
    const create = vi.fn(() =>
      Promise.reject(new ApiError("category_name_profane", 400)),
    );
    const { user } = renderPicker([], { create });

    await openPicker(user);
    await user.type(
      screen.getByLabelText(copy.categories.namePlaceholder),
      "کیر",
    );
    await user.click(screen.getByRole("button", { name: copy.categories.add }));

    expect(
      await screen.findByText(copy.errors.categoryNameProfane),
    ).toBeTruthy();
    expect(screen.getByLabelText(copy.categories.namePlaceholder)).toBeTruthy();
  });

  it("renames from the edit view", async () => {
    const update = vi.fn(
      async (id: string, name: string, isPublic: boolean) => ({
        id,
        name,
        isPublic,
      }),
    );
    const { user } = renderPicker([درس], { update });

    await openPicker(user);
    await user.click(
      await screen.findByRole("button", {
        name: t(copy.categories.editAria, { name: "درس" }),
      }),
    );
    const field = screen.getByLabelText(copy.categories.namePlaceholder);
    await user.clear(field);
    await user.type(field, "ریاضی");
    await user.click(
      screen.getByRole("button", { name: copy.categories.save }),
    );

    expect(update).toHaveBeenCalledWith("c1", "ریاضی", true);
  });

  it("deletes from the edit view and clears the selection it was", async () => {
    const remove = vi.fn(async () => {});
    const { user, onSelect } = renderPicker([درس], { remove });

    await openPicker(user);
    await user.click(await screen.findByText("درس"));
    expect(onSelect).toHaveBeenLastCalledWith("c1");

    await openPicker(user);
    await user.click(
      await screen.findByRole("button", {
        name: t(copy.categories.editAria, { name: "درس" }),
      }),
    );
    await user.click(
      screen.getByRole("button", { name: copy.categories.delete }),
    );

    expect(remove).toHaveBeenCalledWith("c1");
    // The selection cannot survive the thing it selected.
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("offers to create what was searched for when nothing matches", async () => {
    const create = vi.fn(async (name: string, isPublic: boolean) => ({
      id: "made",
      name,
      isPublic,
    }));
    const { user } = renderPicker([درس], { create });

    await openPicker(user);
    await user.type(
      screen.getByPlaceholderText(copy.categories.search),
      "ورزش",
    );
    await user.click(
      await screen.findByRole("button", {
        name: t(copy.categories.createNamed, { name: "ورزش" }),
      }),
    );

    expect(create).toHaveBeenCalledWith("ورزش", true);
  });

  it("lists every category with its edit affordance", async () => {
    const { user } = renderPicker([درس, خصوصی]);

    await openPicker(user);
    const list = await screen.findByRole("listbox");

    expect(within(list).getByText("درس")).toBeTruthy();
    expect(within(list).getByText("یه چیزی")).toBeTruthy();
    expect(within(list).getByText(copy.categories.privateBadge)).toBeTruthy();
  });

  it("keeps every category reachable when there are more than fit", async () => {
    const many: Category[] = Array.from({ length: 12 }, (_, i) => ({
      id: `c${i}`,
      name: `تسک ${i}`,
      isPublic: true,
    }));
    const { user, onSelect } = renderPicker(many);

    await openPicker(user);
    await user.click(await screen.findByText("تسک 11"));

    expect(onSelect).toHaveBeenCalledWith("c11");
  });

  it("creates from the header, alongside the title", async () => {
    const { user } = renderPicker([درس]);

    await openPicker(user);
    await user.click(screen.getByRole("button", { name: copy.categories.new }));

    expect(screen.getByLabelText(copy.categories.namePlaceholder)).toBeTruthy();
  });
});
