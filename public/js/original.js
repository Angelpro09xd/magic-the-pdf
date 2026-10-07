/**
 * "Como la original": analiza la imagen real de una carta y reescribe su texto encima
 * conservando el fondo, el marco, el color y el tamaño de la letra.
 *
 *  1. OCR (Tesseract.js, en el navegador) localiza cada palabra impresa.
 *  2. Las palabras se cruzan con el texto oficial (Scryfall) para saber dónde están el nombre,
 *     la línea de tipo y el texto de reglas en ESTA carta (cualquier marco).
 *  3. Se miden el tamaño de letra, el color y la alineación originales.
 *  4. Se borran solo los píxeles de las letras y se reconstruye el fondo con la textura vecina.
 *  5. Se escribe el texto nuevo con esos mismos parámetros.
 */
import { CARD_H, CARD_W, drawRules, ensureFonts, ensureSymbols, fitText, loadImage, newCanvas, titleFont } from './render.js';
import { idbGet, idbSet } from './idb.js';

const ANALYSIS_VERSION = 16;
// Las fuentes libres por defecto tienen las minúsculas algo más bajas que las oficiales:
// se compensa para que el texto ocupe lo mismo (si no cabe, drawRules lo reduce).
const RULES_COMPENSATION = 1.1;
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

// ---------------------------------------------------------------- OCR

let workerPromise = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('No se pudo cargar el OCR'));
    document.head.append(s);
  });
}

async function ocrWorker() {
  workerPromise ??= (async () => {
    if (!window.Tesseract) await loadScript(TESSERACT_URL);
    return window.Tesseract.createWorker('eng');
  })();
  workerPromise.catch(() => {
    workerPromise = null;
  });
  return workerPromise;
}

async function ocrWords(canvas) {
  const worker = await ocrWorker();
  const { data } = await worker.recognize(canvas);
  return (data.words || [])
    .filter((w) => w.confidence > 30 && w.text.trim())
    .map((w) => ({ text: w.text, conf: w.confidence, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 }));
}

// ---------------------------------------------------------------- cruce con el texto oficial

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');

function tokenSet(text) {
  return new Set(
    String(text || '')
      .replace(/\{[^}]+\}/g, ' ')
      .split(/[\s—–-]+/)
      .map(norm)
      .filter((t) => t.length >= 2),
  );
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function matches(token, set) {
  if (token.length < 2) return false;
  if (set.has(token)) return true;
  if (token.length < 5) return false;
  for (const t of set) if (levenshtein(token, t) <= 1) return true;
  return false;
}

const union = (ws) => ({
  x0: Math.min(...ws.map((w) => w.x0)),
  y0: Math.min(...ws.map((w) => w.y0)),
  x1: Math.max(...ws.map((w) => w.x1)),
  y1: Math.max(...ws.map((w) => w.y1)),
});

/** Agrupa palabras en líneas por su posición vertical. */
function groupLines(words) {
  const sorted = [...words].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const lines = [];
  for (const w of sorted) {
    const cy = (w.y0 + w.y1) / 2;
    const h = w.y1 - w.y0;
    const line = lines.find((l) => Math.abs(l.cy - cy) < Math.max(6, h * 0.45));
    if (line) {
      line.words.push(w);
      line.cy = (line.cy * (line.words.length - 1) + cy) / line.words.length;
    } else lines.push({ cy, words: [w] });
  }
  return lines.map((l) => ({ ...union(l.words), cy: l.cy, words: l.words.sort((a, b) => a.x0 - b.x0) }));
}

/** Busca la línea que más se parece a un texto (nombre o tipo). */
function bestLine(lines, text, { maxY = CARD_H, minY = 0 } = {}) {
  const want = tokenSet(text);
  if (!want.size) return null;
  let best = null;
  for (const line of lines) {
    if (line.cy > maxY || line.cy < minY) continue;
    const hit = line.words.filter((w) => matches(norm(w.text), want));
    const score = hit.length / want.size;
    if (hit.length && (!best || score > best.score)) best = { score, words: hit, line };
  }
  return best && best.score >= 0.34 ? best : null;
}

const STRUCTURED = ['planeswalker', 'saga', 'class', 'case', 'leveler'];

function layoutKind(face) {
  const type = face.type_line || '';
  if (/Planeswalker/.test(type)) return 'planeswalker';
  if (/Saga/.test(type)) return 'saga';
  if (/Class/.test(type) && /Enchantment/.test(type)) return 'class';
  if (/\bCase\b/.test(type)) return 'case';
  if (/LEVEL/.test(face.oracle_text || '')) return 'leveler';
  return 'normal';
}

// ---------------------------------------------------------------- análisis de píxeles

