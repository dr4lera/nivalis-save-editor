// Parser/editor for Nivalis Nights .sav files (tested with save versions 151 and 153).
//
// Layout knowledge (reverse-engineered, see README):
//   header        version, scene, playtime, unix time, in-game seconds, money (cents), GUID list, ..., "END_HEADER"
//   sections      manager saves keyed by an uppercase GUID string, no length prefix
//   variables     articy global variables, stored twice with different type enums
//   Ghost blocks  "Ghost_<guid>" tag, int32 absolute end offset, payload, closing tag
//   player money  int32 cents directly after the player's Ghost block (duplicate of the header value)
//   inventories   see inventory.js
//   skills        see skills.js
//   venues        see venues.js
//
// Money, variable, skill and venue edits are same-size. Inventory edits re-encode the inventory section, which can
// change the file size; every Ghost block after the section then gets its end offset shifted.

import {
  readInt32, writeInt32, readFloat32, writeFloat32, readString, encodeString,
  asciiBytes, indexOf, bytesEqual,
} from './binary.js';
import { SaveFormatError, UnsupportedEditError } from './errors.js';
import { parseInventory, encodeInventoryBody, validateInventoryItems } from './inventory.js';
import { parseSkills, SKILLS_KEY } from './skills.js';
import { findVenue, venueWrites } from './venues.js';
import { parseAchievements, achievementWrites, achievementSnapshot, encodeAchievements } from './achievements.js';

export { SaveFormatError, UnsupportedEditError };

// Versions checked against real saves. 153 (game patch of 2026-10-01) has the same layout as 151; it
// only adds and drops a few variables. Other versions are still opened: the structural checks in
// parseSave decide whether the layout is understood, and header.versionTested lets the UI warn.
export const TESTED_VERSIONS = [151, 153];
export const INT32_MAX = 2147483647;

export const VARIABLE_TABLES = [
  { id: 'primary', key: 'BD57C1E7-3EAE-4896-A466-73822A382AE4', types: { 1: 'int', 3: 'bool', 4: 'string' } },
  { id: 'mirror', key: '53BD367F-1E7D-4886-91D8-D8988CDF96EC', types: { 3: 'int', 2: 'bool', 4: 'string' } },
];

const PLAYER_MANAGER_TAG = 'Guid_PLAYER_MANAGER_SAVE';
const GHOST_PREFIX = asciiBytes('Ghost_');
const END_HEADER = asciiBytes('END_HEADER');

function parseHeader(bytes) {
  if (bytes.length < 32) throw new SaveFormatError('File is too small to be a Nivalis Nights save');
  const version = readInt32(bytes, 0);
  if (version < 1 || version > 100000) throw new SaveFormatError('This is not a Nivalis Nights save');
  let pos = 24;
  const guidCount = readInt32(bytes, pos);
  pos += 4;
  if (guidCount < 0 || guidCount > 1000) throw new SaveFormatError(`Implausible header GUID count ${guidCount}`);
  const guids = [];
  for (let i = 0; i < guidCount; i++) {
    const s = readString(bytes, pos);
    guids.push(s.value);
    pos = s.end;
  }
  const endHeader = indexOf(bytes, END_HEADER, pos);
  if (endHeader < 0 || endHeader > 64 * 1024) throw new SaveFormatError('END_HEADER marker not found');
  return {
    version,
    versionTested: TESTED_VERSIONS.includes(version),
    sceneIndex: readInt32(bytes, 4),
    playtimeSeconds: readFloat32(bytes, 8),
    savedAt: new Date(readInt32(bytes, 12) * 1000),
    gameSeconds: readInt32(bytes, 16),
    moneyCents: readInt32(bytes, 20),
    moneyOffset: 20,
    guids,
    end: endHeader + END_HEADER.length,
  };
}

// Finds every Ghost block by validating that its end offset points exactly past a matching closing tag.
export function indexGhostBlocks(bytes) {
  const blocks = [];
  let i = indexOf(bytes, GHOST_PREFIX, 0);
  while (i !== -1) {
    const len = bytes[i - 1];
    let next = i + 1;
    if (len > GHOST_PREFIX.length && len < 128 && i + len + 4 <= bytes.length) {
      const tagEnd = i + len;
      const end = readInt32(bytes, tagEnd);
      const close = end - 1 - len;
      if (end > tagEnd + 4 && end <= bytes.length && close >= tagEnd + 4 && bytes[close] === len
          && bytesEqual(bytes.subarray(close + 1, end), bytes.subarray(i, tagEnd))) {
        blocks.push({ start: i - 1, tag: readString(bytes, i - 1).value, endOffsetPos: tagEnd, end });
        next = tagEnd + 4;
      }
    }
    i = indexOf(bytes, GHOST_PREFIX, next);
  }
  return blocks;
}

