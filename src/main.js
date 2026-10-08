import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, ask, message } from '@tauri-apps/plugin-dialog';
import {
  parseSave, summarize, listVariables, diffSaves, applyEdits, formatCredits, currentGameDay, xpForLevel, INT32_MAX, TESTED_VERSIONS,
  findVenue, averageReviewScore, VENUE_MAX_LEVEL, REVIEW_MAX_SCORE,
  ACHIEVEMENT_NAMES, storyToggleEdits,
} from '../core/index.js';
import { areaName } from './areas.js';
import {
  itemInfo, itemName, ITEM_CHOICES, venueInfo, venueIdByInternal, venueName, vendorName, skillInfo, skillName, prettify,
} from './catalog.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  dir: null,
  saves: [],
  thumbs: new Map(), // path -> blob URL
  current: null, // { entry, save, summary, vars, varIndex, venueStats }
  edits: null, // set by resetEdits()
  tab: 'overview',
  invKey: 'PLAYER_INVENTORY',
  peopleFilters: { q: '', metOnly: true },
  venueFilters: { ownedOnly: true },
  backups: null, // { path, list, selected: { id, backup, diff, shot } }
  backupFolder: null,
  filters: { q: '', group: '', kind: '', modifiedOnly: false },
  achievementSearch: '',
  storyBatch: null,
  compare: null, // { entry, diff }
};

// ---------- helpers ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function readBytes(path) {
  return new Uint8Array(await invoke('read_file', { path }));
}

function isAutosave(entry) {
  return entry.name.toUpperCase() === 'AUTOSAVE';
}

function displayName(entry) {
  return isAutosave(entry) ? 'Autosave' : 'Manual save';
}

// The running game rewrites the autosave all the time, so that file is off limits until the
// game is closed. A manual save only changes when the player saves over it, so it may be
// written; the returned text is the warning for the confirmation dialog ('' = not running).
async function gameRunningWarning(entry, blocked) {
  if (!(await invoke('is_game_running'))) return '';
  if (isAutosave(entry)) {
    await message(`Close Nivalis Nights first. ${blocked}\n\nManual saves can be changed while the game is running.`, { title: 'Game is running', kind: 'warning' });
    return null;
  }
  return '\n\nNivalis Nights is running. Load this save in the game afterwards to see the changes, and don\'t save over it in the game before you do.';
}

