import test from "node:test";
import assert from "node:assert/strict";
import { isProfane } from "../lib/profanity";

test("plain profanity is caught", () => {
  for (const text of [
    "سکس", "کیر", "جنده", "کسکش", "کص", "کوس", "گاییدم", "جق",
    "قحبه", "پتیاره", "کیرخور", "مقعد", "جق زدن", "شاشیدن", "گمشو", "کس کش",
    "ساک زدن", "فیلم سوپر",
  ]) {
    assert.equal(isProfane(text), true, text);
  }
});

test("a profane word anywhere in a label takes the label", () => {
  assert.equal(isProfane("مطالعه و سکس"), true);
  assert.equal(isProfane("!!!کیر"), true);
});

test("inflections and joined spellings count as the same word", () => {
  // Suffixed…
  assert.equal(isProfane("سکسی"), true);
  assert.equal(isProfane("کیرم"), true);
  // …spaced or joined…
  assert.equal(isProfane("کس کش"), true);
  assert.equal(isProfane("کس‌کش"), true);
  // …stretched, vowel-marked, or typed on an Arabic keyboard.
  assert.equal(isProfane("سکسییییی"), true);
  assert.equal(isProfane("سِکس"), true);
  assert.equal(isProfane("كير"), true);
});

test("spelling a word out letter by letter does not get past it", () => {
  assert.equal(isProfane("س ک س"), true);
  assert.equal(isProfane("س.ک.س"), true);
  assert.equal(isProfane("k_o_s"), true);
  assert.equal(isProfane("k_o_s_k_e_s_h"), true);
  assert.equal(isProfane("j.e.n.d.e.h"), true);
  // Two single letters in a row is «کس و کیر» losing its و, not an evasion.
  assert.equal(isProfane("کار و بار"), false);
});

test("the owner's blocked names match like the rest of the list", () => {
  for (const name of ["خامنه ای", "خامنه‌ای", "خامنهای", "خامنه", "khamenei_1"]) {
    assert.equal(isProfane(name), true, name);
  }
});

test("ordinary task labels are left alone", () => {
  const labels = [
    "کد نویسی",
    "درس خوندن",
    "کار کردن",
    "خرید هفتگی",
    "ویرایش عکس",
    "هیچ کس نیست",
    "کسی نیومد",
    "تکون دادن پروژه",
    "ترکوندن ددلاین",
    "اسکلت صفحه",
    "هیزم جمع کردن",
    "لخته خون",
    "پستانداران",
    "کودکستان",
    "بدبختانه دیر شد",
    "سرخوردگی",
    "پابرهنه",
    "اشغالگر",
  ];
  for (const label of labels) assert.equal(isProfane(label), false, label);
});

test("usernames are read in Latin, where the Persian list cannot reach", () => {
  assert.equal(isProfane("koskesh"), true);
  assert.equal(isProfane("kos_kesh"), true);
  assert.equal(isProfane("sex99"), true);
  assert.equal(isProfane("kir"), true);
  // English too — the list is not only Persian transliteration.
  assert.equal(isProfane("fuck_you"), true);
  assert.equal(isProfane("bitch_x"), true);
  // Names that merely contain those letters are not handles to punish.
  assert.equal(isProfane("kosar"), false);
  assert.equal(isProfane("kiarash"), false);
  assert.equal(isProfane("koorosh_71"), false);
  // Nor are the English words that carry one inside them: every *therapist*
  // ends in `rapist`, *trimming* carries `rimming`, *socialist` carries a drug.
  assert.equal(isProfane("therapist_sara"), false);
  assert.equal(isProfane("socialist_ali"), false);
  assert.equal(isProfane("trimming_co"), false);
});

test("nothing to read is not profanity", () => {
  assert.equal(isProfane(null), false);
  assert.equal(isProfane(undefined), false);
  assert.equal(isProfane(""), false);
  assert.equal(isProfane("۱۲۳ ---"), false);
});
