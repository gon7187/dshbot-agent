// Rich-форматирование ответов Telegram: Markdown → типизированные блоки,
// нарезка по лимитам, HTML/plain-деградация и отправка с лестницей.

export {
  markdownToRichBlocks,
  parseInline,
  richTextToPlain,
  type MarkdownToRichOptions,
  type RichBlock,
  type RichBlockListItem,
  type RichBlockTableCell,
  type RichText,
  type RichTextNode,
} from './markdown.js'
export { splitRichBlocks, type SplitRichOptions } from './split.js'
export { chunkText, markdownToHtml, markdownToPlain } from './html.js'
export {
  extractButtons,
  stripButtons,
  stripPreviewButtons,
  type ButtonRegistryLike,
  type ExtractedButtons,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
} from './buttons.js'
export {
  normalizeMarkdownHardBreaks,
  splitMarkdown,
  RICH_BLOCK_LIMIT,
  RICH_CHAR_LIMIT,
  type SplitMarkdownOptions,
} from './native.js'
export {
  sendFormatted,
  type DeliveryMode,
  type DeliveryReport,
  type RichMediaInput,
  type SendFormattedOptions,
} from './send.js'
export { deliveryNoteOf, createDeliveryNotes, type DeliveryNotes } from './delivery-note.js'
