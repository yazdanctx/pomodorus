/**
 * Persian numerals and Jalali dates.
 *
 * Every number the user reads is set in Persian digits; the one exception is a
 * handle, which is Latin by construction and is pushed back through `enDigits`
 * in case a Persian digit ever reaches it. Clocks are always `dir="ltr"` and
 * tabular — Persian digits in an RTL document still count left to right, and
 * without tabular figures the digits jitter on every tick.
 */

const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"] as const;

/** ASCII digits in a string (or a number) as Persian digits. */
export function faDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)] ?? d);
}

/** Persian digits back to ASCII. */
export function enDigits(value: string): string {
  return value.replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d as never)));
}

/** A countdown as `mm:ss` in Persian digits, e.g. ۲۴:۰۵. */
export function faClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return faDigits(
    `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
  );
}

/** Focus time as a sentence: «۲ ساعت و ۲۵ دقیقه» / «۴۵ دقیقه». */
export function faDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${faDigits(minutes)} دقیقه`;
  if (minutes === 0) return `${faDigits(hours)} ساعت`;
  return `${faDigits(hours)} ساعت و ${faDigits(minutes)} دقیقه`;
}

/**
 * Focus time as a bare `h:mm` clock, for setting at headline size — the
 * sentence form is far too long to set big. Under an hour still reads as a
 * clock: ۴۵ minutes is ۰:۴۵.
 */
export function faHourClock(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return faDigits(`${hours}:${String(minutes).padStart(2, "0")}`);
}

const jalali = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  timeZone: "Asia/Tehran",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const jalaliShort = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  timeZone: "Asia/Tehran",
  day: "numeric",
  month: "long",
});

/** A `YYYY-MM-DD` Tehran day key as «۲ مرداد ۱۴۰۵» — day, month, year. */
export function faDate(dayKey: string): string {
  const parts = jalali.formatToParts(dayFrom(dayKey));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")}`;
}

/** The same day key without the year, for chart axis ticks: «۲ مرداد». */
export function faDateShort(dayKey: string): string {
  return jalaliShort.format(dayFrom(dayKey));
}

/** Noon UTC is unambiguously inside the Tehran day, whatever the offset. */
function dayFrom(dayKey: string): Date {
  return new Date(`${dayKey}T12:00:00Z`);
}
