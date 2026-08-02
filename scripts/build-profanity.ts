// Rebuilds lib/profanity.json from its public sources. Run: npx tsx scripts/build-profanity.ts
//
// The sources are wordlists other people maintain; the judgement about what
// belongs in *this* app's list is all here, in EXCLUDE / EXTRA / BLOCKED, so
// adding a word later means editing one of those and running this again.
// See docs/adr/0003-profanity-wordlist.md.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { normalize } from "../lib/profanity";

const SOURCES = {
  // Persian swear dataset, ~320 entries.
  swearWords: "https://raw.githubusercontent.com/amirshnll/Persian-Swear-Words/master/data.json",
  // The `persian-bad-words` package's dictionary: Persian and Finglish.
  badWords:
    "https://raw.githubusercontent.com/TheKawasaki/persian-bad-words/master/src/Data/farsi.json",
  // A browser extension's Persian toxicity dictionary, Persian and Finglish.
  streamGuard:
    "https://raw.githubusercontent.com/farshidrezaei/stream-guard/main/content/dictionary.js",
  // Shutterstock's list-of-dirty-naughty-words, Persian and English files.
  ldnoobwFa:
    "https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/fa",
  ldnoobwEn:
    "https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en",
  // A Persian toxic-comment dataset; words are mined from the offensive rows.
  toxic: "https://raw.githubusercontent.com/ghaninia/toxicity_detection/master/dataset/dataset.json",
};

/**
 * Entries the sources carry that are not profanity: literal animals, ethnic
 * and national labels, drugs, clinical anatomy, and ordinary Persian words a
 * task label could honestly use. Leaving them in would take «کار کردن», «خرید»
 * or «عکس» out of the feed, which costs more than it saves.
 */
const EXCLUDE = `
  ان, انی, اسب, اسبی, گاو, گاوی, گوسفند, خر, خری, شغال, درازگوش, گردن دراز,
  گوش دراز, کرم, زالو, انگل, میکروب, میمون, گوریل, کفتار, گراز, گوساله, توله, خوک,
  ترک, فارس, عرب, لر, رشتی, وهابی, اجنبی, مزدور, خائن, پرستوی, اعظم,
  کردن, کردنی, سوپر, آلت, جنسی, جوون, منی, حشر, صیغه, صیغه ای, دوجنسه,
  دوست دختر, دوست پسر, ماچ, ماچ کردنی, لخت, ساک, سیخ, دول, دله, خز, لش, دکل,
  زارت, لاس, زر, زرت, شو, خفه, بکن, کلفت, زباله, دزد, لعنت, تف, لغو, پررو,
  چندش, کریه, مزخرفی, نفهم, بشاشم, نشخوار, ابادت, عرق خور,
  سایید, مالید, بمال, مالوندن, گشاد, پستان, بکارت, پریود, کس, زنا,
  مشروب, تریاک, حشیش, موادی, نعشه, بنگی, ملنگ, شنگول, کاندم, کاندوم,
  یاماتا, یامته, گودوخ, زاخار, کداسای, کوداسای, قس, کوبس, اوب, سوسکی,
  حیوانی, حیوون, بچتو, مادرتو, پدرتو, زنتو, زنشو, خواهرتو, خارتو, ننتو, عمتو,
  سرشو, بخورش, بیابخورش, میخوریش, مادرشو, مادرته, ننت, ناموستو, دهنت, دهنتو,
  شرفی, میای, میباره, کودکس, کدکس, نخور, خورش, لیس, گا, گو, جنبه, باو, پرو,
  صفت, خارش, عر, شرت, تیغ, لال
`;

/**
 * Profanity the sources miss, from the toxic-comment dataset and from plain
 * knowledge of what people actually write. Same bar as everything above: a
 * word only goes in if a task label or a username could not innocently be it.
 */
const EXTRA_FA = `
  قحبه, مادرقحبه, ننه قحبه, مادر قحبه, کاکولد, پتیاره, لکاته, روسپی, جنده خانم,
  کیرخور, کیرکلفت, کیرتوش, کیر تو, کیرتوکونت, کصکش, کوسکش, کسکشی, کونکشی,
  گوه خوری, گه خوری, گوهخوری, گهخوری, گوه نخور, زر مفت, زر زدن, زرزدن, گاله,
  شاشیدم, شاشیدن, نجاست, ماتحت, مقعد, مقعدی, انزال, استمنا, شهوانی, هرزگی,
  جق زدن, جلق زدن, جقزدن, سکس تلفنی, سکس چتی, فیلم سکسی, گنگ بنگ,
  نره خر, کودن, خیکی, نکبت, مفنگی, پیرسگ, شل مغز, عنخور, عنی,
  مردک, الدنگ, گمشو, بی همه چیز, بیهمهچیز, جندت,
  تخم سگ, تخمه سگ, بیناموسی, بی ناموس, بیشرف,
  خارکصده, خارکوسده, کسننت, کصننت, کس ننه, کیرم دهنت, کیرم تو دهنت,
  اوسگول, شاسگول, جاکشی, دیوثی, حرومزادگی
`;

/**
 * Not profanity — names the app's owner does not want in a public feed. Kept
 * separate from the merged wordlist so the provenance of each stays honest;
 * matched identically. Their Latin spellings sit in EXTRA_LATIN_PARTS, which
 * has no such split.
 */
const BLOCKED_FA = `خامنه ای, خامنه`;

/** Latin, matched whole-token: short enough that a substring would hit real names. */
const EXTRA_LATIN_WORDS = `
  kos koss kus koos kir kyr kun koon kuni kooni koony gooz gouz goh gouh chos
  jagh jaq sik shash sex sexy sexi sexs jende oskol oskul obne dayoos dayous
  dayus divoos kharkos kirkhar bangi jinda tokhm tokhmi nnto wtf
`;

