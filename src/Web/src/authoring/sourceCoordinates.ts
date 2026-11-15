type SourceRange = Readonly<{ start: number; end: number }>

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

export function textareaSourceRange(source: string, textarea: string, range: SourceRange): SourceRange | undefined {
  if (range.end < range.start || !validBoundary(source, range.start) || !validBoundary(source, range.end)) return
  if (source.includes('\r') && !hasUniformCrlf(source)) return
  if (textarea !== normalizeCrlf(source)) return
  const start = textareaOffset(source, range.start)
  return { start, end: range.start === range.end ? start : textareaOffset(source, range.end) }
}
