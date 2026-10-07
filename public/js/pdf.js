/**
 * Generación del PDF de proxies con jsPDF (cargado como UMD en window.jspdf).
 */
import { isBasicLand, mainType } from './deck.js';
import { displayName, renderEntry } from './resolve.js';
import { renderBack, stampProxy } from './render.js';

export const PAPERS = {
  a4: { w: 210, h: 297, label: 'A4' },
  letter: { w: 215.9, h: 279.4, label: 'Carta / Letter' },
  a3: { w: 297, h: 420, label: 'A3' },
};

export const DEFAULT_PDF_SETTINGS = {
  paper: 'a4',
  scale: 100,
  gap: 0,
  bleed: 0,
  cutMarks: true,
  includeCommanders: true,
  skipBasics: false,
  includeTokens: false,
  backs: false,
  backImage: null,
  dfcDuplex: false,
  deckList: true,
  watermark: false,
  quality: 'png',
  translatedMode: 'overlay',
  jpegQuality: 0.9,
};

const CARD_MM = { w: 63, h: 88 };

/**
 * Construye el PDF. entries: [{ entry, qty }] (incluye fichas si procede).
 * onProgress({ done, total, label }).
 */
export async function buildPdf(deck, entries, settings, { onProgress = () => {}, signal, strings = {} } = {}) {
  const { jsPDF } = window.jspdf;
  const s = { ...DEFAULT_PDF_SETTINGS, ...settings };
  const paper = PAPERS[s.paper] || PAPERS.a4;
  const doc = new jsPDF({ unit: 'mm', format: [paper.w, paper.h], compress: true });
  doc.setProperties({ title: deck.name, creator: 'Magic the PDF' });

  const cw = (CARD_MM.w * s.scale) / 100;
  const ch = (CARD_MM.h * s.scale) / 100;
  const gap = Number(s.gap) || 0;
  const bleed = Number(s.bleed) || 0;
  const minMargin = 5;
  const cols = Math.max(1, Math.floor((paper.w - 2 * minMargin + gap) / (cw + gap + 2 * bleed)));
  const rows = Math.max(1, Math.floor((paper.h - 2 * minMargin + gap) / (ch + gap + 2 * bleed)));
  const perPage = cols * rows;
  const gridW = cols * cw + (cols - 1) * (gap + 2 * bleed);
  const gridH = rows * ch + (rows - 1) * (gap + 2 * bleed);
  const left = (paper.w - gridW) / 2;
  const top = (paper.h - gridH) / 2;

  // Render (una vez por carta distinta) → JPEG
  const toJpeg = (canvas) => canvas.toDataURL('image/jpeg', s.jpegQuality);
  const slots = [];
  const total = entries.length;
  let done = 0;
  const backCanvas = s.backs ? await renderBack({ image: s.backImage, title: deck.commanders[0]?.card?.name?.split(',')[0] || 'Commander' }) : null;
  const backData = backCanvas ? toJpeg(backCanvas) : null;

  for (const { entry, qty } of entries) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    onProgress({ done, total, label: displayName(entry, deck) });
    let canvases;
    try {
      canvases = await renderEntry(entry, deck, s);
    } catch (err) {
      console.warn('No se pudo renderizar', entry.card?.name, err);
      canvases = [];
    }
    if (s.watermark) canvases.forEach((c) => stampProxy(c));
    const images = canvases.map((c, i) => ({ data: toJpeg(c), alias: `${entry.uid}-${i}` }));
    for (let n = 0; n < qty; n++) {
      if (!images.length) continue;
      if (s.dfcDuplex && images.length > 1) {
        slots.push({ front: images[0], back: images[1] });
      } else {
        for (const img of images) slots.push({ front: img, back: null });
      }
    }
    done++;
  }
  onProgress({ done: total, total, label: strings.composing || '…' });

  if (s.deckList) {
    const listCanvas = renderDeckList(deck, entries, paper, strings);
    doc.addImage(listCanvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, paper.w, paper.h);
  }

  const needBackPages = s.backs || (s.dfcDuplex && slots.some((sl) => sl.back));
  const pos = (i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      x: left + col * (cw + gap + 2 * bleed),
      y: top + row * (ch + gap + 2 * bleed),
      col,
      row,
    };
  };

  for (let p = 0; p < slots.length; p += perPage) {
    const pageSlots = slots.slice(p, p + perPage);
    if (s.deckList || p > 0) doc.addPage([paper.w, paper.h]);
    pageSlots.forEach((slot, i) => {
      const { x, y } = pos(i);
      if (bleed > 0) {
        doc.setFillColor(17, 17, 17);
        doc.rect(x - bleed, y - bleed, cw + 2 * bleed, ch + 2 * bleed, 'F');
      }
      doc.addImage(slot.front.data, 'JPEG', x, y, cw, ch, slot.front.alias, 'FAST');
    });
    if (s.cutMarks) drawCutMarks(doc, pageSlots.length, { cols, rows, cw, ch, gap, bleed, left, top, paper });

    if (needBackPages) {
      doc.addPage([paper.w, paper.h]);
      pageSlots.forEach((slot, i) => {
        const { row, col } = pos(i);
        const mirrored = pos(row * cols + (cols - 1 - col));
        const img = slot.back || (backData ? { data: backData, alias: 'generic-back' } : null);
        if (!img) return;
        if (bleed > 0) {
          doc.setFillColor(17, 17, 17);
          doc.rect(mirrored.x - bleed, mirrored.y - bleed, cw + 2 * bleed, ch + 2 * bleed, 'F');
        }
        doc.addImage(img.data, 'JPEG', mirrored.x, mirrored.y, cw, ch, img.alias, 'FAST');
      });
    }
  }
  return doc.output('blob');
}

