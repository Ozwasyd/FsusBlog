import { t, type MessageKey } from '../siteLocale'

// Presentation-only mapping: parser diagnostics remain stable for non-browser consumers.
const messages = new Map<string, MessageKey>([
  ["The Markdown file exceeds the draft size limit.", 'author.helper.markdownSize'],
  ["Choose a readable UTF-8 Markdown file.", 'author.helper.markdownReadable'],
  ["The Markdown source exceeds the size limit or contains invalid Unicode.", 'author.helper.markdownUnicode'],
  ["The exported Markdown title is invalid.", 'author.helper.markdownTitle'],
  ["The exported Markdown header is invalid.", 'author.helper.markdownHeader'],
  ["Use plain Markdown or a Markdown file exported by FsusBlog v2.", 'author.helper.markdownFormat'],
  ["Enter a valid title for the draft.", 'author.helper.draftTitle'],
  ["Enter Markdown within the draft size limit without NUL characters.", 'author.helper.markdownBody'],
])

export function draftMarkdownErrorMessage(message: string): string {
  const key = messages.get(message)
  return key ? t(key) : message
}
