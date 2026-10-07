/**
 * "Traducir todo y revisar": traduce de golpe todas las cartas que no tienen impresión oficial
 * en el idioma elegido y abre un panel para revisarlas una a una (original vs. traducida):
 * aceptar, editar el texto, abrir el editor completo, volver a traducir o dejarla en inglés.
 */
import { languageOptions, getLanguage } from './languages.js';
import { t } from './i18n.js';
import { textFaces } from './deck.js';
import { displayName, langStatus, prepareEntries, renderEntry, targetLang } from './resolve.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const imageOf = (card) => card?.image?.normal || card?.faces?.[0]?.image?.normal || null;

/** Estado de revisión: review | accepted | original | official | custom | failed. */
export function reviewState(entry, deck) {
  const lang = targetLang(entry, deck);
  if (entry.custom || entry.card?.custom) return 'custom';
  if (entry.renderMode === 'original') return 'original';
  const st = langStatus(entry, deck);
  if (st === 'official') return 'official';
  if (entry.translation?.lang === lang) return entry.reviewed === lang ? 'accepted' : 'review';
  return lang === 'en' ? 'official' : 'failed';
}

/**
 * opts: { deck, entries: () => [...], translateFn, renderSettings, save(), refresh(), editEntry(entry, done), toast }
 */
