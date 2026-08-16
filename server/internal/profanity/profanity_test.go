package profanity_test

import (
	"testing"

	"github.com/yazdanctx/pomodorus/server/internal/profanity"
)

// The cases below are v1's suite, carried over as a regression floor, plus a
// case per folding rule in both directions. The negative cases matter more
// than the positive ones: a false positive takes a real person's task name
// away, and there is nobody to appeal to.

func TestContainsPlainProfanity(t *testing.T) {
	for _, text := range []string{
		"سکس", "کیر", "جنده", "کسکش", "کص", "کوس", "گاییدم", "جق",
		"قحبه", "پتیاره", "کیرخور", "مقعد", "جق زدن", "شاشیدن", "گمشو", "کس کش",
		"ساک زدن", "فیلم سوپر",
	} {
		if !profanity.Contains(text) {
			t.Errorf("Contains(%q) = false, want true", text)
		}
	}
}

func TestContainsAnywhereInALabel(t *testing.T) {
	for _, text := range []string{"مطالعه و سکس", "!!!کیر"} {
		if !profanity.Contains(text) {
			t.Errorf("Contains(%q) = false, want true", text)
		}
	}
}

func TestFoldingRules(t *testing.T) {
	tests := []struct {
		rule string
		text string
	}{
		{"a suffix does not make it a different word", "سکسی"},
		{"nor does a possessive one", "کیرم"},
		{"a two-word term typed apart", "کس کش"},
		{"…and the same term joined by a zero-width non-joiner", "کس‌کش"},
		{"…and joined outright", "کسکش"},
		{"a stretched letter is the same letter", "سکسییییی"},
		{"a vowel mark is invisible and changes nothing", "سِکس"},
		{"an Arabic keyboard produces the same word", "كير"},
		{"a tatweel stretches without changing", "كــير"},
		{"a Persian digit standing in for a letter", "کیر۱"},
	}

	for _, tc := range tests {
		t.Run(tc.rule, func(t *testing.T) {
			if !profanity.Contains(tc.text) {
				t.Errorf("Contains(%q) = false, want true", tc.text)
			}
		})
	}
}

func TestSpelledOutLetterByLetter(t *testing.T) {
	for _, text := range []string{
		"س ک س", "س.ک.س", "k_o_s", "k_o_s_k_e_s_h", "j.e.n.d.e.h",
	} {
		if !profanity.Contains(text) {
			t.Errorf("Contains(%q) = false, want true", text)
		}
	}

	// Two single letters in a row is «کس و کیر» losing its و, not an evasion.
	if profanity.Contains("کار و بار") {
		t.Error(`Contains("کار و بار") = true, want false`)
	}
}

func TestBlockedNamesMatchLikeProfanity(t *testing.T) {
	for _, name := range []string{
		"خامنه ای", "خامنه‌ای", "خامنهای", "خامنه", "khamenei_1",
	} {
		if !profanity.Contains(name) {
			t.Errorf("Contains(%q) = false, want true", name)
		}
	}
}

func TestWholeWordMatching(t *testing.T) {
	// Each of these contains a listed term as a substring and is an ordinary
	// thing to write. Allowing them is the whole point of the length rules.
	for _, label := range []string{
		"هیچ کس نیست",    // «کس» is "anyone"
		"کسی نیومد",      // …and so is «کسی»
		"ترکوندن ددلاین", // «کونده» sits inside «ترکونده»
		"اشغالگر",        // «اشغال» sits inside «اشغالگر»
		"اسکلت صفحه",     // «اسکل» plus a suffix is a skeleton
		"هیزم جمع کردن",  // …and «هیز» plus one is firewood
		"پستانداران",     // clinical anatomy inside a mammal
		"کودکستان",
		"بدبختانه دیر شد",
		"سرخوردگی",
		"پابرهنه",
		"لخته خون",
		"تکون دادن پروژه",
	} {
		if profanity.Contains(label) {
			t.Errorf("Contains(%q) = true, want false", label)
		}
	}
}

func TestOrdinaryLabelsAreLeftAlone(t *testing.T) {
	for _, label := range []string{
		"کد نویسی", "درس خوندن", "کار کردن", "خرید هفتگی", "ویرایش عکس",
	} {
		if profanity.Contains(label) {
			t.Errorf("Contains(%q) = true, want false", label)
		}
	}
}

func TestHandlesAreReadInLatin(t *testing.T) {
	// A handle is [a-z0-9_], so the Persian list cannot reach it.
	for _, handle := range []string{
		"koskesh", "kos_kesh", "sex99", "kir", "fuck_you", "bitch_x",
	} {
		if !profanity.Contains(handle) {
			t.Errorf("Contains(%q) = false, want true", handle)
		}
	}

	// Names that merely contain those letters are not handles to punish, and
	// neither are the English words that carry one inside them: every
	// *therapist* ends in `rapist`, *trimming* carries `rimming`.
	for _, handle := range []string{
		"kosar", "kiarash", "koorosh_71",
		"therapist_sara", "socialist_ali", "trimming_co",
	} {
		if profanity.Contains(handle) {
			t.Errorf("Contains(%q) = true, want false", handle)
		}
	}
}

func TestNothingToReadIsNotProfanity(t *testing.T) {
	for _, text := range []string{"", "   ", "۱۲۳ ---", "!!!", "‌"} {
		if profanity.Contains(text) {
			t.Errorf("Contains(%q) = true, want false", text)
		}
	}
}

func TestNormalize(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"lowercases Latin", "KosAr", "kosar"},
		{"unifies Arabic-keyboard letters", "كي", "کی"},
		// All three fold to the same letter, and three of a letter in a row is
		// then a stretched one — the two rules compose, in that order.
		{"unifies the alef forms", "آأإ", "ا"},
		{"unifies two of the alef forms without stretching", "آأ", "اا"},
		{"unifies the he forms", "ةۀ", "هه"},
		{"drops vowel marks", "سِکْس", "سکس"},
		{"drops the tatweel", "كــير", "کیر"},
		{"turns a zero-width non-joiner into a space", "کس‌کش", "کس کش"},
		{"turns Persian digits into spaces", "کس۱کش", "کس کش"},
		{"turns Arabic-Indic digits into spaces", "کس٧کش", "کس کش"},
		{"turns punctuation into a single space", "کس...کش", "کس کش"},
		{"collapses a stretched letter", "سکسییییی", "سکسی"},
		{"leaves a doubled letter alone", "goo", "goo"},
		{"trims", "  کیر  ", "کیر"},
		{"drops anything that is neither Persian nor Latin", "کیر漢字", "کیر"},
		{"reduces a string of separators to nothing", "!!! ۱۲۳ ---", ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := profanity.Normalize(tc.in); got != tc.want {
				t.Errorf("Normalize(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
