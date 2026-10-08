#!/usr/bin/env node
// Command-line companion to the editor, mainly for development and verification.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import {
  parseSave, summarize, listVariables, diffSaves, applyEdits, roundTripCheck, formatCredits, currentGameDay, xpForLevel,
  findVenue, averageReviewScore,
  ACHIEVEMENT_NAMES, storyCompletionEdits, storyChoiceConflicts,
} from '../core/index.js';

const { items: CATALOG, skills: SKILLS, venues: VENUES } = JSON.parse(readFileSync(new URL('../src/data/items.json', import.meta.url), 'utf8'));
const PROGRESS = JSON.parse(readFileSync(new URL('../src/data/progression.json', import.meta.url), 'utf8'));
const itemName = (guid) => CATALOG[guid]?.name ?? `Unknown item ${guid}`;

// Skill levels are stored from 0 but shown from 1 in the game; the CLI speaks the game's numbers.
const shownLevel = (stored) => (stored === undefined ? undefined : stored + 1);
const skillName = (guid) => SKILLS[guid]?.name ?? `Unknown skill ${guid}`;

function findSkill(query) {
  if (SKILLS[query]) return query;
  const match = Object.entries(SKILLS).find(([, s]) => s.name.toLowerCase() === query.toLowerCase());
  if (!match) throw new Error(`Unknown skill "${query}" (known: ${Object.values(SKILLS).map((s) => s.name).join(', ')})`);
  return match[0];
}

// Venue GUID from its GUID, story variable group (Venue_NoodleBar) or key (VENUE_RAMEN_NOIR).
function findVenueId(query) {
  if (VENUES[query]) return query;
  const q = query.toLowerCase();
  const match = Object.entries(VENUES).find(([, v]) => v.internal.toLowerCase() === q || v.key?.toLowerCase() === q);
  if (!match) throw new Error(`Unknown venue "${query}" (see nnsave venues <save>)`);
  return match[0];
}

function findItem(query) {
  if (CATALOG[query]) return query;
  const matches = Object.entries(CATALOG).filter(([, e]) => e.name.toLowerCase() === query.toLowerCase());
  if (matches.length !== 1) throw new Error(`${matches.length ? 'Ambiguous' : 'Unknown'} item "${query}" (use the item GUID)`);
  return matches[0][0];
}

const USAGE = `Usage:
  nnsave info <file.sav>
  nnsave vars <file.sav> [filter]
  nnsave diff <old.sav> <new.sav>
  nnsave check <file.sav>...
  nnsave inv <file.sav> [container]
  nnsave skills <file.sav>
  nnsave achievements <file.sav>
  nnsave venues <file.sav>
  nnsave edit <file.sav> [--money <credits>] [--set Name.Var=value]... [--add-item <container>:<item>:<qty>]...
              [--skill <name>=<level>]... [--venue <venue>.(level|served|stars)=<n>]...
              [--finish-story] [--unlock-recipes] [--unlock-venues] [--max-venues] [--complete-achievements]
              [--complete-save] (-o <out.sav> | --in-place)`;

const load = (path) => parseSave(new Uint8Array(readFileSync(path)));
const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

function parseValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  throw new Error(`Cannot parse value "${raw}" (use an integer, true or false)`);
}

function parseCredits(raw) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) throw new Error(`Invalid credit amount "${raw}" (e.g. 1558.80)`);
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}

