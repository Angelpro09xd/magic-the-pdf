/**
 * Editor completo de carta: textos (nombre, coste, tipo, reglas, ambientación, F/R, lealtad,
 * ilustrador), traducción automática a cualquier idioma, arte (de cualquier edición, de otra
 * carta, subido o por URL) con zoom y encuadre, color de marco, tamaño de letra y estilo.
 * También sirve para crear cartas personalizadas desde cero.
 */
import { getLanguage, languageOptions } from './languages.js';
import * as sf from './scryfall.js';
import { t } from './i18n.js';
import { printableFaces, textFaces } from './deck.js';
import { renderCustomEntry, overlayBaseFor, officialPrint, targetLang, faceKey, faceImage, originalFace } from './resolve.js';
import { FRAME_KEYS, CARD_W, CARD_H } from './render.js';
import { forgetAnalysis } from './original.js';
import { TITLE_FONTS, RULES_FONTS, CUSTOM_TITLE, CUSTOM_RULES, currentFonts, chooseFonts, uploadFont } from './fonts.js';
import { openArtPicker } from './arts.js';
import { checkTranslation, generateFlavor, polishRules } from './ai/cardAi.js';
import './ai/strings.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SYMBOLS = ['{W}', '{U}', '{B}', '{R}', '{G}', '{C}', '{X}', '{1}', '{2}', '{3}', '{4}', '{T}', '{Q}', '{E}', '{S}', '{W/U}', '{B/R}', '{G/W}', '{W/P}'];

const symbolImg = (s) => `https://svgs.scryfall.io/card-symbols/${s.slice(1, -1).replace(/\//g, '')}.svg`;

/** Caras iniciales del editor a partir de la carta y su traducción/impresión oficial. */
export function initialFaces(entry, deck) {
  const card = entry.card;
  const lang = targetLang(entry, deck);
  const tr = entry.translation?.lang === lang ? entry.translation.faces : null;
  const off = officialPrint(entry, deck);
  const offFaces = off ? textFaces(off) : null;
  const imgFaces = printableFaces(card);
  return textFaces(card).map((f, i) => {
    const o = offFaces?.[i];
    return {
      name: tr?.[i]?.name ?? o?.printed_name ?? f.name ?? '',
      mana_cost: f.mana_cost ?? '',
      type_line: tr?.[i]?.type_line ?? o?.printed_type_line ?? f.type_line ?? '',
      oracle_text: tr?.[i]?.oracle_text ?? o?.printed_text ?? f.oracle_text ?? '',
      flavor_text: tr?.[i]?.flavor_text ?? o?.flavor_text ?? f.flavor_text ?? '',
      power: f.power ?? '',
      toughness: f.toughness ?? '',
      loyalty: f.loyalty ?? '',
      defense: f.defense ?? '',
      artist: f.artist ?? card.artist ?? '',
      art: { url: imgFaces[i]?.image?.art_crop || card.image?.art_crop || '', zoom: 1, x: 0, y: 0 },
    };
  });
}

function englishFaces(card) {
  return textFaces(card).map((f) => ({
    name: f.name,
    type_line: f.type_line,
    oracle_text: f.oracle_text,
    flavor_text: card.lang === 'en' ? f.flavor_text || '' : '',
  }));
}

/** Reduce una imagen subida para que quepa en el almacenamiento del navegador. */
function downscale(file, max = 1000) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Abre el editor.
 * opts: { entry, deck, translateFn(lang, faces), onSave({ custom, overlayBase }), onRemove?(), toast(msg, type) }
 */