function formatDate(ms) {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatPlaytime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

function parseCreditsInput(raw) {
  const m = /^\s*(\d{1,8})(?:[.,](\d{1,2}))?\s*$/.exec(raw);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
  return cents <= INT32_MAX ? cents : null;
}

let toastTimer;
function toast(text, kind = 'ok') {
  const el = $('#toast');
  el.textContent = text;
  el.className = `toast toast-${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

function pendingCount() {
  return (state.edits.moneyCents !== undefined ? 1 : 0) + state.edits.variables.size + state.edits.inventory.size
    + state.edits.skills.size + state.edits.venues.size + state.edits.achievements.size;
}

function resetEdits() {
  state.edits = { moneyCents: undefined, variables: new Map(), inventory: new Map(), skills: new Map(), venues: new Map(), achievements: new Map() };
  state.storyBatch = null;
}
resetEdits();

function currentValue(v) {
  return state.edits.variables.has(v.name) ? state.edits.variables.get(v.name) : v.value;
}

function refreshAfterVarEdit() {
  if (state.tab === 'variables') renderVariableRows();
  else if (state.tab === 'people') renderPeopleRows();
  else renderTab();
}

function setVariableEdit(name, value, { fromBatch = false } = {}) {
  if (!fromBatch && state.storyBatch) state.storyBatch = state.storyBatch.filter((entry) => entry.name !== name);
  const original = state.current.varIndex.get(name);
  if (value === original.value) state.edits.variables.delete(name);
  else state.edits.variables.set(name, value);
  renderPending();
}

// ---------- folder & save list ----------

async function loadFolder(dir) {
  state.dir = dir;
  $('#folder-path').textContent = dir;
  $('#folder-path').title = dir;
  try {
    state.saves = await invoke('list_saves', { dir });
  } catch (e) {
    state.saves = [];
    toast(String(e), 'error');
  }
  renderSaveList();
  loadThumbnails();
}

async function loadThumbnails() {
  for (const entry of state.saves) {
    if (!entry.screenshot || state.thumbs.has(entry.path)) continue;
    try {
      const bytes = await readBytes(entry.screenshot);
      state.thumbs.set(entry.path, URL.createObjectURL(new Blob([bytes], { type: 'image/png' })));
      const img = document.querySelector(`[data-thumb="${CSS.escape(entry.path)}"]`);
      if (img) img.src = state.thumbs.get(entry.path);
    } catch {
      // A missing screenshot is harmless.
    }
  }
  if (state.current && state.tab === 'overview') renderMain();
}

function renderSaveList() {
  const list = $('#save-list');
  if (!state.saves.length) {
    list.innerHTML = '<li class="save-list-empty">No .sav files in this folder.</li>';
    return;
  }
  list.innerHTML = state.saves.map((s) => `
    <li>
      <button class="save-item ${state.current?.entry.path === s.path ? 'active' : ''}" data-path="${escapeHtml(s.path)}">
        <img class="thumb" alt="" data-thumb="${escapeHtml(s.path)}" ${state.thumbs.has(s.path) ? `src="${state.thumbs.get(s.path)}"` : ''}>
        <span class="save-meta">
          <span class="save-name">${displayName(s)}</span>
          <span class="save-date">${formatDate(s.modifiedMs)}</span>
          <span class="save-file">${escapeHtml(s.name)}</span>
        </span>
      </button>
    </li>`).join('');
}

async function selectSave(path) {
  if (state.current?.entry.path === path) return;
  if (pendingCount() && !(await ask('Discard your unsaved changes?', { title: 'Unsaved changes', kind: 'warning' }))) return;
  const entry = state.saves.find((s) => s.path === path);
  await openSave(entry);
}

async function openSave(entry) {
  $('#main').innerHTML = '<div class="empty"><div class="spinner"></div><p>Reading save…</p></div>';
  resetEdits();
  state.compare = null;
  state.backups = null;
  renderPending();
  try {
    const save = parseSave(await readBytes(entry.path));
    const vars = listVariables(save);
    state.current = { entry, save, summary: summarize(save), vars, varIndex: new Map(vars.map((v) => [v.name, v])), venueStats: new Map() };
  } catch (e) {
    state.current = null;
    $('#main').innerHTML = `<div class="empty"><h2>Cannot open this save</h2><p class="error-text">${escapeHtml(e.message)}</p></div>`;
    renderSaveList();
    return;
  }
  renderSaveList();
  renderMain();
}

// ---------- main panel ----------

function renderMain() {
  const { entry, summary } = state.current;
  const tabs = [['overview', 'Overview'], ['inventory', 'Inventory'], ['people', 'People'], ['venues', 'Venues'], ['achievements', 'Achievements'], ['variables', `Story variables <span class="count">${summary.variableCount}</span>`], ['compare', 'Compare'], ['backups', 'Backups']];
  $('#main').innerHTML = `
    <div class="save-header">
      <div>
        <h1>${displayName(entry)}</h1>
        <div class="subtle">${escapeHtml(entry.name)}.sav · ${formatDate(entry.modifiedMs)}</div>
      </div>
      <nav class="tabs">${tabs.map(([id, label]) => `<button class="tab ${state.tab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('')}</nav>
    </div>
    ${summary.versionTested ? '' : `<div class="banner banner-warn inline">This save uses format version ${summary.version}, which is newer or older than the versions this editor was tested with (${TESTED_VERSIONS.join(', ')}). It opened without problems, but edits might not work as expected in the game. Check for an editor update; every change is backed up first.</div>`}
    ${summary.warnings.length ? `<div class="banner banner-warn inline">${summary.warnings.map(escapeHtml).join('<br>')}</div>` : ''}
    <div class="tab-body" id="tab-body"></div>`;
  renderTab();
}

function renderTab() {
  const body = $('#tab-body');
  if (state.tab === 'overview') body.innerHTML = overviewHtml();
  else if (state.tab === 'variables') { body.innerHTML = variablesShellHtml(); renderVariableRows(); }
  else if (state.tab === 'inventory') { body.innerHTML = inventoryShellHtml(); renderInventoryRows(); }
  else if (state.tab === 'people') { body.innerHTML = peopleShellHtml(); renderPeopleRows(); }
  else if (state.tab === 'venues') body.innerHTML = venuesHtml();
  else if (state.tab === 'achievements') { body.innerHTML = achievementsShellHtml(); renderAchievementRows(); }
  else if (state.tab === 'backups') {
    body.innerHTML = backupsHtml();
    if (state.backups?.path !== state.current.entry.path) loadBackups().then(() => { if (state.tab === 'backups') renderTab(); });
  }
  else body.innerHTML = compareHtml();
}

// ---------- inventory ----------

const STORAGE_LABELS = { normal: 'Storage', refrigerated: 'Fridge', furniture: 'Furniture' };

function isVenueOwned(venueId) {
  const venue = venueInfo(venueId);
  const owned = venue && state.current.varIndex.get(`${venue.internal}.Owned`);
  return owned?.value === true || state.current.save.header.guids.includes(venueId);
}

// Containers grouped for the picker; empty containers without a known name are hidden.
function containerGroups() {
  const groups = { player: [], owned: [], venues: [], vendors: [] };
  for (const c of state.current.save.inventory.containers) {
    const count = inventoryItems(c.key).length;
    if (c.kind === 'player') groups.player.push({ key: c.key, label: 'Your inventory', count });
    else if (c.kind === 'venue') {
      const label = `${venueName(c.venueId)} · ${STORAGE_LABELS[c.storage]}`;
      (isVenueOwned(c.venueId) ? groups.owned : groups.venues).push({ key: c.key, label, count });
    } else if (c.kind === 'vendor') {
      const name = vendorName(c.vendorId);
      if (name || count) groups.vendors.push({ key: c.key, label: name ?? `Vendor ${c.key.slice(0, 8)}`, count });
    }
  }
  for (const g of [groups.owned, groups.venues, groups.vendors]) g.sort((a, b) => a.label.localeCompare(b.label));
  return groups;
}

function inventoryContainer(key) {
  return state.current.save.inventory.containers.find((c) => c.key === key);
}

function inventoryItems(key) {
  return state.edits.inventory.get(key) ?? inventoryContainer(key).items;
}

// Returns an editable copy of the container's items; call commitInventory(key) after changing it.
function editableItems(key) {
  if (!state.edits.inventory.has(key)) state.edits.inventory.set(key, structuredClone(inventoryContainer(key).items));
  return state.edits.inventory.get(key);
}

function commitInventory(key) {
  const items = state.edits.inventory.get(key).filter((it) => it.stacks.length);
  if (JSON.stringify(items) === JSON.stringify(inventoryContainer(key).items)) state.edits.inventory.delete(key);
  else state.edits.inventory.set(key, items);
  renderPending();
}

function freshnessLabel(units) {
  const days = units / 3;
  return days >= 1 ? `≈ ${Number.isInteger(days) ? days : days.toFixed(1)} days` : `≈ ${units * 8} h`;
}

function inventoryShellHtml() {
  const groups = containerGroups();
  const option = (o) => `<option value="${escapeHtml(o.key)}" ${o.key === state.invKey ? 'selected' : ''}>${escapeHtml(o.label)}${o.count ? ` (${o.count})` : ''}</option>`;
  const group = (label, list) => (list.length ? `<optgroup label="${label}">${list.map(option).join('')}</optgroup>` : '');
  const container = inventoryContainer(state.invKey);
  const changed = state.edits.inventory.has(state.invKey);
  return `
    <div class="toolbar">
      <label>Container
        <select id="inv-container">
          ${group('You', groups.player)}${group('Your venues', groups.owned)}${group('Other venues', groups.venues)}${group('Vendor stock', groups.vendors)}
        </select>
      </label>
      <span class="subtle" id="inv-summary"></span>
      <span class="spacer"></span>
      <button class="btn btn-ghost" id="inv-fresh-all" title="Set every perishable stack in this container to full freshness">Make all fresh</button>
      ${changed ? '<button class="btn btn-ghost" id="inv-revert">Revert container</button>' : ''}
    </div>
    ${container.kind === 'vendor' ? '<p class="hint">Vendor stock is what this vendor currently has for sale. The game restocks vendors on its own schedule.</p>' : ''}
    <div class="card add-item">
      <h2>Add item</h2>
      <div class="add-row">
        <input id="inv-add-search" type="search" list="inv-item-list" placeholder="Search ${ITEM_CHOICES.length.toLocaleString()} items… e.g. Whiskey, Pork, Blender" autocomplete="off">
        <datalist id="inv-item-list">${ITEM_CHOICES.map((c) => `<option value="${escapeHtml(c.label)}"></option>`).join('')}</datalist>
        <input id="inv-add-qty" class="num" type="number" min="1" step="1" value="1" aria-label="Quantity">
        <button class="btn btn-primary" id="inv-add">Add</button>
      </div>
      <p class="hint" id="inv-add-hint">Added items are free (price paid 0) and start fully fresh.</p>
    </div>
    <div class="table-wrap">
      <table class="vars inv">
        <thead><tr><th>Item</th><th>Quantity</th><th>Freshness</th><th>Acquired</th><th>Paid</th><th></th></tr></thead>
        <tbody id="inv-rows"></tbody>
      </table>
    </div>`;
}

function renderInventoryRows() {
  const key = state.invKey;
  const items = inventoryItems(key);
  const original = new Map(inventoryContainer(key).items.map((it) => [it.guid, JSON.stringify(it.stacks)]));
  const total = items.reduce((n, it) => n + it.stacks.reduce((m, s) => m + s.quantity, 0), 0);
  const { capacity } = inventoryContainer(key);
  $('#inv-summary').textContent = `${items.length} item types · ${total.toLocaleString()} units${capacity && capacity < 999999 ? ` · capacity ${capacity.toLocaleString()}` : ''}`;
  if (!items.length) {
    $('#inv-rows').innerHTML = '<tr><td colspan="6" class="none">This container is empty.</td></tr>';
    return;
  }
  $('#inv-rows').innerHTML = items.map((it, i) => {
    const info = itemInfo(it.guid);
    const perishable = Boolean(info?.freshness) || it.stacks.some((s) => s.freshness > 0);
    const status = !original.has(it.guid) ? 'added' : original.get(it.guid) !== JSON.stringify(it.stacks) ? 'modified' : '';
    return it.stacks.map((s, j) => `
      <tr class="${status ? 'modified' : ''}">
        <td class="key">${j === 0
          ? `<span title="${escapeHtml(it.guid)}">${escapeHtml(itemName(it.guid))}</span>${status === 'added' ? ' <span class="count">new</span>' : ''}${info?.refrigerated ? ' <span class="tag" title="Needs refrigeration">❄</span>' : ''}`
          : '<span class="subtle stack-sub">another stack</span>'}</td>
        <td><input class="num inv-qty" type="number" min="1" step="1" value="${s.quantity}" data-item="${i}" data-stack="${j}" aria-label="Quantity"></td>
        <td>${perishable
          ? `<input class="num inv-fresh" type="number" min="0" step="1" value="${s.freshness}" data-item="${i}" data-stack="${j}" aria-label="Freshness" title="Freshness in 8-hour units${info?.freshness ? `, fully fresh = ${info.freshness}` : ''}"> <span class="subtle">${s.freshness ? freshnessLabel(s.freshness) : 'spoiled'}</span>`
          : '<span class="subtle">doesn’t spoil</span>'}</td>
        <td class="subtle">Day ${s.day}</td>
        <td class="subtle">${formatCredits(s.price)}</td>
        <td class="actions"><button class="link" data-remove-stack="${i}:${j}" title="Remove this stack">Remove</button></td>
      </tr>`).join('');
  }).join('');
}

function addInventoryItem() {
  const label = $('#inv-add-search').value.trim();
  const choice = ITEM_CHOICES.find((c) => c.label === label) ?? ITEM_CHOICES.find((c) => c.label.toLowerCase() === label.toLowerCase());
  const qty = Number($('#inv-add-qty').value);
  const hint = $('#inv-add-hint');
  if (!choice) { hint.textContent = 'Pick an item from the suggestions.'; hint.classList.add('error-text'); return; }
  if (!Number.isInteger(qty) || qty < 1 || qty > 100000) { hint.textContent = 'Quantity must be between 1 and 100,000.'; hint.classList.add('error-text'); return; }
  const info = itemInfo(choice.guid);
  const container = inventoryContainer(state.invKey);
  const items = editableItems(state.invKey);
  const stack = { price: 0, day: currentGameDay(state.current.save), quantity: qty, freshness: info?.freshness ?? 0 };
  const existing = items.find((it) => it.guid === choice.guid);
  if (existing) existing.stacks.push(stack);
  else items.push({ guid: choice.guid, stacks: [stack] });
  commitInventory(state.invKey);
  renderTab();
  const warn = info?.refrigerated && container.kind === 'venue' && container.storage !== 'refrigerated'
    ? ` Note: ${choice.name} normally goes in a fridge.` : '';
  toast(`Added ${qty} × ${choice.name}.${warn}`, warn ? 'error' : 'ok');
}

function makeAllFresh() {
  const items = editableItems(state.invKey);
  let n = 0;
  for (const it of items) {
    const max = itemInfo(it.guid)?.freshness;
    if (!max) continue;
    for (const s of it.stacks) if (s.freshness !== max) { s.freshness = max; n++; }
  }
  commitInventory(state.invKey);
  renderTab();
  toast(n ? `Refreshed ${n} stack${n === 1 ? '' : 's'}.` : 'Everything here is already fresh or doesn’t spoil.');
}


function overviewHtml() {
  const { entry, summary } = state.current;
  const money = state.edits.moneyCents ?? summary.moneyCents;
  const thumb = state.thumbs.get(entry.path);
  return `
    <div class="overview">
      <div class="shot">${thumb ? `<img src="${thumb}" alt="Screenshot of this save">` : '<div class="shot-missing">No screenshot</div>'}</div>
      <dl class="facts">
        <div><dt>Location</dt><dd>${escapeHtml(areaName(summary.sceneIndex))}</dd></div>
        <div><dt>In-game time</dt><dd>Day ${summary.gameDay + 1}, ${summary.gameClock}</dd></div>
        <div><dt>Playtime</dt><dd>${formatPlaytime(summary.playtimeSeconds)}</dd></div>
        <div><dt>Saved</dt><dd>${new Date(summary.savedAt).toLocaleString()}</dd></div>
        <div><dt>Story variables</dt><dd>${summary.variableCount.toLocaleString()}</dd></div>
        <div><dt>World objects</dt><dd>${summary.ghostBlockCount.toLocaleString()}</dd></div>
      </dl>
    </div>
    <section class="card">
      <h2>Money</h2>
      <div class="money-row">
        <label class="money-field ${state.edits.moneyCents !== undefined ? 'modified' : ''}">
          
          <input id="money-input" type="text" inputmode="decimal" autocomplete="off" value="${formatCredits(money)}" aria-label="Money in credits">
          <span class="currency">credits</span>
        </label>
        <div class="quick">
          ${[1000, 10000, 100000].map((c) => `<button class="btn btn-ghost" data-add-credits="${c}">+${c.toLocaleString()}</button>`).join('')}
          <button class="btn btn-ghost" id="money-reset" ${state.edits.moneyCents === undefined ? 'disabled' : ''}>Reset</button>
        </div>
      </div>
      <p class="hint" id="money-hint">Original: ${formatCredits(summary.moneyCents)} credits. Both copies in the save are updated.</p>
    </section>
    ${financesHtml()}
    ${skillsHtml()}
    <section class="card muted-card">
      <h2>In-game time</h2>
      <p class="hint">Read-only. The clock is stamped into hundreds of world records (schedules, events), so changing it in one place would desync the world.</p>
    </section>`;
}

function variablesShellHtml() {
  const groups = new Map();
  for (const v of state.current.vars) groups.set(v.group, (groups.get(v.group) ?? 0) + 1);
  const f = state.filters;
  const options = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([g, n]) => `<option value="${escapeHtml(g)}" ${f.group === g ? 'selected' : ''}>${escapeHtml(g || '(no group)')} (${n})</option>`).join('');
  return `
    <div class="toolbar">
      <button class="btn" id="story-finish" ${state.current.save.tablesConsistent ? '' : 'disabled'}>Finish completion flags</button>
      <button class="btn" id="story-enable-all" ${state.current.save.tablesConsistent ? '' : 'disabled'}>Enable all story toggles</button>
      <button class="btn btn-ghost" id="story-undo" ${state.storyBatch ? '' : 'disabled'}>Undo last bulk action</button>
    </div>
    <div class="toolbar">
      <input id="var-search" type="search" placeholder="Search variables… e.g. Romance, Venue, Debt" value="${escapeHtml(f.q)}">
      <select id="var-group"><option value="">All groups</option>${options}</select>
      <select id="var-kind">
        <option value="">All types</option>
        <option value="bool" ${f.kind === 'bool' ? 'selected' : ''}>Flags</option>
        <option value="int" ${f.kind === 'int' ? 'selected' : ''}>Numbers</option>
        <option value="string" ${f.kind === 'string' ? 'selected' : ''}>Text</option>
      </select>
      <label class="check"><input id="var-modified" type="checkbox" ${f.modifiedOnly ? 'checked' : ''}> Changed only</label>
      <span class="subtle" id="var-count"></span>
    </div>
    <p class="hint">These are the game's story and progress flags. Changing them can skip or break quest steps; keep the automatic backup in mind.</p>
    <div class="table-wrap">
      <table class="vars">
        <thead><tr><th>Group</th><th>Variable</th><th>Value</th><th></th></tr></thead>
        <tbody id="var-rows"></tbody>
      </table>
    </div>`;
}

async function stageStoryToggles(completionOnly) {
  const edits = storyToggleEdits(state.current.vars, { completionOnly });
  const changes = Object.entries(edits).filter(([name, value]) => currentValue(state.current.varIndex.get(name)) !== value);
  if (!changes.length) { toast('All matching toggles are already enabled.'); return; }
  const warning = completionOnly
    ? 'Sets boolean variables ending in Complete, Completed, Finished or Done to true. This does not run quests or set numeric quest steps.'
    : 'Sets EVERY boolean story variable to true, including failure flags, mutually exclusive choices and world state. This can break quests and is not a guaranteed completed story.';
  const preview = changes.slice(0, 12).map(([name]) => name).join('\n');
  if (!(await ask(`${warning}\n\nStage ${changes.length} changes across all groups, regardless of search filters?\n\n${preview}${changes.length > 12 ? '\n…' : ''}\n\nYou can review, undo or discard them before saving.`, { title: completionOnly ? 'Finish completion flags' : 'Enable all story toggles', kind: 'warning' }))) return;
  state.storyBatch = changes.map(([name]) => ({ name, before: currentValue(state.current.varIndex.get(name)) }));
  for (const [name, value] of changes) setVariableEdit(name, value, { fromBatch: true });
  renderTab();
  toast(`${changes.length} story toggles staged. Review them with Changed only before saving.`);
}

// ---------- achievements ----------

const BUSINESS_ENTRIES = ['First customer', 'First four-star review', '1,000 revenue', 'Four-star average reviews',
  'First five-star review', 'Handle a complaint', 'Serve 100 customers', 'Serve 500 customers', 'Own two venues',
  'Own five venues', 'Offer drinks', 'Offer a dessert', '500 daily revenue', 'Pictures on the wall',
  'Umbrella Corp', 'Debt free', 'Pay back a loan'];

function achievementName(guid) { return ACHIEVEMENT_NAMES[guid] ?? guid; }

function achievementValues(entry) {
  return { ...entry, ...state.edits.achievements.get(entry.guid) };
}

function setAchievementEdit(guid, edit) {
  const entry = state.current.save.achievements.entries.find((e) => e.guid === guid);
  const next = { ...state.edits.achievements.get(guid), ...edit };
  for (const field of Object.keys(next)) {
    const original = field === 'flags' ? entry.flags.map(Boolean) : entry[field];
    if (JSON.stringify(next[field]) === JSON.stringify(original)) delete next[field];
  }
  if (Object.keys(next).length) state.edits.achievements.set(guid, next);
  else state.edits.achievements.delete(guid);
  renderPending();
}

function achievementsShellHtml() {
  if (!state.current.save.achievements) return '<div class="card"><h2>Achievements unavailable</h2><p class="hint">This save does not contain a supported achievement section.</p></div>';
  return `<div class="toolbar"><input id="achievement-search" type="search" placeholder="Search achievement series…" value="${escapeHtml(state.achievementSearch)}"><span id="achievement-count" class="subtle"></span></div>
    <p class="hint">Saved achievement progress. Counters do not discover collectibles or finish quests, and Steam unlocks are not guaranteed. Individual entry toggles are available where the save stores them. The saved series completion state is preserved.</p>
    <div id="achievement-rows" class="achievement-grid"></div>`;
}

function renderAchievementRows() {
  const section = state.current.save.achievements;
  if (!section) return;
  const expanded = new Set([...document.querySelectorAll('details[data-achievement-details][open]')].map((el) => el.dataset.achievementDetails));
  const total = section.points + section.entries.reduce((n, entry) => n + (achievementValues(entry).earned - entry.earned), 0);
  const rows = section.entries.filter((entry) => achievementName(entry.guid).toLowerCase().includes(state.achievementSearch.toLowerCase().trim()));
  $('#achievement-count').textContent = `${rows.length} series · ${total} saved points`;
  $('#achievement-rows').innerHTML = rows.map((entry) => {
    const value = achievementValues(entry);
    const modified = state.edits.achievements.has(entry.guid);
    return `<div class="card ${modified ? 'modified' : ''}"><h2>${escapeHtml(achievementName(entry.guid))}</h2>
      <div class="achievement-fields"><label>Completed entries <input class="num" type="number" min="0" max="${INT32_MAX}" step="1" data-achievement="${entry.guid}" data-achievement-field="completed" value="${value.completed}" ${entry.flags.length ? 'disabled' : ''}></label>
      <label>Saved points <input class="num" type="number" min="0" max="${INT32_MAX}" step="1" data-achievement="${entry.guid}" data-achievement-field="earned" value="${value.earned}"></label></div>
      ${entry.flags.length ? `<details data-achievement-details="${entry.guid}" ${expanded.has(entry.guid) ? 'open' : ''}><summary>Individual entries (${value.completed}/${entry.flags.length})</summary>${value.flags.map((flag, i) => `<label class="check achievement-entry"><input type="checkbox" data-achievement="${entry.guid}" data-achievement-entry="${i}" ${flag ? 'checked' : ''}>${escapeHtml(achievementName(entry.guid) === 'Business' && entry.flags.length === BUSINESS_ENTRIES.length ? BUSINESS_ENTRIES[i] : `Entry ${i + 1}`)}</label>`).join('')}</details>` : '<p class="hint">This series stores counters rather than individual entry flags.</p>'}
      ${modified ? `<button class="link" data-achievement-revert="${entry.guid}">Revert series</button>` : ''}</div>`;
  }).join('') || '<p class="hint">No achievements match.</p>';
}

function valueEditorHtml(v) {
  const value = currentValue(v);
  if (v.kind === 'bool') {
    return `<label class="switch"><input type="checkbox" data-var="${escapeHtml(v.name)}" ${value ? 'checked' : ''}><span></span></label>`;
  }
  if (v.kind === 'int') {
    return `<input class="num" type="number" step="1" data-var="${escapeHtml(v.name)}" value="${value}">`;
  }
  return `<span class="text-value" title="Text variables are read-only for now">${value === '' ? '<em>empty</em>' : escapeHtml(value)} 🔒</span>`;
}

function renderVariableRows() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  const rows = state.current.vars.filter((v) =>
    (!q || v.name.toLowerCase().includes(q))
    && (!f.group || v.group === f.group)
    && (!f.kind || v.kind === f.kind)
    && (!f.modifiedOnly || state.edits.variables.has(v.name)));
  $('#var-count').textContent = `${rows.length.toLocaleString()} shown`;
  $('#var-rows').innerHTML = rows.length ? rows.map((v) => {
    const changed = state.edits.variables.has(v.name);
    return `<tr class="${changed ? 'modified' : ''}">
      <td class="group">${escapeHtml(v.group)}</td>
      <td class="key">${escapeHtml(v.key)}</td>
      <td class="value">${valueEditorHtml(v)}</td>
      <td class="actions">${changed ? `<button class="link" data-revert="${escapeHtml(v.name)}" title="Original: ${escapeHtml(String(v.value))}">Revert</button>` : ''}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="4" class="none">No variables match.</td></tr>';
}

function compareHtml() {
  const others = state.saves.filter((s) => s.path !== state.current.entry.path);
  const c = state.compare;
  const result = c
    ? diffHtml(c.diff, displayName(c.entry), 'This save', { allowTake: true })
    : '<p class="hint">Pick another save to see what changed between them. Handy for finding which flag a quest step sets.</p>';
  return `
    <div class="toolbar">
      <label>Compare with
        <select id="compare-select">
          <option value="">Choose a save…</option>
          ${others.map((s) => `<option value="${escapeHtml(s.path)}" ${c?.entry.path === s.path ? 'selected' : ''}>${displayName(s)} · ${formatDate(s.modifiedMs)}</option>`).join('')}
        </select>
      </label>
    </div>
    ${result}`;
}

async function runCompare(path) {
  if (!path) { state.compare = null; renderTab(); return; }
  const entry = state.saves.find((s) => s.path === path);
  $('#tab-body').innerHTML = '<div class="empty"><div class="spinner"></div><p>Comparing…</p></div>';
  try {
    const other = parseSave(await readBytes(path));
    state.compare = { entry, diff: diffSaves(other, state.current.save) };
  } catch (e) {
    state.compare = null;
    toast(`Cannot compare: ${e.message}`, 'error');
  }
  renderTab();
}


// ---------- people & venues (friendly views over story variables) ----------

const RELATION_FIELDS = [
  { key: 'Friend', label: 'Friend', seen: '−1 to 5' },
  { key: 'Romance', label: 'Romance', seen: '0 to 2' },
  { key: 'Business', label: 'Business', seen: '0 to 3' },
  { key: 'Enemy', label: 'Enemy', seen: '0 to 1' },
];

// Editor for one story variable; wires into the same data-var handlers as the Story variables tab.
function varInput(name, { title = '' } = {}) {
  const v = state.current.varIndex.get(name);
  if (!v) return '<span class="subtle">—</span>';
  const changed = state.edits.variables.has(name);
  if (v.kind === 'bool') {
    return `<label class="switch ${changed ? 'modified' : ''}" title="${escapeHtml(title)}"><input type="checkbox" data-var="${escapeHtml(name)}" ${currentValue(v) ? 'checked' : ''}><span></span></label>`;
  }
  return `<input class="num small ${changed ? 'modified' : ''}" type="number" step="1" data-var="${escapeHtml(name)}" value="${currentValue(v)}" title="${escapeHtml(title)}">`;
}

function varValue(name) {
  const v = state.current.varIndex.get(name);
  return v ? currentValue(v) : undefined;
}

function peopleList() {
  const byGroup = new Map();
  for (const v of state.current.vars) {
    if (!v.group || !['Met', ...RELATION_FIELDS.map((f) => f.key)].includes(v.key)) continue;
    if (!byGroup.has(v.group)) byGroup.set(v.group, new Set());
    byGroup.get(v.group).add(v.key);
  }
  return [...byGroup.entries()]
    .filter(([, keys]) => RELATION_FIELDS.some((f) => keys.has(f.key)))
    .map(([group]) => ({ group, name: prettify(group), met: varValue(`${group}.Met`) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function peopleShellHtml() {
  const f = state.peopleFilters;
  return `
    <div class="toolbar">
      <input id="people-search" type="search" placeholder="Search people…" value="${escapeHtml(f.q)}">
      <label class="check"><input id="people-met" type="checkbox" ${f.metOnly ? 'checked' : ''}> Met only</label>
      <span class="subtle" id="people-count"></span>
    </div>
    <p class="hint">Relationship levels as the game stores them. The ranges in the column headers are the values seen in real saves so far, not hard limits.</p>
    <div class="table-wrap">
      <table class="vars people">
        <thead><tr><th>Person</th><th>Met</th>${RELATION_FIELDS.map((r) => `<th>${r.label} <span class="subtle">${r.seen}</span></th>`).join('')}</tr></thead>
        <tbody id="people-rows"></tbody>
      </table>
    </div>`;
}

function renderPeopleRows() {
  const f = state.peopleFilters;
  const q = f.q.trim().toLowerCase();
  const rows = peopleList().filter((p) => (!q || p.name.toLowerCase().includes(q)) && (!f.metOnly || p.met !== false));
  $('#people-count').textContent = `${rows.length} shown`;
  $('#people-rows').innerHTML = rows.length ? rows.map((p) => {
    const names = [`${p.group}.Met`, ...RELATION_FIELDS.map((r) => `${p.group}.${r.key}`)];
    const changed = names.some((n) => state.edits.variables.has(n));
    return `<tr class="${changed ? 'modified' : ''}">
      <td>${escapeHtml(p.name)}</td>
      <td>${varInput(`${p.group}.Met`)}</td>
      ${RELATION_FIELDS.map((r) => `<td>${varInput(`${p.group}.${r.key}`)}</td>`).join('')}
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="none">Nobody matches.</td></tr>';
}

// Level, customers served and reviews live in the venue's world record (core/venues.js); the game copies
// them into the Venue_* story variables when a save loads, so those variables are only kept in sync.
const VENUE_INFO = [
  ['Seats', 'Seats'], ['BarSeats', 'Bar seats'], ['MenuMeals', 'Meals on menu'], ['MenuDrinks', 'Drinks on menu'],
  ['StaffTotal', 'Staff'], ['StaffChefs', 'Chefs'], ['StaffWaiters', 'Waiters'], ['StaffCleaners', 'Cleaners'],
  ['StaffManagers', 'Managers'], ['Storage', 'Storage used'], ['ColdStorage', 'Cold storage used'],
];

function venueList() {
  const groups = new Set(state.current.vars.filter((v) => v.group.startsWith('Venue_') && v.key === 'Owned').map((v) => v.group));
  return [...groups].map((group) => {
    const id = venueIdByInternal(group);
    return { group, id, name: id ? venueName(id) : prettify(group.replace(/^Venue_/, '')), owned: varValue(`${group}.Owned`) === true };
  }).sort((a, b) => (b.owned - a.owned) || a.name.localeCompare(b.name));
}

// The venue's world record, or null when the save has none the editor can recognise.
function venueStats(id) {
  const cache = state.current.venueStats;
  if (!cache.has(id)) {
    try {
      cache.set(id, findVenue(state.current.save, id));
    } catch {
      cache.set(id, null);
    }
  }
  return cache.get(id);
}

function setVenueEdit(id, field, value) {
  const stats = venueStats(id);
  const edit = { ...state.edits.venues.get(id) };
  if (value === undefined || (field !== 'reviewScore' && value === stats[field])) delete edit[field];
  else edit[field] = value;
  if (Object.keys(edit).length) state.edits.venues.set(id, edit);
  else state.edits.venues.delete(id);
  renderPending();
}

const formatStars = (score) => (score === null ? '–' : `${score.toFixed(2)} ★`);

function venueFieldsHtml(id) {
  const stats = id && venueStats(id);
  if (!stats) return '<p class="hint">This venue’s level and reviews were not found in this save.</p>';
  const edit = state.edits.venues.get(id) ?? {};
  const number = (field, label, min, max) => `
    <label class="field"><span>${label}</span>
      <input class="num small ${edit[field] !== undefined ? 'modified' : ''}" type="number" step="1" min="${min}" ${max ? `max="${max}"` : ''}
        data-venue="${id}" data-venue-field="${field}" value="${edit[field] ?? stats[field]}"></label>`;
  const count = stats.reviews.length;
  const stars = Array.from({ length: REVIEW_MAX_SCORE }, (_, i) => i + 1)
    .map((s) => `<option value="${s}" ${edit.reviewScore === s ? 'selected' : ''}>All ${s} ★</option>`).join('');
  return `
    <div class="venue-grid">
      ${number('level', `Level <span class="subtle">1–${VENUE_MAX_LEVEL}</span>`, 1, VENUE_MAX_LEVEL)}
      ${number('mealsServed', 'Customers served', 0)}
      <label class="field"><span>Reviews <span class="subtle">${count} · average ${formatStars(averageReviewScore(stats))}</span></span>
        <select data-venue="${id}" data-venue-field="reviewScore" class="${edit.reviewScore ? 'modified' : ''}" ${count ? '' : 'disabled'}>
          <option value="">${count ? 'Keep as they are' : 'No reviews yet'}</option>${stars}
        </select></label>
    </div>`;
}

// Story variables that mirror the venue edits, so the save is consistent before the game refreshes them.
function venueVariableEdits() {
  const out = {};
  for (const [id, edit] of state.edits.venues) {
    const group = venueInfo(id)?.internal;
    const sync = { Level: edit.level, CustomersServed: edit.mealsServed, ReviewScore: edit.reviewScore };
    for (const [key, value] of Object.entries(sync)) {
      const name = `${group}.${key}`;
      if (value !== undefined && state.current.varIndex.get(name)?.kind === 'int' && !state.edits.variables.has(name)) out[name] = value;
    }
  }
  return out;
}

function venuesHtml() {
  const f = state.venueFilters;
  const venues = venueList().filter((v) => !f.ownedOnly || v.owned);
  const cards = venues.map((v) => `
    <section class="card venue">
      <div class="venue-head">
        <h2>${escapeHtml(v.name)}</h2>
        ${v.owned ? '<span class="badge">Owned</span>' : '<span class="subtle">Not owned</span>'}
      </div>
      ${venueFieldsHtml(v.id)}
      <div class="venue-info subtle">
        ${VENUE_INFO.filter(([k]) => varValue(`${v.group}.${k}`) !== undefined).map(([k, label]) => `${label}: <b>${varValue(`${v.group}.${k}`)}</b>`).join(' · ')}
      </div>
      ${v.id ? `<div class="venue-links">${['normal', 'refrigerated', 'furniture'].map((s) => `<button class="link" data-open-container="${escapeHtml(`${v.id}_${{ normal: 'Normal', refrigerated: 'Refridgerated', furniture: 'Furniture' }[s]}Inventory`)}">${STORAGE_LABELS[s]}</button>`).join(' · ')}</div>` : ''}
    </section>`).join('');
  return `
    <div class="toolbar">
      <label class="check"><input id="venues-owned" type="checkbox" ${f.ownedOnly ? 'checked' : ''}> Owned only</label>
      <span class="subtle">${venues.length} venue${venues.length === 1 ? '' : 's'}</span>
    </div>
    <p class="hint">Level and customers served can be edited. The review score is the average of the venue’s reviews, so it changes by giving every review the same number of stars; the number of reviews can’t be changed. The game also checks the level against customers served and the review score, so raise those along with the level. Seats, staff, menu and storage are shown for information: the game recalculates them from your venue. Ownership can’t be changed here yet, because it is also stored in other parts of the save.</p>
    ${cards || '<p class="hint">No venues match.</p>'}`;
}

function financesHtml() {
  const debts = [['GameState.NoodleBar_Debt', 'Noodle bar debt'], ['GameState.Debt', 'Other debt']]
    .filter(([n]) => state.current.varIndex.has(n));
  if (!debts.length) return '';
  return `
    <section class="card">
      <h2>Debt</h2>
      <div class="venue-grid">
        ${debts.map(([n, label]) => `<label class="field"><span>${label}</span>${varInput(n)}</label>`).join('')}
      </div>
      <p class="hint">Shown exactly as stored in the save.</p>
    </section>`;
}

const shownLevel = (stored) => stored + 1;
const formatXp = (xp) => (Number.isNaN(xp) ? '–' : Math.floor(xp).toLocaleString());

// Skills the save has an entry for. Choosing a level also moves the XP to the start of that level,
// so the two stay consistent the way the game keeps them. Levels are stored from 0; the game (and
// therefore everything shown here) counts them from 1.
function skillsHtml() {
  const { entries } = state.current.save.skills;
  if (!entries.length) return '';
  const fields = entries.map((e) => {
    const info = skillInfo(e.guid);
    const edit = state.edits.skills.get(e.guid);
    const { xp, level } = edit ?? e;
    const top = Math.max(info ? info.steps.length - 1 : 0, e.level);
    const options = Array.from({ length: top + 1 }, (_, l) => `<option value="${l}" ${l === level ? 'selected' : ''}>Level ${shownLevel(l)}</option>`).join('');
    const progress = info && level < info.steps.length - 1
      ? `${formatXp(xp)} / ${xpForLevel(info.steps, level + 1).toLocaleString()} XP`
      : 'Top level';
    return `<label class="field"><span>${escapeHtml(skillName(e.guid))}</span>
      <select data-skill="${e.guid}" class="${edit ? 'modified' : ''}" ${info ? '' : 'disabled'}>${options}</select>
      <span class="subtle">${progress}</span></label>`;
  }).join('');
  return `
    <section class="card">
      <h2>Skills</h2>
      <div class="venue-grid">${fields}</div>
      <p class="hint">Choosing a level sets the skill’s XP to the start of that level. A skill appears here once you have gained XP in it in the game.</p>
    </section>`;
}

function setSkillLevel(guid, level) {
  const original = state.current.save.skills.entries.find((e) => e.guid === guid);
  if (level === original.level) state.edits.skills.delete(guid);
  else state.edits.skills.set(guid, { xp: xpForLevel(skillInfo(guid).steps, level), level });
  renderPending();
  renderTab();
}

// ---------- diffs (shared by Compare and Backups) ----------

const HEADER_LABELS = { moneyCents: 'Money', gameSeconds: 'In-game time', sceneIndex: 'Location', playtimeSeconds: 'Playtime' };

function formatHeaderValue(field, v) {
  if (field === 'moneyCents') return formatCredits(v);
  if (field === 'sceneIndex') return areaName(v);
  if (field === 'playtimeSeconds') return formatPlaytime(v);
  return `Day ${Math.floor(v / 86400) + 1}, ${new Date((v % 86400) * 1000).toISOString().slice(11, 16)}`;
}

function containerLabel(key) {
  const c = state.current.save.inventory.containers.find((x) => x.key === key);
  if (!c) return key;
  if (c.kind === 'player') return 'Your inventory';
  if (c.kind === 'venue') return `${venueName(c.venueId)} · ${STORAGE_LABELS[c.storage]}`;
  if (c.kind === 'vendor') return `${vendorName(c.vendorId) ?? 'Vendor'} (stock)`;
  return key;
}

// Cards listing header, inventory and variable differences. beforeLabel/afterLabel name the columns.
function diffHtml(diff, beforeLabel, afterLabel, { allowTake = false } = {}) {
  const { header, variables, inventory, skills } = diff;
  const skillValue = (s) => (s ? `Level ${shownLevel(s.level)} (${formatXp(s.xp)} XP)` : 'Not started');
  const skillsCard = skills.length ? `
    <div class="card">
      <h2>Skills <span class="count">${skills.length}</span></h2>
      <table class="diff"><tbody>${skills.map((s) => `<tr><td>${escapeHtml(skillName(s.guid))}</td><td class="before">${skillValue(s.before)}</td><td>→</td><td class="after">${skillValue(s.after)}</td></tr>`).join('')}</tbody></table>
    </div>` : '';
  const headerCard = `
    <div class="card">
      <h2>Save info</h2>
      ${header.length ? `<table class="diff"><tbody>${header.map((h) => `<tr><td>${HEADER_LABELS[h.field]}</td><td class="before">${escapeHtml(formatHeaderValue(h.field, h.before))}</td><td>→</td><td class="after">${escapeHtml(formatHeaderValue(h.field, h.after))}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">No differences.</p>'}
    </div>`;
  const inventoryCard = `
    <div class="card">
      <h2>Inventory <span class="count">${inventory.length}</span></h2>
      ${inventory.length ? `<div class="table-wrap"><table class="diff vars"><thead><tr><th>Container</th><th>Item</th><th>${escapeHtml(beforeLabel)}</th><th></th><th>${escapeHtml(afterLabel)}</th></tr></thead><tbody>
        ${inventory.map((c) => `<tr>
          <td>${escapeHtml(containerLabel(c.container))}</td>
          <td>${escapeHtml(itemName(c.guid))}</td>
          <td class="before">${c.before}</td><td>→</td>
          <td class="after">${c.after}${c.stacksChanged ? ' <span class="subtle">(freshness or stacks changed)</span>' : ''}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="hint">No differences.</p>'}
    </div>`;
  const variablesCard = `
    <div class="card">
      <h2>Story variables <span class="count">${variables.length}</span></h2>
      ${variables.length ? `<div class="table-wrap"><table class="diff vars"><thead><tr><th>Variable</th><th>${escapeHtml(beforeLabel)}</th><th></th><th>${escapeHtml(afterLabel)}</th><th></th></tr></thead><tbody>
        ${variables.map((v) => `<tr>
          <td class="key">${escapeHtml(v.name)}</td>
          <td class="before">${escapeHtml(JSON.stringify(v.before))}</td><td>→</td>
          <td class="after">${escapeHtml(JSON.stringify(v.after))}</td>
          <td class="actions">${allowTake && v.kind !== 'string' && v.before !== undefined ? `<button class="link" data-take="${escapeHtml(v.name)}" title="Stage the other save's value as an edit">Use other value</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="hint">No differences.</p>'}
    </div>`;
  const achievementsCard = diff.achievements?.length ? `<div class="card"><h2>Achievements <span class="count">${diff.achievements.length}</span></h2>
    <table class="diff vars"><thead><tr><th>Series</th><th>${escapeHtml(beforeLabel)}</th><th>${escapeHtml(afterLabel)}</th></tr></thead><tbody>${diff.achievements.map((a) => {
      const label = (v) => v ? `${v.completed} entries · ${v.earned} points · flags ${v.flags.map(Number).join('') || 'none'}` : 'Not present';
      return `<tr><td>${escapeHtml(achievementName(a.guid))}</td><td class="before">${escapeHtml(label(a.before))}</td><td class="after">${escapeHtml(label(a.after))}</td></tr>`;
    }).join('')}</tbody></table></div>` : '';
  return headerCard + skillsCard + achievementsCard + inventoryCard + variablesCard;
}

// One-line description of an edit, stored with the backup taken before it.
function summarizeDiff(diff) {
  const parts = [];
  if (diff.achievements?.length) parts.push(`${diff.achievements.length} achievement series changed`);
  for (const h of diff.header) parts.push(`${HEADER_LABELS[h.field]} ${formatHeaderValue(h.field, h.before)} → ${formatHeaderValue(h.field, h.after)}`);
  for (const s of diff.skills) {
    if (s.before?.level !== s.after?.level) parts.push(`${skillName(s.guid)} level ${shownLevel(s.before?.level ?? 0)} → ${shownLevel(s.after?.level ?? 0)}`);
  }
  const inv = diff.inventory.filter((c) => c.before !== c.after);
  for (const c of inv.slice(0, 3)) {
    const d = c.after - c.before;
    parts.push(`${d > 0 ? '+' : '−'}${Math.abs(d)} ${itemName(c.guid)}`);
  }
  if (inv.length > 3) parts.push(`${inv.length - 3} more item changes`);
  const fresh = diff.inventory.filter((c) => c.stacksChanged).length;
  if (fresh) parts.push(`${fresh} item${fresh === 1 ? '' : 's'} freshened or restacked`);
  for (const v of diff.variables.slice(0, 2)) parts.push(`${v.name} ${JSON.stringify(v.before)} → ${JSON.stringify(v.after)}`);
  if (diff.variables.length > 2) parts.push(`${diff.variables.length - 2} more variables`);
  return parts.join(', ') || 'No changes';
}

// ---------- backups ----------

const BACKUP_KINDS = { edit: 'Before edit', manual: 'Manual', 'before-restore': 'Before restore', imported: 'Imported' };

async function loadBackups() {
  const path = state.current.entry.path;
  try {
    state.backups = { path, list: await invoke('list_backups', { path }), selected: null };
  } catch (e) {
    state.backups = { path, list: [], selected: null, error: String(e) };
  }
}

// The backup folder without the user name in it (it would end up in screenshots).
function backupFolderLabel(path) {
  if (!path) return 'the app data folder';
  return path
    .replace(/^[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local(?=\\)/, '%LOCALAPPDATA%')
    .replace(/^\/home\/[^/]+(?=\/)/, '~');
}

function backupsHtml() {
  const b = state.backups;
  if (!b || b.path !== state.current.entry.path) return '<div class="empty"><div class="spinner"></div><p>Loading backups…</p></div>';
  const rows = b.list.map((x) => `
    <tr class="${b.selected?.id === x.id ? 'selected' : ''}">
      <td>${formatDate(x.createdMs)}</td>
      <td>${x.original ? '<span class="badge" title="Kept permanently">Original</span> ' : ''}${BACKUP_KINDS[x.kind] ?? escapeHtml(x.kind)}</td>
      <td class="note">${escapeHtml(x.note || '—')}</td>
      <td class="subtle">${(x.size / 1048576).toFixed(1)} MB</td>
      <td class="actions">
        <button class="link" data-backup-compare="${x.id}">Compare</button> ·
        <button class="link" data-backup-restore="${x.id}">Restore</button>${x.original ? '' : ` · <button class="link danger" data-backup-delete="${x.id}">Delete</button>`}
      </td>
    </tr>`).join('');
  const sel = b.selected;
  return `
    <div class="toolbar">
      <button class="btn" id="backup-now">Back up now</button>
      <span class="subtle">Up to 10 backups per save. The oldest (“Original”) is kept permanently.</span>
    </div>
    ${b.error ? `<div class="banner banner-warn inline">${escapeHtml(b.error)}</div>` : ''}
    <div class="table-wrap">
      <table class="vars backups">
        <thead><tr><th>Taken</th><th>Type</th><th>What happened next</th><th>Size</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="none">No backups of this save yet. One is made automatically every time you save changes.</td></tr>'}</tbody>
      </table>
    </div>
    <p class="hint">Stored in <code title="${escapeHtml(state.backupFolder ?? '')}">${escapeHtml(backupFolderLabel(state.backupFolder))}</code>, outside the Steam Cloud save folder.</p>
    ${sel ? `
      <h2 class="section-title">Changes since the backup from ${formatDate(sel.backup.createdMs)}</h2>
      <div class="backup-compare">
        ${sel.shot ? `<img class="backup-shot" src="${sel.shot}" alt="Screenshot stored with this backup">` : ''}
        <p class="hint">Left column: the backup. Right column: the save as it is now. Restoring brings back the left column.</p>
      </div>
      ${diffHtml(sel.diff, 'Backup', 'Now')}` : ''}`;
}

async function compareBackup(id) {
  const backup = state.backups.list.find((x) => x.id === id);
  $('#tab-body').innerHTML = '<div class="empty"><div class="spinner"></div><p>Reading backup…</p></div>';
  try {
    const old = parseSave(new Uint8Array(await invoke('read_backup', { path: state.current.entry.path, id })));
    let shot = null;
    if (backup.hasScreenshot) {
      const png = new Uint8Array(await invoke('read_backup_screenshot', { path: state.current.entry.path, id }));
      shot = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
    }
    if (state.backups.selected?.shot) URL.revokeObjectURL(state.backups.selected.shot);
    state.backups.selected = { id, backup, diff: diffSaves(old, state.current.save), shot };
  } catch (e) {
    toast(`Cannot read backup: ${e.message ?? e}`, 'error');
  }
  renderTab();
}

async function restoreBackup(id) {
  const { entry } = state.current;
  const backup = state.backups.list.find((x) => x.id === id);
  const runningWarning = await gameRunningWarning(entry, 'The game keeps overwriting the autosave, so the restored one would be lost.');
  if (runningWarning === null) return;
  try {
    parseSave(new Uint8Array(await invoke('read_backup', { path: entry.path, id })));
  } catch (e) {
    await message(`This backup can't be read: ${e.message ?? e}`, { title: 'Cannot restore', kind: 'error' });
    return;
  }
  const autosaveWarning = isAutosave(entry)
    ? '\n\nThis is the autosave: everything you played since this backup will be lost from it.' : '';
  const pendingWarning = pendingCount() ? '\n\nYour unsaved changes will be discarded.' : '';
  const ok = await ask(`Restore ${entry.name}.sav to the backup from ${formatDate(backup.createdMs)}?\n\nThe current save is backed up first, so you can undo this.${autosaveWarning}${pendingWarning}${runningWarning}`, { title: 'Restore backup', kind: 'warning' });
  if (!ok) return;
  try {
    await invoke('restore_backup', { path: entry.path, id, note: `Restored the backup from ${formatDate(backup.createdMs)}` });
  } catch (e) {
    await message(String(e), { title: 'Restore failed', kind: 'error' });
    return;
  }
  toast(`Restored the backup from ${formatDate(backup.createdMs)}.`);
  await reopenCurrent('backups');
}

async function deleteBackup(id) {
  const backup = state.backups.list.find((x) => x.id === id);
  if (!(await ask(`Delete the backup from ${formatDate(backup.createdMs)}? This can't be undone.`, { title: 'Delete backup', kind: 'warning' }))) return;
  try {
    await invoke('delete_backup', { path: state.current.entry.path, id });
  } catch (e) {
    toast(String(e), 'error');
  }
  await loadBackups();
  renderTab();
}

async function backupNow() {
  try {
    await invoke('backup_now', { path: state.current.entry.path, note: 'Manual backup' });
    toast('Backup created.');
  } catch (e) {
    toast(String(e), 'error');
  }
  await loadBackups();
  renderTab();
}

// Reloads the folder and reopens the current save (after a write), keeping the chosen tab.
async function reopenCurrent(tab) {
  const path = state.current.entry.path;
  await loadFolder(state.dir);
  const fresh = state.saves.find((s) => s.path === path);
  state.current = null;
  state.tab = tab;
  await openSave(fresh);
}

// ---------- pending changes & saving ----------

function renderPending() {
  const n = pendingCount();
  $('#pending').hidden = n === 0;
  $('#pending-text').textContent = `${n} unsaved change${n === 1 ? '' : 's'}`;
}

async function saveChanges() {
  const { entry, save } = state.current;
  const runningWarning = await gameRunningWarning(entry, 'The game keeps overwriting the autosave, so your changes would be lost.');
  if (runningWarning === null) return;
  let bytes;
  try {
    bytes = applyEdits(save, {
      moneyCents: state.edits.moneyCents,
      variables: { ...venueVariableEdits(), ...Object.fromEntries(state.edits.variables) },
      inventory: Object.fromEntries(state.edits.inventory),
      skills: Object.fromEntries(state.edits.skills),
      venues: Object.fromEntries(state.edits.venues),
      achievements: Object.fromEntries(state.edits.achievements),
    });
  } catch (e) {
    await message(e.message, { title: 'Cannot apply changes', kind: 'error' });
    return;
  }
  const note = summarizeDiff(diffSaves(save, parseSave(bytes)));
  const untested = save.header.versionTested ? '' : `\n\nThis save uses format version ${save.header.version}, which this editor has not been tested with. The game may not load the edited save correctly.`;
  const ok = await ask(`Write ${pendingCount()} change(s) to ${entry.name}.sav?${untested}\n\nThe current file is backed up first; you can restore it from the Backups tab.${runningWarning}`, { title: 'Save changes', kind: untested || runningWarning ? 'warning' : 'info' });
  if (!ok) return;
  try {
    await invoke('write_save', bytes, { headers: { 'x-save-path': encodeURIComponent(entry.path), 'x-backup-note': encodeURIComponent(note) } });
    toast('Saved. The previous version is in the Backups tab.');
  } catch (e) {
    await message(String(e), { title: 'Save failed', kind: 'error' });
    return;
  }
  await reopenCurrent(state.tab);
}

// ---------- events ----------

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.path) await selectSave(t.dataset.path);
  else if (t.dataset.tab) { state.tab = t.dataset.tab; renderMain(); }
  else if (t.id === 'story-finish') await stageStoryToggles(true);
  else if (t.id === 'story-enable-all') await stageStoryToggles(false);
  else if (t.id === 'story-undo') {
    for (const { name, before } of state.storyBatch ?? []) {
      // Keep any manual edits made after the batch.
      if (currentValue(state.current.varIndex.get(name)) === true) setVariableEdit(name, before);
    }
    state.storyBatch = null; renderTab();
  }
  else if (t.dataset.achievementRevert) { state.edits.achievements.delete(t.dataset.achievementRevert); renderPending(); renderAchievementRows(); }
  else if (t.dataset.addCredits) {
    const base = state.edits.moneyCents ?? state.current.summary.moneyCents;
    const next = Math.min(INT32_MAX, base + Number(t.dataset.addCredits) * 100);
    state.edits.moneyCents = next === state.current.summary.moneyCents ? undefined : next;
    renderPending(); renderTab();
  } else if (t.id === 'money-reset') { state.edits.moneyCents = undefined; renderPending(); renderTab(); }
  else if (t.dataset.revert) { state.edits.variables.delete(t.dataset.revert); renderPending(); refreshAfterVarEdit(); }
  else if (t.dataset.openContainer) { state.invKey = t.dataset.openContainer; state.tab = 'inventory'; renderMain(); }
  else if (t.id === 'inv-add') addInventoryItem();
  else if (t.id === 'backup-now') await backupNow();
  else if (t.dataset.backupCompare) await compareBackup(Number(t.dataset.backupCompare));
  else if (t.dataset.backupRestore) await restoreBackup(Number(t.dataset.backupRestore));
  else if (t.dataset.backupDelete) await deleteBackup(Number(t.dataset.backupDelete));
  else if (t.id === 'inv-fresh-all') makeAllFresh();
  else if (t.id === 'inv-revert') { state.edits.inventory.delete(state.invKey); renderPending(); renderTab(); }
  else if (t.dataset.removeStack) {
    const [i, j] = t.dataset.removeStack.split(':').map(Number);
    const items = editableItems(state.invKey);
    items[i].stacks.splice(j, 1);
    if (!items[i].stacks.length) items.splice(i, 1);
    commitInventory(state.invKey);
    renderTab();
  }
  else if (t.dataset.take) {
    const d = state.compare.diff.variables.find((v) => v.name === t.dataset.take);
    setVariableEdit(d.name, d.before);
    toast(`${d.name} staged as ${JSON.stringify(d.before)}. Review it under Story variables.`);
  } else if (t.id === 'discard') { resetEdits(); renderPending(); renderTab(); }
  else if (t.id === 'save') await saveChanges();
  else if (t.id === 'choose-folder') {
    const dir = await open({ directory: true, defaultPath: state.dir ?? undefined, title: 'Choose the Nivalis Nights save folder' });
    if (dir) {
      if (pendingCount() && !(await ask('Discard your unsaved changes?', { title: 'Unsaved changes', kind: 'warning' }))) return;
      resetEdits(); renderPending();
      state.current = null;
      $('#main').innerHTML = $('#empty')?.outerHTML ?? '<div class="empty"><h2>Select a save</h2></div>';
      await loadFolder(dir);
    }
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'money-input') {
    const cents = parseCreditsInput(t.value);
    t.closest('.money-field').classList.toggle('invalid', cents === null);
    if (cents === null) { $('#money-hint').textContent = 'Enter an amount like 1558.80 (max 21,474,836.47).'; return; }
    state.edits.moneyCents = cents === state.current.summary.moneyCents ? undefined : cents;
    t.closest('.money-field').classList.toggle('modified', state.edits.moneyCents !== undefined);
    $('#money-hint').textContent = `Original: ${formatCredits(state.current.summary.moneyCents)} credits. Both copies in the save are updated.`;
    $('#money-reset').disabled = state.edits.moneyCents === undefined;
    renderPending();
  } else if (t.id === 'achievement-search') { state.achievementSearch = t.value; renderAchievementRows(); }
  else if (t.id === 'var-search') { state.filters.q = t.value; renderVariableRows(); }
  else if (t.id === 'people-search') { state.peopleFilters.q = t.value; renderPeopleRows(); }
  else if (t.matches('.inv-qty, .inv-fresh')) {
    const isQty = t.classList.contains('inv-qty');
    const v = Number(t.value);
    const ok = /^\d+$/.test(t.value) && v <= INT32_MAX && (!isQty || v >= 1);
    t.classList.toggle('invalid', !ok);
    if (!ok) return;
    const items = editableItems(state.invKey);
    items[Number(t.dataset.item)].stacks[Number(t.dataset.stack)][isQty ? 'quantity' : 'freshness'] = v;
    commitInventory(state.invKey);
    t.closest('tr').classList.add('modified');
  } else if (t.id === 'inv-add-search') { $('#inv-add-hint').classList.remove('error-text'); }
  else if (t.dataset.venueField && t.matches('input')) {
    const v = Number(t.value);
    const max = t.dataset.venueField === 'level' ? VENUE_MAX_LEVEL : INT32_MAX;
    const ok = /^\d+$/.test(t.value) && v >= Number(t.min) && v <= max;
    t.classList.toggle('invalid', !ok);
    if (!ok) return;
    setVenueEdit(t.dataset.venue, t.dataset.venueField, v);
    t.classList.toggle('modified', state.edits.venues.get(t.dataset.venue)?.[t.dataset.venueField] !== undefined);
  } else if (t.matches('input.num[data-var]')) {
    const ok = /^-?\d+$/.test(t.value) && Math.abs(Number(t.value)) <= INT32_MAX;
    t.classList.toggle('invalid', !ok);
    if (ok) {
      setVariableEdit(t.dataset.var, Number(t.value));
      t.classList.toggle('modified', state.edits.variables.has(t.dataset.var));
      t.closest('tr')?.classList.toggle('modified', state.edits.variables.has(t.dataset.var));
    }
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'var-group') { state.filters.group = t.value; renderVariableRows(); }
  else if (t.dataset.achievementField) {
    const ok = /^\d+$/.test(t.value) && Number(t.value) <= INT32_MAX;
    t.classList.toggle('invalid', !ok);
    if (ok) { setAchievementEdit(t.dataset.achievement, { [t.dataset.achievementField]: Number(t.value) }); renderAchievementRows(); }
  }
  else if (t.dataset.achievementEntry !== undefined) {
    const entry = state.current.save.achievements.entries.find((a) => a.guid === t.dataset.achievement);
    const flags = achievementValues(entry).flags.map(Boolean);
    flags[Number(t.dataset.achievementEntry)] = t.checked;
    const completed = flags.filter(Boolean).length;
    // Each saved business entry awards one point. Preserve any previously staged point adjustment.
    const isBusiness = achievementName(entry.guid) === 'Business' && flags.length === BUSINESS_ENTRIES.length;
    const earned = Math.max(0, achievementValues(entry).earned + (isBusiness ? completed - achievementValues(entry).completed : 0));
    setAchievementEdit(entry.guid, { flags, completed, earned }); renderAchievementRows();
  }
  else if (t.id === 'var-kind') { state.filters.kind = t.value; renderVariableRows(); }
  else if (t.id === 'var-modified') { state.filters.modifiedOnly = t.checked; renderVariableRows(); }
  else if (t.id === 'compare-select') runCompare(t.value);
  else if (t.id === 'inv-container') { state.invKey = t.value; renderTab(); }
  else if (t.dataset.skill) setSkillLevel(t.dataset.skill, Number(t.value));
  else if (t.dataset.venueField === 'reviewScore') {
    setVenueEdit(t.dataset.venue, 'reviewScore', t.value ? Number(t.value) : undefined);
    t.classList.toggle('modified', Boolean(t.value));
  }
  else if (t.matches('.inv-qty, .inv-fresh')) renderTab();
  else if (t.matches('input[type=checkbox][data-var]')) { setVariableEdit(t.dataset.var, t.checked); refreshAfterVarEdit(); }
  else if (t.matches('input.num[data-var]')) refreshAfterVarEdit();
  else if (t.id === 'people-met') { state.peopleFilters.metOnly = t.checked; renderPeopleRows(); }
  else if (t.id === 'venues-owned') { state.venueFilters.ownedOnly = t.checked; renderTab(); }
});

async function pollGameRunning() {
  try {
    $('#game-running').hidden = !(await invoke('is_game_running'));
  } catch {
    // Not fatal; the check runs again before saving.
  }
}

async function init() {
  $('#app-version').textContent = `v${__APP_VERSION__}`;
  getCurrentWindow().onCloseRequested(async (event) => {
    if (pendingCount() && !(await ask('You have unsaved changes. Close anyway?', { title: 'Unsaved changes', kind: 'warning' }))) {
      event.preventDefault();
    }
  });
  invoke('backup_folder').then((p) => { state.backupFolder = p; }).catch(() => {});
  const dir = await invoke('default_save_dir');
  if (dir) await loadFolder(dir);
  else $('#save-list').innerHTML = '<li class="save-list-empty">Save folder not found. Use “Change folder…”.</li>';
  pollGameRunning();
  setInterval(pollGameRunning, 5000);
}

init();
