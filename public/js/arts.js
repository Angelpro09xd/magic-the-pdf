/**
 * Selector de artes: todas las impresiones de una carta (ediciones, idiomas y estilos).
 * - Modo simple: eliges una impresión.
 * - Modo múltiple (tierras básicas…): eliges varios artes y cada copia usa uno distinto.
 */
import { LANGUAGES } from './languages.js';
import * as sf from './scryfall.js';
import { t } from './i18n.js';
import { shuffle } from './deck.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STYLES = ['all', 'normal', 'borderless', 'showcase', 'extended', 'fullart', 'retro', 'etched', 'promo'];

const printsCache = new Map();
async function allPrints(oracleId) {
  if (!printsCache.has(oracleId)) {
    const p = sf.prints(oracleId, 'any');
    p.catch(() => printsCache.delete(oracleId));
    printsCache.set(oracleId, p);
  }
  return printsCache.get(oracleId);
}

/**
 * Abre el selector. opts: { card, deckLang, currentId, multi, max, selectedIds, onPick }
 * onPick(print) en modo simple; onPick([prints]) en modo múltiple.
 */
export function openArtPicker({ card, deckLang = 'en', currentId = null, multi = false, max = 1, selectedIds = [], onPick }) {
  const modal = document.getElementById('artModal');
  const body = document.getElementById('artModalBody');
  const state = {
    lang: deckLang,
    unique: !multi,
    sort: 'new',
    style: 'all',
    selected: new Set(selectedIds),
    prints: [],
  };

  body.innerHTML = `
    <h2>${esc(t('artPickerTitle', { name: card.name }))}</h2>
    <div class="row art-filters">
      <select data-f="lang">
        <option value="any">${esc(t('allLanguages'))}</option>
        ${LANGUAGES.map((l) => `<option value="${l.code}" ${l.code === state.lang ? 'selected' : ''}>${l.flag} ${esc(l.name)}</option>`).join('')}
      </select>
      <select data-f="style">${STYLES.map((s) => `<option value="${s}">${esc(t(`style_${s}`))}</option>`).join('')}</select>
      <select data-f="sort">
        <option value="new">${esc(t('sortNew'))}</option>
        <option value="old">${esc(t('sortOld'))}</option>
        <option value="cheap">${esc(t('sortCheap'))}</option>
        <option value="expensive">${esc(t('sortExpensive'))}</option>
      </select>
      <label class="check"><input type="checkbox" data-f="unique" ${state.unique ? 'checked' : ''}> ${esc(t('uniqueArt'))}</label>
    </div>
    ${multi ? `<p class="small muted">${esc(t('artMultiHelp', { max }))}</p>` : ''}
    <p class="small muted art-info"><span class="spinner"></span></p>
    <div class="art-grid"></div>
    ${
      multi
        ? `<div class="row art-actions">
            <button class="btn primary" data-a="use">${esc(t('useSelected'))}</button>
            <button class="btn" data-a="random">${esc(t('randomArts', { max }))}</button>
            <button class="btn" data-a="clear">${esc(t('singleArt'))}</button>
          </div>`
        : ''
    }`;

  const grid = body.querySelector('.art-grid');
  const info = body.querySelector('.art-info');

  const filtered = () => {
    let list = state.prints.filter((p) => state.lang === 'any' || p.lang === state.lang);
    if (state.style !== 'all') list = list.filter((p) => sf.printStyle(p).includes(state.style));
    if (state.unique) {
      const seen = new Set();
      list = list.filter((p) => {
        const k = p.illustration_id || p.id;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    const price = (p) => parseFloat(p.prices.eur || p.prices.usd || 'Infinity');
    const date = (p) => p.released_at || '';
    const sorters = {
      new: (a, b) => date(b).localeCompare(date(a)),
      old: (a, b) => date(a).localeCompare(date(b)),
      cheap: (a, b) => price(a) - price(b),
      expensive: (a, b) => (price(b) === Infinity ? -1 : price(b)) - (price(a) === Infinity ? -1 : price(a)),
    };
    return list.sort(sorters[state.sort]);
  };

  const render = () => {
    const list = filtered();
    info.textContent = list.length
      ? t('artCount', { n: list.length, total: state.prints.length })
      : state.lang !== 'any'
        ? t('noArtsInLang')
        : t('noArts');
    grid.innerHTML = list
      .map((p) => {
        const sel = multi ? state.selected.has(p.id) : p.id === currentId;
        const img = p.image?.normal || p.faces?.[0]?.image?.normal;
        const styles = sf.printStyle(p).filter((s) => s !== 'normal');
        return `<button class="art-item ${sel ? 'selected' : ''}" data-id="${p.id}" title="${esc(p.set_name)} · ${esc(p.artist || '')}">
          <img src="${esc(img)}" alt="" loading="lazy">
          <span class="lbl">${esc(p.set.toUpperCase())} #${esc(p.collector_number)} · ${esc(p.lang)}${p.prices.eur ? ` · €${p.prices.eur}` : p.prices.usd ? ` · $${p.prices.usd}` : ''}</span>
          ${styles.length ? `<span class="tags">${styles.map((s) => esc(t(`style_${s}`))).join(' · ')}</span>` : ''}
          ${multi && sel ? '<span class="check-mark">✓</span>' : ''}
        </button>`;
      })
      .join('');
  };

  body.onchange = (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    state[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    render();
  };

  body.onclick = (e) => {
    const item = e.target.closest('.art-item');
    if (item) {
      const p = state.prints.find((x) => x.id === item.dataset.id);
      if (!multi) {
        modal.close();
        onPick(p);
        return;
      }
      if (state.selected.has(p.id)) state.selected.delete(p.id);
      else if (state.selected.size < max) state.selected.add(p.id);
      render();
      return;
    }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'use') {
      modal.close();
      onPick(state.prints.filter((p) => state.selected.has(p.id)));
    } else if (a === 'random') {
      const pool = filtered();
      modal.close();
      onPick(shuffle(pool).slice(0, max));
    } else if (a === 'clear') {
      modal.close();
      onPick([]);
    }
  };

  if (!modal.open) modal.showModal();

  allPrints(card.oracle_id)
    .then((prints) => {
      // Fuera las imágenes provisionales ("Localized Image Not Available") y las que faltan.
      state.prints = prints.filter((p) => !['placeholder', 'missing'].includes(p.image_status));
      // Si no hay impresiones en el idioma del mazo, mostramos todas.
      if (!prints.some((p) => p.lang === state.lang)) {
        state.lang = 'any';
        body.querySelector('[data-f="lang"]').value = 'any';
      }
      render();
    })
    .catch((err) => {
      info.textContent = err.message;
    });
}

/** Elige una impresión de la lista según un estilo para todo el mazo. */
export function pickByStyle(prints, style, deckLang) {
  if (!prints?.length) return null;
  const inLang = prints.filter((p) => p.lang === deckLang);
  const pool = inLang.length ? inLang : prints.filter((p) => p.lang === 'en');
  const list = pool.length ? pool : prints;
  const price = (p) => parseFloat(p.prices.eur || p.prices.usd || 'Infinity');
  const date = (p) => p.released_at || '';
  const has = (p, tag) => sf.printStyle(p).includes(tag);
  switch (style) {
    case 'newest':
      return [...list].sort((a, b) => date(b).localeCompare(date(a)))[0];
    case 'oldest':
      return [...list].sort((a, b) => date(a).localeCompare(date(b)))[0];
    case 'cheapest':
      return [...list].sort((a, b) => price(a) - price(b))[0];
    case 'fancy':
      return (
        list.find((p) => has(p, 'borderless')) ||
        list.find((p) => has(p, 'showcase')) ||
        list.find((p) => has(p, 'extended')) ||
        list[0]
      );
    case 'modern':
      return list.find((p) => sf.overlayFriendly(p)) || list[0];
    default:
      return list[0];
  }
}