export function openEditor({ entry, deck, translateFn, onSave, onRemove, toast = () => {} }) {
  const modal = document.getElementById('editorModal');
  const body = document.getElementById('editorModalBody');
  const card = entry.card;
  const draft = entry.custom
    ? structuredClone(entry.custom)
    : { style: card.custom ? 'custom' : 'overlay', frame: 'auto', fontScale: 1, titleScale: 1, faces: initialFaces(entry, deck) };
  draft.layouts ??= [];
  draft.colors ??= [];
  draft.titleScale ??= 1;
  if (draft.style === 'overlay' && card.custom) draft.style = 'custom';
  let overlayBase = draft.basePrint || overlayBaseFor(entry);
  let showZones = true;
  let faceIdx = 0;
  let lastField = null;
  const off = officialPrint(entry, deck);

  const field = (name) => body.querySelector(`[data-k="${name}"]`);
  const face = () => draft.faces[faceIdx];

  body.innerHTML = `
    <h2>${esc(card.custom ? t('editorNewTitle') : t('editorTitle', { name: card.name }))}</h2>
    <div class="editor-layout">
      <div class="editor-form">
        ${draft.faces.length > 1 ? `<div class="face-tabs">${draft.faces.map((f, i) => `<button class="btn small" data-face="${i}">${esc(t('face'))} ${i + 1}</button>`).join('')}</div>` : ''}
        <fieldset>
          <legend>${esc(t('edText'))}</legend>
          <div class="palette">${SYMBOLS.map((s) => `<button type="button" class="sym" data-sym="${s}" title="${s}"><img src="${symbolImg(s)}" alt="${s}"></button>`).join('')}</div>
          <label>${esc(t('fieldName'))}<input data-k="name"></label>
          <label>${esc(t('fieldCost'))}<input data-k="mana_cost" placeholder="{2}{G}{G}"></label>
          <label>${esc(t('fieldType'))}<input data-k="type_line"></label>
          <label>${esc(t('fieldText'))}<textarea data-k="oracle_text" rows="7"></textarea></label>
          <label>${esc(t('fieldFlavor'))}<textarea data-k="flavor_text" rows="2"></textarea></label>
          <div class="stats-row">
            <label>${esc(t('fieldPower'))}<input data-k="power"></label>
            <label>${esc(t('fieldToughness'))}<input data-k="toughness"></label>
            <label>${esc(t('loyalty'))}<input data-k="loyalty"></label>
            <label>${esc(t('fieldDefense'))}<input data-k="defense"></label>
          </div>
          <label>${esc(t('fieldArtist'))}<input data-k="artist"></label>
          ${
            card.custom
              ? ''
              : `<div class="row">
              <select data-k="tlang">${languageOptions(targetLang(entry, deck), { printed: t('langGroupPrinted'), translated: t('langGroupTranslated') })}</select>
              <button type="button" class="btn primary" data-a="translate">🌐 ${esc(t('translateCard'))}</button>
              <button type="button" class="btn" data-a="english">${esc(t('englishText'))}</button>
              ${off ? `<button type="button" class="btn" data-a="official">${esc(t('officialText'))}</button>` : ''}
            </div>`
          }
          ${card.custom ? `<div class="row"><select data-k="tlang">${languageOptions(targetLang(entry, deck), { printed: t('langGroupPrinted'), translated: t('langGroupTranslated') })}</select><button type="button" class="btn" data-a="translate">🌐 ${esc(t('translateCustom'))}</button></div>` : ''}
        </fieldset>
        <fieldset class="ed-ai">
          <legend>${esc(t('edAiTitle'))}</legend>
          <div class="row wrap">
            <button type="button" class="btn primary" data-a="aiAuto">${esc(t('edAiAuto'))}</button>
            <button type="button" class="btn" data-a="aiCheck">${esc(t('edAiCheck'))}</button>
            ${card.custom ? '' : `<button type="button" class="btn" data-a="aiBestPrint">${esc(t('edAiBestPrint'))}</button>`}
            <button type="button" class="btn" data-a="aiFlavor">${esc(t('edAiFlavor'))}</button>
            ${card.custom ? '' : `<button type="button" class="btn" data-a="aiPolish">${esc(t('edAiPolish'))}</button>`}
          </div>
          <div class="ed-ai-out small"></div>
        </fieldset>
        <fieldset>
          <legend>${esc(t('edStyle'))}</legend>
          <label>${esc(t('cardStyle'))}
            <select data-d="style">
              ${card.custom ? '' : `<option value="overlay">${esc(t('modeOriginal'))}</option>`}
              <option value="custom">${esc(t('modeCustom'))}</option>
            </select>
          </label>
          <div class="only-overlay">
            <p class="small muted">${esc(t('originalHelp'))}</p>
            <div class="row">
              <label class="check"><input type="checkbox" data-o="zones" checked> ${esc(t('showZones'))}</label>
              <button type="button" class="btn small" data-a="resetZones">${esc(t('resetZones'))}</button>
              <button type="button" class="btn small" data-a="reanalyze">🔍 ${esc(t('reanalyze'))}</button>
            </div>
            <div class="color-row">
              <label>${esc(t('colorName'))} <input type="color" data-c="name"></label>
              <label>${esc(t('colorType'))} <input type="color" data-c="type"></label>
              <label>${esc(t('colorText'))} <input type="color" data-c="text"></label>
              <button type="button" class="btn small" data-a="autoColors">${esc(t('autoColors'))}</button>
            </div>
            <label>${esc(t('titleSize'))} <input type="range" min="0.6" max="1.4" step="0.02" data-d="titleScale"></label>
          </div>
          <div class="only-custom">
            <label>${esc(t('frameColor'))}
              <select data-d="frame">
                <option value="auto">${esc(t('frameAuto'))}</option>
                ${FRAME_KEYS.map((k) => `<option value="${k}">${esc(t(`frame_${k}`))}</option>`).join('')}
              </select>
            </label>
          </div>
          <label>${esc(t('fontSize'))} <input type="range" min="0.6" max="1.4" step="0.02" data-d="fontScale"></label>
          <div class="font-row">
            <label>${esc(t('titleFont'))}
              <select data-f="title">${[...TITLE_FONTS, CUSTOM_TITLE].map((f) => `<option value="${esc(f)}">${esc(f === CUSTOM_TITLE ? t('ownFont') : f)}</option>`).join('')}</select>
            </label>
            <label class="btn small">⬆ ${esc(t('uploadFont'))}<input type="file" accept=".ttf,.otf,.woff,.woff2" data-upload="title" hidden></label>
          </div>
          <div class="font-row">
            <label>${esc(t('rulesFont'))}
              <select data-f="rules">${[...RULES_FONTS, CUSTOM_RULES].map((f) => `<option value="${esc(f)}">${esc(f === CUSTOM_RULES ? t('ownFont') : f)}</option>`).join('')}</select>
            </label>
            <label class="btn small">⬆ ${esc(t('uploadFont'))}<input type="file" accept=".ttf,.otf,.woff,.woff2" data-upload="rules" hidden></label>
          </div>
          <p class="small muted">${esc(t('fontsHelp'))}</p>
        </fieldset>
        <fieldset>
          <legend>${esc(t('edArt'))}</legend>
          <p class="small muted only-overlay">${esc(t('artOverlayHelp'))}</p>
          <div class="row">
            ${card.custom ? '' : `<button type="button" class="btn" data-a="pickArt">🎨 ${esc(t('artFromPrints'))}</button>`}
            <input type="search" data-k="artSearch" placeholder="${esc(t('artFromOtherCard'))}">
            <button type="button" class="btn" data-a="searchArt">${esc(t('search'))}</button>
          </div>
          <div class="art-search-results"></div>
          <div class="row">
            <label class="btn">📁 ${esc(t('uploadImage'))}<input type="file" accept="image/*" data-k="upload" hidden></label>
            <input type="url" data-k="artUrl" placeholder="https://…">
          </div>
          <div class="only-custom">
            <label>${esc(t('artZoom'))} <input type="range" min="1" max="3" step="0.05" data-art="zoom"></label>
            <label>${esc(t('artX'))} <input type="range" min="-1" max="1" step="0.02" data-art="x"></label>
            <label>${esc(t('artY'))} <input type="range" min="-1" max="1" step="0.02" data-art="y"></label>
            <button type="button" class="btn small" data-a="resetArt">${esc(t('resetFraming'))}</button>
          </div>
        </fieldset>
      </div>
      <div class="editor-preview">
        <div class="preview-canvases"><span class="spinner"></span></div>
        <div class="row">
          <button type="button" class="btn small only-overlay" data-a="compare">👁 ${esc(t('holdOriginal'))}</button>
          <span class="small muted analysis-info"></span>
        </div>
        <p class="small muted">${esc(t('editorPreviewHelp'))}</p>
      </div>
    </div>
    <div class="row editor-actions">
      <button type="button" class="btn primary big" data-a="save">💾 ${esc(t('save'))}</button>
      <button type="button" class="btn" data-a="png">⬇ PNG</button>
      ${entry.custom && onRemove && !card.custom ? `<button type="button" class="btn danger" data-a="remove">${esc(t('removeEdits'))}</button>` : ''}
      <button type="button" class="btn" data-a="cancel">${esc(t('cancel'))}</button>
    </div>`;

  function fillForm() {
    const f = face();
    for (const k of ['name', 'mana_cost', 'type_line', 'oracle_text', 'flavor_text', 'power', 'toughness', 'loyalty', 'defense', 'artist']) {
      field(k).value = f[k] ?? '';
    }
    field('artUrl').value = f.art?.url?.startsWith('data:') ? '' : f.art?.url || '';
    for (const k of ['zoom', 'x', 'y']) body.querySelector(`[data-art="${k}"]`).value = f.art?.[k] ?? (k === 'zoom' ? 1 : 0);
    body.querySelector('[data-d="style"]').value = draft.style;
    body.querySelector('[data-d="frame"]').value = draft.frame || 'auto';
    body.querySelector('[data-d="fontScale"]').value = draft.fontScale || 1;
    body.querySelector('[data-d="titleScale"]').value = draft.titleScale || 1;
    const fonts = currentFonts();
    body.querySelector('[data-f="title"]').value = fonts.title;
    body.querySelector('[data-f="rules"]').value = fonts.rules;
    body.querySelectorAll('.face-tabs [data-face]').forEach((b) => b.classList.toggle('primary', Number(b.dataset.face) === faceIdx));
    body.classList.toggle('style-overlay', draft.style === 'overlay');
    body.classList.toggle('style-custom', draft.style !== 'overlay');
  }

  let timer = null;
  let renderToken = 0;
  let lastCanvases = [];
  function schedulePreview(delay = 200) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const token = ++renderToken;
      const slot = body.querySelector('.preview-canvases');
      try {
        const canvases = await renderCustomEntry({ card, custom: draft, overlayBase }, 'png');
        if (token !== renderToken) return;
        lastCanvases = canvases;
        slot.innerHTML = '';
        canvases.forEach((c, i) => {
          const stage = document.createElement('div');
          stage.className = 'preview-stage';
          stage.dataset.face = i;
          stage.append(c);
          slot.append(stage);
        });
        afterRender();
      } catch (err) {
        slot.textContent = err.message;
      }
    }, delay);
  }

  /** Tras dibujar: colores medidos, información del análisis y cajas de las zonas. */
  function afterRender() {
    const info = lastCanvases[faceIdx]?.mtpInfo;
    const infoNode = body.querySelector('.analysis-info');
    if (draft.style !== 'overlay' || !info) {
      infoNode.textContent = '';
      return;
    }
    infoNode.textContent = info.source === 'ocr' ? t('analysisOcr', { found: info.foundCount }) : t('analysisTemplate');
    // Confianza baja (marcos antiguos, letras adornadas…): sugerir mover las cajas o elegir otra impresión.
    if (info.source === 'ocr' && info.confidence != null && info.confidence < 0.6) infoNode.textContent += ` ${t('analysisLow')}`;
    for (const k of ['name', 'type', 'text']) {
      const input = body.querySelector(`[data-c="${k}"]`);
      input.value = toHex(draft.colors[faceIdx]?.[k] || info.colors[k]);
    }
    drawZones(info.zones);
  }

  const toHex = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#111111');

  /** Cajas arrastrables para mover/redimensionar las zonas de texto. */
  function drawZones(zones) {
    const stage = body.querySelector(`.preview-stage[data-face="${faceIdx}"]`);
    if (!stage) return;
    stage.querySelectorAll('.zone').forEach((z) => z.remove());
    if (!showZones) return;
    for (const k of ['name', 'type', 'text']) {
      const r = draft.layouts[faceIdx]?.[k] || zones[k];
      if (!r) continue;
      const z = document.createElement('div');
      z.className = `zone zone-${k}`;
      z.dataset.zone = k;
      Object.assign(z.style, {
        left: `${(r.x / CARD_W) * 100}%`,
        top: `${(r.y / CARD_H) * 100}%`,
        width: `${(r.w / CARD_W) * 100}%`,
        height: `${(r.h / CARD_H) * 100}%`,
      });
      z.innerHTML = `<span class="zone-label">${esc(t(`zone_${k}`))}</span><span class="zone-handle"></span>`;
      stage.append(z);
      enableDrag(z, stage, k, r);
    }
  }

  function enableDrag(z, stage, key, start) {
    z.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      const resizing = ev.target.classList.contains('zone-handle');
      const box = stage.getBoundingClientRect();
      const scale = CARD_W / box.width;
      const r0 = { ...(draft.layouts[faceIdx]?.[key] || start) };
      const x0 = ev.clientX;
      const y0 = ev.clientY;
      z.setPointerCapture(ev.pointerId);
      const move = (e) => {
        const dx = (e.clientX - x0) * scale;
        const dy = (e.clientY - y0) * scale;
        const r = resizing
          ? { ...r0, w: Math.max(20, r0.w + dx), h: Math.max(12, r0.h + dy) }
          : { ...r0, x: r0.x + dx, y: r0.y + dy };
        draft.layouts[faceIdx] = { ...(draft.layouts[faceIdx] || {}), [key]: r };
        Object.assign(z.style, {
          left: `${(r.x / CARD_W) * 100}%`,
          top: `${(r.y / CARD_H) * 100}%`,
          width: `${(r.w / CARD_W) * 100}%`,
          height: `${(r.h / CARD_H) * 100}%`,
        });
      };
      const up = () => {
        z.removeEventListener('pointermove', move);
        z.removeEventListener('pointerup', up);
        schedulePreview(50);
      };
      z.addEventListener('pointermove', move);
      z.addEventListener('pointerup', up);
    });
  }

  async function ensureOverlayBase() {
    if (overlayBase) return true;
    try {
      const bases = await sf.findOverlayBases([card]);
      overlayBase = bases.get(card.oracle_id) || null;
    } catch {
      overlayBase = null;
    }
    if (!overlayBase) toast(t('noOverlayBase'), 'error');
    return Boolean(overlayBase);
  }

  function setArt(url) {
    face().art = { ...(face().art || {}), url, zoom: 1, x: 0, y: 0 };
    if (draft.style === 'overlay') {
      // Con otra imagen ya no hay "carta original" debajo: se pasa al marco propio.
      draft.style = 'custom';
      toast(t('switchedToCustom'));
    }
    fillForm();
    schedulePreview();
  }

  function insertSymbol(sym) {
    const target = lastField && ['mana_cost', 'oracle_text', 'type_line'].includes(lastField.dataset.k) ? lastField : field('oracle_text');
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    target.value = target.value.slice(0, start) + sym + target.value.slice(end);
    target.focus();
    target.selectionStart = target.selectionEnd = start + sym.length;
    face()[target.dataset.k] = target.value;
    schedulePreview();
  }

  body.oninput = (e) => {
    const el = e.target;
    if (el.dataset.k && el.dataset.k in face()) {
      face()[el.dataset.k] = el.value;
      schedulePreview();
    } else if (el.dataset.art) {
      face().art = { ...(face().art || {}), [el.dataset.art]: Number(el.value) };
      schedulePreview();
    } else if (el.dataset.d === 'fontScale' || el.dataset.d === 'titleScale') {
      draft[el.dataset.d] = Number(el.value);
      schedulePreview();
    } else if (el.dataset.c) {
      draft.colors[faceIdx] = { ...(draft.colors[faceIdx] || {}), [el.dataset.c]: el.value };
      schedulePreview();
    }
  };

  body.onchange = async (e) => {
    const el = e.target;
    if (el.dataset.d === 'style') {
      if (el.value === 'overlay' && !(await ensureOverlayBase())) {
        el.value = 'custom';
        return;
      }
      draft.style = el.value;
      fillForm();
    } else if (el.dataset.d === 'frame') draft.frame = el.value;
    else if (el.dataset.o === 'zones') {
      showZones = el.checked;
      afterRender();
      return;
    } else if (el.dataset.f) {
      chooseFonts({ [el.dataset.f]: el.value });
    } else if (el.dataset.upload && el.files[0]) {
      try {
        await uploadFont(el.dataset.upload, el.files[0]);
        toast(t('fontUploaded'), 'ok');
        fillForm();
      } catch {
        toast(t('fontError'), 'error');
      }
      el.value = '';
    }
    else if (el.dataset.k === 'artUrl' && el.value.trim()) setArt(el.value.trim());
    else if (el.dataset.k === 'upload' && el.files[0]) {
      try {
        setArt(await downscale(el.files[0]));
      } catch {
        toast(t('uploadError'), 'error');
      }
      el.value = '';
      return;
    } else return;
    schedulePreview();
  };

  body.addEventListener('focusin', (e) => {
    if (e.target.dataset?.k) lastField = e.target;
  });

  // ------------------------------------------------------------ IA de la carta
  const aiOut = (html) => {
    body.querySelector('.ed-ai-out').innerHTML = html;
  };
  const langOf = () => field('tlang')?.value || targetLang(entry, deck);
  const issuesOf = (lang) =>
    card.custom ? [] : englishFaces(card).flatMap((f, i) => checkTranslation(f, draft.faces[i] || {}, lang).map((x) => ({ ...x, face: i })));
  const issuesHtml = (issues) =>
    issues.length
      ? `<p>⚠️ ${esc(t('edAiIssues'))}</p><ul>${issues.map((x) => `<li>${esc(t(x.code, x.params))}</li>`).join('')}</ul>`
      : `<p>✅ ${esc(t('edAiCheckOk'))}</p>`;

  async function bestPrint() {
    const bases = await sf.findOverlayBases([card]).catch(() => new Map());
    const base = bases.get(card.oracle_id);
    if (!base) return null;
    draft.basePrint = base;
    overlayBase = base;
    draft.style = 'overlay';
    draft.layouts = [];
    draft.colors = [];
    fillForm();
    schedulePreview(0);
    return base;
  }

  async function runCardAi(action, btn) {
    const lang = langOf();
    const old = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = `⏳ ${t('edAiWorking')}`;
    }
    try {
      if (action === 'aiCheck') {
        const issues = issuesOf(lang);
        aiOut(`${issuesHtml(issues)}${issues.length && !card.custom ? `<button type="button" class="btn small primary" data-a="aiFix">🛠 ${esc(t('translateCard'))}</button>` : ''}`);
      } else if (action === 'aiFix') {
        await doTranslate(lang);
        const issues = issuesOf(lang);
        aiOut(`<p>${esc(t('edAiFixed'))}</p>${issuesHtml(issues)}`);
      } else if (action === 'aiBestPrint') {
        const base = await bestPrint();
        if (!base) toast(t('noOverlayBase'), 'error');
        else aiOut(`<p>✅ ${esc(t('edAiPrintDone', { set: `${base.set_name} (${base.set.toUpperCase()} #${base.collector_number})`, frame: base.frame }))}</p>`);
      } else if (action === 'aiAuto') {
        const steps = [];
        // 1) Traducir si sigue en inglés (o si la revisión encuentra fallos)
        const english = englishFaces(card);
        const untranslated = !card.custom && lang !== 'en' && draft.faces.some((f, i) => f.oracle_text === english[i]?.oracle_text && f.oracle_text);
        if (!card.custom && lang !== 'en' && (untranslated || issuesOf(lang).length)) {
          await doTranslate(lang);
          steps.push(t('edAiStepTranslated'));
        }
        // 2) Estilo «como la original» sobre una impresión de marco moderno si la actual es difícil
        if (!card.custom) {
          const info = lastCanvases[faceIdx]?.mtpInfo;
          const hard = !overlayBase || ['1993', '1997'].includes(overlayBase.frame) || overlayBase.full_art || (info && info.confidence < 0.6);
          if (draft.style !== 'overlay' || hard) {
            if (hard ? await bestPrint() : await ensureOverlayBase()) {
              if (draft.style !== 'overlay') {
                draft.style = 'overlay';
                fillForm();
                schedulePreview(0);
              }
              steps.push(t(hard ? 'edAiStepPrint' : 'edAiStepStyle'));
            }
          }
        }
        const issues = issuesOf(lang);
        aiOut(`<p>✨ ${esc(t('edAiAutoDone', { steps: steps.join(', ') || t('edAiStepNothing') }))}</p>${card.custom ? '' : issuesHtml(issues)}`);
      } else if (action === 'aiFlavor') {
        try {
          face().flavor_text = await generateFlavor(face(), lang);
          fillForm();
          schedulePreview();
          aiOut(`<p>🪶 ${esc(face().flavor_text)}</p><p class="tiny muted">${esc(t('aiOnlineBadge'))}</p>`);
        } catch {
          toast(t('edAiFlavorFail'), 'error');
        }
      } else if (action === 'aiPolish') {
        try {
          const original = englishFaces(card)[faceIdx];
          face().oracle_text = await polishRules(original, face(), lang);
          fillForm();
          schedulePreview();
          aiOut(`<p>✅ ${esc(t('edAiPolish'))}</p>${issuesHtml(issuesOf(lang))}<p class="tiny muted">${esc(t('aiOnlineBadge'))}</p>`);
        } catch {
          toast(t('edAiFlavorFail'), 'error');
        }
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = old;
      }
    }
  }

  /** Traduce la carta (o la personalizada) al idioma indicado. */
  async function doTranslate(lang, btn) {
    if (btn) btn.disabled = true;
    const old = btn?.textContent;
    if (btn) btn.textContent = `⏳ ${t('translating')}`;
    try {
      // Las cartas reales se traducen desde el inglés oficial; las personalizadas, desde lo escrito.
      const source = card.custom ? draft.faces : englishFaces(card);
      const faces = source.map((f, i) => ({
        key: `${faceKey(card, i)}:${lang}:${f.oracle_text.length}:${(f.flavor_text || '').length}:${f.name}`,
        name: f.name,
        mana_cost: draft.faces[i].mana_cost,
        type_line: f.type_line,
        oracle_text: f.oracle_text,
        flavor_text: f.flavor_text || '',
      }));
      const out = await translateFn(lang, faces);
      out.forEach((r, i) => {
        if (r.source === 'untranslated') throw new Error(r.error || t('translateFailed'));
        Object.assign(draft.faces[i], {
          name: r.name,
          type_line: r.type_line,
          oracle_text: r.oracle_text,
          flavor_text: r.flavor_text ?? draft.faces[i].flavor_text,
        });
      });
      fillForm();
      schedulePreview();
      return true;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = old;
      }
    }
  }

  body.onclick = async (e) => {
    const symBtn = e.target.closest('[data-sym]');
    if (symBtn) return insertSymbol(symBtn.dataset.sym);
    const faceBtn = e.target.closest('.face-tabs [data-face]');
    if (faceBtn) {
      faceIdx = Number(faceBtn.dataset.face);
      fillForm();
      afterRender();
      return;
    }
    const artBtn = e.target.closest('[data-art-url]');
    if (artBtn) return setArt(artBtn.dataset.artUrl);
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'cancel') modal.close();
    else if (a === 'save') {
      onSave({ custom: draft, overlayBase: draft.basePrint ? null : overlayBase });
      modal.close();
    } else if (a === 'resetZones') {
      draft.layouts[faceIdx] = undefined;
      schedulePreview(0);
    } else if (a === 'autoColors') {
      draft.colors[faceIdx] = undefined;
      schedulePreview(0);
    } else if (a === 'reanalyze') {
      const base = overlayBase;
      if (!base) return;
      await forgetAnalysis(faceImage(base, faceIdx, 'png'), originalFace(base, faceIdx).name);
      draft.layouts[faceIdx] = undefined;
      body.querySelector('.analysis-info').innerHTML = `<span class="spinner"></span> ${esc(t('analyzing'))}`;
      schedulePreview(0);
    } else if (a === 'remove') {
      onRemove();
      modal.close();
    } else if (a === 'png') {
      lastCanvases.forEach((c, i) => {
        const link = document.createElement('a');
        link.download = `${(face().name || 'carta').replace(/[^\p{L}\p{N}]+/gu, '_')}${lastCanvases.length > 1 ? `_${i + 1}` : ''}.png`;
        link.href = c.toDataURL('image/png');
        link.click();
      });
    } else if (a === 'english') {
      englishFaces(card).forEach((f, i) => Object.assign(draft.faces[i], f));
      fillForm();
      schedulePreview();
    } else if (a === 'official' && off) {
      textFaces(off).forEach((f, i) =>
        Object.assign(draft.faces[i], {
          name: f.printed_name || f.name,
          type_line: f.printed_type_line || f.type_line,
          oracle_text: f.printed_text || f.oracle_text,
          flavor_text: f.flavor_text || '',
        }),
      );
      fillForm();
      schedulePreview();
    } else if (a === 'translate') {
      const lang = field('tlang').value;
      try {
        await doTranslate(lang, e.target.closest('button'));
        toast(t('translatedTo', { lang: getLanguage(lang).name }), 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
    } else if (a.startsWith('ai')) {
      await runCardAi(a, e.target.closest('button'));
    } else if (a === 'pickArt') {
      openArtPicker({
        card,
        deckLang: 'any',
        onPick: (p) => {
          if (draft.style === 'overlay') {
            // "Como la original" sobre otra edición: se reanaliza esa impresión.
            draft.basePrint = p;
            overlayBase = p;
            draft.layouts = [];
            draft.colors = [];
            schedulePreview(0);
            return;
          }
          const pf = printableFaces(p);
          setArt(pf[faceIdx]?.image?.art_crop || p.image?.art_crop || pf[0]?.image?.art_crop);
          if (!face().artist || face().artist === card.artist) face().artist = pf[faceIdx]?.artist || p.artist || '';
          fillForm();
        },
      });
    } else if (a === 'resetArt') {
      face().art = { ...(face().art || {}), zoom: 1, x: 0, y: 0 };
      fillForm();
      schedulePreview();
    } else if (a === 'searchArt') {
      const q = field('artSearch').value.trim();
      const out = body.querySelector('.art-search-results');
      if (!q) return;
      out.innerHTML = '<span class="spinner"></span>';
      try {
        const res = await sf.search(q, { unique: 'art', order: 'edhrec' });
        out.innerHTML = res.cards.length
          ? `<div class="mini-arts">${res.cards
              .slice(0, 40)
              .map((c) => {
                const art = c.image?.art_crop || c.faces?.[0]?.image?.art_crop;
                return art ? `<button type="button" data-art-url="${esc(art)}" title="${esc(c.name)} · ${esc(c.artist || '')}"><img src="${esc(art)}" alt="" loading="lazy"></button>` : '';
              })
              .join('')}</div>`
          : `<p class="small muted">${esc(t('noResults'))}</p>`;
      } catch (err) {
        out.textContent = err.message;
      }
    }
  };

  // Mantener pulsado "Ver original" muestra la carta sin cambios.
  const compareBtn = body.querySelector('[data-a="compare"]');
  const showOriginal = (on) => {
    const stage = body.querySelector(`.preview-stage[data-face="${faceIdx}"]`);
    if (!stage || !overlayBase) return;
    let img = stage.querySelector('img.original-peek');
    if (on && !img) {
      img = document.createElement('img');
      img.className = 'original-peek';
      img.src = faceImage(overlayBase, faceIdx, 'large');
      stage.append(img);
    } else if (!on && img) img.remove();
  };
  compareBtn?.addEventListener('pointerdown', () => showOriginal(true));
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) compareBtn?.addEventListener(ev, () => showOriginal(false));

  modal.onkeydown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      body.querySelector('[data-a="save"]').click();
    }
  };

  fillForm();
  body.querySelector('.analysis-info').innerHTML = draft.style === 'overlay' ? `<span class="spinner"></span> ${esc(t('analyzing'))}` : '';
  schedulePreview(0);
  if (!modal.open) modal.showModal();
}
