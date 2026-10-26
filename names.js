// Company names compared the way they are typed in the search box. The
// sources spell one name several ways ("Coca-Cola Co", "COCA COLA CO", "The
// Coca-Cola Company"), and a name is often typed with its words run together
// or apart ("jp morgan" for JPMorgan, "exxon mobil" for ExxonMobil). So names
// are compared with their words run together, "&" and "and" left out, and
// without the legal form at the end.

const SHORT_FORMS = { CORPORATION: 'CORP', INCORPORATED: 'INC', COMPANY: 'CO', LIMITED: 'LTD' };

// Words at the end of a name that say what kind of company it is, not which.
const LEGAL_FORMS = new Set([
  'INC', 'CORP', 'CO', 'LTD', 'LLC', 'LP', 'PLC', 'SA', 'SPA', 'AG', 'SE', 'NV', 'BV', 'AB', 'ASA', 'AS', 'OYJ', 'KGAA',
  'SAB', 'DE', 'CV', 'HOLDING', 'HOLDINGS', 'GROUP',
]);

function words(name) {
  return String(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // Nestlé is Nestle
    .toUpperCase()
    .replace(/\bA\/S\b/g, 'AS')
    .replace(/\s*\/[A-Z]*\/?\s*$/, '') // the SEC adds a state: "BANK OF AMERICA CORP /DE/"
    .replace(/\b([A-Z])\./g, '$1') // S.p.A. and N.V., but Amazon.com is two words
    .replace(/['’]/g, '')
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .filter((word, i) => !(i === 0 && word === 'THE'))
    .filter((word) => word !== 'AND')
    .map((word) => SHORT_FORMS[word] ?? word);
}

// A name taken apart for comparing: its words run together, where each word
// ends, and the part before its legal form or share class ("ALPHABET" for
// "Alphabet Inc Class A").
export function nameParts(name) {
  const all = words(name);
  let n = all.length;
  while (n > 1) {
    if (LEGAL_FORMS.has(all[n - 1])) n -= 1;
    else if (n > 2 && all[n - 2] === 'CLASS' && all[n - 1].length === 1) n -= 2;
    else break;
  }
  const ends = new Set();
  let length = 0;
  for (const word of all) ends.add((length += word.length));
  return { whole: all.join(''), core: all.slice(0, n).join(''), ends };
}

// What was typed, in the same form.
export const typedName = (text) => nameParts(text).core;

// How a name answers what was typed: 'name' when it is that name, its legal
// form aside; 'start' when it begins with the words typed; else null.
export function nameMatch(parts, typed) {
  if (!typed) return null;
  if (parts.core === typed) return 'name';
  if (parts.whole.startsWith(typed) && parts.ends.has(typed.length)) return 'start';
  return null;
}