const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** Fondo local aproximado (luminosidad y color): mediana en bloques de 8×8, suavizada. */
function backgroundMap(img, rect) {
  const { data, width } = img;
  const B = 8;
  const bw = Math.ceil(rect.w / B);
  const bh = Math.ceil(rect.h / B);
  const med = Array.from({ length: 4 }, () => new Float32Array(bw * bh));
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const vals = [];
      for (let y = by * B; y < Math.min(rect.h, by * B + B); y += 2) {
        for (let x = bx * B; x < Math.min(rect.w, bx * B + B); x += 2) {
          const i = ((rect.y + y) * width + rect.x + x) * 4;
          vals.push([lum(data, i), data[i], data[i + 1], data[i + 2]]);
        }
      }
      vals.sort((a, b) => a[0] - b[0]);
      const m = vals[Math.floor(vals.length / 2)] || [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) med[k][by * bw + bx] = m[k];
    }
  }
  // Mediana 5×5 de bloques para que el texto grueso no "contamine" el fondo.
  const smooth = med.map(() => new Float32Array(bw * bh));
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const v = [];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = bx + dx;
          const y = by + dy;
          if (x >= 0 && y >= 0 && x < bw && y < bh) v.push(y * bw + x);
        }
      }
      v.sort((a, b) => med[0][a] - med[0][b]);
      const pick = v[Math.floor(v.length / 2)];
      for (let k = 0; k < 4; k++) smooth[k][by * bw + bx] = med[k][pick];
    }
  }
  return (x, y) => {
    const i = Math.min(bh - 1, Math.floor(y / B)) * bw + Math.min(bw - 1, Math.floor(x / B));
    return [smooth[0][i], smooth[1][i], smooth[2][i], smooth[3][i]];
  };
}

/** Umbral de Otsu sobre valores 0-255. */
function otsu(values) {
  const hist = new Array(256).fill(0);
  for (const v of values) hist[Math.max(0, Math.min(255, Math.round(v)))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 40;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return threshold;
}

/**
 * Máscara de "tinta" (letras y símbolos) dentro de un rectángulo: píxeles que se alejan del fondo
 * local en la dirección del texto (oscuro sobre claro o claro sobre oscuro) o muy distintos en color.
 */
function inkMask(img, rect, polarity = 'auto', focus = null) {
  const { data, width } = img;
  const bg = backgroundMap(img, rect);
  const n = rect.w * rect.h;
  const dl = new Float32Array(n);
  const dc = new Float32Array(n);
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const i = ((rect.y + y) * width + rect.x + x) * 4;
      const [bl, br, bgc, bb] = bg(x, y);
      dl[y * rect.w + x] = lum(data, i) - bl;
      dc[y * rect.w + x] = Math.hypot(data[i] - br, data[i + 1] - bgc, data[i + 2] - bb);
    }
  }
  // Polaridad: la del contraste más fuerte (las letras contrastan más que la textura del fondo).
  let dark = polarity === 'dark';
  if (polarity === 'auto') {
    const neg = [];
    const pos = [];
    // Si sabemos dónde están las palabras, la polaridad se decide solo con esos píxeles.
    const inFocus = focus
      ? (i) => {
          const x = i % rect.w;
          const y = (i - x) / rect.w;
          return focus.some((f) => x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1);
        }
      : () => true;
    for (let i = 0; i < dl.length; i++) if (inFocus(i)) (dl[i] < 0 ? neg : pos).push(Math.abs(dl[i]));
    const p98 = (a) => (a.length ? a.sort((x, y) => x - y)[Math.floor(a.length * 0.985)] : 0);
    dark = p98(neg) >= p98(pos);
  }
  const mags = Array.from(dl, (d) => (dark ? -d : d)).filter((v) => v > 4);
  const t = Math.max(22, otsu(mags.length ? mags : [0]) * 0.75);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) if ((dark ? -dl[i] : dl[i]) > t || dc[i] > 75) mask[i] = 1;
  return { mask, dark, threshold: t };
}

function dilate(mask, w, h, r) {
  let cur = mask;
  for (let k = 0; k < r; k++) {
    const next = new Uint8Array(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (cur[y * w + x]) continue;
        if (
          (x > 0 && cur[y * w + x - 1]) ||
          (x < w - 1 && cur[y * w + x + 1]) ||
          (y > 0 && cur[(y - 1) * w + x]) ||
          (y < h - 1 && cur[(y + 1) * w + x])
        ) {
          next[y * w + x] = 1;
        }
      }
    }
    cur = next;
  }
  return cur;
}

/** Color de la tinta original: media del 30 % de píxeles más contrastados (el centro de los trazos). */
function inkColor(img, rect, mask, dark) {
  const { data, width } = img;
  const px = [];
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      if (!mask[y * rect.w + x]) continue;
      const i = ((rect.y + y) * width + rect.x + x) * 4;
      px.push([lum(data, i), data[i], data[i + 1], data[i + 2]]);
    }
  }
  if (!px.length) return dark ? '#111111' : '#f5f5f5';
  px.sort((a, b) => (dark ? a[0] - b[0] : b[0] - a[0]));
  const top = px.slice(0, Math.max(1, Math.floor(px.length * 0.3)));
  const hex = (k) => Math.round(top.reduce((s, p) => s + p[k], 0) / top.length).toString(16).padStart(2, '0');
  return `#${hex(1)}${hex(2)}${hex(3)}`;
}

/**
 * Borra la tinta y reconstruye el fondo "de fuera hacia dentro" (cada píxel toma la media de
 * sus vecinos ya conocidos) y añade el grano de la textura original para que no quede liso.
 */
