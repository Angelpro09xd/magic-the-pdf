/**
 * Resuelve cómo se imprime cada carta en el idioma elegido:
 *  1. Impresión oficial en ese idioma (Scryfall).
 *  2. Si no existe: traducción (IA / oficial MTG.io / automática) sobre la carta inglesa.
 */
import { findOverlayBases, findPrintsInLanguage, overlayFriendly } from './scryfall.js';
import { printableFaces, textFaces } from './deck.js';
import { isPrinted } from './languages.js';
import { renderCustom, renderOfficial, renderOverlay } from './render.js';
import { analyzeCard, renderOriginalStyle } from './original.js';

export const targetLang = (entry, deck) => entry.lang || deck.lang || 'en';

/**
 * Estado de idioma de una entrada:
 * custom | official | memory | auto | machine | ai | manual | missing | pending | original.
 */
export function langStatus(entry, deck) {
  const lang = targetLang(entry, deck);
  if (entry.custom || entry.card?.custom) return 'custom';
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
  if (entry.custom) return entry.custom.faces.map((f) => f.name).join(' // ');
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
    if (toSearch.length && !isPrinted(lang)) {
      // Magic no se imprime en este idioma: no hay nada que buscar, todo se traduce.
      for (const e of toSearch) e.searched = [...new Set([...(e.searched || []), lang])];
    } else if (toSearch.length) {
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
    const needBase = missing.filter((e) => e.card.lang !== 'en' && !e.overlayBase);
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
          // El texto de ambientación solo está en inglés en las impresiones inglesas.
          flavor_text: e.card.lang === 'en' ? f.flavor_text || '' : '',
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
        faces: tf.map((r) => ({ name: r.name, type_line: r.type_line, oracle_text: r.oracle_text, flavor_text: r.flavor_text || '' })),
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
  if (entry.custom) return renderCustomEntry(entry, quality);
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
  const base = overlayBaseFor(entry);
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
      if (mode === 'overlay' && baseFaces?.[i]) return renderOriginalFace(base, i, t, quality, { ocr: settings.ocr });
      const art = imageFaces[i]?.image?.art_crop || card.image?.art_crop;
      return renderCustom(art, ef, t, card, { showFlavor: false });
    }),
  );
}

/** Datos (en inglés) de la cara i de una impresión, con su tipo de marco, para el análisis. */
export function originalFace(card, i = 0) {
  const f = textFaces(card)[i] || card;
  return { ...f, frame: card.frame, layout: card.layout, mana_cost: f.mana_cost ?? card.mana_cost };
}

/** Imagen de la cara i de una impresión. */
export function faceImage(card, i = 0, quality = 'png') {
  const f = printableFaces(card)[i];
  return f ? imageOf(f, quality) : null;
}

/**
 * Dibuja la cara i de `base` "como la original" con los textos t (análisis con OCR y borrado
 * del texto original). Si algo falla, recurre al método simple de superponer cajas.
 */
export async function renderOriginalFace(base, i, t, quality = 'png', opts = {}) {
  const url = faceImage(base, i, quality);
  const face = originalFace(base, i);
  try {
    const analysis = await analyzeCard(url, face, { useOcr: opts.ocr !== false });
    return await renderOriginalStyle(url, face, t, analysis, opts);
  } catch (err) {
    console.warn('Render "como la original" falló, uso el simple:', err);
    return renderOverlay(url, face, t);
  }
}

/** Impresión sobre la que se reescribe el texto: la propia carta si está en inglés (cualquier marco). */
export function overlayBaseFor(entry) {
  const card = entry.card;
  if (card.custom) return null;
  if (card.lang === 'en') return card;
  return entry.overlayBase || card;
}

/**
 * Carta editada en el editor (entry.custom):
 * { style: 'overlay' (como la original) | 'custom' (marco propio), frame, fontScale, titleScale,
 *   layouts: [{ name, type, text }] (zonas movidas a mano), colors: [{ name, type, text }],
 *   faces: [{ name, mana_cost, type_line, oracle_text, flavor_text, power, toughness, loyalty,
 *   defense, artist, art: { url, zoom, x, y } }] }
 */
export async function renderCustomEntry(entry, quality = 'png') {
  const custom = entry.custom;
  const card = entry.card;
  const base = custom.style === 'overlay' ? custom.basePrint || overlayBaseFor(entry) : null;
  const baseFaces = base ? printableFaces(base) : null;
  const imageFaces = printableFaces(card);
  // Una sola imagen física aunque haya varias caras de texto (split, aventura): se fusionan.
  const faces =
    custom.faces.length > 1 && imageFaces.length === 1 && !card.custom
      ? [
          {
            ...custom.faces[0],
            name: custom.faces.map((f) => f.name).join(' // '),
            type_line: custom.faces.map((f) => f.type_line).join(' // '),
            oracle_text: custom.faces.map((f) => `${f.name}: ${f.oracle_text}`).join('\n'),
            flavor_text: '',
          },
        ]
      : custom.faces;
  return Promise.all(
    faces.map((f, i) => {
      if (base && baseFaces?.[i]) {
        return renderOriginalFace(base, i, f, quality, {
          layout: custom.layouts?.[i],
          colors: custom.colors?.[i],
          titleScale: custom.titleScale,
          fontScale: custom.fontScale,
        });
      }
      const art = f.art?.url || imageFaces[i]?.image?.art_crop || card.image?.art_crop || null;
      return renderCustom(art, f, f, card, {
        art: f.art,
        frame: custom.frame,
        fontScale: custom.fontScale,
        artist: f.artist,
      });
    }),
  );
}

/** Para cartas con varios artes (p. ej. tierras básicas): la entrada a usar en la copia n. */
export function variantFor(entry, n) {
  const list = entry.variants;
  if (!list?.length) return entry;
  const card = list[n % list.length];
  return { uid: `${entry.uid}-v${card.id}`, qty: 1, card, lang: entry.lang };
}
