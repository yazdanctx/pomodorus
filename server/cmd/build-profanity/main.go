// Command build-profanity rebuilds internal/profanity/profanity.json from its
// public sources. Run it with `make profanity`.
//
// The sources are wordlists other people maintain; the judgement about what
// belongs in *this* app's list is all here, in the curation blocks below, so
// adding or removing a word means editing one of those and running this again.
// Nothing is ever edited in the generated JSON — a hand-edit would be silently
// undone by the next run, and the test in this package fails if one happens.
//
// It folds every term through profanity.Normalize, the same function the
// matcher folds text through, so the list and the text it is matched against
// cannot drift into different shapes.
//
// See docs/adr/0003-profanity-wordlist.md (at the v1-nextjs tag) for why the
// list is curated rather than taken as published.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/profanity"
)

var sourceURLs = map[string]string{
	// Persian swear dataset, ~320 entries.
	"swear": "https://raw.githubusercontent.com/amirshnll/Persian-Swear-Words/master/data.json",
	// The `persian-bad-words` package's dictionary: Persian and Finglish.
	"badWords": "https://raw.githubusercontent.com/TheKawasaki/persian-bad-words/master/src/Data/farsi.json",
	// A browser extension's Persian toxicity dictionary, Persian and Finglish.
	"streamGuard": "https://raw.githubusercontent.com/farshidrezaei/stream-guard/main/content/dictionary.js",
	// Shutterstock's list-of-dirty-naughty-words, Persian and English files.
	"ldnoobwFa": "https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/fa",
	"ldnoobwEn": "https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en",
	// A Persian toxic-comment dataset; words are mined from the offensive rows.
	"toxic": "https://raw.githubusercontent.com/ghaninia/toxicity_detection/master/dataset/dataset.json",
}

// Entries the sources carry that are not profanity: literal animals, ethnic
// and national labels, drugs, clinical anatomy, and ordinary Persian words a
// task label could honestly use. Leaving them in would take «کار کردن», «خرید»
// or «عکس» out of the feed, which costs more than it saves.
//
// Comma-separated, because several of these contain a space.
const excludeFa = `
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
`

// Profanity the sources miss, from the toxic-comment dataset and from plain
// knowledge of what people actually write. Same bar as everything above: a
// word only goes in if a task label or a handle could not innocently be it.
const extraFa = `
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
`

// Not profanity — names the app's owner does not want in a public feed. Kept
// separate from the merged wordlist so the provenance of each stays honest;
// matched identically. Their Latin spellings sit in extraLatinParts, which has
// no such split.
const blockedFa = `خامنه ای, خامنه`

// The handful of real words that survive every matching rule: «اسکلت» is
// «اسکل» plus a suffix, and is a skeleton.
var faAllow = []string{"اسکلت", "هیزم"}

// Latin, matched whole-token: short enough that a substring would hit real
// names.
const extraLatinWords = `
  kos koss kus koos kir kyr kun koon kuni kooni koony gooz gouz goh gouh chos
  jagh jaq sik shash sex sexy sexi sexs jende oskol oskul obne dayoos dayous
  dayus divoos kharkos kirkhar bangi jinda tokhm tokhmi nnto wtf
`

// Latin, matched anywhere: long enough that nothing innocent contains them.
const extraLatinParts = `
  koskesh kooskesh kosskesh koskhol kosmadar kossher kharkose kosnanat kosenanat
  madarjende madarghahbe madarghabe madarghahbeh jakesh jendeh gaeidan gaeidam
  gayidam gaidan gayidam obneh siktir haramzade harumzade haromzade haroomzade
  bisharaf bishoor bishour pofyooz kiriface kirikhar kirtoon kosmagz madareto
  nanato khamenei
`

// Latin entries the English list carries that are identities rather than
// insults, or ordinary words a handle could be built from.
const excludeLatin = `gay gays lesbian bisexual homosexual transsexual suck sucks xx xxx escort
   bang butt organ dink dong domination fire truck sexuality cialis viagra`

