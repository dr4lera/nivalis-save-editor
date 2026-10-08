// Explicit completion markers only; broad toggle enabling is a separate action.
export function storyToggleEdits(variables, { completionOnly = false } = {}) {
  return Object.fromEntries(variables.filter((v) => v.kind === 'bool'
    && (!completionOnly || /(?:complete(?:d)?|finished|done)(?:\d+)?$/i.test(v.key ?? v.name.split('.').at(-1))))
    .map((v) => [v.name, true]));
}
