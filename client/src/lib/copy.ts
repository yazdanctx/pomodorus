import copy from "@/copy.json";

/**
 * Every word of Persian in the product lives in one file, as it did in v1.
 * The register is deliberately casual — including the error messages — and the
 * repo's own docs stay formal by contrast.
 */
export { copy };

/** Fill `{placeholder}` tokens, e.g. t(copy.timer.minutes, { m: "۲۵" }). */
export function t(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    String(vars[key] ?? ""),
  );
}
