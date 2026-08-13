import { describe, expect, it } from "vitest";

import {
  enDigits,
  faClock,
  faDate,
  faDateShort,
  faDigits,
  faDuration,
  faHourClock,
} from "./format";

describe("faDigits", () => {
  it("converts ASCII digits and leaves everything else alone", () => {
    expect(faDigits(25)).toBe("۲۵");
    expect(faDigits("۲۵:۰۰")).toBe("۲۵:۰۰");
    expect(faDigits("v1.2")).toBe("v۱.۲");
  });
});

describe("enDigits", () => {
  it("round-trips", () => {
    expect(enDigits(faDigits("yazdan_82"))).toBe("yazdan_82");
  });
});

describe("faClock", () => {
  it("pads to mm:ss", () => {
    expect(faClock(25 * 60_000)).toBe("۲۵:۰۰");
    expect(faClock(65_000)).toBe("۰۱:۰۵");
  });

  it("rounds up, so a session shows its full length on the first tick", () => {
    expect(faClock(24 * 60_000 + 59_001)).toBe("۲۵:۰۰");
  });

  it("never goes negative — a ring is rendered as its own count-up", () => {
    expect(faClock(-5_000)).toBe("۰۰:۰۰");
  });

  it("keeps counting past an hour rather than wrapping", () => {
    expect(faClock(60 * 60_000)).toBe("۶۰:۰۰");
  });
});

describe("faDuration", () => {
  it("drops the empty half of the sentence", () => {
    expect(faDuration(45 * 60_000)).toBe("۴۵ دقیقه");
    expect(faDuration(120 * 60_000)).toBe("۲ ساعت");
    expect(faDuration(145 * 60_000)).toBe("۲ ساعت و ۲۵ دقیقه");
  });
});

describe("faHourClock", () => {
  it("sets under an hour as a clock, not as a bare number", () => {
    expect(faHourClock(45 * 60_000)).toBe("۰:۴۵");
    expect(faHourClock(145 * 60_000)).toBe("۲:۲۵");
  });
});

describe("jalali dates", () => {
  it("renders a Tehran day key as day-month-year", () => {
    expect(faDate("2026-08-13")).toBe("۲۲ مرداد ۱۴۰۵");
  });

  it("drops the year for chart ticks", () => {
    expect(faDateShort("2026-08-13")).toBe("۲۲ مرداد");
  });

  it("resolves the day at noon UTC, so the offset can never shift it", () => {
    // 2026-03-21 is 1 Farvardin: the day the year turns. An off-by-one here
    // would move a day's focus time into the wrong year.
    expect(faDate("2026-03-21")).toBe("۱ فروردین ۱۴۰۵");
  });
});
