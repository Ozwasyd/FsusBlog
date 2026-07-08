export const CJK_CHARS_PER_MINUTE = 420
export const LATIN_WORDS_PER_MINUTE = 240
export const OTHER_CHARS_PER_MINUTE = 500
export const CODE_CHARS_PER_MINUTE = 140
export const TABLE_CHARS_PER_MINUTE = 220
export const IMAGE_SECONDS = 12
export const LONG_READ_THRESHOLD = 5_000

export type ReadingEstimate = Readonly<{
  codeChars: number
  effectiveChars: number
  imageCount: number
  minutes: number
  showLongReadNotice: boolean
  tableChars: number
  textChars: number
}>

const fencedCodePattern = /```[\s\S]*?```|~~~[\s\S]*?~~~/g
const inlineCodePattern = /`[^`\n]+`/g
const imagePattern = /!\[[^\]]*]\([^)]+\)/g
const linkPattern = /\[([^\]]+)]\([^)]+\)/g
const tableRowPattern = /^\s*\|.*\|\s*$/gmu
const markdownSyntaxPattern = /(^|\n)\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+|[*_~>#|\[\]()\\-]/g
const latinWordPattern = /[A-Za-z]+(?:['-][A-Za-z]+)*/g
const cjkCharPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

export function countEffectiveReadingChars(content: string): number {
  return content.replace(/\s+/g, '').length
}

function sumMarkdownCodeChars(content: string): number {
  let codeChars = 0
  for (const match of content.matchAll(fencedCodePattern)) {
    codeChars += match[0]
      .replace(/^(```|~~~)[^\n]*\n?/u, '')
      .replace(/\n?(```|~~~)$/u, '')
      .replace(/\s+/g, '').length
  }
  for (const match of content.matchAll(inlineCodePattern)) {
    codeChars += match[0].slice(1, -1).replace(/\s+/g, '').length
  }
  return codeChars
}

function stripMarkdownForReading(content: string): string {
  return content
    .replace(fencedCodePattern, ' ')
    .replace(inlineCodePattern, ' ')
    .replace(tableRowPattern, ' ')
    .replace(imagePattern, ' ')
    .replace(linkPattern, '$1')
    .replace(markdownSyntaxPattern, '$1')
}

function sumMarkdownTableChars(content: string): number {
  let tableChars = 0
  for (const match of content.matchAll(tableRowPattern)) {
    tableChars += match[0].replace(/\s+/g, '').length
  }
  return tableChars
}

export function estimateReading(content: string): ReadingEstimate {
  const effectiveChars = countEffectiveReadingChars(content)
  const codeChars = sumMarkdownCodeChars(content)
  const tableChars = sumMarkdownTableChars(content)
  const imageCount = content.match(imagePattern)?.length ?? 0
  const readableText = stripMarkdownForReading(content)
  const cjkChars = readableText.match(cjkCharPattern)?.length ?? 0
  const latinWords = readableText.match(latinWordPattern)?.length ?? 0
  const latinChars = (readableText.match(latinWordPattern) ?? []).join('').length
  const textChars = readableText.replace(/\s+/g, '').length
  const otherChars = Math.max(0, textChars - cjkChars - latinChars)
  const readingSeconds =
    (cjkChars / CJK_CHARS_PER_MINUTE) * 60
    + (latinWords / LATIN_WORDS_PER_MINUTE) * 60
    + (otherChars / OTHER_CHARS_PER_MINUTE) * 60
    + (codeChars / CODE_CHARS_PER_MINUTE) * 60
    + (tableChars / TABLE_CHARS_PER_MINUTE) * 60
    + imageCount * IMAGE_SECONDS

  return {
    codeChars,
    effectiveChars,
    imageCount,
    minutes: Math.max(1, Math.ceil(readingSeconds / 60)),
    showLongReadNotice: effectiveChars > LONG_READ_THRESHOLD,
    tableChars,
    textChars
  }
}
