/**
 * Pestaña «🤖 IA»: análisis del mazo, propuestas de cambios (aceptar / rechazar),
 * constructor de mazos y chat con el asistente.
 */
import './strings.js';
import { t, getUiLang } from '../i18n.js';
import * as sf from '../scryfall.js';
import { mainType, countCards } from '../deck.js';
import { loadRolesModel, modelInfo, rolesOf } from './roles.js';
import { analyzeDeck, proposeChanges, buildDeck, cardValue, edhrecMap, TARGETS } from './brain.js';
import { candidatesFor, basicsFor, edhrecFor } from './sources.js';
import { parseIntent } from './assistant.js';
import { askLLM } from './llm.js';

let deps = null;
let root = null;
const rejected = new Map(); // id del mazo → Set(nombres rechazados)
let lastAnalysis = null;
let busy = false;

const $ = (sel) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const img = (card) => card?.image?.small || card?.faces?.[0]?.image?.small || '';
const roleName = (r) => t(`role_${r}`);
const themeName = (th) => t(`theme_${th.key}`, { tribe: th.tribe || '' });

/** deps: { getDeck, applyChanges, replaceCards, setCommander, openCardModal, toast, settings, saveSettings, getCombos } */
export function initAiPanel(container, d) {
  deps = d;
  root = container;
  const s = deps.settings;
  s.ai ??= { budget: '', bracket: '', online: false };
  root.innerHTML = `
    <p class="muted small ai-intro">${esc(t('aiModelLoading'))}</p>
    <div class="ai-toolbar">
      <button type="button" class="btn primary" data-ai="analyze">${esc(t('aiAnalyze'))}</button>
      <button type="button" class="btn primary" data-ai="improve">${esc(t('aiImprove'))}</button>
      <button type="button" class="btn" data-ai="build">${esc(t('aiBuild'))}</button>
      <button type="button" class="btn" data-ai="complete">${esc(t('aiComplete'))}</button>
    </div>
    <div class="ai-options">
      <label>${esc(t('aiBudget'))}
        <select data-opt="budget">
          <option value="">${esc(t('aiBudgetAny'))}</option>
          ${[1, 2, 5, 10, 20].map((v) => `<option value="${v}">≤ ${v} $</option>`).join('')}
        </select></label>
      <label>${esc(t('aiBracket'))}
        <select data-opt="bracket">
          <option value="">${esc(t('aiBracketAny'))}</option>
          ${[2, 3, 4].map((v) => `<option value="${v}">${v}</option>`).join('')}
        </select></label>
      <label class="check" title="${esc(t('aiOnlineHint'))}"><input type="checkbox" data-opt="online"> ${esc(t('aiOnline'))}</label>
    </div>
    <div class="ai-status"></div>
    <div class="ai-report"></div>
    <div class="ai-proposals"></div>
    <section class="ai-chat">
      <h3>${esc(t('aiChatTitle'))}</h3>
      <div class="ai-log" aria-live="polite"></div>
      <div class="chips ai-chips">
        ${['chipAnalyze', 'chipCuts', 'chipRamp', 'chipDraw', 'chipRemoval', 'chipBudget', 'chipBracket', 'chipUpgrade', 'chipExplain', 'chipBuild']
          .map((k) => `<button type="button" class="chip" data-say="${esc(t(k))}">${esc(t(k))}</button>`)
          .join('')}
      </div>
      <form class="ai-form" autocomplete="off">
        <input type="text" name="q" placeholder="${esc(t('aiChatPlaceholder'))}">
        <button class="btn primary">${esc(t('aiSend'))}</button>
      </form>
    </section>`;
  $('[data-opt="budget"]').value = s.ai.budget ?? '';
  $('[data-opt="bracket"]').value = s.ai.bracket ?? '';
  $('[data-opt="online"]').checked = Boolean(s.ai.online);
  root.addEventListener('change', (e) => {
    const k = e.target.dataset.opt;
    if (!k) return;
    s.ai[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    deps.saveSettings();
  });
  root.addEventListener('click', onClick);
  $('.ai-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = e.target.q;
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    chat(q);
  });
  loadRolesModel()
    .then(() => {
      $('.ai-intro').textContent = t('aiIntro', { cards: (modelInfo()?.cards || 0).toLocaleString() });
    })
    .catch(() => {
      $('.ai-intro').textContent = t('aiIntro', { cards: '—' });
    });
}

