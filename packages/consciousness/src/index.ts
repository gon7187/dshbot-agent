// Wake-ups of the bot: thinking between tasks (DESIGN §8.2).
//
// A wake-up is an ordinary turn of the `main` session, not a separate subsystem:
// the host asks the same runner for a prompt whose text says that nobody asked,
// that the turn belongs to the bot and that a pause is a legitimate outcome.
// This package owns only the clock and the model-facing pieces around that turn:
//
//   - the scheduler (bounds 15 min .. 4 h, doubling after a failed wake-up);
//   - the `set_next_wakeup` tool, present in every turn of `main`;
//   - the wake-up prompt;
//   - the wake-up usage ledger (a separate label, no cap).

export {
  clampInterval,
  createWakeScheduler,
  DEFAULT_WAKE_INTERVAL_MIN,
  DEFAULT_WAKE_JITTER,
  MAX_WAKE_INTERVAL_MIN,
  MIN_WAKE_INTERVAL_MIN,
  normalizeWakeJitter,
  parseWakeJitter,
  type WakeScheduler,
  type WakeSchedulerOptions,
  type WakeTurnOutcome,
} from './scheduler.js'
export {
  createDreamScheduler,
  DEFAULT_DREAM_AT,
  dreamDate,
  DREAM_SESSION_ID,
  DREAM_TOOL_NAMES,
  dreamPrompt,
  dreamSection,
  nextDreamAt,
  parseDreamAt,
  type DreamJournalEntry,
  type DreamMessage,
  type DreamOutcome,
  type DreamPromptInput,
  type DreamScheduler,
  type DreamSchedulerOptions,
} from './dream.js'
export {
  AUTONOMY_LEVELS,
  createSetNextWakeupTool,
  EVENING_REFLECTION_HOUR,
  isEveningReflectionDue,
  isObserve,
  MAINTENANCE_CHORES,
  maintenanceChore,
  markEveningReflection,
  parseAutonomy,
  readMaintenanceChorePosition,
  SET_NEXT_WAKEUP_TOOL,
  takeEveningReflection,
  takeMaintenanceChore,
  WAKE_EVENING_KV_KEY,
  WAKE_MAINTENANCE_KV_KEY,
  wakePrompt,
  wakeSituationNotes,
  type AutonomyLevel,
  type MaintenanceStorage,
  type WakePromptOptions,
} from './prompt.js'
export {
  DEFAULT_FREE_WAKE_CHANCE,
  DEFAULT_PROACTIVE_PER_DAY,
  DEFAULT_QUIET_HOURS,
  formatOwnerMoment,
  hoursSince,
  isFreeMinute,
  isQuietAt,
  normalizeFreeWakeChance,
  ownerDayKey,
  ownerHour,
  ownerInitiativeHold,
  parseFreeWakeChance,
  parseProactivePerDay,
  parseQuietHours,
  PROACTIVE_COOLDOWN_MS,
  readWakeProactiveLedger,
  saveWakeProactiveLedger,
  SILENCE_AFTER_MS,
  SILENCE_STREAK_LIMIT,
  silenceNote,
  WAKE_PROACTIVE_KV_KEY,
  type OwnerInitiativeInput,
  type QuietHours,
  type WakeProactiveLedger,
  type WakeProactiveStorage,
} from './proactive.js'
export {
  collectSessionUsage,
  countSessionEvents,
  createDreamUsageStore,
  createWakeUsageStore,
  DREAM_USAGE_LABEL,
  readSessionUsage,
  SESSION_MAIN_ID,
  WAKE_USAGE_LABEL,
  type SessionModelUsage,
  type WakeUsageStore,
} from './usage.js'
export {
  buildWakeWellbeing,
  IDENTITY_STALE_MS,
  IDENTITY_THIN_CHARS,
  SCRATCHPAD_EMPTY_CHARS,
  SCRATCHPAD_FULL_RATIO,
  WAKE_USAGE_WINDOW_MS,
  WELLBEING_HEADER,
  WELLBEING_LIMIT,
  type WakeUsageSample,
  type WakeWellbeingInput,
} from './wellbeing.js'