function inpaint(img, rect, mask) {
  const { data, width } = img;
  const w = rect.w;
  const h = rect.h;
  const known = new Uint8Array(w * h);
  // Grano: desviación de la luminosidad del fondo conocido.
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    known[i] = mask[i] ? 0 : 1;
    if (known[i]) {
      const p = ((rect.y + Math.floor(i / w)) * width + rect.x + (i % w)) * 4;
      const l = lum(data, p);
      sum += l;
      sum2 += l * l;
      n++;
    }
  }
  const sd = n ? Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2)) : 0;
  const grain = Math.min(sd * 0.35, 9);
  let remaining = w * h - n;
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let pass = 0; remaining > 0 && pass < 400; pass++) {
    const fill = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h || !known[yy * w + xx]) continue;
            const p = ((rect.y + yy) * width + rect.x + xx) * 4;
            const wt = dx && dy ? 0.7 : 1;
            r += data[p] * wt;
            g += data[p + 1] * wt;
            b += data[p + 2] * wt;
            c += wt;
          }
        }
        if (c >= 1.4 || (c > 0 && pass > 3)) fill.push([i, r / c, g / c, b / c]);
      }
    }
    if (!fill.length) break;
    for (const [i, r, g, b] of fill) {
      const p = ((rect.y + Math.floor(i / w)) * width + rect.x + (i % w)) * 4;
      const noise = rand() * grain;
      data[p] = r + noise;
      data[p + 1] = g + noise;
      data[p + 2] = b + noise;
      known[i] = 1;
      remaining--;
    }
  }
}

const clampRect = (r) => {
  const x = Math.max(0, Math.round(r.x));
  const y = Math.max(0, Math.round(r.y));
  return { x, y, w: Math.max(1, Math.min(CARD_W - x, Math.round(r.w))), h: Math.max(1, Math.min(CARD_H - y, Math.round(r.h))) };
};

/** Componentes conexos (8 vecinos) de una máscara: cada letra o símbolo es una "mancha". */
function components(mask, w, h) {
  const labels = new Int32Array(w * h);
  const comps = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || labels[i]) continue;
    const id = comps.length + 1;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    let area = 0;
    labels[i] = id;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop();
      const x = p % w;
      const y = (p - x) / w;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !labels[q]) {
            labels[q] = id;
            stack.push(q);
          }
        }
      }
    }
    comps.push({ id, x0, y0, x1, y1, area });
  }
  return { labels, comps };
}

/**
 * Se queda solo con las manchas de tinta que son texto: fuera las líneas del marco, las manchas
 * enormes (ilustración) y, si el OCR dio la posición de las palabras (cores), las que no las tocan.
 */
function textMask(img, rect, { polarity = 'auto', cores = null } = {}) {
  const coreRects = cores?.map((c) => ({ x0: c.x0 - rect.x - 4, y0: c.y0 - rect.y - 4, x1: c.x1 - rect.x + 4, y1: c.y1 - rect.y + 4 }));
  const { mask, dark } = inkMask(img, rect, polarity, coreRects);
  // Fuera los bordes del marco (tramos largos horizontales o verticales) antes de separar manchas:
  // así una letra que roza el borde no queda unida a él.
  const { w, h } = rect;
  const lineMask = new Uint8Array(mask);
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x <= w; x++) {
      if (x < w && mask[y * w + x]) run++;
      else {
        if (run > w * 0.35) for (let k = x - run; k < x; k++) lineMask[y * w + k] = 0;
        run = 0;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y <= h; y++) {
      if (y < h && mask[y * w + x]) run++;
      else {
        if (run > Math.max(h * 0.6, 40)) for (let k = y - run; k < y; k++) lineMask[k * w + x] = 0;
        run = 0;
      }
    }
  }
  const { labels, comps } = components(lineMask, w, h);
  const keep = new Uint8Array(comps.length + 1);
  let bbox = null;
  for (const c of comps) {
    const cw = c.x1 - c.x0 + 1;
    const ch = c.y1 - c.y0 + 1;
    if (cw > rect.w * 0.6 && ch <= 6) continue; // línea horizontal del marco
    if (ch > rect.h * 0.7 && cw <= 6) continue; // línea vertical
    // Mancha enorme: ilustración, no texto (salvo letras gruesas unidas que caben en una palabra leída).
    const withinCore = coreRects?.some((r) => c.x0 >= r.x0 - 2 && c.x1 <= r.x1 + 2 && c.y0 >= r.y0 - 4 && c.y1 <= r.y1 + 4);
    if ((c.area > rect.w * rect.h * 0.12 && !withinCore) || ch > 90) continue;
    if (coreRects && !coreRects.some((r) => c.x1 >= r.x0 && c.x0 <= r.x1 && c.y1 >= r.y0 && c.y0 <= r.y1)) continue;
    keep[c.id] = 1;
    bbox = bbox
      ? { x0: Math.min(bbox.x0, c.x0), y0: Math.min(bbox.y0, c.y0), x1: Math.max(bbox.x1, c.x1), y1: Math.max(bbox.y1, c.y1) }
      : { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 };
  }
  const out = new Uint8Array(mask.length);
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (labels[i] && keep[labels[i]]) {
      out[i] = 1;
      n++;
    }
  }
  return {
    mask: out,
    dark,
    coverage: n / (rect.w * rect.h),
    bbox: bbox && { x0: bbox.x0 + rect.x, y0: bbox.y0 + rect.y, x1: bbox.x1 + rect.x, y1: bbox.y1 + rect.y },
  };
}

