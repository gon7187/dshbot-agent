// The frame of untrusted data for the `mail` tool is the one common frame of
// the bot (packages/app/src/untrusted-frame.ts), re-exported here for the mail
// package and its tests. A letter is written by a stranger: its sender,
// subject, body and file names are data, not instructions for the owner's
// model. Every `list` and `read` answer puts those fields inside one
// EXTERNAL_UNTRUSTED_CONTENT frame with a fresh random boundary per call, and
// the notice names `mail` as the source tool.

export { BOUNDARY_PREFIX, frameData, sanitizeData, type FrameOptions } from '../../app/src/untrusted-frame.js'
