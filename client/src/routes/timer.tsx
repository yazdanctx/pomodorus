import { CategoryPicker } from "@/components/category-picker";
import { Skeleton } from "@/components/ui/skeleton";
import { useCategories } from "@/lib/categories";
import { usePersisted } from "@/lib/persisted";

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/**
 * The start screen. The picker is here; the −/clock/+ stepper, the start
 * button and the running clock arrive in #14, and the bell and the break in
 * #15 and #16.
 *
 * The page inset is `p-4 sm:p-6` rather than the standard `p-6`, because the
 * stepper row is what sets the horizontal budget on a phone.
 */
export function TimerRoute() {
  const { categories, create, update, remove } = useCategories();

  // Which task was last picked is a per-device preference the server has no
  // opinion about, so it lives on the device. This is not offline support and
  // must not grow into it: losing it costs one re-pick.
  const [selected, setSelected] = usePersisted<string | null>(
    "pomodorus.category",
    null,
    isNullableString,
  );

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-4 sm:p-6">
      <div className="grid w-full min-w-0">
        {categories === null ? (
          // The picker's exact box, so the list arriving does not move the
          // panel that will sit under it.
          <Skeleton className="h-10 w-full" />
        ) : (
          <CategoryPicker
            categories={categories}
            selected={selected}
            onSelect={setSelected}
            actions={{ create, update, remove }}
          />
        )}
      </div>
    </main>
  );
}