/**
 * Borra el texto de una zona y devuelve el color de la tinta borrada y dónde estaban las letras.
 * Si lo detectado no parece texto (ocupa demasiado), no toca la imagen.
 */
function eraseText(img, rect, { polarity = 'auto', grow = 2, cores = null } = {}) {
  const r = clampRect(rect);
  const { mask, dark, coverage, bbox } = textMask(img, r, { polarity, cores });
  const color = inkColor(img, r, mask, dark);
  if (coverage > 0.5) return { color, dark, bbox: null, skipped: true };
  inpaint(img, r, dilate(mask, r.w, r.h, grow));
  return { color, dark, bbox };
}

const grow = (r, dx, dy) => ({ x: r.x - dx, y: r.y - dy, w: r.w + 2 * dx, h: r.h + 2 * dy });

// ---------------------------------------------------------------- análisis completo

const isOldFrame = (card) => card.frame === '1993' || card.frame === '1997';

/** Posiciones estándar por tipo de marco, por si el OCR no encuentra algo. */
function templateRegions(card) {
  const W = CARD_W;
  const H = CARD_H;
  const nSyms = (card.mana_cost || '').match(/\{[^}]+\}/g)?.length || 0;
  const old = isOldFrame(card);
  const symW = old ? 0.05 * W : 0.0505 * W;
  const nameX = old ? 0.065 * W : 0.073 * W;
  const nameRight = (old ? 0.93 : 0.927) * W - (nSyms ? nSyms * symW + 0.015 * W : 0.01 * W);
  const r = (x, y, w, h) => ({ x: x * W, y: y * H, w: w * W, h: h * H });
  if (old) {
    // Marcos de 1993 y 1997: nombre arriba a la izquierda, tipo bajo la ilustración, caja de texto centrada.
    return {
      name: { rect: { x: nameX, y: 0.043 * H, w: nameRight - nameX, h: 0.046 * H }, size: 0.031 * H, align: 'left' },
      type: { rect: r(0.072, 0.556, 0.62, 0.044), size: 0.028 * H, align: 'left' },
      text: { rect: r(0.12, 0.607, 0.76, 0.3), size: 0.032 * H, align: 'left' },
      paras: null,
    };
  }
  return {
    name: { rect: { x: nameX, y: 0.046 * H, w: nameRight - nameX, h: 0.049 * H }, size: 0.032 * H, align: 'left' },
    type: { rect: r(0.073, 0.564, 0.77, 0.04), size: 0.028 * H, align: 'left' },
    text: { rect: r(0.08, 0.627, 0.84, (card.power != null ? 0.885 : 0.915) - 0.627), size: 0.031 * H, align: 'left' },
    paras: null,
  };
}

const realWords = (l) => l.words.filter((w) => norm(w.text).length >= 2);
const avgConf = (ws) => (ws.length ? ws.reduce((s, w) => s + w.conf, 0) / ws.length : 0);