// Long enough for the substring rule, but the substring rule would eat
// ordinary English: every *therapist* ends in `rapist`, *trimming* carries
// `rimming`, *scraping* carries `raping`, *thumping* carries `humping`, and
// `sexual` sits inside every word for an orientation. Matched as whole tokens
// instead.
const latinTokenOnly = `rapist raping rimming humping snatch sexual sexually nanato`

// Under this, a Latin term is only matched as a whole token.
const latinSubstringMin = 6

// inputs is everything the sources contribute, already reduced to flat lists of
// terms. Keeping this apart from the fetching is what lets the test drive the
// whole assembly without a network.
type inputs struct {
	// Terms from the Persian-carrying sources. They are sorted by script here,
	// not by which file they came from — the Persian lists carry their own
	// Finglish.
	persian []string
	// Terms from the English list, all Latin.
	english []string
}

func main() {
	log.SetFlags(0)

	out := flagOutput()
	raw, err := fetchAll()
	if err != nil {
		log.Fatal(err)
	}
	in, err := parse(raw)
	if err != nil {
		log.Fatal(err)
	}

	data := assemble(in)
	if err := write(out, data); err != nil {
		log.Fatal(err)
	}

	log.Printf("fa %d + %d blocked, latin %d words / %d parts → %s",
		len(data.Fa), len(data.FaBlocked), len(data.LatinWords), len(data.LatinParts), out)
}

func flagOutput() string {
	if len(os.Args) > 1 {
		return os.Args[1]
	}
	return filepath.Join("internal", "profanity", "profanity.json")
}

// assemble is the whole of the curation: fold, sort by script, drop what the
// exclude lists say is not profanity, add what the sources miss, and sort.
// It is pure, so it can be tested against its own output.
func assemble(in inputs) profanity.Wordlist {
	persian := map[string]bool{}
	latinWords := map[string]bool{}
	latinParts := map[string]bool{}

	excludedLatin := fields(excludeLatin)
	tokenOnly := fields(latinTokenOnly)

	addLatin := func(term string) {
		// Folded again after the join, not just before it: «ball licking»
		// becomes `balllicking`, and a term with a letter tripled in it can
		// never match, because the text it is matched against has been folded
		// down to `balicking` by the time it gets here. v1 folded once and
		// carried a handful of terms that could not fire.
		folded := profanity.Normalize(
			strings.ReplaceAll(profanity.Normalize(term), " ", ""),
		)
		if folded == "" || slices.Contains(excludedLatin, folded) {
			return
		}
		if len([]rune(folded)) >= latinSubstringMin && !slices.Contains(tokenOnly, folded) {
			latinParts[folded] = true
		} else {
			latinWords[folded] = true
		}
	}

	for _, term := range in.persian {
		folded := profanity.Normalize(term)
		if folded == "" {
			continue
		}
		if isLatin(folded) {
			addLatin(folded)
		} else {
			persian[folded] = true
		}
	}
	for _, term := range terms(extraFa) {
		persian[profanity.Normalize(term)] = true
	}
	for _, term := range fields(extraLatinWords + " " + extraLatinParts) {
		addLatin(term)
	}
	for _, term := range in.english {
		addLatin(term)
	}

	// Folded, because that is the shape of the terms it filters: the list is
	// written «آلت» but every term reaching it reads «الت».
	//
	// Whole terms only — «کس» alone is usually "anyone" and «ساک» alone is a
	// bag, which says nothing about «کس کش» or «ساک زدن».
	excluded := map[string]bool{}
	for _, term := range terms(excludeFa) {
		excluded[profanity.Normalize(term)] = true
	}

	var fa []string
	for term := range persian {
		if !excluded[term] {
			fa = append(fa, term)
		}
	}

	var blocked []string
	for _, term := range terms(blockedFa) {
		blocked = append(blocked, profanity.Normalize(term))
	}

	return profanity.Wordlist{
		Fa:         sorted(fa),
		FaBlocked:  sorted(blocked),
		FaAllow:    faAllow,
		LatinWords: sorted(keys(latinWords)),
		LatinParts: sorted(keys(latinParts)),
	}
}

