import crypto from 'node:crypto';
import { getLanguage } from '../../public/js/languages.js';
import { fetchJson } from './http.js';
import { mask, unmask } from './memory.js';

export { protectSymbols, restoreSymbols } from './symbols.js';

const ENGINE_VERSION = 'v2';
const CLAUDE_BATCH = 12;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          name: { type: 'string' },
          type_line: { type: 'string' },
          oracle_text: { type: 'string' },
          flavor_text: { type: 'string' },
        },
        required: ['key', 'name', 'type_line', 'oracle_text', 'flavor_text'],
        additionalProperties: false,
      },
    },
  },
  required: ['cards'],
  additionalProperties: false,
};

const hash = (s) => crypto.createHash('sha1').update(s || '').digest('hex').slice(0, 10);

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

function pick(c) {
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
 * Si hay ANTHROPIC_API_KEY, Claude traduce primero y el motor propio queda de respaldo.
 */
export function createTranslator({ anthropic = null, model, effort = 'low', cache, memories, machine }) {
  /** Nombre oficial en api.magicthegathering.io (sobre todo cartas antiguas). */
  async function officialName(card, language) {
    const key = `mtgio|${language.code}|${card.name}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let found = null;
    try {
      const baseName = card.name.split(' // ')[0];
      const data = await fetchJson(
        `https://api.magicthegathering.io/v1/cards?name=${encodeURIComponent(`"${baseName}"`)}&pageSize=100`,
        { timeoutMs: 6000 },
      );
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

  async function translateWithClaude(cards, language) {
    const response = await anthropic.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      system: `You translate Magic: The Gathering cards from English into ${language.english} for casual proxy printing. Use the official ${language.english} Magic terminology and templating used by Wizards of the Coast. Keep every symbol in braces exactly as written ({T}, {G}, {2}…) and keep the line breaks. Translate reminder text and flavor text too. Return one entry per input card with the same key.`,
      messages: [{ role: 'user', content: `Translate these cards:\n${JSON.stringify(cards.map(pick), null, 2)}` }],
    });
    if (response.stop_reason === 'refusal') throw new Error('La IA rechazó la traducción');
    if (response.stop_reason === 'max_tokens') throw new Error('La respuesta de la IA se cortó');
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return new Map(JSON.parse(text).cards.map((c) => [c.key, c]));
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

    if (anthropic) {
      for (let i = 0; i < pending.length; i += CLAUDE_BATCH) {
        const batch = pending.slice(i, i + CLAUDE_BATCH);
        try {
          const out = await translateWithClaude(batch, language);
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

  return { translate, hasAI: Boolean(anthropic) };
}
