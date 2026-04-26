export type SelectionSnapshot = Readonly<{
  value: string
  start: number
  end: number
}>

export type SelectionResult = Readonly<{
  value: string
  start: number
  end: number
}>

type BlockSelection = Readonly<{
  before: string
  content: string
  after: string
  startOffset: number
  endOffset: number
}>

export function createSnapshot(value: string, start: number, end: number): SelectionSnapshot {
  return {
    value,
    start,
    end
  }
}

function clampIndex(value: string, index: number): number {
  return Math.max(0, Math.min(value.length, index))
}

function getBlockSelection(snapshot: SelectionSnapshot): BlockSelection {
  const start = clampIndex(snapshot.value, snapshot.start)
  const end = clampIndex(snapshot.value, snapshot.end)
  const blockStart = snapshot.value.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const blockEndIndex = snapshot.value.indexOf('\n', end)
  const blockEnd = blockEndIndex === -1 ? snapshot.value.length : blockEndIndex

  return {
    before: snapshot.value.slice(0, blockStart),
    content: snapshot.value.slice(blockStart, blockEnd),
    after: snapshot.value.slice(blockEnd),
    startOffset: start - blockStart,
    endOffset: end - blockStart
  }
}

export function replaceSelection(
  snapshot: SelectionSnapshot,
  nextText: string,
  selectionStart?: number,
  selectionEnd?: number
): SelectionResult {
  const start = clampIndex(snapshot.value, snapshot.start)
  const end = clampIndex(snapshot.value, snapshot.end)
  const value = `${snapshot.value.slice(0, start)}${nextText}${snapshot.value.slice(end)}`
  const resolvedStart = start + (selectionStart ?? nextText.length)
  const resolvedEnd = start + (selectionEnd ?? selectionStart ?? nextText.length)

  return {
    value,
    start: resolvedStart,
    end: resolvedEnd
  }
}

export function insertAtSelection(
  snapshot: SelectionSnapshot,
  text: string
): SelectionResult {
  return replaceSelection(snapshot, text)
}

export function wrapSelection(
  snapshot: SelectionSnapshot,
  prefix: string,
  suffix = prefix,
  fallback = ''
): SelectionResult {
  const selected = snapshot.value.slice(snapshot.start, snapshot.end)
  const inner = selected || fallback
  const wrapped = `${prefix}${inner}${suffix}`

  if (selected) {
    return replaceSelection(snapshot, wrapped)
  }

  return replaceSelection(snapshot, wrapped, prefix.length, prefix.length + inner.length)
}

export function prefixLines(
  snapshot: SelectionSnapshot,
  prefix: string,
  fallback = ''
): SelectionResult {
  const block = getBlockSelection(snapshot)
  const inner = block.content || fallback
  const lines = inner.split('\n')
  const text = lines.map((line) => `${prefix}${line}`).join('\n')
  const value = `${block.before}${text}${block.after}`
  const prefixDelta = prefix.length
  const lineCount = lines.length

  return {
    value,
    start: block.before.length + block.startOffset + prefixDelta,
    end: block.before.length + block.endOffset + prefixDelta * lineCount
  }
}

export function outdentLines(snapshot: SelectionSnapshot, indent = '  '): SelectionResult {
  const block = getBlockSelection(snapshot)
  const originalLines = block.content.split('\n')
  const adjustedLines = originalLines.map((line) => {
    if (line.startsWith(indent)) {
      return line.slice(indent.length)
    }

    if (line.startsWith('\t')) {
      return line.slice(1)
    }

    return line
  })
  const value = `${block.before}${adjustedLines.join('\n')}${block.after}`

  return {
    value,
    start: block.before.length,
    end: block.before.length + adjustedLines.join('\n').length
  }
}

export function prependInline(
  snapshot: SelectionSnapshot,
  prefix: string,
  fallback = ''
): SelectionResult {
  const selected = snapshot.value.slice(snapshot.start, snapshot.end) || fallback
  const text = `${prefix}${selected}`

  if (snapshot.start === snapshot.end) {
    return replaceSelection(snapshot, text, prefix.length, text.length)
  }

  return replaceSelection(snapshot, text)
}