export function openReview(opts) {
  const { deck, translateFn, save, refresh, editEntry, toast } = opts;
  const modal = document.getElementById('reviewModal');
  const body = document.getElementById('reviewModalBody');
  const state = { filter: 'review', index: 0, items: [], token: 0 };
  const groups = { printed: t('langGroupPrinted'), translated: t('langGroupTranslated') };

  const all = () => opts.entries();
  const items = () => {
    const list = all().filter((e) => {
      const s = reviewState(e, deck);
      if (state.filter === 'all') return true;
      if (state.filter === 'review') return s === 'review' || s === 'failed';
      if (state.filter === 'accepted') return s === 'accepted' || s === 'custom';
      return s === state.filter;
    });
    return list.sort((a, b) => displayName(a, deck).localeCompare(displayName(b, deck)));
  };

  function counts() {
    const c = { review: 0, accepted: 0, original: 0, official: 0, failed: 0, custom: 0 };
    for (const e of all()) c[reviewState(e, deck)]++;
    return c;
  }

  // ------------------------------------------------------------ fase 1: traducir todo

  async function generate() {
    const lang = deck.lang;
    body.innerHTML = `
      <div class="review-generating">
        <div class="card-stack"><span></span><span></span><span></span></div>
        <h2>${esc(t('reviewGenerating', { lang: getLanguage(lang)?.name || lang }))}</h2>
        <div class="progress"><div class="bar"></div><span class="label"></span></div>
        <p class="muted small">${esc(t('reviewGeneratingHelp'))}</p>
      </div>`;
    const bar = body.querySelector('.bar');
    const label = body.querySelector('.label');
    try {
      await prepareEntries(all(), deck, {
        translate: true,
        translateFn,
        onProgress: ({ phase, done, total }) => {
          bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
          label.textContent = `${t(`phase_${phase}`)} ${done}/${total}`;
        },
      });
      save();
      refresh();
    } catch (err) {
      toast(`${t('prepareError')}: ${err.message}`, 'error');
    }
    state.filter = counts().review + counts().failed ? 'review' : 'all';
    state.index = 0;
    renderPanel();
  }

  // ------------------------------------------------------------ fase 2: revisar

  function renderPanel() {
    state.items = items();
    if (state.index >= state.items.length) state.index = Math.max(0, state.items.length - 1);
    const c = counts();
    const tab = (k, n) => `<button class="tab ${state.filter === k ? 'active' : ''}" data-filter="${k}">${esc(t(`reviewFilter_${k}`))} <span class="count">${n}</span></button>`;
    body.innerHTML = `
      <div class="review-head">
        <h2>${esc(t('reviewTitle'))}</h2>
        <label class="review-lang">${esc(t('reviewLanguage'))}
          <select data-r="lang">${languageOptions(deck.lang, groups)}</select>
        </label>
        <div class="button-wrap">
          <button class="btn small" data-bulk="accept">✓ ${esc(t('reviewAcceptAll'))}</button>
          <button class="btn small" data-bulk="original">↩ ${esc(t('reviewAllOriginal'))}</button>
          <button class="btn small" data-bulk="retranslate">🔄 ${esc(t('reviewRetranslateAll'))}</button>
        </div>
      </div>
      <nav class="tabs review-tabs">
        ${tab('review', c.review + c.failed)}${tab('accepted', c.accepted + c.custom)}${tab('original', c.original)}${tab('official', c.official)}${tab('all', all().length)}
      </nav>
      <div class="review-layout">
        <div class="review-list">${
          state.items.length
            ? state.items
                .map((e, i) => {
                  const s = reviewState(e, deck);
                  return `<button class="review-item ${i === state.index ? 'active' : ''}" data-i="${i}">
                    <img src="${esc(e.card.image?.small || e.card.faces?.[0]?.image?.small || '')}" alt="" loading="lazy">
                    <span class="nm">${esc(displayName(e, deck))}<small>${esc(e.card.name)}</small></span>
                    <span class="rstate ${s}">${esc(t(`reviewState_${s}`))}</span>
                  </button>`;
                })
                .join('')
            : `<p class="empty">${esc(t(state.filter === 'review' ? 'reviewAllDone' : 'reviewEmpty'))}</p>`
        }</div>
        <div class="review-detail"></div>
      </div>
      <p class="small muted review-keys">${esc(t('reviewKeys'))}</p>`;
    renderDetail();
  }

  function renderDetail() {
    const box = body.querySelector('.review-detail');
    const entry = state.items[state.index];
    if (!entry) {
      box.innerHTML = '';
      return;
    }
    const s = reviewState(entry, deck);
    const lang = targetLang(entry, deck);
    const tr = entry.translation?.lang === lang ? entry.translation : null;
    const faces = textFaces(entry.card);
    box.innerHTML = `
      <div class="review-compare">
        <figure><figcaption>${esc(t('reviewOriginal'))}</figcaption><img src="${esc(imageOf(entry.card) || '')}" alt=""></figure>
        <figure><figcaption>${esc(t('reviewResult'))} · <span class="rstate ${s}">${esc(t(`reviewState_${s}`))}</span></figcaption><div class="review-preview images"></div></figure>
      </div>
      <div class="row review-actions">
        <button class="btn primary" data-act="accept">✓ ${esc(t('reviewAccept'))}</button>
        <button class="btn" data-act="original">↩ ${esc(t('reviewKeepOriginal'))}</button>
        <button class="btn" data-act="editor">✏️ ${esc(t('openEditor'))}</button>
        <button class="btn" data-act="retranslate">🔄 ${esc(t('retranslateOne'))}</button>
        <label class="small">${esc(t('cardLangOverride'))}
          <select data-r="cardLang"><option value="">${esc(t('deckDefault'))}</option>${languageOptions(entry.lang, groups)}</select>
        </label>
        <span class="spacer"></span>
        <button class="btn icon" data-act="prev" title="←">‹</button>
        <span class="small muted">${state.index + 1}/${state.items.length}</span>
        <button class="btn icon" data-act="next" title="→">›</button>
      </div>
      ${
        tr && !entry.custom
          ? `<div class="review-fields">${tr.faces
              .map(
                (f, i) => `<fieldset data-face="${i}">
                  ${faces.length > 1 ? `<legend>${esc(faces[i]?.name)}</legend>` : ''}
                  <div class="two"><label>${esc(t('fieldName'))}<input data-f="name" value="${esc(f.name)}"></label>
                  <label>${esc(t('fieldType'))}<input data-f="type_line" value="${esc(f.type_line)}"></label></div>
                  <label>${esc(t('fieldText'))}<textarea data-f="oracle_text" rows="4">${esc(f.oracle_text)}</textarea></label>
                  ${f.flavor_text ? `<label>${esc(t('fieldFlavor'))}<textarea data-f="flavor_text" rows="2">${esc(f.flavor_text)}</textarea></label>` : ''}
                  <details class="small muted"><summary>${esc(t('reviewEnglish'))}</summary><pre>${esc(faces[i]?.oracle_text)}</pre></details>
                </fieldset>`,
              )
              .join('')}
              <button class="btn small" data-act="saveText" disabled>💾 ${esc(t('reviewSaveText'))}</button>
            </div>`
          : s === 'failed'
            ? `<p class="issue error">${esc(entry.translationError || t('translateFailed'))}</p>`
            : ''
      }`;
    renderPreview(entry);
    // Precalcula la siguiente para que pasar de carta sea instantáneo.
    const next = state.items[state.index + 1];
    if (next) setTimeout(() => renderEntry(next, deck, opts.renderSettings()).catch(() => {}), 400);
  }

  async function renderPreview(entry) {
    const slot = body.querySelector('.review-preview');
    const token = ++state.token;
    const img = document.createElement('img');
    img.src = imageOf(entry.card) || '';
    slot.append(img);
    slot.classList.add('scanning');
    const overlay = document.createElement('div');
    overlay.className = 'scan-overlay';
    overlay.innerHTML = `<div class="scan-line"></div><div class="scan-sparkles"></div><div class="scan-label"><span class="spinner"></span> ${esc(t('scanComposing'))}<span class="dots"></span></div>`;
    slot.append(overlay);
    try {
      const canvases = await renderEntry(entry, deck, opts.renderSettings());
      if (token !== state.token || !slot.isConnected) return;
      slot.classList.remove('scanning');
      slot.innerHTML = '';
      for (const c of canvases) {
        c.classList.add('reveal');
        slot.append(c);
      }
    } catch (err) {
      if (token === state.token) overlay.querySelector('.scan-label').textContent = `⚠ ${err.message}`;
    }
  }

  function changed() {
    save();
    refresh();
  }

  function advance() {
    // Tras aceptar/descartar en "Por revisar", la carta sale de la lista: el índice ya apunta a la siguiente.
    renderPanel();
  }

  async function retranslate(entry) {
    delete entry.translation;
    delete entry.reviewed;
    delete entry.translationError;
    if (entry.renderMode === 'original') delete entry.renderMode;
    const box = body.querySelector('.review-preview');
    box?.querySelector('.scan-label')?.replaceChildren(document.createTextNode(t('scanTranslating')));
    await prepareEntries([entry], deck, { translate: true, translateFn });
    changed();
  }

  function act(action) {
    const entry = state.items[state.index];
    if (!entry && !['prev', 'next'].includes(action)) return;
    const lang = entry ? targetLang(entry, deck) : null;
    if (action === 'accept') {
      if (entry.translation?.lang === lang) entry.reviewed = lang;
      delete entry.renderMode;
      changed();
      advance();
    } else if (action === 'original') {
      entry.renderMode = 'original';
      changed();
      advance();
    } else if (action === 'editor') {
      editEntry(entry, () => {
        entry.reviewed = lang;
        renderPanel();
      });
    } else if (action === 'retranslate') {
      retranslate(entry).then(renderPanel);
    } else if (action === 'next') {
      state.index = Math.min(state.items.length - 1, state.index + 1);
      renderPanel();
    } else if (action === 'prev') {
      state.index = Math.max(0, state.index - 1);
      renderPanel();
    } else if (action === 'saveText') {
      const faces = [...body.querySelectorAll('.review-fields fieldset')].map((fs, i) => ({
        ...entry.translation.faces[i],
        name: fs.querySelector('[data-f="name"]').value.trim(),
        type_line: fs.querySelector('[data-f="type_line"]').value.trim(),
        oracle_text: fs.querySelector('[data-f="oracle_text"]').value.trim(),
        flavor_text: fs.querySelector('[data-f="flavor_text"]')?.value.trim() ?? entry.translation.faces[i].flavor_text ?? '',
      }));
      entry.translation = { ...entry.translation, source: 'manual', faces };
      entry.reviewed = lang;
      changed();
      toast(t('translationSaved'), 'ok');
      renderPanel();
    }
  }

  async function bulk(kind) {
    const list = all();
    if (kind === 'accept') {
      for (const e of list) if (reviewState(e, deck) === 'review') e.reviewed = targetLang(e, deck);
    } else if (kind === 'original') {
      for (const e of list) if (['review', 'failed', 'accepted'].includes(reviewState(e, deck))) e.renderMode = 'original';
    } else if (kind === 'retranslate') {
      if (!confirm(t('confirmRetranslate'))) return;
      for (const e of list) {
        if (e.translation && e.translation.source !== 'manual') {
          delete e.translation;
          delete e.reviewed;
        }
      }
      changed();
      await generate();
      return;
    }
    changed();
    renderPanel();
  }

  body.onclick = (e) => {
    const f = e.target.closest('[data-filter]')?.dataset.filter;
    if (f) {
      state.filter = f;
      state.index = 0;
      renderPanel();
      return;
    }
    const item = e.target.closest('.review-item');
    if (item) {
      state.index = Number(item.dataset.i);
      body.querySelectorAll('.review-item').forEach((n) => n.classList.toggle('active', n === item));
      renderDetail();
      return;
    }
    const b = e.target.closest('[data-bulk]')?.dataset.bulk;
    if (b) return bulk(b);
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a) act(a);
  };

  body.oninput = (e) => {
    if (e.target.dataset.f) body.querySelector('[data-act="saveText"]')?.removeAttribute('disabled');
  };

  body.onchange = async (e) => {
    const r = e.target.dataset.r;
    if (r === 'lang') {
      deck.lang = e.target.value;
      changed();
      await generate();
    } else if (r === 'cardLang') {
      const entry = state.items[state.index];
      entry.lang = e.target.value || undefined;
      delete entry.reviewed;
      await prepareEntries([entry], deck, { translate: true, translateFn });
      changed();
      renderPanel();
    }
  };

  modal.onkeydown = (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (document.getElementById('editorModal')?.open) return;
    const map = { ArrowRight: 'next', ArrowLeft: 'prev', a: 'accept', Enter: 'accept', o: 'original', e: 'editor', r: 'retranslate' };
    const action = map[e.key];
    if (action) {
      e.preventDefault();
      act(action);
    }
  };

  if (!modal.open) modal.showModal();
  if (deck.lang === 'en') {
    state.filter = 'all';
    renderPanel();
  } else generate();
}
