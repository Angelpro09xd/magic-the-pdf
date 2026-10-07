/**
 * Traducción automática gratuita y sin clave: Google Translate (endpoint público "gtx")
 * y MyMemory como respaldo. Los símbolos de maná se protegen con marcadores ⟨n⟩.
 */
import { protectSymbols, restoreSymbols } from './symbols.js';

const UA = 'Mozilla/5.0 (compatible; MagicThePDF/1.0)';

/** Correcciones de terminología de Magic tras la traducción automática. */
const FIXES = {
  es: [
    [/\b[Ss]acrificar\b/g, 'sacrifica'],
    [/\b[Aa]gregar\b/g, 'agrega'],
    [/\bSuma (?=\{)/g, 'Agrega '],
    [/\bsuma (?=\{)/g, 'agrega '],
    [/\bAñade (?=\{)/g, 'Agrega '],
    [/\bañade (?=\{)/g, 'agrega '],
    [/\b[Gg]irar\b/g, 'gira'],
    [/\b[Ee]nderezar\b/g, 'endereza'],
    [/\b[Dd]escartar\b/g, 'descarta'],
    [/\bPagar\b(?= \{)/g, 'Paga'],
    [/\bpagar\b(?= \{)/g, 'paga'],
    [/\bBarrio\b/g, 'Rebatir'],
    [/\bpisotear\b/gi, 'arrollar'],
    [/\b[Vv]olando\b/g, 'vuela'],
    [/\bmazo\b/g, 'biblioteca'],
    [/\bexiliar\b/g, 'exilia'],
    [/\bel objetivo de hechizo\b/g, 'el hechizo objetivo'],
    [/\bcontrarrestar el hechizo objetivo\b/gi, 'contrarresta el hechizo objetivo'],
  ],
  fr: [[/\bSacrifier\b/g, 'Sacrifiez'], [/\bpiocher une carte\b/g, 'piochez une carte']],
  de: [[/\bOpfern\b/g, 'Opfere']],
};

export function applyFixes(text, lang) {
  let out = text;
  for (const [re, rep] of FIXES[lang] || []) out = out.replace(re, rep);
  return out;
}

async function google(texts, language) {
  const params = new URLSearchParams({ client: 'gtx', sl: 'en', tl: language.gt, dt: 't', q: texts.join('\n') });
  const res = await fetch(`https://translate.googleapis.com/translate_a/single?${params}`, {
    // En el navegador no se puede (ni hace falta) fijar el User-Agent: provocaría una petición CORS previa.
    headers: typeof window === 'undefined' ? { 'User-Agent': UA } : {},
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Google Translate respondió ${res.status}`);
  const data = await res.json();
  const joined = (data?.[0] || []).map((seg) => seg?.[0] ?? '').join('');
  const lines = joined.split('\n');
  if (lines.length !== texts.length) throw new Error('Google Translate devolvió un número distinto de líneas');
  return lines;
}

async function myMemory(text, language, email) {
  const params = new URLSearchParams({ q: text.slice(0, 480), langpair: `en|${language.mt}` });
  if (email) params.set('de', email);
  const res = await fetch(`https://api.mymemory.translated.net/get?${params}`, { signal: AbortSignal.timeout(12000) });
  const data = await res.json();
  const out = data?.responseData?.translatedText;
  if (data.responseStatus !== 200 || !out || /MYMEMORY WARNING/i.test(out)) {
    throw new Error(`MyMemory: ${data?.responseDetails || 'límite alcanzado'}`);
  }
  return out;
}

/**
 * Traduce una lista de fragmentos (el orden se conserva). Lanza si ningún servicio responde.
 * Los fragmentos pueden llevar ~ (nombre de la carta) y símbolos {X}: se protegen.
 */
export function createMachineTranslator({ email = '' } = {}) {
  return async function translate(texts, language) {
    if (!texts.length) return [];
    const masked = texts.map((t) => protectSymbols(t));
    const input = masked.map((m) => m.masked.replace(/\n/g, ' '));
    let out;
    try {
      out = await google(input, language);
    } catch (err) {
      console.warn(`[machine] ${err.message}; probando MyMemory`);
      out = [];
      for (const t of input) out.push(await myMemory(t, language, email));
    }
    return out.map((t, i) =>
      applyFixes(restoreSymbols(t.replace(/[​-‍﻿]/g, '').trim(), masked[i].symbols), language.code),
    );
  };
}
