function maskRange(characters, start, end) {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' '
  }
}

// Keep source offsets stable while preventing braces, attributes, and declarations
// in comments or C# string/character literals from being treated as source code.
export function maskCSharpTrivia(source) {
  const characters = source.split('')
  let index = 0
  while (index < source.length) {
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2)
      const stop = end < 0 ? source.length : end
      maskRange(characters, index, stop)
      index = stop
      continue
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2)
      const stop = end < 0 ? source.length : end + 2
      maskRange(characters, index, stop)
      index = stop
      continue
    }

    const quote = source[index]
    if (quote === '"') {
      let quoteCount = 1
      while (source[index + quoteCount] === '"') quoteCount += 1
      if (quoteCount >= 3) {
        const delimiter = '"'.repeat(quoteCount)
        const end = source.indexOf(delimiter, index + quoteCount)
        const stop = end < 0 ? source.length : end + quoteCount
        maskRange(characters, index, stop)
        index = stop
        continue
      }

      const verbatim = index > 0 && source[index - 1] === '@'
      let cursor = index + 1
      while (cursor < source.length) {
        if (verbatim && source[cursor] === '"' && source[cursor + 1] === '"') {
          cursor += 2
          continue
        }
        if (source[cursor] === '"') {
          cursor += 1
          break
        }
        if (!verbatim && source[cursor] === '\\') cursor += 2
        else cursor += 1
      }
      maskRange(characters, index, cursor)
      index = cursor
      continue
    }

    if (quote === "'") {
      let cursor = index + 1
      while (cursor < source.length) {
        if (source[cursor] === "'") {
          cursor += 1
          break
        }
        if (source[cursor] === '\\') cursor += 2
        else cursor += 1
      }
      maskRange(characters, index, cursor)
      index = cursor
      continue
    }

    index += 1
  }
  return characters.join('')
}

export function findCSharpClassDeclaration(source, className) {
  const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`\\bclass\\s+${escapedClassName}\\b`, 'u').exec(maskCSharpTrivia(source))
}

export { verifyFactWrappersAndSearchUtf8ScalarOwner } from './search-index-utf8-scalar-governance.mjs'
