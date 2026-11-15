import type { SearchEditorTarget } from './canvasEditorHandoff'

type SourceRange = Readonly<{ start: number; end: number }>
type SourceMatch = Pick<SearchEditorTarget, 'sourceStart' | 'sourceEnd' | 'sourceByteStart' | 'sourceByteEnd' | 'sourceDigest' | 'match'>
const utf8 = new TextEncoder()

export function hasUniformCrlf(source: string): boolean {
  return source.includes('\r\n') && !/\r(?!\n)|(?<!\r)\n/u.test(source)
}

export function normalizeCrlf(source: string): string {
  return source.replaceAll('\r\n', '\n')
}

export function restoreCrlf(source: string): string {
  return source.replace(/\r\n?|\n/gu, '\r\n')
}

function validBoundary(source: string, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length) return false
  const before = source.charCodeAt(offset - 1)
  const after = source.charCodeAt(offset)
  const insideCrlf = before === 0x0d && after === 0x0a
  const insideSurrogate = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  return !insideCrlf && !insideSurrogate
}

function textareaOffset(source: string, offset: number): number {
  let result = offset
  for (let index = source.indexOf('\r\n'); index >= 0 && index < offset; index = source.indexOf('\r\n', index + 2)) {
    result--
  }
  return result
}

export function textareaSourceRange(source: string, textarea: string, range: SourceRange,
  lineEndings: 'editor' | 'native' = 'editor'): SourceRange | undefined {
  if (range.end < range.start || !validBoundary(source, range.start) || !validBoundary(source, range.end)) return
  if (lineEndings === 'editor' && source.includes('\r') && !hasUniformCrlf(source)) return
  const expected = lineEndings === 'native' ? source.replace(/\r\n?/gu, '\n') : normalizeCrlf(source)
  if (textarea !== expected) return
  const start = textareaOffset(source, range.start)
  return { start, end: range.start === range.end ? start : textareaOffset(source, range.end) }
}

export async function verifySourceMatch(source: string, target: SourceMatch): Promise<boolean> {
  const { sourceStart: start, sourceEnd: end, sourceByteStart, sourceByteEnd, sourceDigest, match } = target
  if (end <= start || !validBoundary(source, start) || !validBoundary(source, end) ||
      source.slice(start, end) !== match || sourceDigest.length !== 32 || /\p{Surrogate}/u.test(source)) return false
  const before = utf8.encode(source.slice(0, start)).length
  if (sourceByteStart !== before || sourceByteEnd !== before + utf8.encode(match).length || !globalThis.crypto?.subtle) return false
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(source)))
  return digest.every((byte, index) => byte === sourceDigest[index])
}