/** Latin, matched anywhere: long enough that nothing innocent contains them. */
const EXTRA_LATIN_PARTS = `
  koskesh kooskesh kosskesh koskhol kosmadar kossher kharkose kosnanat kosenanat
  madarjende madarghahbe madarghabe madarghahbeh jakesh jendeh gaeidan gaeidam
  gayidam gaidan gayidam obneh siktir haramzade harumzade haromzade haroomzade
  bisharaf bishoor bishour pofyooz kiriface kirikhar kirtoon kosmagz madareto
  nanato khamenei
`;

/**
 * Latin entries the English list carries that are identities rather than
 * insults, or ordinary words a handle could be built from.
 */
const EXCLUDE_LATIN = new Set(
  `gay gays lesbian bisexual homosexual transsexual suck sucks xx xxx escort
   bang butt organ dink dong domination fire truck sexuality cialis viagra`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Long enough for the substring rule, but the substring rule would eat ordinary
 * English: every *therapist* ends in `rapist`, *trimming* carries `rimming`,
 * *scraping* carries `raping`, *thumping* carries `humping`, and `sexual` sits
 * inside every word for an orientation. Matched as whole tokens instead.
 */
const LATIN_TOKEN_ONLY = new Set(
  `rapist raping rimming humping snatch sexual sexually nanato`.split(/\s+/),
);

/** Under this, a Latin term is only matched as a whole token. */
const LATIN_SUBSTRING_MIN = 6;

async function text(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return await response.text();
}

/** Words that show up in the toxic dataset's offensive rows and almost nowhere else. */
function mineToxic(raw: string): string[] {
  const rows: { text: string; label: string }[] = JSON.parse(raw);
  const offensive = new Map<string, number>();
  const neutral = new Map<string, number>();
  for (const row of rows) {
    const seen = new Set(normalize(row.text).split(" "));
    const into = row.label === "Offensive" ? offensive : neutral;
    for (const word of seen) into.set(word, (into.get(word) ?? 0) + 1);
  }
  // A high bar on both counts: this is a suggestion machine, and everything it
  // suggests still has to survive EXCLUDE.
  return [...offensive]
    .filter(([word, count]) => word.length >= 3 && count >= 5)
    .filter(([word, count]) => count / (count + (neutral.get(word) ?? 0)) >= 0.95)
    .map(([word]) => word);
}

/** Terms are comma-separated, because several of them contain a space. */
const words = (block: string) =>
  block
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);

async function main() {
  const [swear, badWords, streamGuard, fa, en, toxic] = await Promise.all(
    [
      SOURCES.swearWords,
      SOURCES.badWords,
      SOURCES.streamGuard,
      SOURCES.ldnoobwFa,
      SOURCES.ldnoobwEn,
      SOURCES.toxic,
    ].map(text),
  );

  const fromSwear: string[] = JSON.parse(swear).word;
  const badWordsJson = JSON.parse(badWords);
  const fromBadWords: string[] = [...badWordsJson.farsiWords, ...badWordsJson.finglishWords];
  const fromStreamGuard = [...streamGuard.matchAll(/word:\s*"([^"]+)"/g)].map((m) => m[1]);
  const fromFa = fa.split("\n");
  const mined = mineToxic(toxic);

  const persian = new Set<string>();
  const latinWords = new Set<string>();
  const latinParts = new Set<string>();

  const addLatin = (term: string) => {
    const folded = normalize(term).replace(/ /g, "");
    if (!folded || EXCLUDE_LATIN.has(folded)) return;
    const anywhere = folded.length >= LATIN_SUBSTRING_MIN && !LATIN_TOKEN_ONLY.has(folded);
    (anywhere ? latinParts : latinWords).add(folded);
  };

  for (const term of [
    ...fromSwear,
    ...fromBadWords,
    ...fromStreamGuard,
    ...fromFa,
    ...mined,
  ]) {
    const folded = normalize(term);
    if (!folded) continue;
    // The Persian sources carry their own Finglish; sort by script, not by file.
    if (/^[a-z ]+$/.test(folded)) addLatin(folded);
    else persian.add(folded);
  }

  for (const term of words(EXTRA_FA)) persian.add(normalize(term));
  for (const term of `${EXTRA_LATIN_WORDS} ${EXTRA_LATIN_PARTS}`.split(/\s+/)) addLatin(term);
  for (const line of en.split("\n")) addLatin(line);

  // Folded, because that is the shape the terms it filters are in: the list is
  // written «آلت» but every term reaching it reads «الت».
  const excluded = new Set(words(EXCLUDE).map(normalize));

  const data = {
    // Whole terms only: EXCLUDE says «کس» alone is usually "anyone" and «ساک»
    // alone is a bag, which says nothing about «کس کش» or «ساک زدن».
    fa: [...persian].filter((term) => !excluded.has(term)).sort(),
    faBlocked: words(BLOCKED_FA).map((term) => normalize(term)).sort(),
    faAllow: ["اسکلت", "هیزم"],
    latinWords: [...latinWords].sort(),
    latinParts: [...latinParts].sort(),
  };

  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  await writeFile(
    path.join(root, "lib/profanity.json"),
    `${JSON.stringify(data, null, 2)}\n`,
  );
  console.log(
    `fa ${data.fa.length} + ${data.faBlocked.length} blocked, ` +
      `latin ${data.latinWords.length} words / ${data.latinParts.length} parts`,
  );
}

main();