function regionsFromOcr(words, face) {
  const out = {};
  const lines = groupLines(words);
  const kind = layoutKind(face);
  const zoneOf = (allWs, factor) => {
    // Fuera los "restos" del OCR (bordes del marco leídos como | [ ( …).
    // También los trazos estrechos (un borde vertical leído como "Il") pegados al marco.
    const clean = allWs.filter((w) => (norm(w.text).length >= 2 || w.conf >= 75) && w.x1 - w.x0 >= (w.y1 - w.y0) * 0.35 && w.x0 > CARD_W * 0.05);
    const ws = clean.length ? clean : allWs;
    const b = union(ws);
    const hgt = b.y1 - b.y0;
    return { rect: { x: b.x0 - 2, y: b.y0 - hgt * 0.08, w: b.x1 - b.x0 + 6, h: hgt * 1.16 }, size: hgt * factor, align: 'left', cores: ws.map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 })) };
  };

  // Toda la línea (no solo las palabras bien leídas) hasta el coste de maná / símbolo de edición,
  // y solo las palabras a la altura de las reconocidas.
  const wholeLine = (match, maxX) => {
    const hy0 = Math.min(...match.words.map((w) => w.y0));
    const hy1 = Math.max(...match.words.map((w) => w.y1));
    const ws = match.line.words.filter((w) => w.x1 <= maxX && w.y1 > hy0 - 6 && w.y0 < hy1 + 6 && (match.words.includes(w) || w.conf > 20));
    return ws.length ? ws : match.words;
  };

  // Nombre: en la mitad superior. Tipo: la línea que mejor coincide, por debajo del nombre.
  const name = bestLine(lines, face.name, { maxY: CARD_H * 0.5 });
  if (name) {
    out.name = zoneOf(wholeLine(name, CARD_W * 0.86), 1.12);
    // Letras muy adornadas (marcos antiguos) que el OCR no leyó: si falta buena parte del nombre,
    // la zona va de la primera letra al coste de maná y se borra toda la tinta de la barra.
    const letters = (str) => norm(str).replace(/[^a-z0-9]/g, '').length;
    const got = letters(name.words.map((w) => w.text).join(''));
    if (got < letters(face.name) * 0.75) {
      const nSyms = (face.mana_cost || '').match(/\{[^}]+\}/g)?.length || 0;
      const r = out.name.rect;
      const x0 = Math.max(CARD_W * 0.055, r.x - r.h * 0.8);
      const x1 = Math.max(r.x + r.w, CARD_W * 0.925 - nSyms * CARD_W * 0.052 - 8);
      out.name.rect = { ...r, x: x0, w: x1 - x0 };
      out.name.cores = null;
    }
  }
  let type = bestLine(lines, face.type_line, { minY: name ? name.line.y1 + 40 : CARD_H * 0.3 });
  if (!type && layoutKind(face) === 'normal') {
    // Tipos antiguos ("Summon Elves", "Interrupt"…) no coinciden con el actual: se toma la línea
    // corta, alineada a la izquierda, justo debajo de la ilustración.
    const guess = lines
      .filter((l) => l.cy > CARD_H * 0.52 && l.cy < CARD_H * 0.64 && l.x0 < CARD_W * 0.2 && realWords(l).length <= 3 && realWords(l).some((w) => w.conf >= 50))
      .sort((a, b) => a.cy - b.cy)[0];
    if (guess) type = { line: guess, words: realWords(guess).filter((w) => w.x1 <= CARD_W * 0.85), score: 0 };
  }
  if (type?.words.length) out.type = zoneOf(wholeLine(type, CARD_W * 0.85), 1.08);
  else type = null;
  // Las tallas se miden con las palabras reconocidas (no con restos del marco).
  if (name) out.name.size = (union(name.words).y1 - union(name.words).y0) * 1.12;
  if (type) out.type.size = (union(type.words).y1 - union(type.words).y0) * 1.08;

  // En las cartas el nombre y el tipo van casi al mismo tamaño: si uno se midió de más, se iguala.
  if (out.name && out.type) {
    out.type.size = Math.min(out.type.size, out.name.size);
    out.name.size = Math.min(out.name.size, out.type.size * 1.2);
  }

  // Texto de reglas (y ambientación): entre la línea de tipo y el crédito del ilustrador.
  // Valen las líneas que coinciden con el texto oficial y también las bien leídas que no
  // coinciden (cartas antiguas con la redacción de entonces).
  let minY = type && kind !== 'saga' ? type.line.y1 : name ? name.line.y1 + 20 : 0;
  // Sin línea de tipo, la caja de texto nunca empieza tan arriba (allí está la ilustración).
  if (!type && kind !== 'saga') minY = Math.max(minY, CARD_H * 0.55);
  // El crédito: "Illus."/"Wizards", o © / ™ en letra pequeña (el símbolo {T} se lee a veces como ©).
  const credit = lines.find((l) => {
    if (l.cy <= minY) return false;
    const str = l.words.map((w) => w.text).join(' ');
    const hs = l.words.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
    return /[il1|]{1,3}l?us\b|wizards/i.test(str) || (/©|™|\(c\)/i.test(str) && hs[Math.floor(hs.length / 2)] <= 16);
  });
  const maxY = Math.min(credit ? credit.y0 : CARD_H, CARD_H * (isOldFrame(face) ? 0.895 : 0.915));
  const ruleSet = tokenSet(`${face.oracle_text} ${face.flavor_text || ''}`);
  const candidates = lines
    .filter((l) => l.cy > minY && l.cy < maxY && l !== type?.line && l !== name?.line)
    .map((l) => ({ ...l, hits: l.words.filter((w) => matches(norm(w.text), ruleSet)) }));
  const isMatch = (l) => l.hits.length >= 1 && l.hits.length >= realWords(l).length * 0.34;
  // Altura típica de la letra del texto (para descartar créditos y letra pequeña).
  const hitHeights = candidates.filter(isMatch).flatMap((l) => l.hits).map((w) => w.y1 - w.y0).sort((a, b) => a - b);
  const textH = hitHeights[Math.floor(hitHeights.length / 2)] || 0;
  let ruleLines = candidates
    .filter((l) => {
      const real = realWords(l);
      if (isMatch(l)) return true;
      if (textH && real.length && real.reduce((s2, w) => s2 + (w.y1 - w.y0), 0) / real.length < textH * 0.7) return false;
      // Redacción antigua: línea con texto real bien leído dentro de la caja.
      const good = real.filter((w) => w.conf >= 60);
      const cx = (l.x0 + l.x1) / 2;
      return !STRUCTURED.includes(kind) && good.length >= 2 && avgConf(real) >= 62 && cx > CARD_W * 0.2 && cx < CARD_W * 0.8 && !/^\d+\/\d+$/.test(l.words.map((w) => w.text).join(''));
    });
  // Además, cualquier otra línea legible dentro de la columna del texto (símbolos mal leídos,
  // redacción antigua…) pertenece a la caja de texto.
  if (ruleLines.length && !STRUCTURED.includes(kind)) {
    const typicalH = ruleLines.flatMap((l) => l.hits).map((w) => w.y1 - w.y0).sort((a, b) => a - b);
    const minH = (typicalH[Math.floor(typicalH.length / 2)] || 20) * 0.7;
    const colX0 = Math.min(...ruleLines.map((l) => l.x0)) - 6;
    const colX1 = Math.max(...ruleLines.map((l) => l.x1)) + 6;
    for (const l of lines) {
      if (ruleLines.some((r) => r.cy === l.cy) || l === type?.line || l === name?.line) continue;
      if (l.cy <= minY || l.cy >= maxY || l.x1 < colX0 || l.x0 > colX1) continue;
      // Letra del mismo tamaño que el texto (el crédito del ilustrador es mucho más pequeño).
      const real = realWords(l).filter((w) => w.conf >= 45 && w.x0 >= colX0 && w.x1 <= colX1 && w.y1 - w.y0 >= minH);
      if (real.length >= 1 && !/^\d+\/\d+$/.test(l.words.map((w) => w.text).join(''))) {
        ruleLines.push({ ...l, words: real, hits: [], extra: true });
      }
    }
    ruleLines.sort((a, b) => a.cy - b.cy);
  }
  if (ruleLines.length) {
    // Cada línea va de su primera a su última palabra reconocida (fuera quedan restos del marco).
    for (const l of ruleLines) {
      const keep = l.words
        .map((w, i) => (l.hits.includes(w) || (w.conf >= 45 && norm(w.text).length >= 2 && w.x1 - w.x0 >= (w.y1 - w.y0) * 0.5) ? i : -1))
        .filter((i) => i >= 0);
      let seg = keep.length ? l.words.slice(Math.min(...keep), Math.max(...keep) + 1) : l.words;
      // Fuera los restos de los extremos: motas diminutas o "palabras" sueltas lejos del resto
      // (trozos de la ilustración o del marco leídos como texto).
      const hs = seg.map((w) => w.y1 - w.y0).sort((x, y) => x - y);
      const mh = hs[Math.floor(hs.length / 2)] || 20;
      const junk = (w, near) => !l.hits.includes(w) && (w.y1 - w.y0 < mh * 0.5 || (near && Math.max(near.x0 - w.x1, w.x0 - near.x1) > mh * 2.5));
      while (seg.length > 1 && junk(seg[seg.length - 1], seg[seg.length - 2])) seg = seg.slice(0, -1);
      while (seg.length > 1 && junk(seg[0], seg[1])) seg = seg.slice(1);
      l.seg = seg;
      Object.assign(l, union(l.seg));
    }
    const hitWords = ruleLines.flatMap((l) => (l.hits.length ? l.hits : l.seg));
    // Alto: todas las líneas; ancho: solo las reconocidas (las añadidas pueden traer restos del marco).
    const bAll = union(ruleLines.flatMap((l) => l.seg));
    const known = ruleLines.filter((l) => !l.extra);
    const bKnown = union((known.length ? known : ruleLines).flatMap((l) => l.seg));
    const b = { x0: bKnown.x0, x1: bKnown.x1, y0: bAll.y0, y1: bAll.y1 };
    const pitches = [];
    for (let i = 1; i < ruleLines.length; i++) {
      const d = ruleLines[i].cy - ruleLines[i - 1].cy;
      if (d > 8 && d < 80) pitches.push(d);
    }
    pitches.sort((a, c) => a - c);
    const heights = hitWords.map((w) => w.y1 - w.y0).sort((a, c) => a - c);
    // Tamaño de letra: por el espaciado típico entre líneas (descartando líneas partidas por el OCR)
    // y nunca menor que lo que miden las propias palabras.
    const wordH = heights[Math.floor(heights.length / 2)] || 20;
    const goodPitches = pitches.filter((p) => p > wordH * 0.9);
    const pitch = goodPitches.length ? goodPitches[Math.floor(goodPitches.length / 2)] : null;
    const size = Math.max(pitch ? pitch / 1.13 : 0, wordH * 1.05);
    const single = ruleLines.length === 1;
    const hasBox = face.power != null || face.loyalty != null || face.defense != null;
    const lineCenter = (b.x0 + b.x1) / 2;
    const pad = size * 0.35;
    const matched = new Set(ruleLines.flatMap((l) => l.hits.map((w) => norm(w.text))));
    out.text = {
      rect: { x: b.x0 - pad * 0.6, y: b.y0 - pad, w: b.x1 - b.x0 + pad * 1.2, h: b.y1 - b.y0 + pad * 2 },
      size,
      align: single && Math.abs(lineCenter - CARD_W / 2) < CARD_W * 0.06 ? 'center' : 'left',
      // Se borra cada fila de texto a todo el ancho de la columna (el OCR a veces parte las líneas).
      // Abajo a la derecha está la caja de fuerza/resistencia o lealtad: ahí solo hasta el final de la línea.
      cores: ruleLines.map((l) => ({ x0: b.x0 - 10, y0: l.y0, x1: hasBox && l.y1 > CARD_H * 0.85 ? l.x1 + 10 : b.x1 + 10, y1: l.y1 })),
      coverage: ruleSet.size ? Math.min(1, matched.size / ruleSet.size) : 1,
    };
    // Planeswalkers, sagas…: una zona por párrafo (habilidad/capítulo) para no tocar sus iconos.
    if (STRUCTURED.includes(kind)) {
      const paragraphs = (face.oracle_text || '').split('\n').map((p) => tokenSet(p));
      const groups = paragraphs.map(() => []);
      for (const l of ruleLines) {
        let bestI = -1;
        let bestN = 0;
        paragraphs.forEach((set, i) => {
          const n = l.words.filter((w) => matches(norm(w.text), set)).length;
          if (n > bestN) [bestI, bestN] = [i, n];
        });
        if (bestI >= 0) groups[bestI].push(l);
      }
      out.paras = groups.map((g) => {
        if (!g.length) return null;
        const u = union(g.flatMap((l) => l.seg));
        // En planeswalkers todas comparten ancho; en sagas cada capítulo conserva su margen (iconos I, II…).
        const x0 = kind === 'saga' ? u.x0 : b.x0;
        return { x: x0 - pad * 0.5, y: u.y0 - pad * 0.6, w: b.x1 - x0 + pad, h: u.y1 - u.y0 + pad * 1.2 };
      });
    }
  }
  return out;
}

