/**
 * Render de cartas en <canvas>:
 *  - official: la imagen tal cual (impresión oficial en el idioma pedido)
 *  - overlay:  imagen inglesa con marco moderno + texto traducido superpuesto
 *  - custom:   marco propio dibujado desde cero con el arte y el texto traducido
 */
import { symbology } from './scryfall.js';

export const CARD_W = 745;
export const CARD_H = 1040;

const FONT_TITLE = '"Alegreya Sans SC", "Alegreya Sans", "Trebuchet MS", sans-serif';
const FONT_RULES = '"Crimson Pro", "Georgia", serif';

const imageCache = new Map();

export function loadImage(url) {
  if (!url) return Promise.reject(new Error('Sin imagen'));
  // Las imágenes de Scryfall permiten CORS y se cargan directamente (también en GitHub Pages).
  // Se usa una URL distinta de la de las <img> normales: si no, el navegador reutiliza su copia
  // en caché sin cabeceras CORS y el canvas queda bloqueado.
  const src = url.startsWith('data:') ? url : `${url}${url.includes('?') ? '&' : '?'}mtp-cors=1`;
  if (!imageCache.has(src)) {
    const p = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`No se pudo cargar la imagen ${url}`));
      img.src = src;
    });
    p.catch(() => imageCache.delete(src));
    imageCache.set(src, p);
    if (imageCache.size > 300) imageCache.delete(imageCache.keys().next().value);
  }
  return imageCache.get(src);
}

let fontsReady = null;
function ensureFonts() {
  fontsReady ??= Promise.all([
    document.fonts.load(`700 40px ${FONT_TITLE}`),
    document.fonts.load(`400 30px ${FONT_RULES}`),
    document.fonts.load(`italic 400 30px ${FONT_RULES}`),
  ]).catch(() => {});
  return fontsReady;
}

function newCanvas(w = CARD_W, h = CARD_H) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// ---------- Símbolos de maná ----------

const symbolImages = new Map();

async function ensureSymbols(text) {
  const needed = [...new Set((text || '').match(/\{[^}]+\}/g) || [])].filter((s) => !symbolImages.has(s));
  if (!needed.length) return;
  const map = await symbology();
  await Promise.all(
    needed.map(async (sym) => {
      const url = map.get(sym);
      try {
        symbolImages.set(sym, url ? await loadImage(url) : null);
      } catch {
        symbolImages.set(sym, null);
      }
    }),
  );
}

const SYMBOL_COLORS = { W: '#f8f3d0', U: '#a9d6f0', B: '#c9c2bf', R: '#f5a585', G: '#9bd3ae', C: '#d6d0cc' };

