# Historical pause checkpoint — 8 October 2026

Resumed on 8 October 2026. The new completion controls, comparisons, CLI actions, tests and Windows 1.7.0 build are now complete. All 29 tests and browser integration checks passed. The user reported everything worked in-game. Remaining release work: publish the committed branch and verified ZIP/EXE/checksums to GitHub. The notes below describe the earlier unfinished checkpoint and are historical, not current blockers.

## Goal and latest feedback

Finish a usable Windows release of the Nivalis save editor with a real 100% save preset. Requested: achievements tab, complete all achievements, complete story/quests so active quests disappear, choose one mutually exclusive outcome, unlock/max venues, unlock all recipes, and any closely related missing completion state. Skills and business entries already worked in the user's game. The prior story flag preset only cleared some quest lines (the user mentioned Salt Pete); other quests remained.

## Repository and published working branch

- Local checkout: `C:/Users/zrock/Downloads/codex/nivalis-save-editor`.
- Branch: `feat/achievements-story-completion`.
- Upstream: HiveSolution/nivalis-save-editor; user's fork: dr4lera/nivalis-save-editor.
- Last pushed revision before the new incomplete changes: `4f272b109abce57e888e6770cde2ab404c82d688`.
- That revision passed 27 tests and browser tests and built a Windows executable. It does not include today's unfinished quest/venue/recipe/all-achievement fixes.
- Existing EXE/ZIP in `release/out` are still that earlier build. Do not represent them as containing the new 100% features.

## Release publishing still unfinished

A preview release was created at `https://github.com/dr4lera/nivalis-save-editor/releases/tag/v1.6.1-story-achievements.1`. GitHub uploads of the ZIP and EXE failed with a closed connection / upload inactivity timeout; only SHA256SUMS.txt was confirmed uploaded. Inspect remote release and assets before retrying. Use existing GitHub Credential Manager account dr4lera; keep credentials in memory, never print them. Prefer a reliable uploader (e.g. curl with binary body and appropriate Content-Length) rather than repeating the failed Invoke-RestMethod upload. Publish final assets only after the fixes below are verified. Existing release notes/checksums currently describe the earlier build.

## Save backup and inspection output

- Game: `D:/SteamLibrary/steamapps/common/Nivalis Nights`.
- Save folder: `C:/Users/zrock/AppData/LocalLow/ION LANDS/Nivalis Nights`.
- Pristine snapshot made before any new tests: `C:/Users/zrock/Downloads/codex/nivalis-research/backup-20261008-034623`.
- Inspection output/tools are outside the repo in `C:/Users/zrock/Downloads/codex/nivalis-research`; never commit or ship extracted game files, dummy DLLs, dump.cs, or raw assets.
- User authorized testing with the running game. PID 33068 was inspected read-only using Frida, then the game was no longer running (no crash diagnosis established). Refresh process IDs; don't reuse 33068. No live gameplay mutations were performed by the inspection scripts. No original .sav was written by this task's new tests.
- Game was paused when captured; `game-before_small.png` and full screenshot are in the research folder. Screenshots use universal-modder um with gfxcapture ffmpeg. Research folder includes Frida/capstone Python dependencies, IL2CPP dump, disassembly, and live catalog scripts.

## Verified discoveries

