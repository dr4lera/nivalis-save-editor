# Achievement editor field notes

## 1.7.0 completion controls — 2026-10-08

Implemented journal quest completion (113), recipe list expansion (192), player property grants for 15 purchasable venues, max venue stats, full achievement series counters/points/completion bytes, a combined preset, progression comparison/backup notes, and corresponding CLI actions. All 29 tests passed against preserved save copies; browser tests covered every button and the complete save serialization flow. The Windows 1.7.0 build passed. The user reported "everything worked on my end" in-game.

Agent-controlled game loading could not be completed because SteamApi_Init failed to connect to the active Steam session. In-game confirmation comes from the user; do not describe it as automated verification. Separate collectible discovery flags and Steam achievements are not fully edited, and journal completion does not replay rewards/cutscenes.

Serialization correction: RuntimeQuest has five trailing collections, including invalidated subquests. The synthesized completed records include all five empty counts. Size-changing edits update all matching SaveWriter wrappers, including named Ghosts with punctuation, SubQuests and trackers.

Verified on 2026-10-08 against two local version 159 save files and the user's installed Nivalis Nights data. No original saves were written or added to this repository. No extracted assets or decompiled code are included.

- AchievementManagerSave metadata fields: points, series, Guid backing field.
- AchievementSeriesSave metadata fields: completedEntriesCount, points, isCompleted, singularEntriesSave.
- Manager key: 03H1F65F-148C-9E66-GHQE-4109P1286Q17. Its following section is 37FBBCF3-ADDF-4B91-825E-480816462579.
- Both saves contain 11 series. Business has 17 individually saved boolean entries; other observed series have no individual flags.
- The sum of series points matches the saved manager total (47). Edits keep that total in sync by applying the series point delta.
- The save section after skills, 55F0A877-007D-4D50-B18E-55AF67D8B77B, is not the achievement counter section. It contains GUID/boolean pairs; its meaning has not been verified.
- Tests prove exact byte re-encoding, same-size achievement edits, preservation through inventory size changes, synchronized story mirrors, rejection of malformed/invalid edits, and recovery of original achievement values.
- Browser verification uses a read-only Tauri mock backed by a local save: search, entry edit/revert, bulk confirmation/cancellation, undo/discard, filtered views and a 960px viewport.
- In-game loading, Steam achievement unlocks, completing series bonuses and a universal finished-story state remain unverified. The editor preserves series completion bytes and never guesses numeric quest endpoints.

Story preset refinement: removed blanket boolean enabling at the user's request. The final preset uses explicit completion flags and eight declared choice groups: two success/failure pairs, Reehan fleshy/neural, Ashwin Bonaventure/don't care, and four coffee choice groups. It picks one named default and clears alternatives. Choice flags and coffee instruction names were found in the installed asset data; the grouping/default policy is an editor policy, not a proof of full quest graph completion. Tests enforce a single outcome per supported group and preservation of unsupported variables. Unknown quest graphs cannot be called seamlessly completed without an in-game oracle.
