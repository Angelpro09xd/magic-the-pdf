import crypto from 'node:crypto';
import { getLanguage } from '../../public/js/languages.js';
import { fetchJson } from './http.js';

const BATCH_SIZE = 12;

// Cartas cuya traducción oficial sirve como "plantilla" de redacción para la IA.
const REFERENCE_CARDS = [
  'Llanowar Elves',
  'Counterspell',
  'Swords to Plowshares',
  'Cultivate',
  'Eternal Witness',
  'Beast Within',
  'Arcane Signet',
  'Swiftfoot Boots',
  'Smothering Tithe',
  'Cyclonic Rift',
  'Sun Titan',
];

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
        },
        required: ['key', 'name', 'type_line', 'oracle_text'],
        additionalProperties: false,
      },
    },
  },
  required: ['cards'],
  additionalProperties: false,
};

const hash = (s) => crypto.createHash('sha1').update(s || '').digest('hex').slice(0, 10);

export function cacheKey(lang, card) {
  return `${lang}|${card.key}|${hash(`${card.name}\n${card.type_line}\n${card.oracle_text}`)}`;
}

/** Sustituye los símbolos {X} por marcadores que la traducción automática no toque. */
export function protectSymbols(text) {
  const symbols = [];
  const masked = (text || '').replace(/\{[^}]+\}/g, (m) => {
    symbols.push(m);
    return `⟨${symbols.length - 1}⟩`;
  });
  return { masked, symbols };
}

export function restoreSymbols(text, symbols) {
  return (text || '').replace(/⟨\s*(\d+)\s*⟩/g, (m, i) => symbols[Number(i)] ?? m);
}

function buildSystemPrompt(language, references) {
  const refs = references.length
    ? references
        .map(
          (r) =>
            `ENGLISH:\n${r.name}\n${r.type_line}\n${r.oracle_text}\n${language.english.toUpperCase()} (official):\n${r.printed_name}\n${r.printed_type_line}\n${r.printed_text}`,
        )
        .join('\n\n')
    : '(no official reference cards available)';

  return `You translate Magic: The Gathering cards from English into ${language.english} so players can print proxies for casual Commander games.

Write the way Wizards of the Coast's official ${language.english} printings are written: use the official ${language.english} names for keywords, ability words, card types, subtypes, zones, counters and game terms, and follow the official templating. The reference cards below are real official translations; match their wording and style.

Rules:
- Keep every mana or game symbol exactly as written, braces included: {T}, {Q}, {W}, {U}, {B}, {R}, {G}, {C}, {X}, {2}, {W/U}, {E}, and so on.
- Keep line breaks: the translated oracle_text has the same paragraphs as the English one.
- Keep reminder text inside parentheses and translate it.
- When a card's official ${language.english} name is supplied, use it exactly, including wherever the card refers to itself.
- Translate the card name too when no official name is supplied, the way a ${language.english} printing would.
- Return one entry per input card, with the same key.

Official reference translations:

${refs}`;
}

function buildUserPrompt(cards, officialNames) {
  const payload = cards.map((c) => ({
    key: c.key,
    name: c.name,
    official_translated_name: officialNames.get(c.key) || null,
    mana_cost: c.mana_cost || '',
    type_line: c.type_line || '',
    oracle_text: c.oracle_text || '',
  }));
  return `Translate these cards:\n${JSON.stringify(payload, null, 2)}`;
}

