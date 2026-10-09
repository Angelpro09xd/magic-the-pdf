/**
 * IA de la carta (editor): revisa traducciones, elige la mejor impresión para superponer
 * texto y, con la IA en línea gratuita, genera ambientación o pule la redacción.
 */
import { askLLM } from './llm.js';

const symbols = (s) => (String(s || '').match(/\{[^}]+\}/g) || []).map((x) => x.toUpperCase()).sort();
// Números fuera de los símbolos ({2}) y de las fuerzas/resistencias (+1/+1 se compara aparte).
const numbers = (s) => (String(s || '').replace(/\{[^}]+\}/g, ' ').match(/[+−-]?\d+(?:\/[+−-]?\d+)?/g) || []).map((x) => x.replace('−', '-')).sort();
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Palabras que se dejan igual en casi todos los idiomas.
const KEEP = new Set(['planeswalker', 'commander', 'mana', 'token', 'tokens', 'scry', 'kicker', 'ninjutsu', 'ward', 'emblem']);
const words = (s) => String(s || '').toLowerCase().match(/\p{L}+/gu) || [];

/**
 * Compara el texto original (inglés) con la traducción. Devuelve [{ code, params }].
 */
export function checkTranslation(original, translated, lang) {
  const issues = [];
  const o = original.oracle_text || '';
  const tr = translated.oracle_text || '';
  if (o.trim() && !tr.trim()) return [{ code: 'edAiIssueEmpty', params: {} }];
  const so = symbols(o);
  const st = symbols(tr);
  if (!same(so, st)) issues.push({ code: 'edAiIssueSymbols', params: { a: so.length, b: st.length } });
  const no = numbers(o);
  const nt = numbers(tr);
  if (!same(no, nt)) issues.push({ code: 'edAiIssueNumbers', params: { a: no.join(' ') || '—', b: nt.join(' ') || '—' } });
  const po = o.split('\n').filter((l) => l.trim()).length;
  const pt = tr.split('\n').filter((l) => l.trim()).length;
  if (po !== pt) issues.push({ code: 'edAiIssueLines', params: { a: po, b: pt } });
  if (lang && lang !== 'en') {
    const nameWords = new Set([...words(original.name), ...words(translated.name)]);
    const english = new Set(words(o).filter((w) => w.length >= 4 && !KEEP.has(w) && !nameWords.has(w)));
    const left = [...new Set(words(tr).filter((w) => english.has(w)))];
    if (left.length >= 2 || (left.length === 1 && left[0].length >= 6)) issues.push({ code: 'edAiIssueEnglish', params: { words: left.slice(0, 6).join(', ') } });
  }
  return issues;
}

/** La mejor impresión para el estilo «como la original»: inglesa, marco moderno, alta resolución. */
export function bestOverlayPrint(prints, isFriendly) {
  const ok = prints.filter((p) => p.lang === 'en' && p.image_status !== 'missing' && p.image_status !== 'placeholder' && isFriendly(p));
  const score = (p) => (p.image_status === 'highres_scan' ? 4 : 0) + (p.promo ? -2 : 0) + (p.border_color === 'black' ? 1 : 0) + (Date.parse(p.released_at || 0) || 0) / 1e13;
  return ok.sort((a, b) => score(b) - score(a))[0] || null;
}

const LANG_NAMES = { es: 'Spanish', en: 'English', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ja: 'Japanese', ko: 'Korean', ru: 'Russian', zhs: 'Simplified Chinese', zht: 'Traditional Chinese', ca: 'Catalan', gl: 'Galician', eu: 'Basque', nl: 'Dutch', pl: 'Polish', tr: 'Turkish', sv: 'Swedish', uk: 'Ukrainian' };

/** Texto de ambientación original para la carta (IA en línea). */
export async function generateFlavor(face, lang) {
  const text = await askLLM(
    [
      { role: 'system', content: `You write flavor text for Magic: The Gathering cards. Reply with ONLY the flavor text in ${LANG_NAMES[lang] || 'Spanish'}: one or two short sentences, at most 25 words, evocative, no quotes around it unless it is a character speaking (then end with "—Name").` },
      { role: 'user', content: `Card: ${face.name}\nType: ${face.type_line}\nRules: ${face.oracle_text}` },
    ],
    { maxChars: 300 },
  );
  return text.replace(/^["“]|["”]$/g, (m) => (/[—-]\s*\S+$/.test(text) ? m : '')).trim();
}

/**
 * Pule la redacción de unas reglas traducidas para que suenen a carta oficial (IA en línea).
 * Si cambia símbolos o números, se descarta.
 */
export async function polishRules(original, translated, lang) {
  const text = await askLLM(
    [
      { role: 'system', content: `You are an expert Magic: The Gathering translator. Rewrite the translated rules text so it follows the official ${LANG_NAMES[lang] || 'Spanish'} Magic templating and terminology. Keep every {symbol}, number and line break exactly. Reply with ONLY the rewritten text.` },
      { role: 'user', content: `English original:\n${original.oracle_text}\n\nCurrent translation:\n${translated.oracle_text}` },
    ],
    { maxChars: 1500 },
  );
  const polished = text.replace(/^```\w*\n?|```$/g, '').trim();
  if (!same(symbols(polished), symbols(translated.oracle_text)) || !same(numbers(polished), numbers(translated.oracle_text))) throw new Error('changed-symbols');
  return polished;
}