function main(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'info': {
      const s = summarize(load(args[0]));
      console.log(`Save version  ${s.version}${s.versionTested ? '' : ' (untested)'}`);
      console.log(`Saved at      ${s.savedAt}`);
      console.log(`Scene index   ${s.sceneIndex}`);
      console.log(`Playtime      ${(s.playtimeSeconds / 3600).toFixed(2)} h`);
      console.log(`In-game time  day ${s.gameDay}, ${s.gameClock}`);
      console.log(`Money         ${formatCredits(s.moneyCents)} credits`);
      console.log(`Variables     ${s.variableCount}`);
      console.log(`Ghost blocks  ${s.ghostBlockCount}`);
      for (const w of s.warnings) console.log(`WARNING       ${w}`);
      return 0;
    }
    case 'vars': {
      const filter = (args[1] ?? '').toLowerCase();
      for (const v of listVariables(load(args[0]))) {
        if (!filter || v.name.toLowerCase().includes(filter)) console.log(`${v.name.padEnd(60)} ${v.kind.padEnd(6)} ${show(v.value)}`);
      }
      return 0;
    }
    case 'inv': {
      const save = load(args[0]);
      for (const c of save.inventory.containers) {
        if (args[1] ? c.key !== args[1] : !c.items.length || c.kind === 'vendor') continue;
        console.log(`
${c.key} (${c.kind}${c.storage ? `, ${c.storage}` : ''}, ${c.items.length} items)`);
        for (const it of c.items) {
          const qty = it.stacks.reduce((n, s) => n + s.quantity, 0);
          console.log(`  ${itemName(it.guid).padEnd(36)} x${String(qty).padEnd(5)} ${it.stacks.map((s) => `[${s.quantity} @${formatCredits(s.price)} day ${s.day} fresh ${s.freshness}]`).join(' ')}`);
        }
      }
      return 0;
    }
    case 'skills': {
      for (const e of load(args[0]).skills.entries) {
        const steps = SKILLS[e.guid]?.steps;
        const next = steps && e.level < steps.length - 1 ? `, next level at ${xpForLevel(steps, e.level + 1)}` : ', top level';
        console.log(`${skillName(e.guid).padEnd(18)} level ${String(shownLevel(e.level)).padEnd(3)} xp ${e.xp}${steps ? next : ''}`);
      }
      return 0;
    }
    case 'achievements': {
      const section = load(args[0]).achievements;
      if (!section) throw new Error('No supported achievement section in this save');
      console.log(`Total saved points: ${section.points}`);
      for (const e of section.entries) console.log(`${(ACHIEVEMENT_NAMES[e.guid] ?? e.guid).padEnd(24)} completed ${e.completed}  points ${e.earned}  series complete ${e.isCompleted}  entries ${e.flags.join('') || '-'}`);
      return 0;
    }
    case 'venues': {
      const save = load(args[0]);
      for (const [id, info] of Object.entries(VENUES)) {
        const v = findVenue(save, id);
        if (!v) continue;
        const avg = averageReviewScore(v);
        console.log(`${info.internal.padEnd(52)} level ${v.level}  served ${String(v.mealsServed).padEnd(6)} reviews ${String(v.reviews.length).padEnd(5)} avg ${avg === null ? '-' : avg.toFixed(2)}`);
      }
      return 0;
    }
    case 'diff': {
      const d = diffSaves(load(args[0]), load(args[1]));
      for (const h of d.header) console.log(`[header] ${h.field}: ${h.before} -> ${h.after}`);
      for (const s of d.skills) console.log(`[skill] ${skillName(s.guid)}: level ${shownLevel(s.before?.level)} xp ${s.before?.xp} -> level ${shownLevel(s.after?.level)} xp ${s.after?.xp}`);
      for (const a of d.achievements) console.log(`[achievement] ${ACHIEVEMENT_NAMES[a.guid] ?? a.guid}: ${JSON.stringify(a.before)} -> ${JSON.stringify(a.after)}`);
      for (const v of d.variables) console.log(`${v.name}: ${show(v.before)} -> ${show(v.after)}`);
      console.log(`${d.variables.length} variable(s) changed`);
      return 0;
    }
    case 'check': {
      let failed = 0;
      for (const path of args) {
        try {
          const save = load(path);
          const problems = [...save.warnings, ...roundTripCheck(save)];
          const untested = save.header.versionTested ? '' : ` (untested version ${save.header.version})`;
          console.log(`${problems.length ? 'FAIL' : 'OK  '} ${path}${untested}${problems.length ? `\n     ${problems.join('\n     ')}` : ''}`);
          if (problems.length) failed++;
        } catch (e) {
          console.log(`FAIL ${path}\n     ${e.message}`);
          failed++;
        }
      }
      return failed ? 1 : 0;
    }
    case 'edit': {
      const [path, ...rest] = args;
      const edits = { variables: {} };
      const addItems = [];
      const skillLevels = [];
      const venueSpecs = [];
      let out;
      let inPlace = false;
      let storyMode;
      const actions = new Set();
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--money') edits.moneyCents = parseCredits(rest[++i]);
        else if (a === '--set') {
          const [name, raw] = rest[++i].split('=');
          edits.variables[name] = parseValue(raw);
        } else if (a === '--add-item') addItems.push(rest[++i]);
        else if (a === '--skill') skillLevels.push(rest[++i]);
        else if (a === '--venue') venueSpecs.push(rest[++i]);
        else if (a === '-o') out = rest[++i];
        else if (a === '--in-place') inPlace = true;
        else if (a === '--finish-story' || a === '--finish-story-flags') storyMode = true;
        else if (['--unlock-recipes', '--unlock-venues', '--max-venues', '--complete-achievements', '--complete-save'].includes(a)) actions.add(a);
        else throw new Error(`Unknown option ${a}`);
      }
      if (!out && !inPlace) throw new Error('Specify -o <out.sav> or --in-place');
      const save = load(path);
      if (actions.has('--complete-save')) {
        storyMode = true;
        for (const a of ['--unlock-recipes', '--unlock-venues', '--max-venues', '--complete-achievements']) actions.add(a);
        for (const e of save.skills.entries) {
          const info = SKILLS[e.guid]; if (info) (edits.skills ??= {})[e.guid] = { level: info.steps.length - 1, xp: xpForLevel(info.steps, info.steps.length - 1) };
        }
      }
      if (storyMode !== undefined) {
        console.log('Journal completion, reviewed flags and one outcome per supported choice group staged. Reward scripts and cutscenes are not replayed.');
        edits.variables = { ...storyCompletionEdits(listVariables(save)), ...edits.variables };
        edits.completeQuests = PROGRESS.quests.map((q) => q.guid);
      }
      if (actions.has('--unlock-recipes')) edits.unlockRecipes = PROGRESS.recipes;
      if (actions.has('--complete-achievements')) {
        edits.achievements = {};
        for (const e of save.achievements?.entries ?? []) {
          const spec = PROGRESS.achievements[e.guid]; if (spec) edits.achievements[e.guid] = { completed: spec.count, earned: spec.total, isCompleted: true, ...(e.flags.length ? { flags: e.flags.map(() => true) } : {}) };
        }
      }
      if (actions.has('--unlock-venues') || actions.has('--max-venues')) {
        const vars = new Map(listVariables(save).map((v) => [v.name, v]));
        if (actions.has('--unlock-venues')) edits.unlockProperties = [];
        for (const [id, info] of Object.entries(VENUES)) {
          const owned = `${info.internal}.Owned`;
          if (vars.get(owned)?.kind !== 'bool') continue;
          const stats = findVenue(save, id); if (!stats) continue;
          if (actions.has('--unlock-venues')) { edits.unlockProperties.push(id); edits.variables[owned] = true; }
          if (actions.has('--max-venues') && (edits.variables[owned] ?? vars.get(owned).value)) {
            (edits.venues ??= {})[id] = { level: 5, mealsServed: Math.max(stats.mealsServed, 10000), ...(stats.reviews.length ? { reviewScore: 5 } : {}) };
            for (const [key, value] of Object.entries({ Level: 5, CustomersServed: edits.venues[id].mealsServed, ...(stats.reviews.length ? { ReviewScore: 5 } : {}) })) if (vars.get(`${info.internal}.${key}`)?.kind === 'int') edits.variables[`${info.internal}.${key}`] = value;
          }
        }
      }
      if (!save.header.versionTested) console.log(`WARNING: save version ${save.header.version} is untested; the game may not load the edited save correctly`);
      for (const spec of skillLevels) {
        const [query, raw] = spec.split('=');
        const guid = findSkill(query);
        const level = Number(raw) - 1;
        const { steps } = SKILLS[guid];
        if (!Number.isInteger(level) || level < 0 || level >= steps.length) throw new Error(`${SKILLS[guid].name} level must be 1 to ${steps.length}`);
        (edits.skills ??= {})[guid] = { xp: xpForLevel(steps, level), level };
      }
      for (const spec of venueSpecs) {
        const [query, field, raw] = spec.split(/[.=]/);
        const id = findVenueId(query);
        const key = { level: 'level', served: 'mealsServed', stars: 'reviewScore' }[field];
        if (!key || !/^\d+$/.test(raw ?? '')) throw new Error(`Invalid venue edit "${spec}" (e.g. Venue_NoodleBar.level=5, .served=600, .stars=5)`);
        (edits.venues ??= {})[id] = { ...edits.venues?.[id], [key]: Number(raw) };
        const sync = { level: 'Level', mealsServed: 'CustomersServed', reviewScore: 'ReviewScore' }[key];
        const name = `${VENUES[id].internal}.${sync}`;
        if (listVariables(save).some((v) => v.name === name) && !(name in edits.variables)) edits.variables[name] = Number(raw);
      }
      if (addItems.length) {
        edits.inventory = {};
        for (const spec of addItems) {
          const [key, query, qtyRaw] = spec.split(':');
          const container = save.inventory.containers.find((c) => c.key === key);
          if (!container) throw new Error(`Unknown container "${key}"`);
          const guid = findItem(query);
          const quantity = Number(qtyRaw ?? 1);
          const items = (edits.inventory[key] ??= structuredClone(container.items));
          const stack = { price: 0, day: currentGameDay(save), quantity, freshness: CATALOG[guid]?.freshness ?? 0 };
          const existing = items.find((it) => it.guid === guid);
          if (existing) existing.stacks.push(stack);
          else items.push({ guid, stacks: [stack] });
        }
      }
      const conflicts = storyChoiceConflicts(listVariables(save).map((v) => ({ ...v, value: Object.hasOwn(edits.variables, v.name) ? edits.variables[v.name] : v.value })));
      if (Object.keys(edits.variables).length && conflicts.length) throw new Error(`Conflicting story choices: ${conflicts.join(', ')}`);
      const edited = applyEdits(save, edits);
      const target = out ?? path;
      if (inPlace) {
        const backup = `${path}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
        copyFileSync(path, backup);
        console.log(`Backup written to ${backup}`);
      } else if (existsSync(target)) {
        throw new Error(`${target} already exists`);
      }
      writeFileSync(target, edited);
      console.log(`Wrote ${target}`);
      return 0;
    }
    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
}