function parseVariableTable(bytes, def) {
  const marker = encodeString(def.key);
  const at = indexOf(bytes, marker, 0);
  if (at < 0) throw new SaveFormatError(`Variable table ${def.key} not found`);
  let pos = at + marker.length;
  const count = readInt32(bytes, pos);
  pos += 4;
  if (count < 0 || count > 100000) throw new SaveFormatError(`Implausible variable count ${count} in ${def.key}`);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const name = readString(bytes, pos);
    const typeCode = readInt32(bytes, name.end);
    const kind = def.types[typeCode];
    pos = name.end + 4;
    let value;
    const valueOffset = pos;
    if (kind === 'int') {
      value = readInt32(bytes, pos);
      pos += 4;
    } else if (kind === 'bool') {
      const raw = bytes[pos];
      if (raw > 1) throw new SaveFormatError(`Variable ${name.value} has non-boolean byte ${raw}`);
      value = raw === 1;
      pos += 1;
    } else if (kind === 'string') {
      const s = readString(bytes, pos);
      value = s.value;
      pos = s.end;
    } else {
      throw new SaveFormatError(`Unknown variable type ${typeCode} for ${name.value} in ${def.key}`);
    }
    entries.push({ name: name.value, kind, value, valueOffset });
  }
  return { id: def.id, key: def.key, start: at, end: pos, entries };
}

function locatePlayerMoney(bytes, ghostBlocks) {
  const at = indexOf(bytes, asciiBytes(PLAYER_MANAGER_TAG), 0);
  if (at < 1 || bytes[at - 1] !== PLAYER_MANAGER_TAG.length) throw new SaveFormatError('Player manager block not found');
  const ghostStart = at + PLAYER_MANAGER_TAG.length;
  const block = ghostBlocks.find((b) => b.start === ghostStart);
  if (!block) throw new SaveFormatError('Player Ghost block not found after player manager tag');
  return { offset: block.end, value: readInt32(bytes, block.end) };
}

export function parseSave(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const header = parseHeader(bytes);
  const ghostBlocks = indexGhostBlocks(bytes);
  if (ghostBlocks.length === 0) throw new SaveFormatError('No Ghost blocks found');
  const tables = VARIABLE_TABLES.map((def) => parseVariableTable(bytes, def));
  const playerMoney = locatePlayerMoney(bytes, ghostBlocks);
  const inventory = parseInventory(bytes);
  const skills = parseSkills(bytes);
  const achievements = parseAchievements(bytes);

  const warnings = [];
  if (playerMoney.value !== header.moneyCents) {
    warnings.push(`Header money (${header.moneyCents}) differs from player money (${playerMoney.value})`);
  }
  const [primary, mirror] = tables;
  let tablesConsistent = primary.entries.length === mirror.entries.length;
  if (tablesConsistent) {
    for (let i = 0; i < primary.entries.length; i++) {
      const a = primary.entries[i];
      const b = mirror.entries[i];
      if (a.name !== b.name || a.kind !== b.kind || a.value !== b.value) {
        tablesConsistent = false;
        warnings.push(`Variable tables disagree at ${a.name}`);
        break;
      }
    }
  } else {
    warnings.push('Variable tables have different lengths');
  }

  return { bytes, header, ghostBlocks, tables, playerMoney, inventory, skills, achievements, tablesConsistent, warnings };
}

// Current in-game day as the game counts it (GameDay.Day, 1-based); used for newly added stacks.
export function currentGameDay(save) {
  const entry = save.tables[0].entries.find((e) => e.name === 'GameDay.Day');
  return entry && entry.kind === 'int' ? entry.value : Math.floor(save.header.gameSeconds / 86400) + 1;
}

