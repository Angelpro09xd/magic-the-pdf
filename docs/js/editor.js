/**
 * Editor completo de carta: textos (nombre, coste, tipo, reglas, ambientación, F/R, lealtad,
 * ilustrador), traducción automática a cualquier idioma, arte (de cualquier edición, de otra
 * carta, subido o por URL) con zoom y encuadre, color de marco, tamaño de letra y estilo.
 * También sirve para crear cartas personalizadas desde cero.
 */
import { LANGUAGES, getLanguage } from './languages.js';
import * as sf from './scryfall.js';
import { t } from './i18n.js';
import { printableFaces, textFaces } from './deck.js';
import { renderCustomEntry, overlayBaseFor, officialPrint, targetLang, faceKey } from './resolve.js';
import { FRAME_KEYS } from './render.js';
import { openArtPicker } from './arts.js';

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
    : { style: 'custom', frame: 'auto', fontScale: 1, faces: initialFaces(entry, deck) };
  let overlayBase = overlayBaseFor(entry);
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
              <select data-k="tlang">${LANGUAGES.map((l) => `<option value="${l.code}" ${l.code === targetLang(entry, deck) ? 'selected' : ''}>${l.flag} ${esc(l.name)}</option>`).join('')}</select>
              <button type="button" class="btn primary" data-a="translate">🌐 ${esc(t('translateCard'))}</button>
              <button type="button" class="btn" data-a="english">${esc(t('englishText'))}</button>
              ${off ? `<button type="button" class="btn" data-a="official">${esc(t('officialText'))}</button>` : ''}
            </div>`
          }
          ${card.custom ? `<div class="row"><select data-k="tlang">${LANGUAGES.map((l) => `<option value="${l.code}" ${l.code === targetLang(entry, deck) ? 'selected' : ''}>${l.flag} ${esc(l.name)}</option>`).join('')}</select><button type="button" class="btn" data-a="translate">🌐 ${esc(t('translateCustom'))}</button></div>` : ''}
        </fieldset>
        <fieldset>
          <legend>${esc(t('edArt'))}</legend>
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
          <label>${esc(t('artZoom'))} <input type="range" min="1" max="3" step="0.05" data-art="zoom"></label>
          <label>${esc(t('artX'))} <input type="range" min="-1" max="1" step="0.02" data-art="x"></label>
          <label>${esc(t('artY'))} <input type="range" min="-1" max="1" step="0.02" data-art="y"></label>
          <button type="button" class="btn small" data-a="resetArt">${esc(t('resetFraming'))}</button>
        </fieldset>
        <fieldset>
          <legend>${esc(t('edStyle'))}</legend>
          <label>${esc(t('cardStyle'))}
            <select data-d="style">
              <option value="custom">${esc(t('modeCustom'))}</option>
              ${card.custom ? '' : `<option value="overlay">${esc(t('modeOverlay'))}</option>`}
            </select>
          </label>
          <label>${esc(t('frameColor'))}
            <select data-d="frame">
              <option value="auto">${esc(t('frameAuto'))}</option>
              ${FRAME_KEYS.map((k) => `<option value="${k}">${esc(t(`frame_${k}`))}</option>`).join('')}
            </select>
          </label>
          <label>${esc(t('fontSize'))} <input type="range" min="0.7" max="1.3" step="0.05" data-d="fontScale"></label>
        </fieldset>
      </div>
      <div class="editor-preview">
        <div class="preview-canvases"><span class="spinner"></span></div>
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
    body.querySelectorAll('[data-face]').forEach((b) => b.classList.toggle('primary', Number(b.dataset.face) === faceIdx));
  }

  let timer = null;
  let renderToken = 0;
  let lastCanvases = [];
  function schedulePreview() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const token = ++renderToken;
      const slot = body.querySelector('.preview-canvases');
      try {
        const canvases = await renderCustomEntry({ card, custom: draft, overlayBase }, 'large');
        if (token !== renderToken) return;
        lastCanvases = canvases;
        slot.innerHTML = '';
        slot.append(...canvases);
      } catch (err) {
        slot.textContent = err.message;
      }
    }, 200);
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
    if (draft.style === 'overlay') draft.style = 'custom';
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
    } else if (el.dataset.d === 'fontScale') {
      draft.fontScale = Number(el.value);
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
    } else if (el.dataset.d === 'frame') draft.frame = el.value;
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

  body.onclick = async (e) => {
    const symBtn = e.target.closest('[data-sym]');
    if (symBtn) return insertSymbol(symBtn.dataset.sym);
    const faceBtn = e.target.closest('[data-face]');
    if (faceBtn) {
      faceIdx = Number(faceBtn.dataset.face);
      fillForm();
      return;
    }
    const artBtn = e.target.closest('[data-art-url]');
    if (artBtn) return setArt(artBtn.dataset.artUrl);
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'cancel') modal.close();
    else if (a === 'save') {
      onSave({ custom: draft, overlayBase });
      modal.close();
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
      const btn = e.target.closest('button');
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = `⏳ ${t('translating')}`;
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
        toast(t('translatedTo', { lang: getLanguage(lang).name }), 'ok');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    } else if (a === 'pickArt') {
      openArtPicker({
        card,
        deckLang: 'any',
        onPick: (p) => {
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

  fillForm();
  schedulePreview();
  if (!modal.open) modal.showModal();
}
