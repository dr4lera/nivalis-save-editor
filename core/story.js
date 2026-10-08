// Reviewed completion flags from the observed schema. Unknown names are excluded;
// suffix matching alone cannot establish mutually exclusive dialogue outcomes.
export const STORY_COMPLETION_FLAGS = [
  'Zaffer.BuyNeonComplete', 'Gladstone.CheeseQuestComplete', 'Gladstone.TrapQuestComplete',
  'ClemHortelano.FirstFoodQuestComplete', 'ClemHortelano.GrapevineQuestComplete', 'ElaineMalloy.PhotosDone',
  'MaGomba.GrowQuestComplete', 'MaGomba.PoisonQuestComplete', 'MaGomba.FirstGrowMissionComplete',
  'MaGomba.SecondGrowMissionComplete', 'Bonaventure.ShipwreckQuestComplete', 'GanCoilson.QuestFinished',
  'Deeala.Complete', 'HanzGrundown.PopularityBoostDone', 'HanzGrundown.BeefQuestComplete',
  'Dotson.DannyComplete', 'MagzZunica.QuestComplete', 'HarperOsiris.QuestComplete',
  'SalMagundi.StealHolosComplete', 'SalMagundi.TrashFusionPointComplete', 'SalMagundi.BuyTTFromLuminitaComplete',
  'AlanFontus.Finished', 'CirianKrell.LevelUpQuestComplete', 'KaseyRemo.QuestComplete',
  'FinnAmano.QuestComplete', 'SiloMills.QuestComplete', 'FredMatombo.AllDone', 'MasatoShima.QuestComplete',
  'SalmaSmith.QuestComplete', 'BenQuestVariables.MasatoMizzyOneDone', 'BenQuestVariables.TravelToOdinsPubDone',
  'Eldridge.GetPhotosComplete', 'MiaJay.QuestComplete', 'BouFriday.ThrowCoffeeComplete',
  'NoeStalgia.FirstQuestComplete', 'JohnDoe.QuestComplete', 'MizzyWeiss.QuestComplete',
  'ZiggyRaSand.QuestComplete', 'GlobalPlayerKnowledge.IntroComplete', 'GlobalPlayerKnowledge.ExpansionComplete',
  'GlobalPlayerKnowledge.ChairQuestDone', 'ThaddeusQuest.Complete', 'PilkDane.Complete',
  'TaylorHernz.ReenaDone', 'TaylorHernz.FinlayDone', 'TaylorHernz.RoxyDone',
  ...['Silo', 'JohnDoe', 'Nabla', 'Mary', 'Magz', 'Mia', 'Rollo', 'Professor', 'Ziggy', 'Sanderson']
    .map((name) => `ApartmentStaging.${name}Complete`),
];

// One default per supported choice group. Each group explicitly clears alternatives.
// Never infer groups from arbitrary names such as HelpedAva/HelpedLochlainn.
export const STORY_CHOICE_GROUPS = [
  { name: 'Poison quest: success', selected: 'MaGomba.PoisonQuestComplete', choices: ['MaGomba.PoisonQuestComplete', 'MaGomba.PoisonQuestFailed'] },
  { name: 'Steal holos: success', selected: 'SalMagundi.StealHolosComplete', choices: ['SalMagundi.StealHolosComplete', 'SalMagundi.StealHolosFailed'] },
  { name: 'Reehan: fleshy kind', selected: 'BenQuestVariables.ReehanFleshyKind', choices: ['BenQuestVariables.ReehanFleshyKind', 'BenQuestVariables.ReehanNeuralKind'] },
  { name: 'Ashwin: Bonaventure', selected: 'AshwinChopra.StoryQuestBonaventure', choices: ['AshwinChopra.StoryQuestBonaventure', 'AshwinChopra.StoryQuestDontCare'] },
  ...[['ElaineMalloy', 3], ['MaGomba', 2], ['FauxterGlambeat', 2], ['MarcelleDeNuite', 3]].map(([person, count]) => ({
    name: `${person}: coffee choice 1`, selected: `${person}.CoffeeChoice1`,
    choices: Array.from({ length: count }, (_, i) => `${person}.CoffeeChoice${i + 1}`),
  })),
];

export function storyCompletionEdits(variables) {
  const byName = new Map(variables.map((v) => [v.name, v]));
  const edits = {};
  for (const name of STORY_COMPLETION_FLAGS) if (byName.get(name)?.kind === 'bool') edits[name] = true;
  for (const group of STORY_CHOICE_GROUPS) {
    // Partial/new layouts must not guess whether an absent alternative was renamed.
    if (!group.choices.every((name) => byName.get(name)?.kind === 'bool')) continue;
    for (const name of group.choices) edits[name] = name === group.selected;
  }
  return edits;
}

export function storyChoiceConflicts(variables) {
  const byName = new Map(variables.map((v) => [v.name, v]));
  return STORY_CHOICE_GROUPS.filter((group) => group.choices.filter((name) => byName.get(name)?.value === true).length > 1)
    .map((group) => group.name);
}
