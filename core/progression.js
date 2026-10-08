import { readInt32, writeInt32, readString, encodeString, bytesEqual, indexOf } from './binary.js';
import { SaveFormatError, UnsupportedEditError } from './errors.js';

export const QUESTS_KEY = '995F9525-8D5C-4853-BC1C-E899CF23FEDD';
export const RECIPES_KEY = 'FD7EDFDC-A7BD-4BAA-8B6C-751444DB0340';
const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export const concatBytes = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out;
};
const int = (n) => { const b = new Uint8Array(4); writeInt32(b, 0, n); return b; };

// SaveWriter uses the same absolute-end-offset wrapper for Ghosts, RuntimeQuests,
// SubQuests and other nested saveables. Every one must move when a section grows.
export function indexSerializedBlocks(bytes) {
  const blocks = [];
  for (let i = 0; i < bytes.length - 12; i++) {
    const len = bytes[i];
    if (len < 3 || len > 127 || i + len + 5 >= bytes.length || bytes[i + 1] < 65 || bytes[i + 1] > 122) continue;
    const endOffsetPos = i + 1 + len;
    const end = readInt32(bytes, endOffsetPos);
    const close = end - 1 - len;
    if (end <= endOffsetPos + 4 || end > bytes.length || close < endOffsetPos + 4 || bytes[close] !== len) continue;
    if (!bytesEqual(bytes.subarray(i, endOffsetPos), bytes.subarray(close, end))) continue;
    const tag = readString(bytes, i).value;
    if (/[\x00-\x1f]/.test(tag)) continue;
    blocks.push({ start: i, tag, endOffsetPos, end });
  }
  return blocks;
}

export function spliceSaveRegion(bytes, start, end, replacement) {
  const delta = replacement.length - (end - start);
  const out = concatBytes([bytes.subarray(0, start), replacement, bytes.subarray(end)]);
  for (const block of indexSerializedBlocks(bytes)) {
    if (block.start >= start && block.end <= end) continue; // replacement encodes its own wrappers
    if (block.start < end && block.end > start && !(block.start < start && block.end >= end)) throw new SaveFormatError(`Partial overlap with ${block.tag}`);
    const pos = block.endOffsetPos >= end ? block.endOffsetPos + delta : block.endOffsetPos;
    if (block.end >= end) writeInt32(out, pos, block.end + delta);
  }
  return out;
}

function guidList(bytes, start) {
  const count = readInt32(bytes, start);
  if (count < 0 || count > 100000) throw new SaveFormatError('Invalid progression GUID count');
  let end = start + 4;
  const guids = [];
  for (let i = 0; i < count; i++) { const s = readString(bytes, end); if (!GUID.test(s.value)) throw new SaveFormatError('Invalid progression GUID'); guids.push(s.value); end = s.end; }
  return { start, end, guids };
}

export function parseProgression(bytes, playerMoneyOffset) {
  const recipeAt = indexOf(bytes, encodeString(RECIPES_KEY));
  const recipes = recipeAt < 0 ? null : guidList(bytes, recipeAt + 37);
  const properties = guidList(bytes, playerMoneyOffset + 4);
  const at = indexOf(bytes, encodeString(QUESTS_KEY));
  let quests = null;
  if (at >= 0) {
    let pos = at + 37;
    const nextNumber = readInt32(bytes, pos); pos += 4;
    const readList = () => {
      const count = readInt32(bytes, pos); pos += 4;
      if (count < 0 || count > 10000) throw new SaveFormatError('Invalid quest count');
      const out = [];
      for (let i = 0; i < count; i++) {
        const start = pos, tag = readString(bytes, pos), end = readInt32(bytes, tag.end);
        if (end > bytes.length || end <= tag.end + 8) throw new SaveFormatError('Invalid quest wrapper');
        const close = end - encodeString(tag.value).length;
        if (readString(bytes, close).value !== tag.value || !tag.value.startsWith('RuntimeQuest_')) throw new SaveFormatError('Invalid quest boundary');
        const guid = readString(bytes, tag.end + 8);
        if (!GUID.test(guid.value) || tag.value !== `RuntimeQuest_${guid.value}`) throw new SaveFormatError('Invalid quest ID');
        const state = readInt32(bytes, guid.end);
        if (state < 0 || state > 3) throw new SaveFormatError('Invalid quest state');
        out.push({ guid: guid.value, state, start, end, stateOffset: guid.end, number: readInt32(bytes, guid.end + 5), raw: bytes.subarray(start, end) });
        pos = end;
      }
      return out;
    };
    const active = readList(), completed = readList();
    quests = { start: at + 37, end: pos, nextNumber, active, completed };
  }
  return { recipes, properties, quests };
}

const encodeGuidList = (guids) => concatBytes([int(guids.length), ...guids.map(encodeString)]);
function validateGuids(guids) {
  if (!Array.isArray(guids) || guids.length > 10000 || guids.some((g) => !GUID.test(g)) || new Set(guids).size !== guids.length) throw new UnsupportedEditError('Progression IDs must be unique GUIDs');
}

// Completed runtime quest: state=Completed, not pinned, no active/paused trackers.
// The game reads it into CompletedQuests, preventing it from reappearing as active.
function completedQuest(guid, number, gameSeconds, start) {
  const tag = encodeString(`RuntimeQuest_${guid}`);
  const payload = concatBytes([int(0), encodeString(guid), int(2), new Uint8Array([0]), int(number), int(gameSeconds), int(0), int(0), int(0), int(0), int(0)]);
  return concatBytes([tag, int(start + tag.length * 2 + 4 + payload.length), payload, tag]);
}

export function applyProgressionEdits(bytes, edits, moneyOffset, gameSeconds) {
  let out = bytes;
  // Process right-to-left so original offsets of earlier sections stay valid.
  const progress = parseProgression(bytes, moneyOffset);
  const regions = [];
  if (edits.completeQuests) {
    validateGuids(edits.completeQuests);
    if (!progress.quests) throw new UnsupportedEditError('No supported quest section');
    const q = progress.quests;
    const old = new Map([...q.completed, ...q.active].map((e) => [e.guid, e]));
    const ids = [...new Set([...old.keys(), ...edits.completeQuests])];
    const parts = [int(Math.max(q.nextNumber, ids.length + 1)), int(0), int(ids.length)];
    let pos = q.start + 12;
    ids.forEach((guid, i) => { const b = completedQuest(guid, old.get(guid)?.number ?? i + 1, gameSeconds, pos); parts.push(b); pos += b.length; });
    regions.push({ ...q, body: concatBytes(parts) });
  }
  if (edits.unlockRecipes) {
    validateGuids(edits.unlockRecipes);
    if (!progress.recipes) throw new UnsupportedEditError('No supported recipe section');
    regions.push({ ...progress.recipes, body: encodeGuidList([...new Set([...progress.recipes.guids, ...edits.unlockRecipes])]) });
  }
  if (edits.unlockProperties) {
    validateGuids(edits.unlockProperties);
    regions.push({ ...progress.properties, body: encodeGuidList([...new Set([...progress.properties.guids, ...edits.unlockProperties])]) });
  }
  for (const r of regions.sort((a, b) => b.start - a.start)) out = spliceSaveRegion(out, r.start, r.end, r.body);
  return out;
}
