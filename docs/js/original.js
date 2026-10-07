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

const ANALYSIS_VERSION = 7;
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
function inkMask(img, rect, polarity = 'auto') {
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
    for (const d of dl) (d < 0 ? neg : pos).push(Math.abs(d));
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

/** Borra el texto de una zona y devuelve el color de la tinta borrada. */
function eraseText(img, rect, polarity, grow = 2) {
  const r = clampRect(rect);
  const { mask, dark } = inkMask(img, r, polarity);
  const color = inkColor(img, r, mask, dark);
  inpaint(img, r, dilate(mask, r.w, r.h, grow));
  return { color, dark };
}

// ---------------------------------------------------------------- análisis completo

/** Posiciones estándar por tipo de marco, por si el OCR no encuentra algo. */
function templateRegions(card) {
  const W = CARD_W;
  const H = CARD_H;
  const nSyms = (card.mana_cost || '').match(/\{[^}]+\}/g)?.length || 0;
  const old = card.frame === '1993' || card.frame === '1997';
  const symW = old ? 0.045 * W : 0.0505 * W;
  const nameX = old ? 0.06 * W : 0.073 * W;
  const nameRight = (old ? 0.94 : 0.927) * W - (nSyms ? nSyms * symW + 0.012 * W : 0.01 * W);
  const r = (x, y, w, h) => ({ x: x * W, y: y * H, w: w * W, h: h * H });
  if (old) {
    return {
      name: { rect: { x: nameX, y: 0.038 * H, w: nameRight - nameX, h: 0.05 * H }, size: 0.03 * H, align: 'left' },
      type: { rect: r(0.06, 0.555, 0.8, 0.042), size: 0.027 * H, align: 'left' },
      text: { rect: r(0.08, 0.615, 0.84, 0.27), size: 0.031 * H, align: 'left' },
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

function regionsFromOcr(words, face) {
  const out = {};
  const lines = groupLines(words);
  const kind = layoutKind(face);

  // Nombre: en la mitad superior. Tipo: la línea que mejor coincide, por debajo del nombre.
  const name = bestLine(lines, face.name, { maxY: CARD_H * 0.5 });
  if (name) {
    const b = union(name.words);
    const hgt = b.y1 - b.y0;
    out.name = { rect: { x: b.x0 - 2, y: b.y0 - hgt * 0.08, w: b.x1 - b.x0 + 6, h: hgt * 1.16 }, size: hgt * 1.12, align: 'left' };
  }
  const type = bestLine(lines, face.type_line, { minY: name ? name.line.y1 + 40 : CARD_H * 0.3 });
  if (type) {
    const b = union(type.words);
    const hgt = b.y1 - b.y0;
    out.type = { rect: { x: b.x0 - 2, y: b.y0 - hgt * 0.08, w: b.x1 - b.x0 + 6, h: hgt * 1.16 }, size: hgt * 1.08, align: 'left' };
  }

  // En las cartas el nombre y el tipo van casi al mismo tamaño: si uno se midió de más, se iguala.
  if (out.name && out.type) {
    out.type.size = Math.min(out.type.size, out.name.size);
    out.name.size = Math.min(out.name.size, out.type.size * 1.2);
  }

  // Texto de reglas (y ambientación): palabras que coinciden con el texto oficial, bajo el tipo
  // (o en cualquier sitio si el tipo no se encontró: sagas y cartas con el texto a un lado).
  const minY = type && kind !== 'saga' ? type.line.y1 : name ? name.line.y1 + 20 : 0;
  const ruleSet = tokenSet(`${face.oracle_text} ${face.flavor_text || ''}`);
  const ruleLines = lines
    .filter((l) => l.cy > minY && l.cy < CARD_H * 0.94 && l !== type?.line && l !== name?.line)
    .map((l) => ({ ...l, hits: l.words.filter((w) => matches(norm(w.text), ruleSet)) }))
    .filter((l) => {
      const real = l.words.filter((w) => norm(w.text).length >= 2).length;
      return l.hits.length >= 1 && l.hits.length >= real * 0.34;
    });
  if (ruleLines.length) {
    // Cada línea va de su primera a su última palabra reconocida (fuera quedan restos del marco).
    for (const l of ruleLines) {
      const idx = l.words.map((w, i) => (l.hits.includes(w) ? i : -1)).filter((i) => i >= 0);
      l.seg = l.words.slice(Math.min(...idx), Math.max(...idx) + 1);
      Object.assign(l, union(l.seg));
    }
    const hitWords = ruleLines.flatMap((l) => l.hits);
    const b = union(ruleLines.flatMap((l) => l.seg));
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
    const lineCenter = (b.x0 + b.x1) / 2;
    const pad = size * 0.35;
    out.text = {
      rect: { x: b.x0 - pad * 0.6, y: b.y0 - pad, w: b.x1 - b.x0 + pad * 1.2, h: b.y1 - b.y0 + pad * 2 },
      size,
      align: single && Math.abs(lineCenter - CARD_W / 2) < CARD_W * 0.06 ? 'center' : 'left',
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
      // Todas las zonas comparten el ancho del texto (empiezan y acaban donde el bloque entero).
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

const memo = new Map();

/**
 * Analiza una impresión. face: datos en inglés de esa cara (name, type_line, oracle_text,
 * flavor_text, mana_cost, power…). Devuelve { name, type, text, paras, source }.
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
        found = regionsFromOcr(await ocrWords(c), face);
        source = 'ocr';
      } catch (err) {
        console.warn('OCR no disponible, uso posiciones estándar:', err.message);
      }
    }
    const result = {
      name: found.name || template.name,
      type: found.type || template.type,
      text: found.text || template.text,
      paras: found.paras || null,
      kind: layoutKind(face),
      source: Object.keys(found).length ? source : 'template',
      found: { name: Boolean(found.name), type: Boolean(found.type), text: Boolean(found.text) },
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
  const nameInk = eraseText(pixels, name.rect);
  const typeInk = eraseText(pixels, type.rect);
  const paraRects = analysis.paras && !layout.text ? analysis.paras : null;
  let textInk;
  if (paraRects) {
    textInk = null;
    for (const r of paraRects) if (r) textInk = eraseText(pixels, r, 'auto', 3);
    textInk ??= eraseText(pixels, text.rect, 'auto', 3);
  } else {
    textInk = eraseText(pixels, text.rect, 'auto', 3);
  }
  ctx.putImageData(pixels, 0, 0);

  // 2) Escribir el texto nuevo con el color y el tamaño medidos
  const titleScale = Number(opts.titleScale) || 1;
  const fontScale = Number(opts.fontScale) || 1;
  const drawTitle = (str, z, color, extraRoom) => {
    const r = z.rect;
    const size = fitText(ctx, str, r.w + extraRoom, z.size * titleScale, 700, titleFont());
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(str, r.x + 2, r.y + r.h / 2 + size * 0.04);
  };
  // El nombre y el tipo pueden crecer un poco hacia la derecha si el texto traducido es más largo.
  const nSyms = (face.mana_cost || '').match(/\{[^}]+\}/g)?.length || 0;
  const costLeft = CARD_W * 0.925 - nSyms * CARD_W * 0.052 - 8;
  drawTitle(t.name, name, colors.name || nameInk.color, Math.max(0, costLeft - name.rect.x - name.rect.w));
  drawTitle(t.type_line, type, colors.type || typeInk.color, Math.max(0, CARD_W * 0.84 - type.rect.x - type.rect.w));

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
