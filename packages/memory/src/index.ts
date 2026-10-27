// Public contract of the memory package.

export {
  createEntryStore,
  ENTRY_SEPARATOR,
  EntryStoreError,
  type EntryOperation,
  type EntryStore,
  type EntryStoreOptions,
} from './entries.js'
export {
  IdentityError,
  readIdentity,
  revisionOf,
  writeIdentity,
  type Identity,
} from './identity.js'
export {
  createRecallIndex,
  RECALL_KINDS,
  type RecallDocument,
  type RecallHit,
  type RecallIndex,
  type RecallKind,
  type RecallSearchOptions,
} from './recall.js'
export {
  recallTurnBlock,
  significantRecallWords,
  TURN_RECALL_MAX_CHARS,
  TURN_RECALL_MAX_HITS,
  type RecallTurnBlockOptions,
} from './turn-recall.js'
export { startRecallRelay, type RecallRelay, type RecallRelayOptions } from './recall-relay.js'
export {
  createUpdateMoodTool,
  MOOD_FILE,
  MOOD_LIMIT,
  MoodLimitError,
  moodBlock,
  readMood,
  UPDATE_MOOD_TOOL_NAME,
  writeMood,
} from './mood.js'
export {
  buildMoodOccasions,
  countToolErrors,
  execResultFailed,
  MOOD_OCCASIONS_HEADER,
  type MoodOccasionsBoundary,
  type MoodOccasionsInput,
} from './mood-occasions.js'
export {
  composeScratchpad,
  createUpdateScratchpadTool,
  readScratchpad,
  scratchpadBlock,
  SCRATCHPAD_FILE,
  SCRATCHPAD_LIMIT,
  ScratchpadLimitError,
  UPDATE_SCRATCHPAD_TOOL_NAME,
  writeScratchpad,
  type ScratchpadMode,
} from './scratchpad.js'
export {
  createKnowledgeTool,
  KNOWLEDGE_LIST_LIMIT,
  KNOWLEDGE_SUMMARY_LIMIT,
  KNOWLEDGE_TEXT_LIMIT,
  KNOWLEDGE_TOOL_NAME,
  KNOWLEDGE_TOPIC_LIMIT,
  knowledgeListBlock,
  listKnowledgeTopics,
  readKnowledgeTopic,
  requireKnowledgeTopic,
  writeKnowledgeTopic,
  type KnowledgeStoreOptions,
  type KnowledgeSummary,
  type KnowledgeToolOptions,
} from './knowledge.js'
export {
  appendJournalEntry,
  createJournalTool,
  JOURNAL_ENTRY_LIMIT,
  JOURNAL_TOOL_NAME,
  type JournalAppendResult,
  type JournalStoreOptions,
  type JournalToolOptions,
} from './journal.js'
export { localDate, localTime } from './local-time.js'
export {
  createMemoryTool,
  createRecallTool,
  createUpdateIdentityTool,
  currentIdentityRevision,
  ENVIRONMENT_MEMORY_LIMIT,
  MEMORY_TOOL_NAME,
  RECALL_TOOL_NAME,
  UPDATE_IDENTITY_TOOL_NAME,
  USER_MEMORY_LIMIT,
  type RecallToolOptions,
} from './tools.js'

export {
  createWorkspaceIndex,
  WORKSPACE_MAX_BYTES,
  WORKSPACE_TEXT_EXTENSIONS,
  type WorkspaceIndex,
  type WorkspaceIndexOptions,
  type WorkspaceIndexStats,
} from './workspace.js'
