# Achievement editor field notes

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
