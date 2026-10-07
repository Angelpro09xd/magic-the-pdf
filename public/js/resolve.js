/**
 * Resuelve cómo se imprime cada carta en el idioma elegido:
 *  1. Impresión oficial en ese idioma (Scryfall).
 *  2. Si no existe: traducción (IA / oficial MTG.io / automática) sobre la carta inglesa.
 */
import { findOverlayBases, findPrintsInLanguage, overlayFriendly } from './scryfall.js';
import { printableFaces, textFaces } from './deck.js';
import { renderCustom, renderOfficial, renderOverlay } from './render.js';

export const targetLang = (entry, deck) => entry.lang || deck.lang || 'en';

/** Estado de idioma de una entrada: official | ai | official-text | machine | manual | missing | pending. */
export function langStatus(entry, deck) {
  const lang = targetLang(entry, deck);
  if (entry.renderMode === 'original') return 'original';
  if (entry.card?.lang === lang) return 'official';
  if (entry.localized?.lang === lang) return 'official';
  if (entry.translation?.lang === lang) {
    const s = entry.translation.source;
    return s === 'official' ? 'official-text' : s;
  }
  if (entry.searched?.includes(lang)) return lang === 'en' ? 'original' : 'missing';
  return 'pending';
}

/** Carta oficial que se imprimirá (o null si hay que traducir). */
export function officialPrint(entry, deck) {
  const lang = targetLang(entry, deck);
  if (entry.card?.lang === lang) return entry.card;
  if (entry.localized?.lang === lang) return entry.localized;
  return null;
}

/** Nombre mostrado en el idioma del mazo. */
export function displayName(entry, deck) {
  const off = officialPrint(entry, deck);
  if (off) return off.printed_name || off.faces?.map((f) => f.printed_name || f.name).join(' // ') || off.name;
  const lang = targetLang(entry, deck);
  if (entry.translation?.lang === lang) return entry.translation.faces.map((f) => f.name).join(' // ');
  return entry.card?.name || entry.name;
}

export function faceKey(card, i) {
  return `${card.oracle_id || card.id}:${i}`;
}

/**
 * Prepara las entradas: busca impresiones oficiales y traduce lo que falte.
 * translateFn(lang, faces) → [{ key, name, type_line, oracle_text, source }]
 */
export async function prepareEntries(entries, deck, { translateFn, onProgress = () => {}, translate = true } = {}) {
  const byLang = new Map();
  for (const e of entries) {
    if (!e.card) continue;
    const st = langStatus(e, deck);
    if (st !== 'pending' && !(st === 'missing' && translate)) continue;
    const lang = targetLang(e, deck);
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang).push(e);
  }

  for (const [lang, list] of byLang) {
    // 1) Impresiones oficiales
    const toSearch = list.filter((e) => langStatus(e, deck) === 'pending');
    if (toSearch.length) {
      onProgress({ phase: 'search', lang, done: 0, total: toSearch.length });
      const found = await findPrintsInLanguage(toSearch.map((e) => e.card), lang, (d, t) =>
        onProgress({ phase: 'search', lang, done: d, total: t }),
      );
      for (const e of toSearch) {
        const p = found.get(e.card.oracle_id);
        if (p) e.localized = p;
        else e.searched = [...new Set([...(e.searched || []), lang])];
      }
    }

    if (!translate || lang === 'en') continue;
    const missing = list.filter((e) => langStatus(e, deck) === 'missing');
    if (!missing.length) continue;

    // 2) Base inglesa con marco moderno para superponer la traducción
    const needBase = missing.filter((e) => !overlayFriendly(e.card) && !e.overlayBase);
    if (needBase.length) {
      onProgress({ phase: 'bases', lang, done: 0, total: needBase.length });
      try {
        const bases = await findOverlayBases(needBase.map((e) => e.card));
        for (const e of needBase) {
          const b = bases.get(e.card.oracle_id);
          if (b) e.overlayBase = b;
        }
      } catch {
        // Si falla, se usará el marco propio.
      }
    }

    // 3) Traducción por lotes
    const faces = [];
    for (const e of missing) {
      textFaces(e.card).forEach((f, i) =>
        faces.push({
          key: faceKey(e.card, i),
          name: f.name,
          mana_cost: f.mana_cost,
          type_line: f.type_line,
          oracle_text: f.oracle_text,
        }),
      );
    }
    const results = new Map();
    for (let i = 0; i < faces.length; i += 40) {
      onProgress({ phase: 'translate', lang, done: i, total: faces.length });
      const out = await translateFn(lang, faces.slice(i, i + 40));
      for (const r of out) results.set(r.key, r);
    }
    onProgress({ phase: 'translate', lang, done: faces.length, total: faces.length });
    for (const e of missing) {
      const tf = textFaces(e.card).map((f, i) => results.get(faceKey(e.card, i)));
      if (tf.some((r) => !r || r.source === 'untranslated')) {
        e.translationError = tf.find((r) => r?.error)?.error || 'Sin traducción';
        continue;
      }
      const order = ['manual', 'official', 'ai', 'machine'];
      const source = tf.map((r) => r.source).sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
      e.translation = {
        lang,
        source,
        faces: tf.map((r) => ({ name: r.name, type_line: r.type_line, oracle_text: r.oracle_text })),
      };
      delete e.translationError;
    }
  }
}

function imageOf(face, quality) {
  return face.image?.[quality] || face.image?.png || face.image?.large || face.image?.normal;
}

/**
 * Devuelve los lienzos (uno por cara imprimible) de una entrada.
 * settings: { quality: 'png'|'large', translatedMode: 'overlay'|'custom' }
 */
export async function renderEntry(entry, deck, settings = {}) {
  const quality = settings.quality || 'png';
  const off = officialPrint(entry, deck);
  const lang = targetLang(entry, deck);
  const translated = !off && entry.translation?.lang === lang && entry.renderMode !== 'original';

  if (!translated) {
    const card = off || entry.card;
    return Promise.all(printableFaces(card).map((f) => renderOfficial(imageOf(f, quality))));
  }

  const card = entry.card;
  const tFaces = entry.translation.faces;
  const englishFaces = textFaces(card);
  const mode = entry.renderMode && entry.renderMode !== 'auto' ? entry.renderMode : settings.translatedMode || 'overlay';
  const base = overlayFriendly(card) && card.lang === 'en' ? card : entry.overlayBase;
  const imageFaces = printableFaces(card);

  // Cartas con varias caras de texto pero una sola imagen (split, aventura...): una única carta propia.
  if (englishFaces.length > 1 && imageFaces.length === 1) {
    const merged = {
      name: tFaces.map((f) => f.name).join(' // '),
      type_line: tFaces.map((f) => f.type_line).join(' // '),
      oracle_text: tFaces.map((f) => `${f.name}: ${f.oracle_text}`).join('\n'),
    };
    return [await renderCustom(card.image?.art_crop, { ...card, mana_cost: englishFaces[0].mana_cost }, merged, card)];
  }

  const baseFaces = base ? printableFaces(base) : null;
  return Promise.all(
    englishFaces.map((ef, i) => {
      const t = tFaces[i] || tFaces[0];
      if (mode === 'overlay' && baseFaces?.[i]) return renderOverlay(imageOf(baseFaces[i], quality), ef, t);
      const art = imageFaces[i]?.image?.art_crop || card.image?.art_crop;
      return renderCustom(art, ef, t, card);
    }),
  );
}
