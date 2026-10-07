import { LANGUAGES, getLanguage } from './languages.js';
import * as sf from './scryfall.js';
import {
  parseDeckText, exportDeckText, exportDeckCsv, validateDeck, deckStats, deckIdentity, countCards,
  canBeCommander, validPair, maxCopiesAllowed, mainType, cardRoles, printableFaces, textFaces,
  edhrecSlug, encodeShare, decodeShare, shuffle, estimateBracket, CARD_TYPES, isBasicLand,
  customCard, applyCustomFace,
} from './deck.js';
import { openEditor } from './editor.js';
import { openArtPicker, pickByStyle } from './arts.js';
import * as store from './storage.js';
import { t, setUiLang, applyStaticTranslations } from './i18n.js';
import { langStatus, officialPrint, displayName, prepareEntries, renderEntry, targetLang, faceKey } from './resolve.js';
import { buildPdf, entriesToPrint, DEFAULT_PDF_SETTINGS, PAPERS } from './pdf.js';

// ---------------------------------------------------------------- utilidades

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function manaHtml(cost, big = false) {
  const syms = (cost || '').match(/\{[^}]+\}/g) || [];
  if (!syms.length) return '';
  return `<span class="mana${big ? ' big' : ''}">${syms
    .map((s) => `<img src="https://svgs.scryfall.io/card-symbols/${s.slice(1, -1).replace(/\//g, '')}.svg" alt="${esc(s)}" loading="lazy">`)
    .join('')}</span>`;
}

function textWithSymbols(text) {
  return esc(text).replace(/\{([^}]+)\}/g, (m, s) => manaHtml(`{${s}}`));
}

function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  $('#toasts').append(node);
  setTimeout(() => node.remove(), type === 'error' ? 7000 : 3500);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function setProgress(node, done, total, label) {
  node.classList.remove('hidden');
  $('.bar', node).style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  $('.label', node).textContent = label;
}

function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const fileSafe = (s) => s.replace(/[^\p{L}\p{N}\- ]+/gu, '').trim().replace(/\s+/g, '_') || 'mazo';

const imageUrl = (card, size = 'normal') => card?.image?.[size] || card?.faces?.[0]?.image?.[size] || null;

// ---------------------------------------------------------------- estado

const settings = {
  uiLang: 'es',
  theme: 'auto',
  groupBy: 'type',
  deckView: 'list',
  pdf: { ...DEFAULT_PDF_SETTINGS, autoTranslate: true },
  ...store.loadSettings(),
};
settings.pdf = { ...DEFAULT_PDF_SETTINGS, autoTranslate: true, ...settings.pdf };

const state = {
  decks: store.loadDecks(),
  deck: null,
  ai: null,
  search: { query: '', page: 1, hasMore: false },
  edhrec: null,
  combos: null,
  tokenEntries: [],
  hand: { library: [], hand: [], mulligans: 0 },
  pdfAbort: null,
};

// Historial para deshacer/rehacer (instantáneas del mazo actual).
const history = { undo: [], redo: [], last: null, lastTime: 0 };
const snapshot = () =>
  JSON.stringify({
    name: state.deck.name,
    lang: state.deck.lang,
    notes: state.deck.notes,
    commanders: state.deck.commanders,
    cards: state.deck.cards,
  });

function recordHistory() {
  const now = snapshot();
  if (now === history.last) return;
  // Los cambios seguidos (p. ej. escribir notas) se agrupan en un solo paso.
  if (history.last !== null && (Date.now() - history.lastTime > 800 || !history.undo.length)) {
    history.undo.push(history.last);
    if (history.undo.length > 60) history.undo.shift();
  }
  history.last = now;
  history.lastTime = Date.now();
  history.redo = [];
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $('#undoBtn').disabled = !history.undo.length;
  $('#redoBtn').disabled = !history.redo.length;
}

function restoreSnapshot(json) {
  Object.assign(state.deck, JSON.parse(json));
  history.last = json;
  persistDecks();
  renderAll();
  updateHistoryButtons();
}

function undo() {
  if (!history.undo.length) return;
  history.redo.push(history.last);
  restoreSnapshot(history.undo.pop());
  toast(t('undone'));
}

function redo() {
  if (!history.redo.length) return;
  history.undo.push(history.last);
  restoreSnapshot(history.redo.pop());
  toast(t('redone'));
}

let saveTimer = null;
function persistDecks() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!store.saveDecks(state.decks)) toast(t('storageFull'), 'error');
  }, 300);
}

function saveDeck() {
  state.deck.updatedAt = Date.now();
  recordHistory();
  persistDecks();
}
const saveSettingsNow = () => store.saveSettings(settings);

function selectDeck(id) {
  state.deck = state.decks.find((d) => d.id === id) || state.decks[0];
  store.saveCurrentId(state.deck.id);
  history.undo = [];
  history.redo = [];
  history.last = snapshot();
  updateHistoryButtons();
  state.edhrec = null;
  state.combos = null;
  state.tokenEntries = [];
  state.hand = { library: [], hand: [], mulligans: 0 };
  renderAll();
}

function allEntries(deck = state.deck) {
  return [...deck.commanders, ...deck.cards];
}

// ---------------------------------------------------------------- cabecera / mazos

function renderDeckSelect() {
  const sel = $('#deckSelect');
  sel.innerHTML = state.decks
    .map((d) => `<option value="${d.id}" ${d.id === state.deck.id ? 'selected' : ''}>${esc(d.name)} (${countCards(d)})</option>`)
    .join('');
  $('#deckLang').value = state.deck.lang;
}

function bindHeader() {
  const langSel = $('#deckLang');
  langSel.innerHTML = LANGUAGES.map((l) => `<option value="${l.code}">${l.flag} ${esc(l.name)}</option>`).join('');
  langSel.addEventListener('change', () => {
    state.deck.lang = langSel.value;
    saveDeck();
    renderAll();
    toast(t('langChanged', { lang: getLanguage(langSel.value).name }));
    warmTranslator(langSel.value);
  });
  $('#deckSelect').addEventListener('change', (e) => selectDeck(e.target.value));
  $('#newDeck').addEventListener('click', () => {
    const name = prompt(t('deckNamePrompt'), t('newDeckName'));
    if (name === null) return;
    const d = store.newDeck(name.trim() || t('newDeckName'), state.deck?.lang || 'es');
    state.decks.push(d);
    saveDeckList();
    selectDeck(d.id);
  });
  $('#renameDeck').addEventListener('click', () => {
    const name = prompt(t('deckNamePrompt'), state.deck.name);
    if (!name) return;
    state.deck.name = name.trim();
    saveDeck();
    renderAll();
  });
  $('#duplicateDeck').addEventListener('click', () => {
    const copy = JSON.parse(JSON.stringify(state.deck));
    copy.id = crypto.randomUUID();
    copy.name = `${state.deck.name} (${t('copy')})`;
    state.decks.push(copy);
    saveDeckList();
    selectDeck(copy.id);
  });
  $('#deleteDeck').addEventListener('click', () => {
    if (!confirm(t('confirmDelete', { name: state.deck.name }))) return;
    state.decks = state.decks.filter((d) => d.id !== state.deck.id);
    if (!state.decks.length) state.decks.push(store.newDeck(t('newDeckName'), 'es'));
    saveDeckList();
    selectDeck(state.decks[0].id);
  });

  const ui = $('#uiLang');
  ui.value = settings.uiLang;
  ui.addEventListener('change', () => {
    settings.uiLang = ui.value;
    setUiLang(ui.value);
    saveSettingsNow();
    applyStaticTranslations();
    renderAll();
    renderAiStatus();
  });
  $('#themeToggle').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    settings.theme = order[(order.indexOf(settings.theme) + 1) % order.length];
    applyTheme();
    saveSettingsNow();
    toast(t(`theme_${settings.theme}`));
  });
}

function saveDeckList() {
  store.saveDecks(state.decks);
}

function applyTheme() {
  if (settings.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = settings.theme;
}

/** Pide al servidor que vaya preparando la memoria de traducción de ese idioma. */
async function warmTranslator(lang) {
  if (lang === 'en') return loadAiStatus();
  try {
    await api(`/api/memory/${lang}`, { method: 'POST' });
  } catch {
    // Sin servidor: se verá en la píldora de estado.
  }
  loadAiStatus();
}

let statusTimer = null;
async function loadAiStatus() {
  try {
    state.ai = await api('/api/status');
  } catch {
    state.ai = { ai: false, offline: true };
  }
  renderAiStatus();
  // Mientras se prepara la memoria de un idioma, consultamos el progreso.
  const building = Object.values(state.ai.memories || {}).some((m) => m.building);
  clearTimeout(statusTimer);
  if (building) statusTimer = setTimeout(loadAiStatus, 2500);
}

function renderAiStatus() {
  const pill = $('#aiStatus');
  if (!state.ai) return;
  if (state.ai.offline) {
    pill.className = 'pill warn';
    pill.textContent = t('serverOffline');
    return;
  }
  const mem = state.ai.memories?.[state.deck?.lang];
  if (mem?.building) {
    pill.className = 'pill warn';
    pill.textContent = t('translatorLearning', { page: mem.page, pages: mem.pages });
    pill.title = t('translatorLearningHelp');
    return;
  }
  pill.className = 'pill ok';
  pill.textContent = state.ai.ai ? t('aiOn') : t('translatorReady');
  pill.title = mem?.cards
    ? t('translatorMemory', { cards: mem.cards.toLocaleString(), templates: mem.templates.toLocaleString() })
    : t('translatorHelp');
}

// ---------------------------------------------------------------- pestañas

function bindTabs() {
  for (const nav of $$('.tabs')) {
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      const panel = nav.parentElement;
      $$('.tab', nav).forEach((b) => b.classList.toggle('active', b === btn));
      $$(':scope > .tab-panel', panel).forEach((p) => p.classList.toggle('active', p.dataset.panel === btn.dataset.tab));
      onTabShown(btn.dataset.tab);
    });
  }
}

