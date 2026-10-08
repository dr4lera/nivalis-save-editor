// AchievementManagerSave, verified structurally against version 159 saves and game metadata.
// Same-size edits only; Steam achievement unlocking has not been verified.
import { readInt32, readString, encodeString, indexOf } from './binary.js';
import { SaveFormatError, UnsupportedEditError } from './errors.js';

export const ACHIEVEMENTS_KEY = '03H1F65F-148C-9E66-GHQE-4109P1286Q17';
export const ACHIEVEMENT_NAMES = {
  '3a6306d6-a3e4-490c-b4d3-2d3b32e16ae5': 'Apartments',
  '8fa2c9dc-d919-44ef-8b85-5d530e012b24': 'Business',
  '565e8399-ebb9-4bb1-b0c1-8a566900f8fd': 'Farming',
  'e63a2c03-e2e0-46d4-bd49-e969992fc706': 'Fishing',
  '39b9fb2c-7fff-4c74-9dfd-4965724f2fc8': 'Graffiti',
  '9be4afdc-1e91-421e-9f53-338902f0f2fb': 'Menus',
  'e03ccfa4-0897-4c65-ae32-a4338273fcbe': 'Postcards',
  '33f189fc-62ef-430c-a2be-9e8b197234e0': 'Quests',
  'cedf09fb-5d94-45f5-99be-b5c2e13fcb2a': 'Vendors',
  '8ebc153a-08a0-4985-8535-bf06dd293e69': 'Locations visited',
  '05db8b1d-c0cf-49f6-a700-c90f33bd2d2c': 'Venues visited',
};

export function parseAchievements(bytes) {
  const marker = encodeString(ACHIEVEMENTS_KEY);
  const start = indexOf(bytes, marker);
  if (start < 0) return null; // Older layouts can still use the rest of the editor.
  try {
    let pos = start + marker.length;
    const pointsOffset = pos;
    const points = readInt32(bytes, pos);
    const count = readInt32(bytes, pos + 4);
    pos += 8;
    if (points < 0 || count < 0 || count > 1000) throw new Error('Invalid achievement counts');
    const entries = [];
    const seen = new Set();
    for (let i = 0; i < count; i++) {
      const id = readString(bytes, pos);
      if (!/^[0-9a-f-]{36}$/.test(id.value) || seen.has(id.value)) throw new Error('Invalid achievement series ID');
      seen.add(id.value);
      pos = id.end;
      const completed = readInt32(bytes, pos);
      const earned = readInt32(bytes, pos + 4);
      const isCompleted = bytes[pos + 8];
      const n = readInt32(bytes, pos + 9);
      if (completed < 0 || earned < 0 || isCompleted > 1 || n < 0 || n > 100000 || pos + 13 + n > bytes.length) throw new Error('Invalid achievement series');
      const flags = Array.from(bytes.subarray(pos + 13, pos + 13 + n));
      if (flags.some((v) => v > 1)) throw new Error('Invalid achievement entry flag');
      entries.push({ guid: id.value, completed, earned, isCompleted: Boolean(isCompleted), flags,
        completedOffset: pos, earnedOffset: pos + 4, isCompletedOffset: pos + 8, flagsOffset: pos + 13 });
      pos += 13 + n;
    }
    if (!/^[0-9A-Z-]{36}$/.test(readString(bytes, pos).value)) throw new Error('Achievement section boundary mismatch');
    return { start, end: pos, points, pointsOffset, entries };
  } catch (e) {
    throw new SaveFormatError(`Cannot decode achievements: ${e.message}`);
  }
}

export function achievementWrites(section, edits) {
  if (!section) throw new UnsupportedEditError('This save has no supported achievement section');
  const writes = [];
  let points = section.points;
  for (const [guid, edit] of Object.entries(edits)) {
    const entry = section.entries.find((e) => e.guid === guid);
    if (!entry) throw new UnsupportedEditError(`Unknown achievement series ${guid}`);
    for (const field of Object.keys(edit)) {
      if (!['completed', 'earned', 'flags'].includes(field)) throw new UnsupportedEditError(`Unsupported achievement field ${field}`);
    }
    for (const field of ['completed', 'earned']) {
      if (edit[field] === undefined) continue;
      if (!Number.isInteger(edit[field]) || edit[field] < 0 || edit[field] > 2147483647) throw new UnsupportedEditError('Achievement counters must be nonnegative 32-bit integers');
      writes.push([entry[`${field}Offset`], edit[field], 4]);
    }
    if (edit.flags !== undefined) {
      if (!Array.isArray(edit.flags) || edit.flags.length !== entry.flags.length || edit.flags.some((v) => typeof v !== 'boolean')) throw new UnsupportedEditError('Achievement entry flags must match the saved entry count');
      const completed = edit.flags.filter(Boolean).length;
      if (edit.completed !== completed) throw new UnsupportedEditError('Completed count must match achievement entry flags');
      edit.flags.forEach((v, i) => writes.push([entry.flagsOffset + i, Number(v), 1]));
    } else if (entry.flags.length && edit.completed !== undefined && edit.completed !== entry.completed) {
      throw new UnsupportedEditError('Edit individual achievement entries to change this series count');
    }
    points += (edit.earned ?? entry.earned) - entry.earned;
  }
  if (!Number.isInteger(points) || points < 0 || points > 2147483647) throw new UnsupportedEditError('Achievement total points would be out of range');
  writes.push([section.pointsOffset, points, 4]);
  return writes;
}

export function achievementSnapshot(section) {
  return section && { points: section.points, entries: section.entries.map(({ guid, completed, earned, isCompleted, flags }) => ({ guid, completed, earned, isCompleted, flags })) };
}

export function encodeAchievements(section) {
  const int = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); return b; };
  const parts = [encodeString(ACHIEVEMENTS_KEY), int(section.points), int(section.entries.length)];
  for (const e of section.entries) parts.push(encodeString(e.guid), int(e.completed), int(e.earned), new Uint8Array([Number(e.isCompleted)]), int(e.flags.length), new Uint8Array(e.flags));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}