const opts = () => {
  const a = deps.settings.ai || {};
  return { budget: a.budget ? Number(a.budget) : null, bracket: a.bracket ? Number(a.bracket) : null, online: Boolean(a.online) };
};

function rejectedSet() {
  const id = deps.getDeck().id;
  if (!rejected.has(id)) rejected.set(id, new Set());
  return rejected.get(id);
}

/** Se llama al mostrar la pestaña o cuando cambia el mazo. */
export function onAiTabShown() {
  if (!root) return;
  const deck = deps.getDeck();
  if (!deck.commanders.length) {
    $('.ai-report').innerHTML = `<p class="notice">${esc(t('aiNeedCommander'))}</p>`;
    $('.ai-proposals').innerHTML = '';
    return;
  }
  if (!lastAnalysis || lastAnalysis.deckId !== deck.id || lastAnalysis.stamp !== stamp(deck)) analyze(false);
}

const stamp = (deck) => `${deck.commanders.map((e) => e.card?.name).join('+')}|${deck.cards.map((e) => `${e.card?.name}x${e.qty}`).join(',')}`;

async function withBusy(label, fn) {
  if (busy) return null;
  busy = true;
  const box = $('.ai-status');
  box.innerHTML = `<div class="ai-thinking"><span class="ai-brain">🤖</span><span>${esc(label)}</span><span class="dots"><i></i><i></i><i></i></span></div>`;
  try {
    return await fn();
  } catch (err) {
    deps.toast(err.message, 'error');
    return null;
  } finally {
    busy = false;
    box.innerHTML = '';
  }
}

async function context(deck, { candidates = false, roles = [] } = {}) {
  await loadRolesModel();
  const o = opts();
  if (!candidates) return { edhrec: await edhrecFor(deck), candidates: [], basics: {} };
  const [{ candidates: list, edhrec }, basics] = await Promise.all([candidatesFor(deck, { roles, budget: o.budget, bracket: o.bracket, lands: true }), basicsFor(deck.commanders.flatMap((e) => e.card.color_identity))]);
  const skip = rejectedSet();
  return { edhrec, candidates: list.filter((c) => !skip.has(c.card.name)), basics };
}

/** Analiza (y opcionalmente propone cambios). */
async function analyze(propose) {
  const deck = deps.getDeck();
  if (!deck.commanders.length) return onAiTabShown();
  await withBusy(t(propose ? 'aiLoadingData' : 'aiWorking'), async () => {
    const ctx0 = await context(deck);
    const a = analyzeDeck(deck, { edhrec: ctx0.edhrec, combos: deps.getCombos() });
    lastAnalysis = { deckId: deck.id, stamp: stamp(deck), a };
    renderReport(a);
    if (!propose) return;
    const roles = a.checks.filter((c) => c.status !== 'good' && ['ramp', 'draw', 'interaction', 'wipe'].includes(c.key)).map((c) => c.key);
    const ctx = await context(deck, { candidates: true, roles });
    const o = opts();
    const list = proposeChanges(deck, a, ctx.candidates, { basics: ctx.basics, budget: o.budget, bracket: o.bracket, max: 15 });
    renderGroup($('.ai-proposals'), list, t('aiProposals'));
  });
}