function showTab(name) {
  $(`.tab[data-tab="${name}"]`)?.click();
}

function onTabShown(tab) {
  if (tab === 'stats') renderStats();
  if (tab === 'lang') renderLangTab();
  if (tab === 'pdf') renderPdfSummary();
  if (tab === 'hand' && !state.hand.hand.length) newHand();
}

// ---------------------------------------------------------------- añadir / quitar cartas

function findEntry(card) {
  return allEntries().find((e) => e.card?.oracle_id === card.oracle_id);
}

function addCard(card, { qty = 1, silent = false } = {}) {
  const existing = state.deck.cards.find((e) => e.card?.oracle_id === card.oracle_id);
  const isCmd = state.deck.commanders.some((e) => e.card?.oracle_id === card.oracle_id);
  if (isCmd) {
    if (!silent) toast(t('alreadyCommander', { name: card.name }));
    return;
  }
  if (existing) {
    if (existing.qty + qty > maxCopiesAllowed(card)) {
      if (!silent) toast(t('singletonBlocked', { name: card.name }), 'error');
      return;
    }
    existing.qty += qty;
  } else {
    state.deck.cards.push(store.newEntry(card, qty));
  }
  if (!silent) toast(t('added', { name: card.name }), 'ok');
  saveDeck();
  renderDeckPanels();
}

function setCommander(card) {
  const deck = state.deck;
  const inMain = deck.cards.findIndex((e) => e.card?.oracle_id === card.oracle_id);
  const entry = inMain >= 0 ? deck.cards.splice(inMain, 1)[0] : store.newEntry(card, 1);
  entry.qty = 1;
  if (deck.commanders.length === 1 && validPair(deck.commanders[0].card, card)) {
    deck.commanders.push(entry);
    toast(t('partnerAdded', { name: card.name }), 'ok');
  } else {
    if (deck.commanders.length && !confirm(t('replaceCommander', { name: card.name }))) {
      if (inMain >= 0) deck.cards.splice(inMain, 0, entry);
      return;
    }
    for (const old of deck.commanders) deck.cards.push(old);
    deck.commanders = [entry];
    toast(t('commanderSet', { name: card.name }), 'ok');
  }
  state.edhrec = null;
  state.combos = null;
  saveDeck();
  renderAll();
}

function removeEntry(entry) {
  const d = state.deck;
  d.commanders = d.commanders.filter((e) => e !== entry);
  d.cards = d.cards.filter((e) => e !== entry);
  saveDeck();
  renderDeckPanels();
}

function changeQty(entry, delta) {
  const next = entry.qty + delta;
  if (next <= 0) return removeEntry(entry);
  if (next > maxCopiesAllowed(entry.card)) {
    toast(t('singletonBlocked', { name: entry.card.name }), 'error');
    return;
  }
  entry.qty = next;
  saveDeck();
  renderDeckPanels();
}

function demoteCommander(entry) {
  state.deck.commanders = state.deck.commanders.filter((e) => e !== entry);
  state.deck.cards.push(entry);
  saveDeck();
  renderAll();
}

// ---------------------------------------------------------------- búsqueda

function buildQuery() {
  const parts = [$('#searchInput').value.trim()];
  if ($('#fCommander').checked) parts.push('is:commander');
  const identity = deckIdentity(state.deck);
  if ($('#fIdentity').checked && state.deck.commanders.length && !$('#fCommander').checked) {
    parts.push(`id<=${identity.join('') || 'c'}`);
  }
  const type = $('#fType').value;
  if (type) parts.push(`t:${type}`);
  const cmc = $('#fCmc').value;
  if (cmc) parts.push(cmc.startsWith('>') ? `mv${cmc}` : `mv=${cmc}`);
  const color = $('#fColors').value;
  if (color === 'm') parts.push('c:m');
  else if (color) parts.push(`c:${color}`);
  if ($('#fBudget').checked) parts.push('usd<1');
  if ($('#fInLang').checked && state.deck.lang !== 'en') parts.push(`lang:${state.deck.lang}`);
  parts.push('legal:commander', 'game:paper');
  return parts.filter(Boolean).join(' ');
}

async function runSearch(page = 1) {
  const query = page === 1 ? buildQuery() : state.search.query;
  if (page === 1 && !$('#searchInput').value.trim() && !$('#fCommander').checked && !$('#fType').value && !$('#fColors').value) {
    toast(t('emptySearch'));
    return;
  }
  state.search.query = query;
  state.search.page = page;
  const info = $('#searchInfo');
  info.innerHTML = `<span class="spinner"></span> ${esc(t('searching'))}`;
  try {
    const unique = query.includes('lang:') ? 'prints' : 'cards';
    const res = await sf.search(query, { order: $('#fOrder').value, unique, page });
    // Con unique=prints en otro idioma nos quedamos con una impresión por carta.
    const seen = new Set(page === 1 ? [] : $$('#searchResults [data-oracle]').map((n) => n.dataset.oracle));
    const cards = res.cards.filter((c) => !seen.has(c.oracle_id) && seen.add(c.oracle_id));
    if (page === 1) $('#searchResults').innerHTML = '';
    $('#searchResults').append(...cards.map((c) => cardTile(c)));
    state.search.hasMore = res.hasMore;
    $('#searchMore').classList.toggle('hidden', !res.hasMore);
    info.textContent = res.total ? t('results', { n: res.total, q: query }) : t('noResults', { q: query });
  } catch (err) {
    info.textContent = `${t('searchError')}: ${err.message}`;
  }
}

function cardTile(card, { actions = true, badge = '' } = {}) {
  const tile = document.createElement('div');
  tile.className = 'card-tile';
  tile.dataset.oracle = card.oracle_id;
  const img = imageUrl(card);
  tile.innerHTML = `${img ? `<img src="${esc(img)}" alt="${esc(card.printed_name || card.name)}" loading="lazy">` : `<div class="tile-text">${esc(card.name)}</div>`}
    ${badge ? `<span class="tile-badge">${esc(badge)}</span>` : ''}
    ${
      actions
        ? `<div class="tile-actions">
            <button class="btn" data-act="add" title="${esc(t('addToDeck'))}">＋</button>
            ${canBeCommander(card) || /Background/.test(card.type_line) ? `<button class="btn" data-act="cmd" title="${esc(t('setCommander'))}">👑</button>` : ''}
            <button class="btn" data-act="info">ⓘ</button>
          </div>`
        : ''
    }`;
  tile.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add') addCard(card);
    else if (act === 'cmd') setCommander(card);
    else openCardModal(card);
  });
  return tile;
}

