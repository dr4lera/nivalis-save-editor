import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAchievements, encodeAchievements, achievementWrites, achievementSnapshot,
  storyCompletionEdits, storyChoiceConflicts, STORY_CHOICE_GROUPS, parseSave, applyEdits, diffSaves, roundTripCheck, listVariables, SaveFormatError, UnsupportedEditError } from '../core/index.js';
import { encodeString } from '../core/binary.js';

const guid = '8fa2c9dc-d919-44ef-8b85-5d530e012b24';
const fixture = () => {
  const body = encodeAchievements({ points: 1, entries: [{ guid, completed: 1, earned: 1, isCompleted: false, flags: [1, 0] }] });
  const next = encodeString('37FBBCF3-ADDF-4B91-825E-480816462579');
  const bytes = new Uint8Array(body.length + next.length);
  bytes.set(body); bytes.set(next, body.length);
  return bytes;
};

test('achievement records re-encode exactly; missing section is optional', () => {
  const bytes = fixture();
  const section = parseAchievements(bytes);
  assert.deepEqual(encodeAchievements(section), bytes.slice(0, section.end));
  assert.equal(parseAchievements(new Uint8Array(30)), null);
});

test('achievement parser rejects invalid boolean bytes, duplicate IDs and truncated records', () => {
  const bytes = fixture();
  const section = parseAchievements(bytes);
  bytes[section.entries[0].flagsOffset] = 2;
  assert.throws(() => parseAchievements(bytes), SaveFormatError);
  assert.throws(() => parseAchievements(fixture().slice(0, section.end - 1)), SaveFormatError);
  const e = { guid, completed: 0, earned: 0, isCompleted: false, flags: [] };
  assert.throws(() => parseAchievements(encodeAchievements({ points: 0, entries: [e, e] })), SaveFormatError);
});

test('achievement edits update total points and reject inconsistent flags and overflow', () => {
  const section = parseAchievements(fixture());
  const writes = achievementWrites(section, { [guid]: { flags: [true, true], completed: 2, earned: 2 } });
  assert.ok(writes.some(([p, v]) => p === section.pointsOffset && v === 2));
  for (const edit of [{ flags: [true], completed: 1 }, { flags: [true, true], completed: 1 },
    { completed: 2 }, { earned: -1 }, { earned: 1.5 }, { earned: 2147483648 }, { isCompleted: 'true' }]) {
    assert.throws(() => achievementWrites(section, { [guid]: edit }), UnsupportedEditError);
  }
  assert.throws(() => achievementWrites(null, { [guid]: {} }), UnsupportedEditError);
  assert.throws(() => achievementWrites(section, { unknown: {} }), UnsupportedEditError);
});

test('story completion sets reviewed flags, selects one outcome and ignores unknown branches', () => {
  const vars = [
    { name: 'MaGomba.PoisonQuestComplete', kind: 'bool', value: false },
    { name: 'MaGomba.PoisonQuestFailed', kind: 'bool', value: true },
    { name: 'Unknown.GoodEndingComplete', kind: 'bool', value: false },
    { name: 'Unknown.BadEndingComplete', kind: 'bool', value: true },
    { name: 'MiaJay.QuestComplete', kind: 'int', value: 1 },
    { name: 'JohnDoe.QuestComplete', kind: 'string', value: '' },
  ];
  assert.deepEqual(storyCompletionEdits(vars), { 'MaGomba.PoisonQuestComplete': true, 'MaGomba.PoisonQuestFailed': false });
  const allChoices = STORY_CHOICE_GROUPS.flatMap((g) => g.choices.map((name) => ({ name, kind: 'bool', value: true })));
  assert.equal(storyChoiceConflicts(allChoices).length, STORY_CHOICE_GROUPS.length);
  const edits = storyCompletionEdits(allChoices);
  const after = allChoices.map((v) => ({ ...v, value: edits[v.name] }));
  assert.deepEqual(storyChoiceConflicts(after), []);
  for (const group of STORY_CHOICE_GROUPS) assert.equal(group.choices.filter((name) => edits[name] === true).length, 1);
  const partial = allChoices.filter((v) => v.name !== 'BenQuestVariables.ReehanFleshyKind');
  assert.equal(Object.hasOwn(storyCompletionEdits(partial), 'BenQuestVariables.ReehanNeuralKind'), false);
});

const dir = process.env.NN_SAVE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sav')) : [];
for (const file of files) {
  test(`${file}: achievements and bulk story edits survive inventory resizing without touching the source`, () => {
    const source = readFileSync(join(dir, file));
    const save = parseSave(source);
    assert.ok(save.achievements);
    assert.throws(() => applyEdits(save, { variables: {
      'MaGomba.PoisonQuestComplete': true, 'MaGomba.PoisonQuestFailed': true,
    } }), UnsupportedEditError);
    const entry = save.achievements.entries.find((e) => !e.flags.length);
    const business = save.achievements.entries.find((e) => e.flags.length);
    const flags = business.flags.map(Boolean);
    flags[0] = !flags[0];
    const key = 'PLAYER_INVENTORY';
    const items = structuredClone(save.inventory.containers.find((c) => c.key === key).items);
    assert.ok(items.length);
    items.push(structuredClone(items[0]));
    const edits = { achievements: { [entry.guid]: { completed: entry.completed + 1, earned: entry.earned + 1 },
      [business.guid]: { flags, completed: flags.filter(Boolean).length, earned: business.earned + (flags[0] ? 1 : -1) } },
      variables: storyCompletionEdits(listVariables(save)), inventory: { [key]: items } };
    const bytes = applyEdits(save, edits);
    const after = parseSave(bytes);
    assert.deepEqual(roundTripCheck(after), []);
    assert.equal(after.tablesConsistent, true);
    assert.deepEqual(storyChoiceConflicts(listVariables(after)), []);
    for (const v of listVariables(after)) assert.equal(v.value, Object.hasOwn(edits.variables, v.name) ? edits.variables[v.name] : listVariables(save).find((before) => before.name === v.name).value);
    assert.equal(after.achievements.entries.find((e) => e.guid === entry.guid).completed, entry.completed + 1);
    assert.equal(diffSaves(save, after).achievements.length, 2);
    assert.deepEqual(source, readFileSync(join(dir, file)));
    const restored = parseSave(applyEdits(after, { achievements: {
      [entry.guid]: { completed: entry.completed, earned: entry.earned },
      [business.guid]: { completed: business.completed, earned: business.earned, flags: business.flags.map(Boolean) },
    } }));
    assert.deepEqual(achievementSnapshot(restored.achievements), achievementSnapshot(save.achievements));
  });
}