function renderReport(a) {
  const pct = a.score;
  const color = pct >= 72 ? 'var(--ok)' : pct >= 58 ? 'var(--warn)' : 'var(--err)';
  const checkRow = (c) => {
    const icon = c.status === 'good' ? '✅' : c.status === 'warn' ? '⚠️' : '❌';
    const key = c.key === 'legal' || c.key === 'colors' ? `checkMsg_${c.key}_${c.status === 'good' ? 'good' : 'bad'}` : `checkMsg_${c.key}`;
    return `<li class="ai-check ${c.status}"><span class="ic">${icon}</span><b>${esc(t(`check_${c.key}`))}</b><span>${esc(t(key, { ...c.params, weak: (c.params.weak || []).join(', ') }))}</span></li>`;
  };
  const cardChip = (x) => `<span class="chip" data-card="${esc(x.name)}"><span class="nm">${esc(x.name)}</span></span>`;
  $('.ai-report').innerHTML = `
    <div class="ai-summary">
      <div class="ai-ring" style="--p:${pct};--c:${color}"><span>${pct}</span><small>${esc(a.grade)}</small></div>
      <div>
        <p class="ai-verdict">${esc(t(`verdict_${a.verdict}`))}</p>
        <p class="small"><b>${esc(t('aiBracketLabel'))}:</b> ${a.bracket} · <b>${esc(t('aiPrice'))}:</b> ${Math.round(a.counts.usd)} $</p>
        <p class="small"><b>${esc(t('aiThemes'))}:</b> ${a.themes.length ? a.themes.slice(0, 3).map((th) => `<span class="tag">${esc(themeName(th))}</span>`).join(' ') : esc(t('aiNoThemes'))}</p>
      </div>
    </div>
    <h3>${esc(t('aiChecks'))}</h3>
    <ul class="ai-checks">${a.checks.map(checkRow).join('')}</ul>
    <details class="ai-cards"><summary>${esc(t('aiStrongest'))} / ${esc(t('aiWeakest'))}</summary>
      <p class="small"><b>${esc(t('aiStrongest'))}:</b></p><div class="chips">${a.strongest.map(cardChip).join('')}</div>
      <p class="small"><b>${esc(t('aiWeakest'))}:</b></p><div class="chips">${a.weakest.map(cardChip).join('')}</div>
    </details>`;
}

// ---------------------------------------------------------------- propuestas

const groups = new Map();
let groupSeq = 0;

function reasonText(p) {
  const params = { ...p.reason.params };
  if (params.role) params.roleName = roleName(params.role);
  if (p.reason.code === 'addRole' && params.n == null) return t('reason_addRoleShort', params);
  return t(`reason_${p.reason.code}`, params);
}

function proposalHtml(p) {
  const side = (card, cls, qty) =>
    card
      ? `<button type="button" class="ai-card ${cls}" data-card="${esc(card.name)}" title="${esc(card.name)}">
          ${img(card) ? `<img src="${esc(img(card))}" alt="" loading="lazy">` : ''}
          <span>${qty > 1 ? `${qty}× ` : ''}${esc(card.name)}</span></button>`
      : '';
  if (p.kind === 'bulk') {
    const byType = {};
    for (const e of p.cards) byType[mainType(e.card)] = (byType[mainType(e.card)] || 0) + e.qty;
    return `<div class="ai-prop bulk" data-pid="${p.id}">
      <div class="ai-prop-body">
        <p><b>${esc(t('aiBulkAdd', { n: p.cards.reduce((n, e) => n + e.qty, 0) }))}</b> · ${Object.entries(byType).map(([k, n]) => `${esc(k)} ${n}`).join(' · ')}</p>
        <div class="ai-bulk-list">${p.cards.map((e) => `<span class="chip" data-card="${esc(e.card.name)}">${e.qty > 1 ? `${e.qty}× ` : ''}${esc(e.card.name)}</span>`).join('')}</div>
      </div>
      <div class="ai-prop-actions"><button type="button" class="btn primary small" data-act="accept">${esc(t('aiAccept'))}</button><button type="button" class="btn small" data-act="reject">${esc(t('aiReject'))}</button></div>
    </div>`;
  }
  return `<div class="ai-prop ${p.kind}" data-pid="${p.id}">
    <div class="ai-prop-cards">${side(p.cut, 'out', 1)}${p.cut && p.add ? '<span class="arrow">→</span>' : ''}${side(p.add, 'in', p.qty || 1)}</div>
    <div class="ai-prop-body"><span class="ai-kind">${p.kind === 'add' ? '＋' : p.kind === 'cut' ? '－' : '⇄'}</span> ${esc(reasonText(p))}</div>
    <div class="ai-prop-actions">
      <button type="button" class="btn primary small" data-act="accept">${esc(t('aiAccept'))}</button>
      <button type="button" class="btn small" data-act="reject" title="${esc(t('aiRejected'))}">${esc(t('aiReject'))}</button>
    </div>
  </div>`;
}