export function createTranslator({ anthropic = null, model, effort = 'low', cache, scryfall, mymemoryEmail = '' }) {
  const referenceCache = new Map();

  async function getReferences(language) {
    if (referenceCache.has(language.code)) return referenceCache.get(language.code);
    let refs = [];
    try {
      const names = REFERENCE_CARDS.map((n) => `!"${n}"`).join(' or ');
      const q = encodeURIComponent(`lang:${language.code} (${names})`);
      const data = await scryfall(() =>
        fetchJson(`https://api.scryfall.com/cards/search?q=${q}&unique=prints&order=released&dir=desc`),
      );
      const seen = new Set();
      for (const c of data.data || []) {
        if (seen.has(c.oracle_id) || !c.printed_text || !c.oracle_text) continue;
        seen.add(c.oracle_id);
        refs.push({
          name: c.name,
          type_line: c.type_line,
          oracle_text: c.oracle_text,
          printed_name: c.printed_name || c.name,
          printed_type_line: c.printed_type_line || c.type_line,
          printed_text: c.printed_text,
        });
      }
    } catch (err) {
      console.warn(`[translate] Sin cartas de referencia para ${language.code}: ${err.message}`);
    }
    refs = refs.slice(0, 8);
    referenceCache.set(language.code, refs);
    return refs;
  }

  /** Busca traducciones oficiales en api.magicthegathering.io (sobre todo cartas antiguas). */
  async function lookupMtgio(card, language) {
    const key = `mtgio|${language.code}|${card.name}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let found = null;
    try {
      const baseName = card.name.split(' // ')[0];
      const data = await fetchJson(
        `https://api.magicthegathering.io/v1/cards?name=${encodeURIComponent(`"${baseName}"`)}&pageSize=100`,
        { timeoutMs: 8000 },
      );
      for (const c of data.cards || []) {
        if (c.name !== card.name && c.name !== baseName) continue;
        const f = (c.foreignNames || []).find((fn) => fn.language === language.mtgio);
        if (f?.name) {
          found = { name: f.name, type_line: f.type || null, oracle_text: f.text || null };
          if (f.text) break;
        }
      }
    } catch {
      return null; // Error de red: no lo cacheamos para reintentar más tarde.
    }
    cache.set(key, found);
    return found;
  }

  async function translateWithClaude(cards, language, officialNames) {
    const references = await getReferences(language);
    const response = await anthropic.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      system: buildSystemPrompt(language, references),
      messages: [{ role: 'user', content: buildUserPrompt(cards, officialNames) }],
    });
    if (response.stop_reason === 'refusal') {
      throw new Error(`La IA rechazó la traducción (${response.stop_details?.category ?? 'sin categoría'})`);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new Error('La respuesta de la IA se cortó (max_tokens)');
    }
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const parsed = JSON.parse(text);
    return new Map(parsed.cards.map((c) => [c.key, c]));
  }

  async function machineTranslate(text, language) {
    if (!text) return '';
    const { masked, symbols } = protectSymbols(text);
    const lines = masked.split('\n');
    const out = [];
    for (const line of lines) {
      if (!line.trim()) {
        out.push(line);
        continue;
      }
      const params = new URLSearchParams({ q: line.slice(0, 480), langpair: `en|${language.mt}` });
      if (mymemoryEmail) params.set('de', mymemoryEmail);
      const data = await fetchJson(`https://api.mymemory.translated.net/get?${params}`, { timeoutMs: 10000 });
      const translated = data?.responseData?.translatedText;
      if (data.responseStatus !== 200 || !translated || /MYMEMORY WARNING/i.test(translated)) {
        throw new Error(`MyMemory: ${data?.responseDetails || 'límite alcanzado'}`);
      }
      out.push(translated);
    }
    return restoreSymbols(out.join('\n'), symbols);
  }

  async function translateWithMachine(card, language, official) {
    return {
      key: card.key,
      name: official?.name || (await machineTranslate(card.name, language)),
      type_line: official?.type_line || (await machineTranslate(card.type_line, language)),
      oracle_text: await machineTranslate(card.oracle_text, language),
    };
  }

  /**
   * Traduce una lista de caras de carta.
   * Orden de preferencia: caché → IA (Claude) → texto oficial de MTG.io → traducción automática.
   */
  async function translate(langCode, cards) {
    const language = getLanguage(langCode);
    if (!language) throw new Error(`Idioma no soportado: ${langCode}`);
    if (langCode === 'en') {
      return cards.map((c) => ({ ...pick(c), source: 'original' }));
    }

    const results = new Map();
    const pending = [];
    for (const card of cards) {
      const hit = cache.get(cacheKey(langCode, card));
      if (hit) results.set(card.key, { ...hit, key: card.key, cached: true });
      else pending.push(card);
    }

    // Nombres oficiales (con concurrencia limitada).
    const official = new Map();
    for (let i = 0; i < pending.length; i += 4) {
      await Promise.all(
        pending.slice(i, i + 4).map(async (c) => {
          const o = await lookupMtgio(c, language);
          if (o) official.set(c.key, o);
        }),
      );
    }
    const officialNames = new Map([...official].map(([k, v]) => [k, v.name]));

    let aiError = null;
    if (anthropic && pending.length) {
      for (let i = 0; i < pending.length; i += BATCH_SIZE) {
        const batch = pending.slice(i, i + BATCH_SIZE);
        try {
          const out = await translateWithClaude(batch, language, officialNames);
          for (const card of batch) {
            const t = out.get(card.key);
            if (!t) continue;
            const value = { ...pick(t), key: card.key, source: 'ai' };
            results.set(card.key, value);
            cache.set(cacheKey(langCode, card), value);
          }
        } catch (err) {
          aiError = err;
          console.warn(`[translate] Fallo de la IA: ${err.message}`);
        }
      }
    }

    let mtError = null;
    for (const card of pending) {
      if (results.has(card.key)) continue;
      const o = official.get(card.key);
      if (o?.oracle_text) {
        const value = {
          key: card.key,
          name: o.name,
          type_line: o.type_line || card.type_line,
          oracle_text: o.oracle_text,
          source: 'official',
        };
        results.set(card.key, value);
        cache.set(cacheKey(langCode, card), value);
        continue;
      }
      if (mtError) continue; // Si MyMemory ya falló (cuota), no insistimos.
      try {
        const value = { ...(await translateWithMachine(card, language, o)), source: 'machine' };
        results.set(card.key, value);
        cache.set(cacheKey(langCode, card), value);
      } catch (err) {
        mtError = err;
        console.warn(`[translate] Fallo de traducción automática: ${err.message}`);
      }
    }

    return cards.map(
      (c) =>
        results.get(c.key) || {
          ...pick(c),
          source: 'untranslated',
          error: (aiError || mtError)?.message || 'Sin traducción disponible',
        },
    );
  }

  return { translate, hasAI: Boolean(anthropic) };
}

function pick(c) {
  return { key: c.key, name: c.name || '', type_line: c.type_line || '', oracle_text: c.oracle_text || '' };
}