- QuestManagerSave fields: nextQuestNumber, ActiveQuests, CompletedQuests. Manager key `995F9525-8D5C-4853-BC1C-E899CF23FEDD`.
- RuntimeQuest state: 0 None, 1 InProgress, 2 Completed, 3 Failed. Wrapper: string RuntimeQuest_GUID, int absolute end, int group version, GUID, int state, byte pinned, int questNumber, int lastUpdateTime, then tracker lists and matching closing tag.
- Live catalog contained 113 quests. Live/save state before new edits: 13 active, 5 completed/failed.
- MealDatabaseSave key `FD7EDFDC-A7BD-4BAA-8B6C-751444DB0340`. Starts with count + known recipe GUID strings, then custom recipe definitions which must be preserved. Live catalog contained 192 recipe GUIDs; only 16 known originally. Game has DiscoverAllRecipes method.
- PlayerManager.PlayerSave starts at player Ghost end: money int, OwnedProperties GUID list, then 9 knowledge booleans and further fields. Existing player owned seven properties, including two venues. PropertyManager does not have a separate save packet; underlying owner inventories / AI ownership may also need synchronization. Investigate before claiming venue unlock works.
- Ownable venues can be matched from Venue_*.Owned story variables plus item catalog internal names and recognized world records (about 15). NPC venues should not be granted blindly.
- Actual achievement limits and bonuses were read through game getters and stored as reference metadata in `src/data/progression.json`: apartments 11/16 points, business 17/22, farming 93/98, fishing 24/29, graffiti 28/33, menus 27/32, postcards 10/15, quests 113/123, vendors 141/151, locations 18/23, restaurants 83/88. Series isCompleted byte matters; old editor preserved it, explaining why numeric edits didn't finish series. Underlying collectible entry state may still need edits.
- Important serialization issue: absolute-end-offset wrappers include RuntimeQuest, SubQuest, tracker and other saveables, not just Ghost blocks. Inventory/recipe/property size changes must shift ALL validated wrapper offsets. New code handles matching closing tags, including named Ghosts with apostrophes/parentheses.

## New code saved, but incomplete and unverified

- `core/progression.js`: generic serialized-block index, splice helper, parsing of player property list, known recipe list, and quest lists; edits for adding recipes/properties and completing quests.
- `core/save.js`: progression parsing/edit pipeline; inventory offset shifting broadened to all validated wrappers.
- `core/achievements.js`: allows editing isCompleted byte.
- `src/data/progression.json`: reference quest IDs/names, recipe IDs, actual achievement limits (no personal save values).
- `src/main.js`: unfinished buttons for all achievements, real journal completion, unlock/max venues, recipes and aggregate 100% preset. Only syntax-smoked; not rebuilt/released.

## Required work when resuming

1. Run full real-save tests with NN_SAVE_DIR. Fix any parser/splice failures. A first quest+recipe combined edit failed verification because 19 named Ghosts were excluded by the initial tag regex; that regex was broadened, but combined edit has not been rerun.
2. Validate synthesized completed RuntimeQuest records against the game's loader, not just our parser. They currently omit objective trackers and do not replay quest rewards/cutscenes. Confirm journal has zero active quests after loading/re-saving and does not regenerate them. Preserve unknown/auto-generated quests safely.
3. Verify property unlocks in-game and any other ownership records; current implementation only appends player OwnedProperties plus .Owned flags. Do not claim this works yet.
4. Verify all achievement series completion, correct points/bonus arithmetic, and underlying entry flags/collectible state after load. Series completion currently changes counters + isCompleted; not all discovery state is decoded.
5. Validate all recipes in-game, preserving customized recipes.
6. Fix pending/edit bookkeeping: manual story edits filter the storyBatch array and can lose questBefore; progression-reset clears ownership list edits without reverting staged .Owned variables; all-achievement edits need an undo strategy; update comparisons and backup notes for quest/recipe/property edits.
7. Test venue bulk max (level 5, at least 10,000 meals, 5-star existing reviews), no-review behavior, and source/variable consistency.
8. Add meaningful tests for new features, update the browser mock/test harness at `../nivalis-ui-check.mjs`, docs, version and release notes. Previous browser suite still assumes story preset only changes flags, so adjust it.
9. Build the final Windows EXE, package with README/license/AI disclosure, inspect package, commit/push final branch, and finish GitHub release uploads. Do not ship research/game assets or personal saves.

At pause: source syntax checks passed. The focused progression suite's old rejection assertion for isCompleted=true was updated because that edit is now supported; it must be rerun. Full new-feature correctness and in-game behavior are still pending. No 100% claim is justified yet.