func isLatin(folded string) bool {
	for _, r := range folded {
		if r != ' ' && (r < 'a' || r > 'z') {
			return false
		}
	}
	return folded != ""
}

// terms splits a comma-separated curation block. Several entries contain a
// space, which is why they are not whitespace-separated.
func terms(block string) []string {
	var out []string
	for _, term := range strings.Split(block, ",") {
		if term = strings.TrimSpace(term); term != "" {
			out = append(out, term)
		}
	}
	return out
}

func fields(block string) []string { return strings.Fields(block) }

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// sorted deduplicates and orders, so the generated file has one canonical form
// and a rebuild that changed nothing produces no diff.
func sorted(items []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, item := range items {
		if item != "" && !seen[item] {
			seen[item] = true
			out = append(out, item)
		}
	}
	sort.Strings(out)
	return out
}

func write(path string, data profanity.Wordlist) error {
	body, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(body, '\n'), 0o644)
}

// --- the sources ------------------------------------------------------------

type rawSources map[string][]byte

func fetchAll() (rawSources, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	raw := rawSources{}
	for name, url := range sourceURLs {
		body, err := fetch(client, url)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		raw[name] = body
	}
	return raw, nil
}

func fetch(client *http.Client, url string) ([]byte, error) {
	res, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s %s", res.Status, url)
	}
	return io.ReadAll(res.Body)
}

var streamGuardWord = regexp.MustCompile(`word:\s*"([^"]+)"`)

func parse(raw rawSources) (inputs, error) {
	var in inputs

	var swear struct {
		Word []string `json:"word"`
	}
	if err := json.Unmarshal(raw["swear"], &swear); err != nil {
		return in, fmt.Errorf("swear: %w", err)
	}
	in.persian = append(in.persian, swear.Word...)

	var bad struct {
		Farsi    []string `json:"farsiWords"`
		Finglish []string `json:"finglishWords"`
	}
	if err := json.Unmarshal(raw["badWords"], &bad); err != nil {
		return in, fmt.Errorf("badWords: %w", err)
	}
	in.persian = append(in.persian, bad.Farsi...)
	in.persian = append(in.persian, bad.Finglish...)

	for _, m := range streamGuardWord.FindAllSubmatch(raw["streamGuard"], -1) {
		in.persian = append(in.persian, string(m[1]))
	}

	in.persian = append(in.persian, strings.Split(string(raw["ldnoobwFa"]), "\n")...)

	mined, err := mineToxic(raw["toxic"])
	if err != nil {
		return in, fmt.Errorf("toxic: %w", err)
	}
	in.persian = append(in.persian, mined...)

	in.english = strings.Split(string(raw["ldnoobwEn"]), "\n")
	return in, nil
}

// mineToxic pulls the words that show up in the dataset's offensive rows and
// almost nowhere else. The bar is high on both counts: this is a suggestion
// machine, and everything it suggests still has to survive excludeFa.
func mineToxic(body []byte) ([]string, error) {
	var rows []struct {
		Text  string `json:"text"`
		Label string `json:"label"`
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}

	offensive, neutral := map[string]int{}, map[string]int{}
	for _, row := range rows {
		counts := neutral
		if row.Label == "Offensive" {
			counts = offensive
		}
		seen := map[string]bool{}
		for _, word := range strings.Split(profanity.Normalize(row.Text), " ") {
			if !seen[word] {
				seen[word] = true
				counts[word]++
			}
		}
	}

	var out []string
	for word, count := range offensive {
		if len([]rune(word)) < 3 || count < 5 {
			continue
		}
		if float64(count)/float64(count+neutral[word]) >= 0.95 {
			out = append(out, word)
		}
	}
	return out, nil
}
