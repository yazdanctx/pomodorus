import { useCallback, useEffect, useState } from "react";

import { get, post, type ServerTimed } from "@/lib/api";

export type Category = {
  id: string;
  name: string;
  isPublic: boolean;
};

type CategoriesPayload = ServerTimed & { categories: Category[] };
type CategoryPayload = ServerTimed & { category: Category };

/**
 * The signed-in user's categories, as the server has them.
 *
 * There is no local queue and no optimistic list: the server owns this, and a
 * write that has not landed has not happened. Offline is out of scope, so the
 * only thing a failed write has to do is report itself — which is why every
 * mutation here throws rather than swallowing.
 */
export function useCategories() {
  const [categories, setCategories] = useState<Category[] | null>(null);

  const reload = useCallback(async () => {
    const payload = await get<CategoriesPayload>("/api/categories");
    setCategories(payload.categories);
  }, []);

  useEffect(() => {
    void reload().catch(() => setCategories([]));
  }, [reload]);

  const create = useCallback(
    async (name: string, isPublic: boolean) => {
      // Minted here, so a retry on a poor connection lands on the row the
      // first attempt created rather than making a second one.
      const id = crypto.randomUUID();
      const payload = await post<CategoryPayload>("/api/categories", {
        id,
        name,
        isPublic,
      });
      await reload();
      return payload.category;
    },
    [reload],
  );

  const update = useCallback(
    async (id: string, name: string, isPublic: boolean) => {
      const payload = await post<CategoryPayload>(`/api/categories/${id}`, {
        name,
        isPublic,
      });
      await reload();
      return payload.category;
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string) => {
      await post(`/api/categories/${id}/delete`);
      await reload();
    },
    [reload],
  );

  return { categories, create, update, remove, reload };
}