function renderGroup(container, list, title) {
  if (!list.length) {
    container.innerHTML = `<p class="muted">${esc(t('aiNoProposals'))}</p>`;
    return;
  }
  const gid = `g${++groupSeq}`;
  groups.set(gid, new Map(list.map((p) => [p.id, { p, state: 'pending' }])));
  container.innerHTML = `<div class="ai-group" data-gid="${gid}">
    <div class="ai-group-head"><h3>${esc(title)} (${list.length})</h3>
      ${list.length > 1 ? `<span><button type="button" class="btn small primary" data-act="acceptAll">${esc(t('aiAcceptAll'))}</button> <button type="button" class="btn small" data-act="rejectAll">${esc(t('aiRejectAll'))}</button></span>` : ''}
    </div>
    ${list.map(proposalHtml).join('')}
  </div>`;
}

function settle(gid, pids, accept) {
  const g = groups.get(gid);
  if (!g) return;
  const items = pids.map((id) => g.get(id)).filter((x) => x && x.state === 'pending');
  if (!items.length) return;
  if (accept) {
    const bulk = items.find((x) => x.p.kind === 'bulk');
    if (bulk) deps.replaceCards(bulk.p.cards, bulk.p.replace);
    const changes = items.filter((x) => x.p.kind !== 'bulk').map((x) => ({ add: x.p.add, qty: x.p.qty || 1, cut: x.p.cut }));
    if (changes.length) deps.applyChanges(changes);
    if (items.length > 1) deps.toast(t('aiAppliedN', { n: items.length }), 'ok');
  } else {
    for (const x of items) if (x.p.add) rejectedSet().add(x.p.add.name);
  }
  for (const x of items) {
    x.state = accept ? 'accepted' : 'rejected';
    const node = root.querySelector(`[data-gid="${gid}"] [data-pid="${x.p.id}"]`);
    if (!node) continue;
    node.classList.add(x.state);
    node.querySelector('.ai-prop-actions').innerHTML = `<span class="badge">${esc(t(accept ? 'aiAccepted' : 'aiRejected'))}</span>`;
  }
}

async function onClick(e) {
  const ai = e.target.closest('[data-ai]')?.dataset.ai;
  if (ai === 'analyze') return analyze(false);
  if (ai === 'improve') return analyze(true);
  if (ai === 'build') return build();
  if (ai === 'complete') return complete();
  const say = e.target.closest('[data-say]')?.dataset.say;
  if (say) return chat(say);
  const act = e.target.closest('[data-act]')?.dataset.act;
  const gid = e.target.closest('[data-gid]')?.dataset.gid;
  if (act && gid) {
    const g = groups.get(gid);
    if (act === 'acceptAll' || act === 'rejectAll') return settle(gid, [...g.keys()], act === 'acceptAll');
    const pid = e.target.closest('[data-pid]')?.dataset.pid;
    if (pid) return settle(gid, [pid], act === 'accept');
  }
  if (act === 'addCard') {
    const name = e.target.closest('[data-card]')?.dataset.card;
    const card = await sf.named(name).catch(() => null);
    if (card) deps.applyChanges([{ add: card, qty: 1 }]);
    return;
  }
  const cardName = e.target.closest('[data-card]')?.dataset.card;
  if (cardName) {
    const card = await sf.named(cardName).catch(() => null);
    if (card) deps.openCardModal(card);
  }
}

