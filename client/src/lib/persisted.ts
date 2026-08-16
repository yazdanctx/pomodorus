import { useCallback, useState } from "react";

/**
 * A preference that survives a reload, kept on the device.
 *
 * This is not offline support and must not grow into it: nothing here is a
 * queue of unsent writes, and losing it costs the user one re-pick. What it
 * holds is which task and which length were last chosen — the answer to "where
 * was I", which the server has no opinion about and which is genuinely
 * per-device.
 */
export function usePersisted<T>(
  key: string,
  fallback: T,
  isValid: (value: unknown) => value is T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => read(key, fallback, isValid));

  const store = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Private mode, or a full quota. Forgetting a preference is not worth
        // interrupting somebody's pomodoro over.
      }
    },
    [key],
  );

  return [value, store];
}

function read<T>(
  key: string,
  fallback: T,
  isValid: (value: unknown) => value is T,
): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    // Validated rather than trusted: this is editable storage, and a value
    // that has drifted out of range should fall back rather than be believed.
    return isValid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