function bindSearch() {
  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch(1);
  });
  $('#searchMore').addEventListener('click', () => runSearch(state.search.page + 1));
  let acTimer;
  $('#searchInput').addEventListener('input', (e) => {
    clearTimeout(acTimer);
    const v = e.target.value;
    if (/[:<>=]/.test(v)) return; // sintaxis avanzada: sin autocompletado
    acTimer = setTimeout(async () => {
      try {
        const names = await sf.autocomplete(v);
        $('#autocompleteList').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
      } catch {
        // sin autocompletado
      }
    }, 250);
  });
  $('#randomCommander').addEventListener('click', async () => {
    try {
      const identity = $('#fColors').value && $('#fColors').value !== 'm' ? ` id:${$('#fColors').value}` : '';
      const card = await sf.randomCard(`is:commander legal:commander game:paper${identity}`);
      openCardModal(card);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---------------------------------------------------------------- panel del mazo

function renderDeckHeader() {
  const deck = state.deck;
  const total = countCards(deck);
  const stats = deckStats(deck);
  const identity = deckIdentity(deck);
  const cmdHtml = deck.commanders.length
    ? deck.commanders
        .map((e) => `<img src="${esc(imageUrl(officialPrint(e, deck) || e.card, 'small') || imageUrl(e.card, 'normal'))}" alt="${esc(e.card.name)}" data-uid="${e.uid}">`)
        .join('')
    : `<div class="cmd-empty">${esc(t('noCommanderYet'))}</div>`;
  const lang = getLanguage(deck.lang);
  $('#deckHeader').innerHTML = `
    <div class="cmd-thumbs">${cmdHtml}</div>
    <div>
      <h2 class="deck-title">${esc(deck.name)}</h2>
      <div class="deck-meta">
        <span class="count-badge ${total === 100 ? 'ok' : total > 100 ? 'bad' : ''}">${total}/100</span>
        ${identity.length ? manaHtml(identity.map((c) => `{${c}}`).join(''), true) : deck.commanders.length ? manaHtml('{C}', true) : ''}
        <span>${lang.flag} ${esc(lang.name)}</span>
        <span>$${stats.usd.toFixed(2)} · €${stats.eur.toFixed(2)}</span>
        <span>${esc(t('avgCmc'))}: ${stats.avgCmc.toFixed(2)}</span>
      </div>
    </div>`;
  $$('#deckHeader img[data-uid]').forEach((img) =>
    img.addEventListener('click', () => openEntryModal(deck.commanders.find((e) => e.uid === img.dataset.uid))),
  );
}

function issueText(issue) {
  return t(`issue_${issue.code}`, issue.params || {});
}

function renderValidation() {
  const issues = validateDeck(state.deck);
  const node = $('#validation');
  if (!issues.length) {
    node.innerHTML = `<div class="issue ok">✔ ${esc(t('deckValid'))}</div>`;
    return;
  }
  // Agrupar issues repetidos del mismo tipo
  const grouped = new Map();
  for (const i of issues) {
    if (!grouped.has(i.code)) grouped.set(i.code, []);
    grouped.get(i.code).push(i);
  }
  node.innerHTML = [...grouped.values()]
    .map((list) => {
      if (list.length === 1 || !list[0].params?.name) return list.map((i) => `<div class="issue ${i.level}">${esc(issueText(i))}</div>`).join('');
      const names = list.map((i) => i.params.name).join(', ');
      return `<div class="issue ${list[0].level}">${esc(t(`issue_${list[0].code}_many`, { names, n: list.length }))}</div>`;
    })
    .join('');
}

function groupKey(entry, mode) {
  const c = entry.card;
  if (state.deck.commanders.includes(entry)) return { key: '0', label: t('commanderGroup') };
  if (mode === 'cmc') {
    if (mainType(c) === 'Land') return { key: '99', label: t('type_Land') };
    const n = Math.min(7, Math.floor(c.cmc));
    return { key: String(n + 1).padStart(2, '0'), label: n === 7 ? 'CMC 7+' : `CMC ${n}` };
  }
  if (mode === 'role') {
    const r = cardRoles(c)[0];
    if (mainType(c) === 'Land') return { key: 'zz', label: t('type_Land') };
    return r ? { key: r, label: t(`role_${r}`) } : { key: 'zy', label: t('role_other') };
  }
  if (mode === 'status') {
    const s = langStatus(entry, state.deck);
    return { key: s, label: t(`status_${s}`) };
  }
  const type = mainType(c);
  return { key: String(CARD_TYPES.indexOf(type) + 1).padStart(2, '0'), label: t(`type_${type}`) };
}

function statusBadge(entry) {
  const s = langStatus(entry, state.deck);
  return `<span class="status ${s}" title="${esc(t(`status_${s}_help`))}">${esc(t(`status_${s}`))}</span>`;
}

function renderDeckList() {
  const deck = state.deck;
  const mode = settings.groupBy;
  const filter = $('#deckFilter').value.trim().toLowerCase();
  const list = $('#deckList');
  const entries = allEntries().filter(
    (e) => !filter || e.card.name.toLowerCase().includes(filter) || displayName(e, deck).toLowerCase().includes(filter),
  );
  if (!allEntries().length) {
    list.innerHTML = `<div class="empty">${esc(t('emptyDeck'))}</div>`;
    return;
  }
  const groups = new Map();
  for (const e of entries) {
    const g = groupKey(e, mode);
    if (!groups.has(g.key)) groups.set(g.key, { label: g.label, entries: [] });
    groups.get(g.key).entries.push(e);
  }
  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  list.innerHTML = '';
  for (const [, g] of sorted) {
    g.entries.sort((a, b) => a.card.cmc - b.card.cmc || displayName(a, deck).localeCompare(displayName(b, deck)));
    const count = g.entries.reduce((n, e) => n + e.qty, 0);
    const section = document.createElement('div');
    section.className = 'group';
    section.innerHTML = `<h4><span>${esc(g.label)}</span><span>${count}</span></h4>`;
    if (settings.deckView === 'grid') {
      const grid = document.createElement('div');
      grid.className = 'card-grid';
      for (const e of g.entries) {
        const card = officialPrint(e, deck) || e.card;
        const tile = cardTile(card, { actions: false, badge: e.qty > 1 ? `×${e.qty}` : '' });
        tile.onclick = () => openEntryModal(e);
        // Las cartas editadas o traducidas se muestran tal como se imprimirán.
        if (e.custom || (!officialPrint(e, deck) && e.translation?.lang === targetLang(e, deck))) {
          renderEntry(e, deck, { ...settings.pdf, quality: 'large' })
            .then(([canvas]) => {
              if (!canvas) return;
              tile.querySelector('img, .tile-text')?.replaceWith(canvas);
            })
            .catch(() => {});
        }
        grid.append(tile);
      }
      section.append(grid);
    } else {
      for (const e of g.entries) section.append(deckRow(e));
    }
    list.append(section);
  }
}

function deckRow(e) {
  const deck = state.deck;
  const row = document.createElement('div');
  row.className = 'deck-row';
  const c = e.card;
  const local = displayName(e, deck);
  const isCmd = deck.commanders.includes(e);
  const flags = [];
  if (c.legal === 'banned') flags.push(t('banned'));
  if (deck.commanders.length && c.color_identity.some((col) => !deckIdentity(deck).includes(col))) flags.push(t('offColor'));
  if (c.game_changer) flags.push('GC');
  row.innerHTML = `
    <div class="qty">
      ${isCmd ? '<span>👑</span>' : `<button class="btn icon" data-act="minus">−</button><span>${e.qty}</span><button class="btn icon" data-act="plus">＋</button>`}
    </div>
    <div class="name" data-act="info">${esc(local)}${local !== c.name ? `<small>${esc(c.name)}</small>` : ''}${e.variants?.length ? `<small>🎨×${e.variants.length}</small>` : ''}${flags.length ? `<span class="flag">${esc(flags.join(' · '))}</span>` : ''}</div>
    ${manaHtml(c.mana_cost)}
    ${statusBadge(e)}
    <div class="row-actions">
      ${c.custom ? '' : `<button class="btn" data-act="art" title="${esc(t('chooseArt'))}">🎨</button>`}
      <button class="btn" data-act="edit" title="${esc(t('openEditor'))}">✏️</button>
    </div>
    <div class="price">${c.prices?.eur ? `€${c.prices.eur}` : c.prices?.usd ? `$${c.prices.usd}` : ''}</div>`;
  row.addEventListener('click', (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'minus') changeQty(e, -1);
    else if (act === 'plus') changeQty(e, 1);
    else if (act === 'info') openEntryModal(e);
    else if (act === 'art') chooseArt(e);
    else if (act === 'edit') editEntry(e);
  });
  const nameNode = $('.name', row);
  nameNode.addEventListener('mouseenter', (ev) => showHover(officialPrint(e, deck) || c, ev));
  nameNode.addEventListener('mousemove', moveHover);
  nameNode.addEventListener('mouseleave', hideHover);
  return row;
}

// ---------------------------------------------------------------- arte y editor

/** Abre el selector de artes de una entrada (varios artes si es una básica con varias copias). */
function chooseArt(entry) {
  const multi = isBasicLand(entry.card) && entry.qty > 1;
  openArtPicker({
    card: entry.card,
    deckLang: targetLang(entry, state.deck),
    currentId: entry.card.id,
    multi,
    max: entry.qty,
    selectedIds: (entry.variants || []).map((v) => v.id),
    onPick: (picked) => {
      if (multi) {
        if (picked.length > 1) {
          entry.variants = picked;
          entry.card = picked[0];
        } else {
          delete entry.variants;
          if (picked[0]) entry.card = picked[0];
        }
      } else {
        setPrint(entry, picked);
      }
      saveDeck();
      renderDeckPanels();
      toast(t('artChanged'), 'ok');
    },
  });
}

/** Cambia la impresión de una entrada conservando traducción y edición. */
function setPrint(entry, print) {
  entry.card = print;
  delete entry.localized;
  delete entry.searched;
  delete entry.overlayBase;
  if (entry.custom) {
    printableFaces(print).forEach((f, i) => {
      const face = entry.custom.faces[i];
      if (face) face.art = { ...(face.art || {}), url: f.image?.art_crop || print.image?.art_crop, zoom: 1, x: 0, y: 0 };
    });
  }
}

function editEntry(entry) {
  openEditor({
    entry,
    deck: state.deck,
    translateFn: translateApi,
    toast,
    onSave: ({ custom, overlayBase }) => {
      entry.custom = custom;
      if (overlayBase) entry.overlayBase = overlayBase;
      if (entry.card.custom) applyCustomFace(entry.card, custom.faces[0]);
      saveDeck();
      renderDeckPanels();
      toast(t('cardSaved'), 'ok');
    },
    onRemove: () => {
      delete entry.custom;
      saveDeck();
      renderDeckPanels();
    },
  });
}

/** Crea una carta personalizada desde cero y abre el editor. */
function newCustomCard() {
  const face = {
    name: t('customCardName'),
    mana_cost: '{2}{G}',
    type_line: t('customCardType'),
    oracle_text: '',
    flavor_text: '',
    power: '2',
    toughness: '2',
    loyalty: '',
    defense: '',
    artist: '',
    art: { url: '', zoom: 1, x: 0, y: 0 },
  };
  const card = customCard(face, state.deck.lang);
  const entry = { ...store.newEntry(card, 1), custom: { style: 'custom', frame: 'auto', fontScale: 1, faces: [face] } };
  openEditor({
    entry,
    deck: state.deck,
    translateFn: translateApi,
    toast,
    onSave: ({ custom }) => {
      entry.custom = custom;
      applyCustomFace(card, custom.faces[0]);
      state.deck.cards.push(entry);
      saveDeck();
      renderDeckPanels();
      toast(t('added', { name: card.name }), 'ok');
    },
  });
}

/** Cambia el arte de todo el mazo según un estilo (salvo tierras básicas y cartas personalizadas). */
async function applyBulkArt() {
  const style = $('#bulkArtStyle').value;
  const deck = state.deck;
  const entries = allEntries().filter((e) => !e.card.custom && !isBasicLand(e.card));
  if (!entries.length) return toast(t('emptyDeck'));
  const progress = $('#bulkArtProgress');
  const btn = $('#bulkArtApply');
  btn.disabled = true;
  try {
    const langs = deck.lang === 'en' ? 'lang:en' : `(lang:${deck.lang} or lang:en)`;
    const byOracle = await sf.printsForCards(
      entries.map((e) => e.card),
      langs,
      (d, n) => setProgress(progress, d, n, `${t('searching')} ${d}/${n}`),
    );
    let changed = 0;
    for (const e of entries) {
      const p = pickByStyle(byOracle.get(e.card.oracle_id), style, targetLang(e, deck));
      if (p && p.id !== e.card.id) {
        setPrint(e, p);
        changed++;
      }
    }
    saveDeck();
    renderDeckPanels();
    toast(t('bulkArtDone', { n: changed }), 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    progress.classList.add('hidden');
  }
}

function renderTokens() {
  const tokens = new Map();
  for (const e of allEntries()) for (const tk of e.card.tokens || []) tokens.set(tk.name, tk);
  const node = $('#tokensList');
  if (!tokens.size) {
    node.innerHTML = '';
    return;
  }
  node.innerHTML = `<div class="tokens"><strong>${esc(t('tokensMade'))}:</strong> <span class="chips">${[...tokens.values()]
    .map((tk) => `<span class="chip" data-id="${tk.id}"><span class="nm">${esc(tk.name)}</span></span>`)
    .join('')}</span></div>`;
  $$('.chip', node).forEach((chip) =>
    chip.addEventListener('click', async () => openCardModal(await sf.byId(chip.dataset.id))),
  );
}

// Vista previa al pasar el ratón
function showHover(card, ev) {
  const url = imageUrl(card, 'normal');
  if (!url || matchMedia('(hover: none)').matches) return;
  const node = $('#hoverPreview');
  node.innerHTML = `<img src="${esc(url)}" alt="">`;
  node.classList.remove('hidden');
  moveHover(ev);
}
function moveHover(ev) {
  const node = $('#hoverPreview');
  const x = ev.clientX + 20 + 250 > innerWidth ? ev.clientX - 270 : ev.clientX + 20;
  const y = Math.min(ev.clientY - 40, innerHeight - 360);
  node.style.left = `${x}px`;
  node.style.top = `${Math.max(8, y)}px`;
}
function hideHover() {
  $('#hoverPreview').classList.add('hidden');
}

function renderDeckPanels() {
  renderDeckSelect();
  renderDeckHeader();
  renderValidation();
  renderDeckList();
  renderTokens();
  const active = $('.tabs[data-group="right"] .tab.active')?.dataset.tab;
  if (active && active !== 'deck') onTabShown(active);
}

function renderAll() {
  applyStaticTranslations();
  $('#deckNotes').value = state.deck.notes || '';
  $('#groupBy').value = settings.groupBy;
  $('#deckView').value = settings.deckView;
  renderDeckPanels();
  renderEdhrec();
  renderCombos();
}

function bindDeckPanel() {
  $('#groupBy').addEventListener('change', (e) => {
    settings.groupBy = e.target.value;
    saveSettingsNow();
    renderDeckList();
  });
  $('#deckView').addEventListener('change', (e) => {
    settings.deckView = e.target.value;
    saveSettingsNow();
    renderDeckList();
  });
  $('#deckFilter').addEventListener('input', renderDeckList);
  $('#deckNotes').addEventListener('input', (e) => {
    state.deck.notes = e.target.value;
    saveDeck();
  });
}

// ---------------------------------------------------------------- modal de carta

async function openEntryModal(entry) {
  if (entry) openCardModal(entry.card, entry);
}

async function openCardModal(card, entry = findEntry(card)) {
  const modal = $('#cardModal');
  const body = $('#cardModalBody');
  const deck = state.deck;
  const inDeck = Boolean(entry && allEntries().includes(entry));
  const off = entry ? officialPrint(entry, deck) : card.lang === deck.lang ? card : null;
  const shown = off || card;
  const faces = textFaces(card);
  const translation = entry?.translation?.lang === targetLang(entry, deck) ? entry.translation : null;

  body.innerHTML = `
    <div class="modal-grid">
      <div class="images" id="modalImages">
        ${printableFaces(shown).map((f) => `<img src="${esc(f.image?.normal || imageUrl(shown))}" alt="${esc(f.name)}">`).join('')}
      </div>
      <div>
        <h2>${esc(shown.printed_name || card.name)} ${manaHtml(card.mana_cost, true)}</h2>
        ${shown.printed_name && shown.printed_name !== card.name ? `<div class="muted">${esc(card.name)}</div>` : ''}
        <p class="muted">${esc(shown.printed_type_line || card.type_line)}</p>
        ${faces.map((f) => `<div class="oracle">${faces.length > 1 ? `<strong>${esc(f.name)}</strong>\n` : ''}${textWithSymbols(f.oracle_text)}${f.power != null ? `\n<strong>${esc(f.power)}/${esc(f.toughness)}</strong>` : ''}${f.loyalty != null ? `\n<strong>${esc(t('loyalty'))}: ${esc(f.loyalty)}</strong>` : ''}</div>`).join('')}
        ${translation ? translation.faces.map((f) => `<div class="oracle translated"><strong>${esc(f.name)}</strong> — <em>${esc(f.type_line)}</em>\n${textWithSymbols(f.oracle_text)}</div>`).join('') + `<p class="small muted">${esc(t(`status_${langStatus(entry, deck)}`))}</p>` : ''}
        <div class="row">
          ${inDeck ? '' : `<button class="btn primary" data-act="add">${esc(t('addToDeck'))}</button>`}
          ${canBeCommander(card) || /Background/.test(card.type_line) ? `<button class="btn" data-act="cmd">👑 ${esc(t('setCommander'))}</button>` : ''}
          ${inDeck && deck.commanders.includes(entry) ? `<button class="btn" data-act="demote">${esc(t('moveToDeck'))}</button>` : ''}
          ${inDeck ? `<button class="btn danger" data-act="remove">${esc(t('remove'))}</button>` : ''}
        </div>
        <div class="row">
          ${card.custom ? '' : `<button class="btn" data-act="art">🎨 ${esc(t('chooseArt'))}</button>`}
          ${inDeck ? `<button class="btn" data-act="editor">✏️ ${esc(t('openEditor'))}</button>` : ''}
          ${inDeck && !card.custom ? `<button class="btn" data-act="edit">📝 ${esc(t('editTranslation'))}</button>` : ''}
        </div>
        ${inDeck ? `<div class="row small">
            <label>${esc(t('cardLangOverride'))}
              <select data-act="lang"><option value="">${esc(t('deckDefault'))}</option>${LANGUAGES.map((l) => `<option value="${l.code}" ${entry.lang === l.code ? 'selected' : ''}>${l.flag} ${esc(l.name)}</option>`).join('')}</select>
            </label>
            <label>${esc(t('renderMode'))}
              <select data-act="mode">
                ${['auto', 'overlay', 'custom', 'original'].map((m) => `<option value="${m}" ${(entry.renderMode || 'auto') === m ? 'selected' : ''}>${esc(t(`mode_${m}`))}</option>`).join('')}
              </select>
            </label>
            <label class="check"><input type="checkbox" data-act="skip" ${entry.skipPrint ? 'checked' : ''}> ${esc(t('skipPrint'))}</label>
          </div>` : ''}
        <dl class="kv">
          <dt>${esc(t('edition'))}</dt><dd>${esc(shown.set_name)} (${esc(shown.set?.toUpperCase())} #${esc(shown.collector_number)}) · ${esc(shown.rarity)}</dd>
          <dt>${esc(t('legality'))}</dt><dd>${esc(t(`legal_${card.legal}`))}${card.game_changer ? ' · Game Changer' : ''}</dd>
          <dt>${esc(t('price'))}</dt><dd>${card.prices?.usd ? `$${card.prices.usd}` : '—'} · ${card.prices?.eur ? `€${card.prices.eur}` : '—'}</dd>
          ${card.edhrec_rank ? `<dt>EDHREC</dt><dd>#${card.edhrec_rank}</dd>` : ''}
          <dt>${esc(t('roles'))}</dt><dd>${cardRoles(card).map((r) => esc(t(`role_${r}`))).join(', ') || '—'}</dd>
        </dl>
        ${
          card.custom
            ? ''
            : `<div class="row small">
          <a href="${esc(card.scryfall_uri)}" target="_blank" rel="noopener">Scryfall</a>
          ${card.related?.edhrec ? `<a href="${esc(card.related.edhrec)}" target="_blank" rel="noopener">EDHREC</a>` : ''}
          ${card.purchase?.cardmarket ? `<a href="${esc(card.purchase.cardmarket)}" target="_blank" rel="noopener">Cardmarket</a>` : ''}
          ${card.purchase?.tcgplayer ? `<a href="${esc(card.purchase.tcgplayer)}" target="_blank" rel="noopener">TCGplayer</a>` : ''}
        </div>
        <h3>${esc(t('rulings'))}</h3>
        <button class="btn small" data-act="rulings">${esc(t('showRulings'))}</button>
        <div id="rulingsOut"></div>`
        }
        <div id="modalEditor"></div>
      </div>
    </div>`;

  // Vista previa de la carta traducida o editada, tal como se imprimirá
  if (entry && (translation || entry.custom)) {
    renderEntry(entry, deck, settings.pdf)
      .then((canvases) => {
        const imgs = $('#modalImages');
        if (!imgs) return;
        imgs.innerHTML = '';
        imgs.append(...canvases);
      })
      .catch(() => {});
  }

  body.onclick = async (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (!act || ev.target.tagName === 'SELECT' || ev.target.type === 'checkbox') return;
    if (act === 'add') {
      addCard(card);
      modal.close();
    } else if (act === 'cmd') {
      setCommander(card);
      modal.close();
    } else if (act === 'remove') {
      removeEntry(entry);
      modal.close();
    } else if (act === 'demote') {
      demoteCommander(entry);
      modal.close();
    } else if (act === 'edit') {
      openTranslationEditor(entry, $('#modalEditor'));
    } else if (act === 'rulings') {
      const out = $('#rulingsOut');
      out.innerHTML = '<span class="spinner"></span>';
      try {
        const list = await sf.rulings(card.id);
        out.innerHTML = list.length
          ? `<ul class="rulings">${list.map((r) => `<li><strong>${esc(r.published_at)}</strong>: ${textWithSymbols(r.comment)}</li>`).join('')}</ul>`
          : `<p class="muted">${esc(t('noRulings'))}</p>`;
      } catch (err) {
        out.textContent = err.message;
      }
    } else if (act === 'editor') {
      modal.close();
      editEntry(entry);
    } else if (act === 'art') {
      if (inDeck) {
        modal.close();
        chooseArt(entry);
      } else {
        openArtPicker({ card, deckLang: deck.lang, currentId: card.id, onPick: (p) => openCardModal(p) });
      }
    }
  };
  body.onchange = (ev) => {
    const act = ev.target.dataset.act;
    if (!entry) return;
    if (act === 'lang') entry.lang = ev.target.value || undefined;
    else if (act === 'mode') entry.renderMode = ev.target.value === 'auto' ? undefined : ev.target.value;
    else if (act === 'skip') entry.skipPrint = ev.target.checked || undefined;
    else return;
    saveDeck();
    renderDeckPanels();
  };
  if (!modal.open) modal.showModal();
}

// ---------------------------------------------------------------- idioma y traducción

async function translateApi(lang, faces) {
  const res = await api('/api/translate', { method: 'POST', body: { lang, cards: faces } });
  return res.translations;
}

async function runPrepare({ translate = true, retranslateMachine = false } = {}) {
  const deck = state.deck;
  const entries = allEntries();
  if (!entries.length) return toast(t('emptyDeck'));
  if (retranslateMachine) {
    for (const e of entries) {
      if (e.translation && e.translation.source !== 'manual') delete e.translation;
    }
  }
  const progress = $('#prepareProgress');
  const buttons = ['#prepareBtn', '#searchOnlyBtn', '#retranslateBtn'].map((s) => $(s));
  buttons.forEach((b) => (b.disabled = true));
  try {
    await prepareEntries(entries, deck, {
      translate,
      translateFn: translateApi,
      onProgress: ({ phase, done, total }) => setProgress(progress, done, total, `${t(`phase_${phase}`)} ${done}/${total}`),
    });
    saveDeck();
    const failed = entries.filter((e) => e.translationError);
    if (failed.length) toast(t('someFailed', { n: failed.length, err: failed[0].translationError }), 'error');
    else toast(t('prepareDone'), 'ok');
  } catch (err) {
    toast(`${t('prepareError')}: ${err.message}`, 'error');
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    progress.classList.add('hidden');
    renderDeckPanels();
    renderLangTab();
  }
}

function renderLangTab() {
  const deck = state.deck;
  const entries = allEntries();
  const counts = {};
  for (const e of entries) {
    const s = langStatus(e, deck);
    counts[s] = (counts[s] || 0) + 1;
  }
  $('#langSummary').innerHTML = Object.entries(counts)
    .map(([s, n]) => `<span class="status ${s}">${esc(t(`status_${s}`))}: ${n}</span>`)
    .join('');
  const list = $('#langList');
  if (!entries.length) {
    list.innerHTML = `<div class="empty">${esc(t('emptyDeck'))}</div>`;
    return;
  }
  const order = ['pending', 'missing', 'machine', 'auto', 'ai', 'memory', 'official-text', 'manual', 'custom', 'official', 'original'];
  const sorted = [...entries].sort(
    (a, b) => order.indexOf(langStatus(a, deck)) - order.indexOf(langStatus(b, deck)) || a.card.name.localeCompare(b.card.name),
  );
  list.innerHTML = '';
  for (const e of sorted) {
    const row = document.createElement('div');
    row.className = 'lang-row';
    const shown = officialPrint(e, deck) || e.card;
    const lang = getLanguage(targetLang(e, deck));
    row.innerHTML = `
      ${imageUrl(shown, 'small') ? `<img src="${esc(imageUrl(shown, 'small'))}" alt="" loading="lazy">` : '<span>✨</span>'}
      <div class="names">
        <div>${esc(displayName(e, deck))} ${e.lang ? `<span class="small">${lang.flag}</span>` : ''}</div>
        <div class="en">${esc(e.card.name)}</div>
        ${e.translationError ? `<div class="err">${esc(e.translationError)}</div>` : ''}
      </div>
      ${statusBadge(e)}
      <div class="button-wrap">
        <button class="btn small" data-act="preview">${esc(t('preview'))}</button>
        ${e.card.custom ? '' : `<button class="btn small" data-act="edit">📝 ${esc(t('quickEdit'))}</button>`}
        <button class="btn small" data-act="editor">✏️ ${esc(t('openEditor'))}</button>
      </div>
      <div class="editor-slot" style="grid-column: 1 / -1"></div>`;
    row.addEventListener('click', async (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      const slot = $('.editor-slot', row);
      if (act === 'edit') openTranslationEditor(e, slot);
      else if (act === 'editor') editEntry(e);
      else if (act === 'preview') {
        slot.innerHTML = '<span class="spinner"></span>';
        try {
          const canvases = await renderEntry(e, deck, settings.pdf);
          slot.innerHTML = '';
          const wrap = document.createElement('div');
          wrap.className = 'card-grid';
          for (const c of canvases) {
            const tile = document.createElement('div');
            tile.className = 'card-tile';
            tile.append(c);
            wrap.append(tile);
          }
          slot.append(wrap);
        } catch (err) {
          slot.textContent = err.message;
        }
      }
    });
    list.append(row);
  }
}

function openTranslationEditor(entry, container) {
  const deck = state.deck;
  const lang = targetLang(entry, deck);
  const faces = textFaces(entry.card);
  const current = entry.translation?.lang === lang ? entry.translation.faces : null;
  const off = officialPrint(entry, deck);
  container.innerHTML = `
    <div class="editor">
      ${off ? `<p class="small muted">${esc(t('officialExistsNote'))}</p>` : ''}
      <div class="editor-grid">
        <div>
          ${faces
            .map(
              (f, i) => `
            <fieldset style="border:none;padding:0;margin:0 0 8px">
              ${faces.length > 1 ? `<strong>${esc(f.name)}</strong>` : ''}
              <label>${esc(t('fieldName'))}</label><input data-f="${i}" data-k="name" value="${esc(current?.[i]?.name ?? f.name)}">
              <label>${esc(t('fieldType'))}</label><input data-f="${i}" data-k="type_line" value="${esc(current?.[i]?.type_line ?? f.type_line)}">
              <label>${esc(t('fieldText'))}</label><textarea data-f="${i}" data-k="oracle_text" rows="6">${esc(current?.[i]?.oracle_text ?? f.oracle_text)}</textarea>
              <div class="small muted">EN: ${textWithSymbols(f.oracle_text)}</div>
            </fieldset>`,
            )
            .join('')}
          <div class="row">
            <button class="btn primary" data-ed="save">${esc(t('saveTranslation'))}</button>
            <button class="btn" data-ed="preview">${esc(t('preview'))}</button>
            <button class="btn" data-ed="ai">${esc(t('retranslateOne'))}</button>
            ${current ? `<button class="btn danger" data-ed="clear">${esc(t('clearTranslation'))}</button>` : ''}
          </div>
        </div>
        <div class="ed-preview"></div>
      </div>
    </div>`;
  const collect = () =>
    faces.map((f, i) => ({
      name: $(`[data-f="${i}"][data-k="name"]`, container).value.trim(),
      type_line: $(`[data-f="${i}"][data-k="type_line"]`, container).value.trim(),
      oracle_text: $(`[data-f="${i}"][data-k="oracle_text"]`, container).value.trim(),
    }));
  const preview = async () => {
    const slot = $('.ed-preview', container);
    slot.innerHTML = '<span class="spinner"></span>';
    const temp = { ...entry, localized: undefined, card: entry.card.lang === lang ? { ...entry.card, lang: 'en' } : entry.card, translation: { lang, source: 'manual', faces: collect() } };
    try {
      const canvases = await renderEntry(temp, deck, settings.pdf);
      slot.innerHTML = '';
      slot.append(...canvases);
    } catch (err) {
      slot.textContent = err.message;
    }
  };
  container.onclick = async (ev) => {
    const act = ev.target.closest('[data-ed]')?.dataset.ed;
    if (!act) return;
    if (act === 'save') {
      entry.translation = { lang, source: 'manual', faces: collect() };
      if (off) entry.renderMode = entry.renderMode || 'overlay';
      saveDeck();
      toast(t('translationSaved'), 'ok');
      renderDeckPanels();
      preview();
    } else if (act === 'preview') preview();
    else if (act === 'clear') {
      delete entry.translation;
      saveDeck();
      renderDeckPanels();
      container.innerHTML = '';
    } else if (act === 'ai') {
      ev.target.disabled = true;
      try {
        const res = await translateApi(
          lang,
          faces.map((f, i) => ({ key: `${faceKey(entry.card, i)}:${Date.now()}`, name: f.name, mana_cost: f.mana_cost, type_line: f.type_line, oracle_text: f.oracle_text })),
        );
        res.forEach((r, i) => {
          $(`[data-f="${i}"][data-k="name"]`, container).value = r.name;
          $(`[data-f="${i}"][data-k="type_line"]`, container).value = r.type_line;
          $(`[data-f="${i}"][data-k="oracle_text"]`, container).value = r.oracle_text;
        });
        toast(t(`status_${res[0].source === 'official' ? 'official-text' : res[0].source}`));
        preview();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        ev.target.disabled = false;
      }
    }
  };
  preview();
}

// ---------------------------------------------------------------- análisis

const ROLE_TARGETS = { ramp: [10, 14], draw: [10, 14], removal: [8, 12], wipe: [2, 4], tutor: [0, 5], counter: [0, 6], protection: [2, 6] };

function hbar(label, n, max, cls = '') {
  const pct = max ? Math.min(100, (n / max) * 100) : 0;
  return `<div class="hbar"><span>${esc(label)}</span><div class="track"><div class="fill ${cls}" style="width:${pct}%"></div></div><span class="n">${n}</span></div>`;
}

function renderStats() {
  const deck = state.deck;
  const s = deckStats(deck);
  const out = $('#statsOut');
  if (!s.total) {
    out.innerHTML = `<div class="empty">${esc(t('emptyDeck'))}</div>`;
    return;
  }
  const maxCurve = Math.max(...s.curve, 1);
  const twoCardCombos = state.combos?.included?.filter((c) => c.cards.length <= 2).length || 0;
  const bracket = estimateBracket(s, twoCardCombos);
  const lands = s.types.Land || 0;
  const maxType = Math.max(...Object.values(s.types), 1);
  const colorNames = { W: t('color_W'), U: t('color_U'), B: t('color_B'), R: t('color_R'), G: t('color_G'), C: t('color_C') };
  const pipTotal = Object.values(s.pips).reduce((a, b) => a + b, 0) || 1;

  out.innerHTML = `
    <div class="stat-card">
      <h4>${esc(t('summary'))}</h4>
      <div class="big-number">${s.total} <span class="small muted">${esc(t('cards'))}</span></div>
      <div>${esc(t('avgCmc'))}: <strong>${s.avgCmc.toFixed(2)}</strong></div>
      <div>${esc(t('lands'))}: <strong>${lands}</strong> <span class="small muted">(${esc(t('landsRecommended'))})</span></div>
      <div>${esc(t('value'))}: <strong>$${s.usd.toFixed(2)}</strong> · <strong>€${s.eur.toFixed(2)}</strong></div>
    </div>
    <div class="stat-card">
      <h4>${esc(t('bracket'))}</h4>
      <div class="big-number">${bracket} <span class="small muted">/ 5</span></div>
      <div class="small">${esc(t(`bracket_${bracket}`))}</div>
      <div class="small muted">Game Changers (${s.gameChangers.length}): ${esc(s.gameChangers.join(', ') || '—')}</div>
      <div class="small muted">${esc(state.combos ? t('combosCounted', { n: twoCardCombos }) : t('bracketCombosHint'))}</div>
    </div>
    <div class="stat-card" style="grid-column: span 2; min-width: 0">
      <h4>${esc(t('manaCurve'))}</h4>
      <div class="curve">${s.curve
        .map((n, i) => `<div class="col"><span class="n">${n || ''}</span><div class="bar" style="height:${(n / maxCurve) * 100}%"></div><span>${i === 7 ? '7+' : i}</span></div>`)
        .join('')}</div>
    </div>
    <div class="stat-card">
      <h4>${esc(t('types'))}</h4>
      ${Object.entries(s.types).sort((a, b) => b[1] - a[1]).map(([k, n]) => hbar(t(`type_${k}`), n, maxType)).join('')}
    </div>
    <div class="stat-card">
      <h4>${esc(t('roles'))}</h4>
      ${Object.entries(s.roles)
        .map(([r, n]) => {
          const [lo, hi] = ROLE_TARGETS[r];
          const cls = n < lo ? 'low' : n <= hi ? 'good' : '';
          return hbar(`${t(`role_${r}`)} (${lo}-${hi})`, n, hi * 1.3, cls);
        })
        .join('')}
      <p class="small muted">${esc(t('rolesHint'))}</p>
    </div>
    <div class="stat-card">
      <h4>${esc(t('colorBalance'))}</h4>
      ${Object.entries(s.pips)
        .filter(([, n]) => n)
        .map(([c, n]) => `${hbar(`${colorNames[c]} ${Math.round((n / pipTotal) * 100)}%`, n, pipTotal)}<div class="small muted" style="margin:-2px 0 4px 106px">${esc(t('sources'))}: ${s.sources[c]}</div>`)
        .join('') || `<p class="muted small">—</p>`}
    </div>
    <div class="stat-card">
      <h4>${esc(t('suggestions'))}</h4>
      <ul class="small">${suggestions(s, lands).map((x) => `<li>${esc(x)}</li>`).join('') || `<li>${esc(t('looksGood'))}</li>`}</ul>
    </div>`;
}

function suggestions(s, lands) {
  const out = [];
  if (lands < 34) out.push(t('sugLands', { n: lands }));
  if (lands > 40) out.push(t('sugTooManyLands', { n: lands }));
  for (const [r, [lo]] of Object.entries(ROLE_TARGETS)) if (lo && s.roles[r] < lo) out.push(t('sugRole', { role: t(`role_${r}`), n: s.roles[r], lo }));
  if (s.avgCmc > 3.6) out.push(t('sugCurve', { n: s.avgCmc.toFixed(2) }));
  for (const [c, pips] of Object.entries(s.pips)) {
    if (c !== 'C' && pips > 10 && s.sources[c] < 10) out.push(t('sugSources', { color: t(`color_${c}`), n: s.sources[c] }));
  }
  return out;
}

// ---------------------------------------------------------------- mano de prueba

function newHand() {
  const lib = [];
  for (const e of state.deck.cards) for (let i = 0; i < e.qty; i++) lib.push(e);
  state.hand.library = shuffle(lib);
  state.hand.hand = state.hand.library.splice(0, 7);
  state.hand.mulligans = 0;
  renderHand();
}

function mulligan() {
  state.hand.mulligans++;
  const lib = [...state.hand.library, ...state.hand.hand];
  state.hand.library = shuffle(lib);
  state.hand.hand = state.hand.library.splice(0, 7);
  renderHand();
}

function drawCard() {
  if (!state.hand.library.length) return;
  state.hand.hand.push(state.hand.library.shift());
  renderHand();
}

function hypergeom(N, K, n, k) {
  const comb = (a, b) => {
    if (b < 0 || b > a) return 0;
    let r = 1;
    for (let i = 1; i <= b; i++) r = (r * (a - b + i)) / i;
    return r;
  };
  return (comb(K, k) * comb(N - K, n - k)) / comb(N, n);
}

function renderHand() {
  const deck = state.deck;
  const { hand, mulligans, library } = state.hand;
  const out = $('#handOut');
  out.innerHTML = '';
  if (!deck.cards.length) {
    out.innerHTML = `<div class="empty">${esc(t('emptyDeck'))}</div>`;
    return;
  }
  for (const e of hand) {
    const tile = cardTile(officialPrint(e, deck) || e.card, { actions: false });
    tile.onclick = () => openEntryModal(e);
    out.append(tile);
  }
  const lands = hand.filter((e) => mainType(e.card) === 'Land').length;
  $('#handInfo').textContent = t('handInfo', { n: hand.length, lands, lib: library.length, m: mulligans, bottom: Math.max(0, mulligans - 1) });
  const N = deck.cards.reduce((n, e) => n + e.qty, 0);
  const K = deck.cards.filter((e) => mainType(e.card) === 'Land').reduce((n, e) => n + e.qty, 0);
  if (N >= 7) {
    let p = 0;
    for (let k = 2; k <= 5; k++) p += hypergeom(N, K, 7, k);
    $('#handOdds').textContent = t('handOdds', { p: Math.round(p * 100), K, N });
  }
}

// ---------------------------------------------------------------- EDHREC

async function loadEdhrec() {
  const cmds = state.deck.commanders.map((e) => e.card.name);
  if (!cmds.length) return toast(t('needCommander'), 'error');
  const out = $('#edhrecOut');
  out.innerHTML = '<span class="spinner"></span>';
  try {
    state.edhrec = await api(`/api/edhrec/${edhrecSlug(cmds)}`);
  } catch (err) {
    state.edhrec = null;
    out.innerHTML = `<p class="muted">${esc(t('edhrecError'))} (${esc(err.message)})</p>`;
    return;
  }
  renderEdhrec();
}

function renderEdhrec() {
  const out = $('#edhrecOut');
  if (!state.edhrec) {
    out.innerHTML = '';
    return;
  }
  const owned = new Set(allEntries().map((e) => e.card.name));
  const hide = $('#edhrecHideOwned').checked;
  out.innerHTML = `${state.edhrec.numDecks ? `<p class="small muted">${esc(t('edhrecDecks', { n: state.edhrec.numDecks.toLocaleString() }))}</p>` : ''}${state.edhrec.lists
    .map((l) => {
      const cards = l.cards.filter((c) => !hide || !owned.has(c.name));
      if (!cards.length) return '';
      return `<h3>${esc(l.header)}</h3><div class="chips">${cards
        .map(
          (c) => `<span class="chip ${owned.has(c.name) ? 'owned' : ''}" data-name="${esc(c.name)}">
            <span class="nm">${esc(c.name)}</span>
            <span class="meta">${c.inclusion != null ? `${Math.round(c.inclusion * 100)}%` : ''}${c.synergy ? ` · ${c.synergy > 0 ? '+' : ''}${Math.round(c.synergy * 100)}%` : ''}</span>
            ${owned.has(c.name) ? '' : '<button class="btn small" data-act="add">＋</button>'}
          </span>`,
        )
        .join('')}</div>`;
    })
    .join('')}<p class="small muted">${esc(t('edhrecLegend'))}</p>`;
}

function bindEdhrec() {
  $('#loadEdhrec').addEventListener('click', loadEdhrec);
  $('#edhrecHideOwned').addEventListener('change', renderEdhrec);
  $('#edhrecOut').addEventListener('click', (ev) => chipAction(ev));
  $('#combosOut').addEventListener('click', (ev) => chipAction(ev));
}

async function chipAction(ev) {
  const chip = ev.target.closest('[data-name]');
  if (!chip) return;
  const act = ev.target.closest('[data-act]')?.dataset.act;
  try {
    const card = await sf.named(chip.dataset.name);
    if (act === 'add') {
      addCard(card);
      renderEdhrec();
      renderCombos();
    } else openCardModal(card);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------- combos

async function loadCombos() {
  if (!allEntries().length) return toast(t('emptyDeck'));
  const out = $('#combosOut');
  out.innerHTML = '<span class="spinner"></span>';
  try {
    state.combos = await api('/api/combos', {
      method: 'POST',
      body: { commanders: state.deck.commanders.map((e) => e.card.name), main: state.deck.cards.map((e) => e.card.name) },
    });
  } catch (err) {
    out.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
    return;
  }
  renderCombos();
}

function comboHtml(combo, owned) {
  return `<div class="combo">
    <div class="cards">${combo.cards
      .map((n) => (owned.has(n) ? esc(n) : `<span class="chip" data-name="${esc(n)}"><span class="nm missing">${esc(n)}</span><button class="btn small" data-act="add">＋</button></span>`))
      .join(' + ')}</div>
    <div class="produces">${esc(combo.produces.join(' · '))}</div>
    <details><summary>${esc(t('howItWorks'))}</summary>${combo.prerequisites ? `<em>${esc(combo.prerequisites)}</em>\n` : ''}${esc(combo.description)}${combo.manaNeeded ? `\n${esc(t('manaNeeded'))}: ${esc(combo.manaNeeded)}` : ''}\n<a href="${esc(combo.url)}" target="_blank" rel="noopener">Commander Spellbook ↗</a></details>
  </div>`;
}

function renderCombos() {
  const out = $('#combosOut');
  if (!state.combos) {
    out.innerHTML = '';
    return;
  }
  const owned = new Set(allEntries().map((e) => e.card.name));
  const { included, almostIncluded } = state.combos;
  out.innerHTML = `<h3>${esc(t('combosIncluded', { n: included.length }))}</h3>${included.map((c) => comboHtml(c, owned)).join('') || `<p class="muted">${esc(t('noCombos'))}</p>`}
    <h3>${esc(t('combosAlmost', { n: almostIncluded.length }))}</h3>${almostIncluded.map((c) => comboHtml(c, owned)).join('') || `<p class="muted">—</p>`}`;
}

// ---------------------------------------------------------------- importar / exportar

async function resolveParsed(parsed) {
  const lines = [...parsed.commanders.map((l) => ({ ...l, cmd: true })), ...parsed.cards];
  const identifiers = lines.map((l) =>
    l.set && l.cn ? { set: l.set, collector_number: l.cn } : l.set ? { name: l.name.split(' // ')[0], set: l.set } : { name: l.name.split(' // ')[0] },
  );
  const { found } = await sf.collection(identifiers);
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const byName = new Map();
  for (const c of found) {
    byName.set(norm(c.name), c);
    byName.set(norm(c.name.split(' // ')[0]), c);
    if (c.set) byName.set(`${c.set}#${c.collector_number}`, c);
  }
  const result = { commanders: [], cards: [], missing: [] };
  for (const l of lines) {
    let card = (l.set && l.cn && byName.get(`${l.set}#${l.cn}`)) || byName.get(norm(l.name)) || byName.get(norm(l.name.split(' // ')[0]));
    if (!card) {
      try {
        card = await sf.named(l.name, { fuzzy: true });
      } catch {
        result.missing.push(l.name);
        continue;
      }
    }
    (l.cmd ? result.commanders : result.cards).push({ card, qty: l.qty });
  }
  return result;
}

function mergeInto(deck, resolved, replace) {
  if (replace) {
    deck.commanders = [];
    deck.cards = [];
  }
  for (const { card } of resolved.commanders) {
    if (!deck.commanders.some((e) => e.card.oracle_id === card.oracle_id)) deck.commanders.push(store.newEntry(card, 1));
  }
  for (const { card, qty } of resolved.cards) {
    const ex = deck.cards.find((e) => e.card.oracle_id === card.oracle_id);
    if (ex) ex.qty += qty;
    else deck.cards.push(store.newEntry(card, qty));
  }
  // Si no venía comandante pero hay una sola leyenda candidata al principio, no adivinamos: el usuario elige.
}

async function importText(text, mode, name) {
  const parsed = parseDeckText(text);
  if (!parsed.commanders.length && !parsed.cards.length) return toast(t('nothingToImport'), 'error');
  toast(t('importing', { n: parsed.commanders.length + parsed.cards.length }));
  const resolved = await resolveParsed(parsed);
  let deck = state.deck;
  if (mode === 'new') {
    deck = store.newDeck(name || parsed.name || t('importedDeck'), state.deck.lang);
    state.decks.push(deck);
  }
  mergeInto(deck, resolved, mode === 'replace');
  saveDeckList();
  selectDeck(deck.id);
  if (resolved.missing.length) toast(t('importMissing', { n: resolved.missing.length, names: resolved.missing.slice(0, 5).join(', ') }), 'error');
  else toast(t('importDone'), 'ok');
  if (!deck.commanders.length) toast(t('importNoCommander'));
  showTab('deck');
}

function bindIO() {
  $('#importTextBtn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await importText($('#importText').value, $('#importMode').value);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      e.target.disabled = false;
    }
  });
  $('#importUrlBtn').addEventListener('click', async (e) => {
    const url = $('#importUrl').value.trim();
    if (!url) return;
    e.target.disabled = true;
    try {
      const res = await api(`/api/import?url=${encodeURIComponent(url)}`);
      await importText(res.text, $('#importMode').value, res.name);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      e.target.disabled = false;
    }
  });
  $$('[data-export]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const deck = state.deck;
      const kind = btn.dataset.export;
      const base = fileSafe(deck.name);
      if (kind === 'mtgo' || kind === 'arena' || kind === 'plain') download(`${base}.txt`, exportDeckText(deck, kind), 'text/plain');
      else if (kind === 'csv') download(`${base}.csv`, exportDeckCsv(deck), 'text/csv');
      else if (kind === 'json') download(`${base}.json`, JSON.stringify({ format: 'magic-the-pdf', version: 1, deck }, null, 1), 'application/json');
      else if (kind === 'copy') {
        try {
          await navigator.clipboard.writeText(exportDeckText(deck, 'mtgo'));
          toast(t('copied'), 'ok');
        } catch {
          toast(t('copyFailed'), 'error');
        }
      } else if (kind === 'share') {
        const url = `${location.origin}${location.pathname}#share=${encodeShare(deck)}`;
        try {
          await navigator.clipboard.writeText(url);
          toast(t('shareCopied'), 'ok');
        } catch {
          prompt(t('shareLink'), url);
        }
      }
    }),
  );
  $('#importJson').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const deck = data.deck || data;
      if (!Array.isArray(deck.cards) || !Array.isArray(deck.commanders)) throw new Error(t('invalidBackup'));
      deck.id = crypto.randomUUID();
      state.decks.push(deck);
      saveDeckList();
      selectDeck(deck.id);
      toast(t('importDone'), 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
    e.target.value = '';
  });
}