function drawSymbol(ctx, sym, x, y, size) {
  const img = symbolImages.get(sym);
  if (img) {
    ctx.drawImage(img, x, y, size, size);
    return;
  }
  const inner = sym.slice(1, -1);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = SYMBOL_COLORS[inner[0]] || SYMBOL_COLORS.C;
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.font = `700 ${size * 0.6}px ${FONT_TITLE}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(inner.length > 2 ? inner[0] : inner, x + size / 2, y + size / 2 + 1);
  ctx.restore();
}

function drawManaCost(ctx, cost, rightX, centerY, size) {
  const syms = (cost || '').match(/\{[^}]+\}/g) || [];
  let x = rightX - syms.length * (size + 3);
  for (const s of syms) {
    // Sombra como en las cartas reales
    ctx.save();
    ctx.beginPath();
    ctx.arc(x + size / 2 - 2, centerY + 3, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.85)';
    ctx.fill();
    ctx.restore();
    drawSymbol(ctx, s, x, centerY - size / 2, size);
    x += size + 3;
  }
  return syms.length * (size + 3);
}

// ---------- Maquetación de texto de reglas ----------

/** Divide el texto en tokens; el texto entre paréntesis (recordatorio) va en cursiva. */
export function tokenize(text) {
  const tokens = [];
  let italic = false;
  const re = /(\{[^}]+\})|(\n)|( +)|([^\s{]+)/g;
  let m;
  while ((m = re.exec(text || ''))) {
    if (m[1]) tokens.push({ type: 'symbol', value: m[1], italic });
    else if (m[2]) tokens.push({ type: 'newline' });
    else if (m[3]) tokens.push({ type: 'space', italic });
    else {
      const word = m[4];
      let buf = '';
      for (const ch of word) {
        if (ch === '(') {
          if (buf) tokens.push({ type: 'word', value: buf, italic });
          buf = ch;
          italic = true;
        } else if (ch === ')') {
          buf += ch;
          tokens.push({ type: 'word', value: buf, italic: true });
          buf = '';
          italic = false;
        } else buf += ch;
      }
      if (buf) tokens.push({ type: 'word', value: buf, italic });
    }
  }
  // Los fragmentos contiguos (p. ej. "palabra" + "(recordatorio") no deben partirse en líneas distintas.
  return tokens;
}

function layout(ctx, tokens, maxWidth, size) {
  const symSize = size * 0.92;
  const font = (it) => `${it ? 'italic ' : ''}400 ${size}px ${FONT_RULES}`;
  const paragraphs = [];
  let lines = [];
  let line = { items: [], width: 0 };
  let pendingSpace = 0;
  const flushLine = () => {
    lines.push(line);
    line = { items: [], width: 0 };
    pendingSpace = 0;
  };
  for (const t of tokens) {
    if (t.type === 'newline') {
      flushLine();
      paragraphs.push(lines);
      lines = [];
      continue;
    }
    if (t.type === 'space') {
      ctx.font = font(t.italic);
      pendingSpace = ctx.measureText(' ').width;
      continue;
    }
    let w;
    if (t.type === 'symbol') w = symSize + 2;
    else {
      ctx.font = font(t.italic);
      w = ctx.measureText(t.value).width;
    }
    const glued = pendingSpace === 0 && line.items.length > 0;
    if (line.items.length && line.width + pendingSpace + w > maxWidth && !glued) flushLine();
    line.items.push({ ...t, x: line.width + pendingSpace, w });
    line.width += pendingSpace + w;
    pendingSpace = 0;
  }
  flushLine();
  paragraphs.push(lines);
  const lineH = size * 1.13;
  const paraGap = size * 0.38;
  const height = paragraphs.reduce((h, p) => h + p.length * lineH, 0) + Math.max(0, paragraphs.length - 1) * paraGap;
  const widest = Math.max(...paragraphs.flat().map((l) => l.width));
  return { paragraphs, height, lineH, paraGap, symSize, widest };
}

function drawRules(ctx, text, box, { color = '#111', maxSize = 34, minSize = 12, center = false, flavor = '' } = {}) {
  const tokens = tokenize(text);
  if (flavor) {
    // El texto de ambientación va en cursiva, en un párrafo aparte.
    if (tokens.length) tokens.push({ type: 'newline' });
    for (const tk of tokenize(flavor)) tokens.push(tk.type === 'newline' ? tk : { ...tk, italic: true });
  }
  let size = maxSize;
  let lay = layout(ctx, tokens, box.w, size);
  while ((lay.height > box.h || lay.widest > box.w) && size > minSize) {
    size -= 1;
    lay = layout(ctx, tokens, box.w, size);
  }
  let y = box.y + Math.max(0, (box.h - lay.height) / 2);
  const shortText = lay.paragraphs.length === 1 && lay.paragraphs[0].length === 1 && center;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  for (const para of lay.paragraphs) {
    for (const ln of para) {
      const offsetX = shortText ? (box.w - ln.width) / 2 : 0;
      const baseline = y + size * 0.86;
      for (const it of ln.items) {
        if (it.type === 'symbol') {
          drawSymbol(ctx, it.value, box.x + offsetX + it.x + 1, baseline - lay.symSize * 0.82, lay.symSize);
        } else {
          ctx.font = `${it.italic ? 'italic ' : ''}400 ${size}px ${FONT_RULES}`;
          ctx.fillText(it.value, box.x + offsetX + it.x, baseline);
        }
      }
      y += lay.lineH;
    }
    y += lay.paraGap;
  }
}

function fitText(ctx, text, maxWidth, maxSize, weight = 700, family = FONT_TITLE) {
  let size = maxSize;
  do {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 1;
  } while (size > 10);
  return size;
}

// ---------- Utilidades de color ----------

/** Color de fondo de una región: media de los píxeles más claros (ignora el texto impreso). */
function sampleBackground(ctx, x, y, w, h) {
  const data = ctx.getImageData(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))).data;
  const px = [];
  for (let i = 0; i < data.length; i += 16) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    px.push([lum, data[i], data[i + 1], data[i + 2]]);
  }
  px.sort((a, b) => a[0] - b[0]);
  // Fondo claro (texto negro) o fondo oscuro (texto blanco): nos quedamos con la mayoría.
  const median = px[Math.floor(px.length / 2)][0];
  const dark = median < 100;
  const slice = dark ? px.slice(0, Math.floor(px.length * 0.6)) : px.slice(Math.floor(px.length * 0.4));
  const avg = [1, 2, 3].map((k) => Math.round(slice.reduce((s, p) => s + p[k], 0) / slice.length));
  return { rgb: `rgb(${avg.join(',')})`, dark };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// ---------- Render ----------

export async function renderOfficial(imageUrl) {
  const img = await loadImage(imageUrl);
  const c = newCanvas();
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.drawImage(img, 0, 0, CARD_W, CARD_H);
  return c;
}

/**
 * Superpone el texto traducido sobre una impresión inglesa con marco 2015.
 * face: cara inglesa (mana_cost, power...), t: { name, type_line, oracle_text } traducido.
 */
export async function renderOverlay(imageUrl, face, t) {
  await ensureFonts();
  await ensureSymbols(`${t.oracle_text} ${face.mana_cost}`);
  const c = await renderOfficial(imageUrl);
  const ctx = c.getContext('2d');
  const W = CARD_W;
  const H = CARD_H;

  // Nombre (a la izquierda del coste de maná)
  const nSyms = (face.mana_cost || '').match(/\{[^}]+\}/g)?.length || 0;
  const name = { x: 0.073 * W, y: 0.046 * H, h: 0.049 * H };
  name.w = 0.927 * W - name.x - (nSyms ? nSyms * 0.0505 * W + 0.012 * W : 0.01 * W);
  let bg = sampleBackground(ctx, name.x, name.y, name.w, name.h);
  ctx.fillStyle = bg.rgb;
  roundRect(ctx, name.x, name.y, name.w, name.h, 6);
  ctx.fill();
  fitText(ctx, t.name, name.w - 10, 0.032 * H);
  ctx.fillStyle = bg.dark ? '#fff' : '#111';
  ctx.textBaseline = 'middle';
  ctx.fillText(t.name, name.x + 4, name.y + name.h / 2 + 1);

  // Línea de tipo (a la izquierda del símbolo de edición)
  const type = { x: 0.073 * W, y: 0.564 * H, w: 0.77 * W, h: 0.04 * H };
  bg = sampleBackground(ctx, type.x, type.y, type.w, type.h);
  ctx.fillStyle = bg.rgb;
  roundRect(ctx, type.x, type.y, type.w, type.h, 6);
  ctx.fill();
  fitText(ctx, t.type_line, type.w - 10, 0.028 * H);
  ctx.fillStyle = bg.dark ? '#fff' : '#111';
  ctx.fillText(t.type_line, type.x + 4, type.y + type.h / 2 + 1);

  // Caja de texto
  const hasPT = face.power != null || face.toughness != null || face.defense != null;
  const box = { x: 0.08 * W, y: 0.627 * H, w: 0.84 * W, h: (hasPT ? 0.885 : 0.917) * H - 0.627 * H };
  bg = sampleBackground(ctx, box.x, box.y, box.w, box.h);
  ctx.fillStyle = bg.rgb;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  // Franja inferior a la izquierda de la caja de F/R (ahí también llega el texto original).
  if (hasPT) ctx.fillRect(box.x, box.y + box.h, 0.695 * W, 0.917 * H - (box.y + box.h));
  drawRules(ctx, t.oracle_text, { x: box.x + 10, y: box.y + 8, w: box.w - 20, h: box.h - 16 }, {
    color: bg.dark ? '#fff' : '#111',
    maxSize: 0.033 * H,
    center: true,
  });
  return c;
}

const FRAME_COLORS = {
  W: ['#fbf6e2', '#e8dfc0'],
  U: ['#1a74b8', '#0c4f86'],
  B: ['#4d4541', '#26211f'],
  R: ['#d8452f', '#9e2316'],
  G: ['#1b8a4f', '#0f5a33'],
  M: ['#e0c066', '#b28f2c'],
  A: ['#b7c0c6', '#7d878e'],
  L: ['#c9b48d', '#8d7756'],
};

export const FRAME_KEYS = Object.keys(FRAME_COLORS);

function frameKey(face, card) {
  const type = face.type_line || card.type_line || '';
  const colors = face.colors || card.colors || [];
  if (/Land/.test(type)) return 'L';
  if (colors.length > 1) return 'M';
  if (colors.length === 1) return colors[0];
  return 'A';
}

/**
 * Marco propio: útil para marcos antiguos, arte completo, sagas, planeswalkers y cartas personalizadas.
 * face: datos de la cara (mana_cost, power…); t: textos a mostrar { name, type_line, oracle_text, flavor_text? }.
 * opts: { art: { zoom, x, y }, frame: 'auto'|'W'|…, fontScale, artist, showFlavor }
 */
export async function renderCustom(artUrl, face, t, card = face, opts = {}) {
  await ensureFonts();
  await ensureSymbols(`${t.oracle_text} ${face.mana_cost}`);
  const W = CARD_W;
  const H = CARD_H;
  const c = newCanvas();
  const ctx = c.getContext('2d');
  const key = opts.frame && opts.frame !== 'auto' ? opts.frame : frameKey(face, card);
  const [light, dark] = FRAME_COLORS[key] || FRAME_COLORS.A;
  const darkFrame = ['U', 'B', 'R', 'G'].includes(key);
  const fontScale = Number(opts.fontScale) || 1;
  const artT = { zoom: 1, x: 0, y: 0, ...(opts.art || {}) };

  ctx.fillStyle = '#111';
  roundRect(ctx, 0, 0, W, H, 34);
  ctx.fill();
  const inset = 0.045 * W;
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, light);
  grad.addColorStop(1, dark);
  ctx.fillStyle = grad;
  roundRect(ctx, inset, inset, W - inset * 2, H - inset * 2.6, 14);
  ctx.fill();

  const inner = { x: 0.07 * W, w: 0.86 * W };
  const bar = (y, h) => {
    ctx.fillStyle = '#efe6cf';
    roundRect(ctx, inner.x - 6, y, inner.w + 12, h, h / 2.6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.lineWidth = 2;
    ctx.stroke();
  };

  // Barra del nombre + coste
  const nameY = 0.06 * H;
  const nameH = 0.055 * H;
  bar(nameY, nameH);
  const costW = drawManaCost(ctx, face.mana_cost, inner.x + inner.w - 6, nameY + nameH / 2, 0.036 * H);
  fitText(ctx, t.name, inner.w - costW - 24, 0.036 * H);
  ctx.fillStyle = '#111';
  ctx.textBaseline = 'middle';
  ctx.fillText(t.name, inner.x + 8, nameY + nameH / 2 + 1);

  // Arte
  const art = { x: inner.x, y: nameY + nameH + 6, w: inner.w, h: 0.44 * H };
  ctx.fillStyle = '#222';
  ctx.fillRect(art.x, art.y, art.w, art.h);
  if (artUrl) {
    try {
      const img = await loadImage(artUrl);
      // Encuadre: zoom ≥ 1 y desplazamiento -1…1 dentro del margen sobrante.
      const zoom = Math.max(1, Number(artT.zoom) || 1);
      const scale = Math.max(art.w / img.width, art.h / img.height) * zoom;
      const sw = art.w / scale;
      const sh = art.h / scale;
      const sx = ((img.width - sw) / 2) * (1 + Math.max(-1, Math.min(1, Number(artT.x) || 0)));
      const sy = ((img.height - sh) / 2) * (1 + Math.max(-1, Math.min(1, Number(artT.y) || 0)));
      ctx.save();
      ctx.beginPath();
      ctx.rect(art.x, art.y, art.w, art.h);
      ctx.clip();
      ctx.drawImage(img, sx, sy, sw, sh, art.x, art.y, art.w, art.h);
      ctx.restore();
    } catch {
      // Sin arte: se queda el fondo oscuro
    }
  }
  ctx.strokeStyle = 'rgba(0,0,0,.6)';
  ctx.lineWidth = 3;
  ctx.strokeRect(art.x, art.y, art.w, art.h);

  // Tipo
  const typeY = art.y + art.h + 6;
  const typeH = 0.05 * H;
  bar(typeY, typeH);
  fitText(ctx, t.type_line, inner.w - 20, 0.03 * H);
  ctx.fillStyle = '#111';
  ctx.fillText(t.type_line, inner.x + 8, typeY + typeH / 2 + 1);

  // Caja de texto
  const box = { x: inner.x, y: typeY + typeH + 6, w: inner.w, h: 0.9 * H - (typeY + typeH + 6) };
  ctx.fillStyle = '#f6f0de';
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.strokeStyle = 'rgba(0,0,0,.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  const stat =
    face.power != null ? `${face.power}/${face.toughness}` : face.loyalty != null ? face.loyalty : face.defense ?? null;
  drawRules(ctx, t.oracle_text, { x: box.x + 14, y: box.y + 10, w: box.w - 28, h: box.h - (stat != null ? 46 : 20) }, {
    maxSize: 0.032 * H * fontScale,
    center: true,
    flavor: opts.showFlavor === false ? '' : t.flavor_text || '',
  });

  // Fuerza/resistencia o lealtad
  if (stat != null) {
    const pw = 0.17 * W;
    const ph = 0.05 * H;
    const px = inner.x + inner.w - pw + 6;
    const py = box.y + box.h - ph / 2;
    ctx.fillStyle = '#efe6cf';
    roundRect(ctx, px, py, pw, ph, 10);
    ctx.fill();
    ctx.strokeStyle = darkFrame ? dark : '#555';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    fitText(ctx, String(stat), pw - 12, 0.036 * H);
    ctx.fillText(String(stat), px + pw / 2, py + ph / 2 + 1);
    ctx.textAlign = 'left';
  }

  ctx.fillStyle = '#ddd';
  ctx.font = `400 ${0.016 * H}px ${FONT_RULES}`;
  ctx.textBaseline = 'alphabetic';
  const credit = opts.artist ?? face.artist ?? card.artist;
  ctx.fillText(credit ? `Illus. ${credit}` : 'Proxy', inner.x, H - 0.022 * H);
  ctx.textAlign = 'right';
  ctx.fillText('Proxy · not for sale', inner.x + inner.w, H - 0.022 * H);
  ctx.textAlign = 'left';
  return c;
}

/** Reverso genérico (no se reproduce el reverso oficial de Magic). */
export async function renderBack({ image = null, title = 'Commander' } = {}) {
  await ensureFonts();
  const c = newCanvas();
  const ctx = c.getContext('2d');
  if (image) {
    const img = await loadImage(image);
    ctx.drawImage(img, 0, 0, CARD_W, CARD_H);
    return c;
  }
  ctx.fillStyle = '#111';
  roundRect(ctx, 0, 0, CARD_W, CARD_H, 34);
  ctx.fill();
  const g = ctx.createRadialGradient(CARD_W / 2, CARD_H / 2, 40, CARD_W / 2, CARD_H / 2, CARD_H * 0.6);
  g.addColorStop(0, '#5b3a8c');
  g.addColorStop(1, '#1d1033');
  ctx.fillStyle = g;
  roundRect(ctx, 30, 30, CARD_W - 60, CARD_H - 60, 20);
  ctx.fill();
  ctx.strokeStyle = '#c9a54a';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.ellipse(CARD_W / 2, CARD_H / 2, CARD_W * 0.33, CARD_H * 0.36, 0, 0, Math.PI * 2);
  ctx.stroke();
  const colors = ['#f8f3d0', '#0e68ab', '#3b3632', '#d3202a', '#00733e'];
  colors.forEach((col, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    ctx.beginPath();
    ctx.arc(CARD_W / 2 + Math.cos(a) * 150, CARD_H / 2 + Math.sin(a) * 150, 42, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.strokeStyle = '#c9a54a';
    ctx.lineWidth = 4;
    ctx.stroke();
  });
  ctx.fillStyle = '#f2e2b0';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitText(ctx, title, CARD_W * 0.6, 64);
  ctx.fillText(title, CARD_W / 2, CARD_H / 2);
  ctx.font = `400 26px ${FONT_RULES}`;
  ctx.fillText('Magic the PDF · proxy', CARD_W / 2, CARD_H - 90);
  ctx.textAlign = 'left';
  return c;
}

/** Marca de agua "PROXY" opcional en la parte inferior. */
export function stampProxy(canvas, text = 'PROXY') {
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.font = `700 22px ${FONT_TITLE}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.strokeStyle = 'rgba(0,0,0,.8)';
  ctx.lineWidth = 4;
  ctx.strokeText(text, CARD_W / 2, CARD_H - 18);
  ctx.fillText(text, CARD_W / 2, CARD_H - 18);
  ctx.restore();
  return canvas;
}