/**
 * OCR de una franja de la carta, preparada para que se lea mejor: ampliada ×2, en grises,
 * con el contraste estirado e invertida si la letra es clara sobre fondo oscuro.
 */
async function ocrBand(src, band) {
  const b = clampRect(band);
  const scale = 2;
  const c = document.createElement('canvas');
  c.width = b.w * scale;
  c.height = b.h * scale;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, b.x, b.y, b.w, b.h, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const ls = new Float32Array(d.length / 4);
  for (let i = 0; i < ls.length; i++) ls[i] = lum(d, i * 4);
  const sorted = Float32Array.from(ls).sort();
  const p = (q) => sorted[Math.floor(q * (sorted.length - 1))];
  const lo = p(0.03);
  const mid = p(0.5);
  const hi = p(0.97);
  const invert = hi - mid > mid - lo; // letra clara: se invierte para que quede oscura sobre claro
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < ls.length; i++) {
    let v = ((ls[i] - lo) / range) * 255;
    v = Math.max(0, Math.min(255, v));
    if (invert) v = 255 - v;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  const words = await ocrWords(c);
  return words.map((w) => ({ ...w, x0: b.x + w.x0 / scale, x1: b.x + w.x1 / scale, y0: b.y + w.y0 / scale, y1: b.y + w.y1 / scale }));
}