// ---------------------------------------------------------------- construir / completar

async function build(target = $('.ai-proposals')) {
  const deck = deps.getDeck();
  if (!deck.commanders.length) {
    deps.toast(t('aiNeedCommander'), 'error');
    return null;
  }
  return withBusy(t('aiLoadingData'), async () => {
    const o = opts();
    const ctx = await context(deck, { candidates: true, roles: ['ramp', 'draw', 'interaction', 'wipe', 'protection'] });
    const cards = buildDeck(deck.commanders.map((e) => e.card), ctx.candidates, { basics: ctx.basics, budget: o.budget, bracket: o.bracket });
    const total = cards.reduce((n, e) => n + e.qty, 0);
    let replace = true;
    if (deck.cards.length) replace = confirm(t('aiBuildReplace', { n: countCards(deck) - deck.commanders.length }));
    if (!replace) {
      busy = false;
      return complete(target);
    }
    const p = { id: `b${Date.now()}`, kind: 'bulk', cards, replace: true, reason: { code: 'build', params: {} } };
    renderGroup(target, [p], t('aiBuilt', { n: total + deck.commanders.length, cmd: deck.commanders.map((e) => e.card.name).join(' + ') }));
    return p;
  });
}

async function complete(target = $('.ai-proposals')) {
  const deck = deps.getDeck();
  if (!deck.commanders.length) return deps.toast(t('aiNeedCommander'), 'error');
  return withBusy(t('aiLoadingData'), async () => {
    const ctx = await context(deck, { candidates: true, roles: ['ramp', 'draw', 'interaction', 'wipe'] });
    const a = analyzeDeck(deck, { edhrec: ctx.edhrec });
    const o = opts();
    const missing = 100 - countCards(deck);
    const list = proposeChanges(deck, a, ctx.candidates, { basics: ctx.basics, budget: o.budget, bracket: o.bracket, max: Math.max(5, missing + 8) }).filter((p) => p.kind === 'add' || p.tag === 'legal');
    renderGroup(target, list, t('aiProposals'));
    return list;
  });
}

// ---------------------------------------------------------------- chat

function addMessage(who, html) {
  const log = $('.ai-log');
  const node = document.createElement('div');
  node.className = `ai-msg ${who}`;
  node.innerHTML = html;
  log.append(node);
  node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return node;
}

const para = (s) => esc(s).replace(/\n/g, '<br>');

/** Hechos del mazo para que la IA en línea redacte sin inventar. */
function factSheet(deck, a) {
  const lines = [
    `Commander: ${deck.commanders.map((e) => e.card.name).join(' + ')}`,
    `Cards: ${a.counts.total}/100. Lands: ${a.counts.lands} (recommended ${a.counts.recLands}). Average mana value: ${a.counts.avgCmc.toFixed(2)}.`,
    `Ramp ${a.counts.ramp}, card draw ${a.counts.draw}, removal ${a.counts.removal}, counterspells ${a.counts.counter}, board wipes ${a.counts.wipe}, tutors ${a.counts.tutor}, protection ${a.counts.protection}.`,
    `Score ${a.score}/100 (${a.grade}). Estimated bracket ${a.bracket}. Themes: ${a.themes.map((x) => x.key + (x.tribe ? ` ${x.tribe}` : '')).join(', ') || 'none'}.`,
    `Weak points: ${a.weaknesses.join(', ') || 'none'}.`,
    ...deck.commanders.map((e) => `Commander text (${e.card.name}): ${(e.card.oracle_text || e.card.faces?.map((f) => f.oracle_text).join(' // ') || '').slice(0, 500)}`),
    'Key cards:',
    ...a.strongest.slice(0, 6).map((x) => {
      const c = deck.cards.find((e) => e.card?.name === x.name)?.card;
      return `- ${x.name}: ${(c?.oracle_text || '').replace(/\n/g, ' ').slice(0, 160)}`;
    }),
  ];
  return lines.join('\n');
}

