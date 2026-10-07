/**
 * Motor de traducción de cartas, común al servidor (Node) y al navegador (GitHub Pages).
 * No depende de nada de Node: solo fetch.
 */
import { getLanguage } from '../languages.js';
import { mask, unmask } from './memory.js';

export { protectSymbols, restoreSymbols } from './symbols.js';

const ENGINE_VERSION = 'v2';
const CLAUDE_BATCH = 12;

/** Hash FNV-1a de 32 bits (suficiente para claves de caché). */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function cacheKey(lang, card) {
  return `${ENGINE_VERSION}|${lang}|${card.key}|${hash(`${card.name}\n${card.type_line}\n${card.oracle_text}\n${card.flavor_text || ''}`)}`;
}

function fixSubtypeCase(typeLine, lang) {
  if (!['es', 'pt'].includes(lang)) return typeLine;
  const [main, sub] = typeLine.split(' — ');
  if (!sub) return typeLine;
  const words = sub.split(' ');
  return `${main} — ${words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase())).join(' ')}`;
}

export function pick(c) {
  return {
    key: c.key,
    name: c.name || '',
    type_line: c.type_line || '',
    oracle_text: c.oracle_text || '',
    flavor_text: c.flavor_text || '',
  };
}

/**
 * Traductor de cartas. Sin configuración usa el motor propio:
 *   1. Memoria de traducción aprendida de cartas oficiales (plantillas de Wizards).
 *   2. Nombre oficial de MTG.io si existe.
 *   3. Traducción automática gratuita (Google / MyMemory) para lo que falte.
 * Opcionalmente, `claude(cards, language)` traduce primero (solo en el servidor, con clave).
 * cache: { get(key), set(key, value) } síncrono.
 */
export function createTranslator({ cache, memories, machine, claude = null, claudeBatch = CLAUDE_BATCH }) {
  /** Nombre oficial en api.magicthegathering.io (sobre todo cartas antiguas). */
  async function officialName(card, language) {
    const key = `mtgio|${language.code}|${card.name}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let found = null;
    try {
      const baseName = card.name.split(' // ')[0];
      const res = await fetch(
        `https://api.magicthegathering.io/v1/cards?name=${encodeURIComponent(`"${baseName}"`)}&pageSize=100`,
        { signal: AbortSignal.timeout(6000) },
      );
      if (!res.ok) return null;
      const data = await res.json();
      for (const c of data.cards || []) {
        if (c.name !== card.name && c.name !== baseName) continue;
        const f = (c.foreignNames || []).find((fn) => fn.language === language.mtgio);
        if (f?.name) {
          found = f.name;
          break;
        }
      }
    } catch {
      return null; // Error de red: sin caché, se reintentará.
    }
    cache.set(key, found);
    return found;
  }

  /** Motor propio: memoria + traducción automática gratuita. */
  async function translateFree(card, language, mem) {
    const names = [card.name, card.name.split(',')[0]].filter((n) => n.length > 2);
    const fragments = []; // textos en inglés que irán a la traducción automática
    const ask = (text) => fragments.push(text) - 1;
    const toMachine = (text) => {
      const m = mask(text, names); // el nombre de la carta viaja como "~"
      return `⟪${ask(unmask(m.key, m, '~'))}⟫`;
    };
    let usedMemory = false;

    // Nombre: el oficial de MTG.io si existe
    const official = await officialName(card, language);
    const nameIdx = official ? -1 : ask(card.name);
    const textStart = fragments.length;

    // Línea de tipo
    let typeTpl = '';
    if (card.type_line) {
      if (mem) {
        const r = mem.translateType(card.type_line);
        if (r.pending.length < card.type_line.split(/\s+/).length) usedMemory = true;
        typeTpl = r.text.replace(/⟪(\d+)⟫/g, (m, i) => `⟪${ask(r.pending[Number(i)])}⟫`);
      } else typeTpl = `⟪${ask(card.type_line)}⟫`;
    }

    // Texto de reglas, línea a línea
    const lineTpls = (card.oracle_text || '').split('\n').map((line) => {
      if (!line.trim()) return line;
      if (!mem) return toMachine(line);
      const r = mem.translateLine(line, names, '~');
      if (r.text.replace(/⟪\d+⟫/g, '').trim()) usedMemory = true;
      return r.text.replace(/⟪(\d+)⟫/g, (m, i) => toMachine(r.pending[Number(i)]));
    });
    const textMachine = fragments.length - textStart;

    const flavorIdx = card.flavor_text ? ask(card.flavor_text) : -1;
    const translated = fragments.length ? await machine(fragments, language) : [];
    const fill = (tpl) => tpl.replace(/⟪(\d+)⟫/g, (m, i) => translated[Number(i)] ?? m);
    const name = official || translated[nameIdx] || card.name;
    // Los legendarios se nombran a sí mismos por su nombre corto ("Valgavoth", no "Valgavoth, Harrower of Souls").
    const selfName =
      card.name.includes(',') && !(card.oracle_text || '').includes(card.name) ? name.split(/[,，、]/)[0] : name;
    const oracle = lineTpls
      .map((l) => {
        const out = fill(l).replace(/~/g, selfName);
        return out.charAt(0).toUpperCase() + out.slice(1);
      })
      .join('\n');
    const source = textMachine === 0 ? 'memory' : usedMemory ? 'auto' : 'machine';
    return {
      key: card.key,
      name,
      type_line: fixSubtypeCase(fill(typeTpl), language.code),
      oracle_text: oracle,
      flavor_text: flavorIdx >= 0 ? translated[flavorIdx] : '',
      source,
    };
  }

  async function translate(langCode, cards) {
    const language = getLanguage(langCode);
    if (!language) throw new Error(`Idioma no soportado: ${langCode}`);
    if (langCode === 'en') return cards.map((c) => ({ ...pick(c), source: 'original' }));

    const results = new Map();
    const pending = [];
    for (const card of cards) {
      const hit = cache.get(cacheKey(langCode, card));
      if (hit) results.set(card.key, { ...hit, key: card.key, cached: true });
      else pending.push(card);
    }

    if (claude) {
      for (let i = 0; i < pending.length; i += claudeBatch) {
        const batch = pending.slice(i, i + claudeBatch);
        try {
          const out = await claude(batch.map(pick), language);
          for (const card of batch) {
            const t = out.get(card.key);
            if (!t) continue;
            const value = { ...pick(t), key: card.key, source: 'ai' };
            results.set(card.key, value);
            cache.set(cacheKey(langCode, card), value);
          }
        } catch (err) {
          console.warn(`[translate] Claude falló, uso el traductor propio: ${err.message}`);
        }
      }
    }

    const rest = pending.filter((c) => !results.has(c.key));
    let mem = null;
    if (rest.length) {
      try {
        mem = await memories.get(langCode);
      } catch (err) {
        console.warn(`[translate] Sin memoria de traducción: ${err.message}`);
      }
    }
    let lastError = null;
    for (const card of rest) {
      try {
        const value = await translateFree(card, language, mem);
        results.set(card.key, value);
        cache.set(cacheKey(langCode, card), value);
      } catch (err) {
        lastError = err;
        console.warn(`[translate] ${card.name}: ${err.message}`);
      }
    }

    return cards.map(
      (c) =>
        results.get(c.key) || {
          ...pick(c),
          source: 'untranslated',
          error: lastError?.message || 'Sin traducción disponible',
        },
    );
  }

  return { translate, hasAI: Boolean(claude) };
}