const inside = (w, band) => (w.y0 + w.y1) / 2 >= band.y && (w.y0 + w.y1) / 2 <= band.y + band.h;

const memo = new Map();

/**
 * Analiza una impresión. face: datos en inglés de esa cara (name, type_line, oracle_text,
 * flavor_text, mana_cost, power, frame…). Devuelve { name, type, text, paras, source, confidence }.
 */
export async function analyzeCard(imageUrl, face, { useOcr = true } = {}) {
  const key = `ana:${ANALYSIS_VERSION}:${imageUrl}:${face.name}`;
  if (memo.has(key)) return memo.get(key);
  const promise = (async () => {
    const saved = await idbGet(key);
    if (saved) return saved;
    const template = templateRegions(face);
    let found = {};
    let source = 'template';
    if (useOcr) {
      try {
        const img = await loadImage(imageUrl);
        const c = newCanvas();
        c.getContext('2d').drawImage(img, 0, 0, CARD_W, CARD_H);
        let words = await ocrWords(c);
        found = regionsFromOcr(words, face);
        source = 'ocr';
        // Segunda pasada, franja a franja y con la imagen preparada, para lo que no se encontró
        // (letras cursivas, blancas sobre oscuro, marcos antiguos…).
        const bands = [];
        if (!found.name) bands.push({ x: 0.03 * CARD_W, y: 0.02 * CARD_H, w: 0.8 * CARD_W, h: 0.1 * CARD_H });
        if (!found.type) bands.push({ x: 0.03 * CARD_W, y: 0.5 * CARD_H, w: 0.85 * CARD_W, h: 0.15 * CARD_H });
        // La caja de texto se relee siempre: con letra pequeña o símbolos el primer OCR se salta líneas.
        if (layoutKind(face) === 'normal') {
          const top = found.type ? found.type.rect.y + found.type.rect.h : 0.55 * CARD_H;
          bands.push({ x: 0.05 * CARD_W, y: top, w: 0.9 * CARD_W, h: 0.94 * CARD_H - top });
        }
        for (const band of bands) {
          const extra = await ocrBand(c, band);
          words = [...words.filter((w) => !inside(w, band)), ...extra];
        }
        if (bands.length) {
          const second = regionsFromOcr(words, face);
          for (const k of ['name', 'type']) found[k] ||= second[k];
          const area = (z) => (z ? z.rect.w * z.rect.h : 0);
          const better =
            second.text &&
            (!found.text ||
              (second.text.coverage ?? 0) > (found.text.coverage ?? 0) + 0.05 ||
              ((second.text.coverage ?? 0) >= (found.text.coverage ?? 0) - 0.05 && area(second.text) > area(found.text)));
          if (better) {
            found.text = second.text;
            found.paras = second.paras;
          }
        }
      } catch (err) {
        console.warn('OCR no disponible, uso posiciones estándar:', err.message);
      }
    }
    const confidence =
      (found.name ? 0.25 : 0) + (found.type ? 0.25 : 0) + (found.text ? 0.2 + 0.3 * (found.text.coverage ?? 0.5) : 0);
    const result = {
      name: found.name || template.name,
      type: found.type || template.type,
      text: found.text || template.text,
      paras: found.paras || null,
      kind: layoutKind(face),
      source: Object.keys(found).length ? source : 'template',
      found: { name: Boolean(found.name), type: Boolean(found.type), text: Boolean(found.text) },
      confidence: Math.round(confidence * 100) / 100,
      oldFrame: isOldFrame(face),
    };
    if (result.source === 'ocr') idbSet(key, result);
    return result;
  })();
  memo.set(key, promise);
  promise.catch(() => memo.delete(key));
  return promise;
}

