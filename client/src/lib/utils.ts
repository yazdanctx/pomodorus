import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind classes so a caller's override actually wins. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
