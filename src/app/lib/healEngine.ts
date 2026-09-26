// The heavy half of healing — ~1,000 rules, diagnosis patterns and the strategy
// ladder. Loaded with a dynamic import() when a heal starts, so it stays out of
// the initial page bundle.

export { applyRuleBasedFixes } from './ruleBasedFixer';
export { categorizeAllErrors } from './diagnostics';
export { clusterRootCauses, crossFileConsistencyCheck } from './fixEngine';
export { runHealingLadder } from './strategies/ladder';
export { revertToLastGreen } from './strategies/revert';
export { runAutofixJob } from './strategies/autofixJob';