async function handleShareHash() {
  const m = location.hash.match(/^#share=(.+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname);
  try {
    const data = decodeShare(m[1]);
    const ids = [...data.commanders, ...data.cards].map(([id]) => ({ id }));
    const { found } = await sf.collection(ids);
    const byId = new Map(found.map((c) => [c.id, c]));
    const deck = store.newDeck(data.name || t('importedDeck'), data.lang || 'es');
    deck.commanders = data.commanders.filter(([id]) => byId.has(id)).map(([id, q]) => store.newEntry(byId.get(id), q));
    deck.cards = data.cards.filter(([id]) => byId.has(id)).map(([id, q]) => store.newEntry(byId.get(id), q));
    state.decks.push(deck);
    saveDeckList();
    selectDeck(deck.id);
    toast(t('sharedLoaded', { name: deck.name }), 'ok');
  } catch (err) {
    toast(`${t('shareError')}: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------- PDF

function bindPdf() {
  const form = $('#pdfForm');
  for (const [k, v] of Object.entries(settings.pdf)) {
    const input = form.elements[k];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(v);
    else input.value = v;
  }
  form.addEventListener('change', (e) => {
    const input = e.target;
    if (!input.name) return;
    settings.pdf[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
    saveSettingsNow();
    renderPdfSummary();
  });
  $('#backImageInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const dataUrl = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.readAsDataURL(file);
    });
    settings.pdf.backImage = dataUrl;
    settings.pdf.backs = true;
    form.elements.backs.checked = true;
    if (!store.saveSettings(settings)) toast(t('backTooBig'), 'error');
    toast(t('backSaved'), 'ok');
  });
  $('#clearBack').addEventListener('click', () => {
    settings.pdf.backImage = null;
    saveSettingsNow();
    toast(t('backCleared'));
  });
  $('#generatePdf').addEventListener('click', generatePdf);
  $('#cancelPdf').addEventListener('click', () => state.pdfAbort?.abort());

  // Selección de cartas a imprimir (usa entry.skipPrint)
  $('.print-select').addEventListener('click', (e) => {
    const sel = e.target.closest('[data-sel]')?.dataset.sel;
    if (!sel) return;
    const deck = state.deck;
    for (const entry of deck.cards) {
      const st = langStatus(entry, deck);
      const keep =
        sel === 'all' ||
        (sel === 'translated' && !['official', 'original', 'pending'].includes(st)) ||
        (sel === 'official' && st === 'official');
      if (keep) delete entry.skipPrint;
      else entry.skipPrint = true;
    }
    saveDeck();
    renderPrintSelect();
    renderPdfSummary();
  });
  $('#printSelectList').addEventListener('change', (e) => {
    const entry = state.deck.cards.find((x) => x.uid === e.target.dataset.uid);
    if (!entry) return;
    if (e.target.checked) delete entry.skipPrint;
    else entry.skipPrint = true;
    saveDeck();
    renderPdfSummary();
  });
}

function renderPrintSelect() {
  const deck = state.deck;
  $('#printSelectList').innerHTML = [...deck.cards]
    .sort((a, b) => displayName(a, deck).localeCompare(displayName(b, deck)))
    .map(
      (e) => `<label><input type="checkbox" data-uid="${e.uid}" ${e.skipPrint ? '' : 'checked'}> ${e.qty > 1 ? `${e.qty}× ` : ''}${esc(displayName(e, deck))} ${statusBadge(e)}</label>`,
    )
    .join('');
}

function renderPdfSummary() {
  renderPrintSelect();
  const deck = state.deck;
  const items = entriesToPrint(deck, settings.pdf, settings.pdf.includeTokens ? state.tokenEntries : []);
  const cards = items.reduce((n, i) => n + i.qty * (settings.pdf.dfcDuplex ? 1 : Math.max(1, printableFaces(officialPrint(i.entry, deck) || i.entry.card).length)), 0);
  const paper = PAPERS[settings.pdf.paper];
  const perPage = settings.pdf.paper === 'a3' ? 18 : 9;
  const pages = Math.ceil(cards / perPage) * (settings.pdf.backs || settings.pdf.dfcDuplex ? 2 : 1) + (settings.pdf.deckList ? 1 : 0);
  const pending = allEntries().filter((e) => ['pending', 'missing'].includes(langStatus(e, deck))).length;
  $('#pdfSummary').textContent = `${t('pdfSummary', { cards, pages, paper: paper.label })}${pending && deck.lang !== 'en' ? ` ${t('pdfPending', { n: pending })}` : ''}`;
}

async function loadTokenEntries() {
  const ids = new Map();
  for (const e of allEntries()) for (const tk of e.card.tokens || []) ids.set(tk.name, tk.id);
  const known = new Set(state.tokenEntries.map((e) => e.card.id));
  const missing = [...ids.values()].filter((id) => !known.has(id));
  if (missing.length) {
    const { found } = await sf.collection(missing.map((id) => ({ id })));
    for (const c of found) state.tokenEntries.push({ uid: `tok-${c.id}`, qty: 1, card: c });
  }
  return state.tokenEntries.filter((e) => [...ids.values()].includes(e.card.id));
}

async function generatePdf() {
  const deck = state.deck;
  if (!allEntries().length) return toast(t('emptyDeck'), 'error');
  if (!window.jspdf) return toast(t('jspdfMissing'), 'error');
  const btn = $('#generatePdf');
  const progress = $('#pdfProgress');
  btn.disabled = true;
  $('#cancelPdf').classList.remove('hidden');
  state.pdfAbort = new AbortController();
  $('#pdfResult').innerHTML = '';
  try {
    const tokens = settings.pdf.includeTokens ? await loadTokenEntries() : [];
    // 1) Idioma: buscar oficiales y traducir lo que falte
    const toPrepare = [...allEntries(), ...tokens];
    setProgress(progress, 0, 1, t('phase_search'));
    await prepareEntries(toPrepare, deck, {
      translate: settings.pdf.autoTranslate,
      translateFn: translateApi,
      onProgress: ({ phase, done, total }) => setProgress(progress, done, total, `${t(`phase_${phase}`)} ${done}/${total}`),
    });
    saveDeck();
    // 2) Render + PDF
    const items = entriesToPrint(deck, settings.pdf, tokens);
    const strings = {
      commander: t('commanderGroup'),
      cards: t('cards'),
      composing: t('composing'),
      calibrationTitle: t('calibrationTitle'),
      calibrationHelp: t('calibrationHelp'),
      types: Object.fromEntries([...CARD_TYPES, 'Other', 'Token', 'Commander'].map((k) => [k, k === 'Commander' ? t('commanderGroup') : t(`type_${k}`)])),
    };
    const blob = await buildPdf(deck, items, settings.pdf, {
      signal: state.pdfAbort.signal,
      strings,
      onProgress: ({ done, total, label }) => setProgress(progress, done, total, `${t('rendering')} ${done}/${total} · ${label}`),
    });
    const url = URL.createObjectURL(blob);
    const filename = `${fileSafe(deck.name)}_${deck.lang}.pdf`;
    $('#pdfResult').innerHTML = `
      <a class="btn primary" href="${url}" download="${esc(filename)}">⬇ ${esc(t('downloadPdf'))} (${(blob.size / 1048576).toFixed(1)} MB)</a>
      <a class="btn" href="${url}" target="_blank" rel="noopener">${esc(t('openPdf'))}</a>`;
    download(filename, blob);
    toast(t('pdfReady'), 'ok');
  } catch (err) {
    if (err.name === 'AbortError') toast(t('cancelled'));
    else {
      console.error(err);
      toast(`${t('pdfError')}: ${err.message}`, 'error');
    }
  } finally {
    btn.disabled = false;
    $('#cancelPdf').classList.add('hidden');
    progress.classList.add('hidden');
    renderDeckPanels();
  }
}

// ---------------------------------------------------------------- arranque

function bindMisc() {
  $('#prepareBtn').addEventListener('click', () => runPrepare({ translate: true }));
  $('#searchOnlyBtn').addEventListener('click', () => runPrepare({ translate: false }));
  $('#retranslateBtn').addEventListener('click', () => {
    if (confirm(t('confirmRetranslate'))) runPrepare({ translate: true, retranslateMachine: true });
  });
  $('#newHand').addEventListener('click', newHand);
  $('#mulligan').addEventListener('click', mulligan);
  $('#drawCard').addEventListener('click', drawCard);
  $('#loadCombos').addEventListener('click', loadCombos);
  for (const id of ['#cardModal', '#editorModal', '#artModal']) {
    $(id).addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.close();
    });
  }
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || document.querySelector('dialog[open]')) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
      e.preventDefault();
      redo();
    }
  });
  $('#newCustomCard').addEventListener('click', newCustomCard);
  $('#bulkArtApply').addEventListener('click', applyBulkArt);
}

function init() {
  setUiLang(settings.uiLang);
  applyTheme();
  if (!state.decks.length) state.decks.push(store.newDeck(t('newDeckName'), settings.uiLang === 'en' ? 'en' : 'es'));
  bindTabs();
  bindHeader();
  bindSearch();
  bindDeckPanel();
  bindEdhrec();
  bindIO();
  bindPdf();
  bindMisc();
  selectDeck(store.loadCurrentId());
  warmTranslator(state.deck.lang);
  handleShareHash();
  window.addEventListener('hashchange', handleShareHash);
}

init();