function drawCutMarks(doc, count, { cols, rows, cw, ch, gap, bleed, left, top, paper }) {
  const usedRows = Math.ceil(count / cols);
  const usedCols = Math.min(cols, count);
  const xs = [];
  const ys = [];
  for (let c = 0; c < usedCols; c++) {
    const x = left + c * (cw + gap + 2 * bleed);
    xs.push(x, x + cw);
  }
  for (let r = 0; r < Math.min(rows, usedRows); r++) {
    const y = top + r * (ch + gap + 2 * bleed);
    ys.push(y, y + ch);
  }
  const gridBottom = ys[ys.length - 1];
  const gridRight = xs[xs.length - 1];
  doc.setDrawColor(120, 120, 120);
  doc.setLineWidth(0.15);
  const len = 4;
  for (const x of xs) {
    doc.line(x, Math.max(0, top - bleed - len - 1), x, top - bleed - 1);
    doc.line(x, gridBottom + bleed + 1, x, Math.min(paper.h, gridBottom + bleed + len + 1));
  }
  for (const y of ys) {
    doc.line(Math.max(0, left - bleed - len - 1), y, left - bleed - 1, y);
    doc.line(gridRight + bleed + 1, y, Math.min(paper.w, gridRight + bleed + len + 1), y);
  }
}

/** Página con la lista del mazo, dibujada en canvas para soportar cualquier alfabeto. */
function renderDeckList(deck, entries, paper, strings) {
  const dpmm = 6;
  const W = Math.round(paper.w * dpmm);
  const H = Math.round(paper.h * dpmm);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  const m = 14 * dpmm;
  ctx.fillStyle = '#111';
  ctx.textBaseline = 'top';
  ctx.font = `700 ${9 * dpmm}px "Alegreya Sans SC", sans-serif`;
  ctx.fillText(deck.name, m, m);
  ctx.font = `400 ${4 * dpmm}px "Crimson Pro", serif`;
  const cmdNames = deck.commanders.map((e) => displayName(e, deck)).join(' + ');
  const total = entries.filter((x) => !x.token).reduce((n, x) => n + x.qty, 0);
  ctx.fillText(`${strings.commander || 'Commander'}: ${cmdNames || '—'}   ·   ${total} ${strings.cards || 'cards'}`, m, m + 11 * dpmm);

  const groups = new Map();
  for (const { entry, qty, token } of entries) {
    const key = token ? 'Token' : deck.commanders.includes(entry) ? 'Commander' : mainType(entry.card);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ name: displayName(entry, deck), qty, en: entry.card?.name });
  }
  const order = ['Commander', 'Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Other', 'Token'];
  const colW = (W - 2 * m) / 3;
  const lineH = 4.1 * dpmm;
  let col = 0;
  let y = m + 20 * dpmm;
  const startY = y;
  const fit = (text, maxW) => {
    let t = text;
    while (ctx.measureText(t).width > maxW && t.length > 3) t = `${t.slice(0, -2)}…`;
    return t;
  };
  for (const key of order) {
    const list = groups.get(key);
    if (!list) continue;
    list.sort((a, b) => a.name.localeCompare(b.name));
    const needed = (list.length + 2) * lineH;
    if (y + Math.min(needed, 4 * lineH) > H - m) {
      col++;
      y = startY;
    }
    if (col > 2) break;
    const x = m + col * colW;
    ctx.font = `700 ${4.4 * dpmm}px "Alegreya Sans SC", sans-serif`;
    const count = list.reduce((n, i) => n + i.qty, 0);
    ctx.fillText(`${strings.types?.[key] || key} (${count})`, x, y);
    y += lineH * 1.3;
    ctx.font = `400 ${3.6 * dpmm}px "Crimson Pro", serif`;
    for (const item of list) {
      if (y > H - m) {
        col++;
        y = startY;
        if (col > 2) break;
      }
      const label = item.name !== item.en ? `${item.name} (${item.en})` : item.name;
      ctx.strokeStyle = '#999';
      ctx.strokeRect(m + col * colW, y + 0.5 * dpmm, 2.6 * dpmm, 2.6 * dpmm);
      ctx.fillText(fit(`${item.qty}  ${label}`, colW - 6 * dpmm), m + col * colW + 4 * dpmm, y);
      y += lineH;
    }
    y += lineH * 0.6;
  }
  ctx.font = `400 ${3 * dpmm}px "Crimson Pro", serif`;
  ctx.fillStyle = '#777';
  ctx.fillText('Magic the PDF — proxies for casual play, not for sale. Card data © Scryfall / Wizards of the Coast.', m, H - m + 4 * dpmm);
  return c;
}

/** Lista de { entry, qty, token? } a imprimir según los ajustes. */
export function entriesToPrint(deck, settings, tokenEntries = []) {
  const s = { ...DEFAULT_PDF_SETTINGS, ...settings };
  const out = [];
  if (s.includeCommanders) for (const e of deck.commanders) out.push({ entry: e, qty: e.qty });
  for (const e of deck.cards) {
    if (s.skipBasics && isBasicLand(e.card)) continue;
    if (e.skipPrint) continue;
    out.push({ entry: e, qty: e.qty });
  }
  if (s.includeTokens) for (const t of tokenEntries) out.push({ entry: t, qty: 1, token: true });
  return out;
}