async function online(question, deck, a) {
  const lang = getUiLang() === 'en' ? 'English' : 'Spanish';
  return askLLM([
    {
      role: 'system',
      content: `You are a Magic: The Gathering Commander deck-building assistant inside a web app. Answer in ${lang}, in at most 110 words, plainly. Use ONLY the facts and card texts below; never invent card names, abilities or numbers. If you are not sure, say so briefly. Commander decks have 100 cards and usually 35-38 lands.\n\nDECK FACTS:\n${a ? factSheet(deck, a) : 'No deck analysis available.'}`,
    },
    { role: 'user', content: question },
  ]);
}

async function chat(question) {
  if (busy) return;
  root.querySelector('.ai-chat').scrollIntoView({ block: 'nearest' });
  addMessage('user', para(question));
  const thinking = addMessage('ai', `<span class="dots"><i></i><i></i><i></i></span>`);
  try {
    const res = await answer(question);
    thinking.innerHTML = `${para(res.text)}${res.online ? `<p class="tiny muted">${esc(t('aiOnlineBadge'))}</p>` : ''}${res.note ? `<p class="tiny muted">${esc(res.note)}</p>` : ''}${res.extra || ''}`;
    if (res.proposals?.length) {
      const box = document.createElement('div');
      thinking.append(box);
      renderGroup(box, res.proposals, t('aiProposals'));
    }
  } catch (err) {
    thinking.textContent = err.message;
  }
}

async function freshAnalysis(deck, withCandidates = false, roles = []) {
  const ctx = await context(deck, { candidates: withCandidates, roles });
  const a = analyzeDeck(deck, { edhrec: ctx.edhrec, combos: deps.getCombos() });
  lastAnalysis = { deckId: deck.id, stamp: stamp(deck), a };
  renderReport(a);
  return { a, ctx };
}

