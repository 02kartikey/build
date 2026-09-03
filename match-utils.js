/* ════════════════════════════════════════════════════════════════════
   match-utils.js — tolerant school / class / name matching.

   WHY THIS EXISTS
   ───────────────
   Access-code entry asks a 14-year-old to reproduce, exactly, three strings
   a school typed into a CSV months earlier. That is not a reasonable ask:

     • School  — the row says "ABPS,BAGA"; the student types "ABPS", or
                 "A.B.P.S. Baga", or "abps baga".
     • Class   — the row says "IX"; the student picks "9". Same class.
                 Also seen: "Class 9", "9th", "Grade 9", "IX-B", "9 B".
     • Name    — "Mamta  Sharma" vs "Mamta Sharma" vs "MAMTA SHARMA".

   Every mismatch is a support ticket and a student who cannot reach their
   report. These helpers normalise all three so equivalent values compare
   equal, WITHOUT weakening the credential: the access code itself is still
   compared byte-for-byte in constant time by the caller. Broadening
   school/class/name only widens the candidate set the code must then match.

   NOTHING HERE IS A DATA TABLE
   ────────────────────────────
   Roman numerals are parsed with the actual algorithm (subtractive notation,
   any length), not looked up in a hand-typed list of twelve. The only tunable
   values are the grade bounds and the minimum school-query length, both named
   constants below with the reasoning attached. Change a bound and every
   caller follows; there is no second copy to keep in sync.

   USED BY
   ───────
     dashboard-db.js  — listAccessSchools / listAccessClasses /
                        listAccessNames / redeemAccessCode
     counsellor-db.js — redeemAccessCodeForCounsellor
════════════════════════════════════════════════════════════════════ */

'use strict';

/* ─── Tunables ───────────────────────────────────────────────────────
   GRADE_MIN / GRADE_MAX bound what counts as a school grade. They exist to
   reject numbers that are obviously not grades — a class labelled
   "Batch 2026" must not be read as grade 20. Widen these if the platform
   ever covers primary years or a 13th year; nothing else needs to change.

   SCHOOL_MIN_QUERY is the shortest typed school fragment that may match by
   prefix. Below it, a query is so unselective ("a") that it would match most
   of the database and the suggestion list becomes useless. Exact matches are
   always honoured regardless of length. */
const GRADE_MIN         = 1;
const GRADE_MAX         = 12;
const SCHOOL_MIN_QUERY  = 3;

/* ─── School ─────────────────────────────────────────────────────────
   Strip everything that varies between how a school types its own name
   and how a student remembers it: case, punctuation, and spacing.
   "ABPS,BAGA" / "A.B.P.S. Baga" / "abps  baga" → "abpsbaga". */