// Variables as a flat, UI-friendly list; group is the articy namespace before the first dot.
export function listVariables(save) {
  return save.tables[0].entries.map(({ name, kind, value }) => {
    const dot = name.indexOf('.');
    return { name, group: dot > 0 ? name.slice(0, dot) : '', key: dot > 0 ? name.slice(dot + 1) : name, kind, value };
  });
}

export function summarize(save) {
  const { header } = save;
  return {
    version: header.version,
    versionTested: header.versionTested,
    sceneIndex: header.sceneIndex,
    playtimeSeconds: header.playtimeSeconds,
    savedAt: header.savedAt.toISOString(),
    gameSeconds: header.gameSeconds,
    gameDay: Math.floor(header.gameSeconds / 86400),
    gameClock: formatClock(header.gameSeconds),
    moneyCents: header.moneyCents,
    variableCount: save.tables[0].entries.length,
    ghostBlockCount: save.ghostBlocks.length,
    fileSize: save.bytes.length,
    warnings: save.warnings,
  };
}

function formatClock(seconds) {
  const s = ((seconds % 86400) + 86400) % 86400;
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatCredits(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// Returns a new byte array with the edits applied and verified:
//   edits = { moneyCents?, variables?: { name: value }, inventory?: { containerKey: items[] },
//             skills?: { skillGuid: { xp, level } }, venues?: { venueGuid: { level?, mealsServed?, reviewScore? } },
//             achievements?: { seriesGuid: { completed?, earned?, flags?: boolean[] } } }
// Inventory entries replace the full item list of that container ({ guid, stacks: [{ price, day, quantity, freshness }] }).
export function applyEdits(save, edits) {
  const out = new Uint8Array(save.bytes);
  const changedOffsets = new Set();
  const write32 = (pos, v) => { writeInt32(out, pos, v); for (let i = 0; i < 4; i++) changedOffsets.add(pos + i); };

  if (edits.moneyCents !== undefined) {
    const cents = edits.moneyCents;
    if (!Number.isInteger(cents) || cents < 0 || cents > INT32_MAX) {
      throw new UnsupportedEditError(`Money must be a whole number of cents between 0 and ${INT32_MAX}`);
    }
    if (save.playerMoney.value !== save.header.moneyCents) {
      throw new UnsupportedEditError('Money copies disagree in this save; refusing to edit money');
    }
    write32(save.header.moneyOffset, cents);
    write32(save.playerMoney.offset, cents);
  }

  const varEdits = Object.entries(edits.variables ?? {});
  if (varEdits.length) {
    if (!save.tablesConsistent) throw new UnsupportedEditError('Variable tables disagree in this save; refusing to edit variables');
    const indexByName = new Map(save.tables[0].entries.map((e, i) => [e.name, i]));
    for (const [name, value] of varEdits) {
      const idx = indexByName.get(name);
      if (idx === undefined) throw new UnsupportedEditError(`Unknown variable ${name}`);
      for (const table of save.tables) {
        const entry = table.entries[idx];
        if (entry.kind === 'int') {
          if (!Number.isInteger(value) || value < -INT32_MAX - 1 || value > INT32_MAX) {
            throw new UnsupportedEditError(`${name} must be a 32-bit integer`);
          }
          write32(entry.valueOffset, value);
        } else if (entry.kind === 'bool') {
          if (typeof value !== 'boolean') throw new UnsupportedEditError(`${name} must be true or false`);
          out[entry.valueOffset] = value ? 1 : 0;
          changedOffsets.add(entry.valueOffset);
        } else {
          throw new UnsupportedEditError(`${name} is a text variable; text edits are not supported yet`);
        }
      }
    }
  }

  for (const [guid, value] of Object.entries(edits.skills ?? {})) {
    const entry = save.skills.entries.find((e) => e.guid === guid);
    if (!entry) throw new UnsupportedEditError(`Skill ${guid} is not in this save yet; gain some XP in it in the game first`);
    const { xp, level } = value;
    if (typeof xp !== 'number' || !Number.isFinite(xp) || xp < 0 || !Number.isFinite(Math.fround(xp))) {
      throw new UnsupportedEditError('Skill XP must be a number of 0 or more');
    }
    if (!Number.isInteger(level) || level < 0 || level > 1000) throw new UnsupportedEditError('Skill level must be a whole number of 0 or more');
    writeFloat32(out, entry.xpOffset, xp);
    for (let i = 0; i < 4; i++) changedOffsets.add(entry.xpOffset + i);
    write32(entry.levelOffset, level);
  }

  if (Object.keys(edits.achievements ?? {}).length) {
    for (const [pos, value, size] of achievementWrites(save.achievements, edits.achievements)) {
      if (size === 4) write32(pos, value);
      else { out[pos] = value; changedOffsets.add(pos); }
    }
  }

  for (const [id, edit] of Object.entries(edits.venues ?? {})) {
    const venue = findVenue(save, id);
    if (!venue) throw new UnsupportedEditError(`Venue ${id} is not in this save`);
    let writes;
    try {
      writes = venueWrites(venue, edit);
    } catch (e) {
      throw new UnsupportedEditError(e.message);
    }
    for (const [pos, v] of writes) write32(pos, v);
  }

  for (let i = 0; i < out.length; i++) {
    if (out[i] !== save.bytes[i] && !changedOffsets.has(i)) {
      throw new SaveFormatError(`Unexpected byte change at 0x${i.toString(16)}`);
    }
  }

  const invEdits = new Map(Object.entries(edits.inventory ?? {}));
  const result = invEdits.size ? spliceInventory(save, out, invEdits) : out;
  verifyEdited(save, result, edits);
  return result;
}

// Re-encodes the inventory section with the edited containers and shifts all later Ghost block end offsets.
function spliceInventory(save, bytes, invEdits) {
  const { inventory } = save;
  for (const [key, items] of invEdits) {
    if (!inventory.containers.some((c) => c.key === key)) throw new UnsupportedEditError(`Unknown container ${key}`);
    try {
      validateInventoryItems(key, items);
    } catch (e) {
      throw new UnsupportedEditError(e.message);
    }
  }
  const containers = inventory.containers.map((c) => (invEdits.has(c.key) ? { ...c, items: invEdits.get(c.key) } : c));
  const body = encodeInventoryBody(containers);
  const { bodyStart, end } = inventory;
  const delta = body.length - (end - bodyStart);

  const result = new Uint8Array(bytes.length + delta);
  result.set(bytes.subarray(0, bodyStart), 0);
  result.set(body, bodyStart);
  result.set(bytes.subarray(end), bodyStart + body.length);

  for (const g of save.ghostBlocks) {
    if (g.start < end && g.end > bodyStart) throw new SaveFormatError('A Ghost block overlaps the inventory section');
    if (g.start >= end) writeInt32(result, g.endOffsetPos + delta, g.end + delta);
  }

  // Everything outside the section must be unchanged apart from the shifted Ghost end offsets.
  const shiftedOffsetFields = new Set();
  for (const g of save.ghostBlocks) {
    if (g.start >= end) for (let i = 0; i < 4; i++) shiftedOffsetFields.add(g.endOffsetPos + delta + i);
  }
  for (let i = 0; i < bodyStart; i++) {
    if (result[i] !== bytes[i]) throw new SaveFormatError(`Unexpected byte change at 0x${i.toString(16)}`);
  }
  for (let i = end; i < bytes.length; i++) {
    if (result[i + delta] !== bytes[i] && !shiftedOffsetFields.has(i + delta)) {
      throw new SaveFormatError(`Unexpected byte change at 0x${(i + delta).toString(16)}`);
    }
  }
  return result;
}

function verifyEdited(original, bytes, edits) {
  const reparsed = parseSave(bytes);
  const expectedAchievements = achievementSnapshot(original.achievements);
  if (Object.keys(edits.achievements ?? {}).length) {
    for (const [guid, edit] of Object.entries(edits.achievements)) {
      const entry = expectedAchievements.entries.find((e) => e.guid === guid);
      expectedAchievements.points += (edit.earned ?? entry.earned) - entry.earned;
      Object.assign(entry, edit);
      if (edit.flags) entry.flags = edit.flags.map(Number);
    }
  }
  if (JSON.stringify(achievementSnapshot(reparsed.achievements)) !== JSON.stringify(expectedAchievements)) throw new SaveFormatError('Achievements did not verify after edit');
  if (reparsed.ghostBlocks.length !== original.ghostBlocks.length) throw new SaveFormatError('Ghost block index changed after edit');
  reparsed.ghostBlocks.forEach((g, i) => {
    if (g.tag !== original.ghostBlocks[i].tag) throw new SaveFormatError(`Ghost block ${i} changed identity after edit`);
  });
  if (!reparsed.tablesConsistent) throw new SaveFormatError('Variable tables inconsistent after edit');
  if (edits.moneyCents !== undefined
      && (reparsed.header.moneyCents !== edits.moneyCents || reparsed.playerMoney.value !== edits.moneyCents)) {
    throw new SaveFormatError('Money did not verify after edit');
  }
  const vars = new Map(reparsed.tables[0].entries.map((e) => [e.name, e.value]));
  for (const [name, value] of Object.entries(edits.variables ?? {})) {
    if (vars.get(name) !== value) throw new SaveFormatError(`${name} did not verify after edit`);
  }
  const skillEdits = edits.skills ?? {};
  if (reparsed.skills.entries.length !== original.skills.entries.length) throw new SaveFormatError('Skill count changed after edit');
  reparsed.skills.entries.forEach((e, i) => {
    const before = original.skills.entries[i];
    const expected = skillEdits[e.guid] ? { xp: Math.fround(skillEdits[e.guid].xp), level: skillEdits[e.guid].level } : before;
    if (e.guid !== before.guid || !Object.is(e.xp, expected.xp) || e.level !== expected.level) {
      throw new SaveFormatError(`Skill ${e.guid} did not verify after edit`);
    }
  });
  for (const [id, edit] of Object.entries(edits.venues ?? {})) {
    const before = findVenue(original, id);
    const after = findVenue(reparsed, id);
    const expect = (field, v) => {
      if (after[field] !== (v ?? before[field])) throw new SaveFormatError(`Venue ${id} ${field} did not verify after edit`);
    };
    expect('level', edit.level);
    expect('mealsServed', edit.mealsServed);
    if (after.reviews.length !== before.reviews.length
        || after.reviews.some((r, i) => r.score !== (edit.reviewScore ?? before.reviews[i].score))) {
      throw new SaveFormatError(`Venue ${id} reviews did not verify after edit`);
    }
  }
  const invEdits = edits.inventory ?? {};
  if (reparsed.inventory.containers.length !== original.inventory.containers.length) {
    throw new SaveFormatError('Container count changed after edit');
  }
  reparsed.inventory.containers.forEach((c, i) => {
    const before = original.inventory.containers[i];
    const expected = invEdits[c.key] ?? before.items;
    if (c.key !== before.key || !bytesEqual(encodeInventoryBody([{ ...c }]), encodeInventoryBody([{ ...before, items: expected }]))) {
      throw new SaveFormatError(`Container ${c.key} did not verify after edit`);
    }
  });
}

// Re-encodes the parsed structures and compares them with the original bytes; proves the model is lossless.
export function roundTripCheck(save) {
  const problems = [];
  if (save.achievements && !bytesEqual(encodeAchievements(save.achievements), save.bytes.subarray(save.achievements.start, save.achievements.end))) problems.push('Achievement section does not re-encode identically');
  for (const [def, table] of VARIABLE_TABLES.map((d, i) => [d, save.tables[i]])) {
    const codeFor = Object.fromEntries(Object.entries(def.types).map(([code, kind]) => [kind, Number(code)]));
    const parts = [encodeString(def.key), int32Bytes(table.entries.length)];
    for (const e of table.entries) {
      parts.push(encodeString(e.name), int32Bytes(codeFor[e.kind]));
      if (e.kind === 'int') parts.push(int32Bytes(e.value));
      else if (e.kind === 'bool') parts.push(new Uint8Array([e.value ? 1 : 0]));
      else parts.push(encodeString(e.value));
    }
    const encoded = concat(parts);
    if (!bytesEqual(encoded, save.bytes.subarray(table.start, table.end))) {
      problems.push(`Variable table ${table.id} does not re-encode identically`);
    }
  }
  const { inventory } = save;
  if (!bytesEqual(encodeInventoryBody(inventory.containers), save.bytes.subarray(inventory.bodyStart, inventory.end))) {
    problems.push('Inventory section does not re-encode identically');
  }
  const { skills } = save;
  const skillParts = [encodeString(SKILLS_KEY), int32Bytes(skills.entries.length)];
  for (const e of skills.entries) skillParts.push(encodeString(e.guid), save.bytes.subarray(e.xpOffset, e.xpOffset + 4), int32Bytes(e.level));
  if (!bytesEqual(concat(skillParts), save.bytes.subarray(skills.start, skills.end))) {
    problems.push('Skill section does not re-encode identically');
  }
  const money = save.header.moneyCents;
  if (readInt32(save.bytes, save.header.moneyOffset) !== money) problems.push('Header money mismatch');
  for (const b of save.ghostBlocks) {
    if (readInt32(save.bytes, b.endOffsetPos) !== b.end) problems.push(`Ghost block ${b.tag} offset mismatch`);
  }
  return problems;
}

function int32Bytes(v) {
  const b = new Uint8Array(4);
  writeInt32(b, 0, v);
  return b;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// Differences between two saves: header values, variables, skills and inventory quantities.
// Skill entries: { guid, before, after } with { xp, level } or undefined when the save lacks the skill.
// Inventory entries: { container, guid, before, after } with total quantities; stacksChanged marks
// items whose quantity is equal but whose stacks (freshness, day, price) differ.
export function diffSaves(a, b) {
  const headerFields = ['sceneIndex', 'gameSeconds', 'moneyCents', 'playtimeSeconds'];
  const header = headerFields
    .filter((f) => a.header[f] !== b.header[f])
    .map((f) => ({ field: f, before: a.header[f], after: b.header[f] }));
  const before = new Map(a.tables[0].entries.map((e) => [e.name, e]));
  const variables = [];
  for (const e of b.tables[0].entries) {
    const old = before.get(e.name);
    if (!old) variables.push({ name: e.name, kind: e.kind, before: undefined, after: e.value });
    else if (old.value !== e.value) variables.push({ name: e.name, kind: e.kind, before: old.value, after: e.value });
    before.delete(e.name);
  }
  for (const old of before.values()) variables.push({ name: old.name, kind: old.kind, before: old.value, after: undefined });
  const oldAchievements = new Map(a.achievements?.entries.map((e) => [e.guid, e]) ?? []);
  const achievements = (b.achievements?.entries ?? []).flatMap((entry) => {
    const before = oldAchievements.get(entry.guid);
    oldAchievements.delete(entry.guid);
    const pick = (e) => e && { completed: e.completed, earned: e.earned, isCompleted: e.isCompleted, flags: e.flags };
    return JSON.stringify(pick(before)) === JSON.stringify(pick(entry)) ? [] : [{ guid: entry.guid, before: pick(before), after: pick(entry) }];
  });
  for (const entry of oldAchievements.values()) achievements.push({ guid: entry.guid, before: entry, after: undefined });
  return { header, variables, achievements, inventory: diffInventories(a.inventory, b.inventory), skills: diffSkills(a.skills, b.skills) };
}

function diffSkills(a, b) {
  const pick = (e) => e && { xp: e.xp, level: e.level };
  const before = new Map(a.entries.map((e) => [e.guid, e]));
  const changes = [];
  for (const e of b.entries) {
    const old = before.get(e.guid);
    if (!old || !Object.is(old.xp, e.xp) || old.level !== e.level) changes.push({ guid: e.guid, before: pick(old), after: pick(e) });
    before.delete(e.guid);
  }
  for (const old of before.values()) changes.push({ guid: old.guid, before: pick(old), after: undefined });
  return changes;
}

function diffInventories(a, b) {
  const summarize = (items) => {
    const m = new Map();
    for (const it of items) {
      const e = m.get(it.guid) ?? { qty: 0, stacks: [] };
      e.qty += it.stacks.reduce((n, s) => n + s.quantity, 0);
      e.stacks.push(...it.stacks);
      m.set(it.guid, e);
    }
    return m;
  };
  const oldByKey = new Map(a.containers.map((c) => [c.key, c]));
  const changes = [];
  for (const c of b.containers) {
    const before = summarize(oldByKey.get(c.key)?.items ?? []);
    const after = summarize(c.items);
    for (const guid of new Set([...before.keys(), ...after.keys()])) {
      const x = before.get(guid);
      const y = after.get(guid);
      if ((x?.qty ?? 0) !== (y?.qty ?? 0)) {
        changes.push({ container: c.key, guid, before: x?.qty ?? 0, after: y?.qty ?? 0 });
      } else if (JSON.stringify(x?.stacks) !== JSON.stringify(y?.stacks)) {
        changes.push({ container: c.key, guid, before: x.qty, after: y.qty, stacksChanged: true });
      }
    }
  }
  return changes;
}