/** Quita el coste de lealtad ("+1: ") o el capítulo ("I, II — ") que ya están dibujados como iconos. */
function stripPrefix(text, kind) {
  if (kind === 'planeswalker') return text.replace(/^\s*[+−-]?[\dX]+\s*:\s*/, '');
  if (kind === 'saga') return text.replace(/^\s*[IVX]+(?:\s*,\s*[IVX]+)*\s*[—-]\s*/, '');
  return text;
}

/**
 * Dibuja la carta "como la original" con el texto nuevo.
 * t: { name, type_line, oracle_text, flavor_text }. analysis: de analyzeCard().
 * opts: { layout (zonas movidas por el usuario), colors, titleScale, fontScale, showFlavor }
 */
export async function renderOriginalStyle(imageUrl, face, t, analysis, opts = {}) {
  await ensureFonts();
  await ensureSymbols(`${t.oracle_text} ${face.mana_cost}`);
  const img = await loadImage(imageUrl);
  const c = newCanvas();
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, CARD_W, CARD_H);
  const layout = opts.layout || {};
  const colors = opts.colors || {};
  const zone = (k) => ({ ...analysis[k], rect: layout[k] || analysis[k].rect });

  // 1) Borrar el texto original de cada zona (sobre los píxeles de la imagen)
  const pixels = ctx.getImageData(0, 0, CARD_W, CARD_H);
  const name = zone('name');
  const type = zone('type');
  const text = zone('text');
  // Si el usuario movió una zona, se borra todo lo que hay dentro; si no, solo las letras del OCR.
  const coresOf = (k) => (layout[k] ? null : analysis[k].cores || null);
  const nameInk = eraseText(pixels, grow(name.rect, 10, 0), { cores: coresOf('name') });
  const typeInk = eraseText(pixels, grow(type.rect, 10, 0), { cores: coresOf('type') });
  const paraRects = analysis.paras && !layout.text ? analysis.paras : null;
  let textInk;
  if (paraRects) {
    textInk = null;
    for (const r of paraRects) if (r) textInk = eraseText(pixels, r, { grow: 3 });
    textInk ??= eraseText(pixels, text.rect, { grow: 3 });
  } else {
    textInk = eraseText(pixels, grow(text.rect, 6, 4), { grow: 3, cores: coresOf('text') });
  }
  ctx.putImageData(pixels, 0, 0);

  // 2) Escribir el texto nuevo con el color y el tamaño medidos
  const titleScale = Number(opts.titleScale) || 1;
  const fontScale = Number(opts.fontScale) || 1;
  const drawTitle = (str, z, color, extraRoom, ink) => {
    const r = z.rect;
    // Empieza donde empezaban las letras originales (si se detectaron), centrado en su línea.
    const x = ink?.bbox ? Math.max(ink.bbox.x0, r.x) : r.x + 2;
    const size = fitText(ctx, str, r.w + extraRoom - (x - r.x), z.size * titleScale, 700, titleFont());
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(str, x, r.y + r.h / 2 + size * 0.04);
  };
  // El nombre y el tipo pueden crecer un poco hacia la derecha si el texto traducido es más largo.
  const nSyms = (face.mana_cost || '').match(/\{[^}]+\}/g)?.length || 0;
  const costLeft = CARD_W * 0.925 - nSyms * CARD_W * 0.052 - 8;
  drawTitle(t.name, name, colors.name || nameInk.color, Math.max(0, costLeft - name.rect.x - name.rect.w), nameInk);
  drawTitle(t.type_line, type, colors.type || typeInk.color, Math.max(0, CARD_W * 0.84 - type.rect.x - type.rect.w), typeInk);

  const rulesColor = colors.text || textInk.color;
  if (paraRects) {
    const paras = t.oracle_text.split('\n');
    paraRects.forEach((r, i) => {
      if (!r || paras[i] == null) return;
      drawRules(ctx, stripPrefix(paras[i], analysis.kind), r, { color: rulesColor, maxSize: text.size * fontScale * RULES_COMPENSATION, align: 'left' });
    });
  } else {
    drawRules(ctx, t.oracle_text, text.rect, {
      color: rulesColor,
      maxSize: text.size * fontScale * RULES_COMPENSATION,
      align: text.align,
      flavor: opts.showFlavor === false ? '' : t.flavor_text || '',
    });
  }
  // Datos para el editor: colores medidos y zonas usadas.
  c.mtpInfo = {
    source: analysis.source,
    confidence: analysis.confidence,
    foundCount: Object.values(analysis.found || {}).filter(Boolean).length,
    colors: { name: nameInk.color, type: typeInk.color, text: textInk.color },
    zones: { name: name.rect, type: type.rect, text: text.rect },
  };
  return c;
}

/** Elimina análisis guardados (si el usuario quiere repetir el OCR). */
export function forgetAnalysis(imageUrl, faceName) {
  const key = `ana:${ANALYSIS_VERSION}:${imageUrl}:${faceName}`;
  memo.delete(key);
  return idbSet(key, null);
}

/** Para pruebas y depuración. */
export const _internal = { textMask, inkMask, components, regionsFromOcr, eraseText, grow };