function normSchool(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/* Looser form that keeps word boundaries, for word-level matching.
   "ABPS,BAGA" → "abps baga" */
function tokenSchool(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Does the student's typed school refer to the stored one?
   Accepts exact-normalised equality, either side being a prefix of the other,
   or the typed words matching the start of the stored name word-for-word.
   "ABPS" matches "ABPS,BAGA"; "Delhi Public" matches "Delhi Public School". */
function schoolMatches(typed, stored) {
  const a = normSchool(typed);
  const b = normSchool(stored);
  if (!a || !b) return false;
  if (a === b) return true;               // exact wins at any length
  if (a.length < SCHOOL_MIN_QUERY) return false;
  if (b.startsWith(a) || a.startsWith(b)) return true;

  // Word-level: every word typed matches the corresponding leading word of
  // the stored name (allowing the last one to be a partial word).
  const at = tokenSchool(typed).split(' ').filter(Boolean);
  const bt = tokenSchool(stored).split(' ').filter(Boolean);
  if (at.length && at.length <= bt.length) {
    if (at.every((w, i) => bt[i] === w || bt[i].startsWith(w))) return true;
  }
  return false;
}

/* ─── Roman numerals ─────────────────────────────────────────────────
   A real parser, not a lookup table: handles subtractive notation and any
   length, so IV/IX/XIV/XIX all work and nothing needs adding if the grade
   range ever widens. Returns null for anything that is not a well-formed
   roman numeral, including the empty string.

   Validation is strict enough to reject letter-soup that happens to use
   roman letters — "mix", "civic" and "dill" are words, not numerals — by
   requiring canonical form: the value round-trips to the same numeral. */
const _ROMAN_DIGIT = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
const _ROMAN_CANON = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
  [100,  'c'], [90,  'xc'], [50,  'l'], [40,  'xl'],
  [10,   'x'], [9,   'ix'], [5,   'v'], [4,   'iv'], [1, 'i'],
];

function _intToRoman(n) {
  let out = '', left = n;
  for (const [val, sym] of _ROMAN_CANON) {
    while (left >= val) { out += sym; left -= val; }
  }
  return out;
}

function romanToInt(token) {
  const t = String(token || '').toLowerCase().trim();
  if (!t || !/^[ivxlcdm]+$/.test(t)) return null;

  let total = 0;
  for (let k = 0; k < t.length; k++) {
    const cur  = _ROMAN_DIGIT[t[k]];
    const next = _ROMAN_DIGIT[t[k + 1]];
    // A smaller digit before a larger one is subtractive (IX = 10 - 1).
    if (next && cur < next) total -= cur;
    else                    total += cur;
  }
  if (total <= 0) return null;
  // Canonical-form check rejects words that merely use roman letters.
  return _intToRoman(total) === t ? total : null;
}

/* ─── Class ──────────────────────────────────────────────────────────
   Reduce a free-text class to its grade number. Bulk imports contain
   "IX", "9", "Class 9", "9th", "Grade 9", "IX-B", "9-B", "10 DS".

   The section suffix is intentionally dropped: a student in "IX" and a row
   that says "IX-B" are in the same grade, and students routinely do not know
   or type their section on this form. Callers that surface a class list
   collapse same-grade labels to one option so the label never implies a
   section the student did not choose. */
function classGradeNumber(s) {
  const raw = String(s || '').toLowerCase().trim();
  if (!raw) return null;

  // Digits win when present: "class 10-b" → 10, "9th" → 9.
  const digits = raw.match(/\d{1,2}/);
  if (digits) {
    const n = parseInt(digits[0], 10);
    return (n >= GRADE_MIN && n <= GRADE_MAX) ? n : null;
  }

  // Otherwise look for a roman numeral among the word tokens. Splitting on
  // non-letters means "ix-b" and "ix b" both yield the token "ix".
  for (const t of raw.split(/[^a-z]+/)) {
    if (!t) continue;
    const n = romanToInt(t);
    if (n != null && n >= GRADE_MIN && n <= GRADE_MAX) return n;
  }
  return null;
}

/* Two class strings refer to the same grade. Falls back to normalised string
   equality when neither side yields a grade number, so unusual labels
   ("Foundation", "Pre-Board") still match themselves exactly. */
function classMatches(a, b) {
  const ga = classGradeNumber(a);
  const gb = classGradeNumber(b);
  if (ga != null && gb != null) return ga === gb;
  const na = String(a || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const nb = String(b || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return !!na && na === nb;
}

/* ─── Name ───────────────────────────────────────────────────────────
   Collapse case, punctuation and repeated whitespace. Does NOT reorder
   words: "Sharma Mamta" is deliberately not treated as "Mamta Sharma",
   because the dropdown shows the stored spelling and the student picks it. */
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameMatches(a, b) {
  const na = normName(a);
  const nb = normName(b);
  return !!na && na === nb;
}

module.exports = {
  GRADE_MIN, GRADE_MAX, SCHOOL_MIN_QUERY,
  normSchool, tokenSchool, schoolMatches,
  romanToInt, classGradeNumber, classMatches,
  normName, nameMatches,
};