async function answer(question) {
  const intent = parseIntent(question);
  const deck = deps.getDeck();
  const o = opts();
  await loadRolesModel();
  const needDeck = !['help', 'card', 'chat', 'build'].includes(intent.type);
  if (needDeck && !deck.commanders.length) return { text: t('aiNeedCommander') };

  switch (intent.type) {
    case 'help':
      return { text: t('ans_help') };
    case 'analyze': {
      const { a } = await freshAnalysis(deck);
      const list = (keys) => keys.map((k) => t(`check_${k}`).toLowerCase()).join(', ');
      return { text: [t('ans_analyze', { score: a.score, grade: a.grade, verdict: t(`verdict_${a.verdict}`) }), a.strengths.length ? t('ans_strengths', { list: list(a.strengths) }) : '', a.weaknesses.length ? t('ans_weaknesses', { list: list(a.weaknesses) }) : ''].filter(Boolean).join('\n') };
    }
    case 'cuts': {
      const { a, ctx } = await freshAnalysis(deck);
      const proposals = proposeChanges(deck, a, ctx.candidates, { mode: 'cuts', count: intent.count || 5 });
      return { text: proposals.length ? t('ans_proposals') : t('ans_noChanges'), proposals };
    }
    case 'role':
    case 'cutLands': {
      const role = intent.type === 'cutLands' ? 'lands' : intent.role;
      const { a, ctx } = await freshAnalysis(deck, true, [role]);
      let proposals;
      if (intent.type === 'cutLands') proposals = proposeChanges(deck, { ...a, counts: { ...a.counts, recLands: Math.max(30, a.counts.lands - (intent.count || 2) - 2) } }, ctx.candidates, { basics: ctx.basics, max: intent.count || 2 }).filter((p) => p.tag === 'lands');
      else proposals = proposeChanges(deck, a, ctx.candidates, { mode: 'role', role, count: intent.count || 3, basics: ctx.basics, budget: o.budget, bracket: o.bracket });
      return { text: proposals.length ? t('ans_proposals') : t('ans_noChanges'), proposals };
    }
    case 'budget': {
      const { a, ctx } = await freshAnalysis(deck, true, ['ramp', 'draw', 'interaction']);
      const proposals = proposeChanges(deck, a, ctx.candidates, { mode: 'budget', budget: intent.budget, max: 20 });
      return { text: proposals.length ? t('ans_proposals') : t('ans_noChanges'), proposals };
    }
    case 'bracket': {
      const { a, ctx } = await freshAnalysis(deck, true, ['ramp', 'draw', 'interaction', 'tutor']);
      const proposals = proposeChanges(deck, a, ctx.candidates, { mode: 'bracket', bracket: intent.bracket, max: 20 });
      return { text: `${t('ans_bracket', { bracket: a.bracket, gc: a.gameChangers.length, tutors: a.counts.tutor, turns: a.counts.extraTurn })}\n${proposals.length ? t('ans_proposals') : t('ans_noChanges')}`, proposals };
    }
    case 'upgrade': {
      const { a, ctx } = await freshAnalysis(deck, true, ['ramp', 'draw', 'interaction']);
      const proposals = proposeChanges(deck, a, ctx.candidates, { mode: 'upgrade', basics: ctx.basics, budget: o.budget, bracket: o.bracket ?? 4, max: 12 });
      return { text: proposals.length ? t('ans_proposals') : t('ans_noChanges'), proposals };
    }
    case 'complete': {
      const box = document.createElement('div');
      const list = await complete(box);
      return { text: list?.length ? t('ans_proposals') : t('ans_noChanges'), extra: '', proposals: list || [] };
    }
    case 'build': {
      if (intent.commander) {
        const card = await sf.named(intent.commander, { fuzzy: true }).catch(() => null);
        if (!card) return { text: t('ans_cardNotFound', { name: intent.commander }) };
        if (!deck.commanders.some((e) => e.card.oracle_id === card.oracle_id)) deps.setCommander(card);
      }
      if (!deps.getDeck().commanders.length) return { text: t('ans_buildNeedCmd') };
      if (intent.budget != null) deps.settings.ai.budget = String(intent.budget);
      const p = await build(document.createElement('div'));
      return { text: p ? t('aiBuilt', { n: p.cards.reduce((n, e) => n + e.qty, 0) + deps.getDeck().commanders.length, cmd: deps.getDeck().commanders.map((e) => e.card.name).join(' + ') }) : t('ans_noChanges'), proposals: p ? [p] : [] };
    }
    case 'curve': {
      const { a } = await freshAnalysis(deck);
      return { text: t('ans_curve', { avg: a.counts.avgCmc.toFixed(2), curve: a.counts.curve.map((n, i) => `${i === 7 ? '7+' : i}:${n}`).join(' '), advice: a.counts.avgCmc > 3.6 ? t('ans_curveHigh') : t('ans_curveOk') }) };
    }
    case 'colors': {
      const { a } = await freshAnalysis(deck);
      return { text: t('ans_colors', { list: a.colors.map((c) => `${c.c} ${c.pips}/${c.sources}${c.ok ? '' : ' ⚠️'}`).join(', ') || '—' }) };
    }
    case 'lands': {
      const { a } = await freshAnalysis(deck);
      return { text: t('ans_lands', { n: a.counts.lands, ramp: a.counts.ramp, avg: a.counts.avgCmc.toFixed(2), target: a.counts.recLands }) };
    }
    case 'bracketInfo': {
      const { a } = await freshAnalysis(deck);
      return { text: t('ans_bracket', { bracket: a.bracket, gc: a.gameChangers.length ? `${a.gameChangers.length} (${a.gameChangers.join(', ')})` : 0, tutors: a.counts.tutor, turns: a.counts.extraTurn }) };
    }
    case 'combos':
      return { text: t('ans_combosNeedServer') };
    case 'roleInfo': {
      const { a } = await freshAnalysis(deck);
      const names = deck.cards.filter((e) => e.card && rolesOf(e.card).includes(intent.role === 'interaction' ? 'removal' : intent.role)).map((e) => e.card.name);
      return { text: t('ans_roleInfo', { n: names.length, roleName: roleName(intent.role), list: names.join(', ') || '—' }), proposals: [] , note: a ? '' : '' };
    }
    case 'card': {
      const card = await sf.named(intent.card, { fuzzy: true }).catch(() => null);
      if (!card) return { text: t('ans_cardNotFound', { name: intent.card }) };
      const ed = deck.commanders.length ? edhrecMap(await edhrecFor(deck)) : new Map();
      const info = ed.get(card.name.split(' // ')[0].toLowerCase());
      const roles = rolesOf(card).filter((r) => !['massLand'].includes(r));
      const { value } = cardValue(card, { edhrec: ed, themes: lastAnalysis?.a?.themes || [] });
      const owned = [...deck.commanders, ...deck.cards].some((e) => e.card?.oracle_id === card.oracle_id);
      const identity = new Set(deck.commanders.flatMap((e) => e.card.color_identity));
      const fits = !deck.commanders.length || card.color_identity.every((c) => identity.has(c));
      const text = [
        t('ans_card', {
          name: card.name,
          roles: roles.length ? roles.map(roleName).join(', ') : t('ans_cardNoRoles'),
          edhrec: info ? t('ans_cardEdhrec', { pct: Math.round(info.inclusion * 100), syn: `${info.synergy >= 0 ? '+' : ''}${Math.round(info.synergy * 100)}` }) : '',
          value: value >= 1.4 ? t('ans_cardValueHigh') : value >= 0.8 ? t('ans_cardValueMid') : t('ans_cardValueLow'),
        }),
        owned ? t('aiInDeck') : fits ? '' : t('aiNotInIdentity'),
      ].filter(Boolean).join('\n');
      const extra = `<div class="ai-card-answer" data-card="${esc(card.name)}">${img(card) ? `<img src="${esc(img(card))}" alt="">` : ''}
        ${!owned && fits && deck.commanders.length ? `<button type="button" class="btn small primary" data-act="addCard">＋ ${esc(t('aiAddCard'))}</button>` : ''}</div>`;
      return { text, extra };
    }
    case 'explain': {
      const { a } = await freshAnalysis(deck);
      const top = a.themes[0];
      const local = t('ans_explain', {
        themes: a.themes.slice(0, 2).map(themeName).join(' + ') || t('aiNoThemes'),
        plan: t(top ? `plan_${top.key}` : 'plan_generic', { tribe: top?.tribe || '' }),
        keys: a.strongest.slice(0, 5).map((x) => x.name).join(', '),
      });
      if (!o.online) return { text: local };
      try {
        return { text: `${local}\n\n🌐 ${await online(question, deck, a)}`, online: true };
      } catch {
        return { text: local, note: t('aiOnlineFail') };
      }
    }
    default: {
      if (!o.online) return { text: t('ans_chatOffline') };
      const a = deck.commanders.length ? (await freshAnalysis(deck)).a : null;
      try {
        return { text: await online(question, deck, a), online: true };
      } catch {
        return { text: t('ans_chatOffline'), note: t('aiOnlineFail') };
      }
    }
  }
}

export { TARGETS };
