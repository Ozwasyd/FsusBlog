import { WireLimits } from '../../../Contracts/wire.generated.ts'

const encoder = new TextEncoder()
const invalidSurrogate = /[\uD800-\uDFFF]/u
const headerBytes = WireLimits.TitleBytes * 6 + 128
export const maxDraftMarkdownCharacters = 200_000 + headerBytes
const maxDraftMarkdownBytes = WireLimits.BodyBytes + headerBytes
const exportedHeader = /^---\nfsusFormat: fsusblog-markdown-v2\ntitle: ("[^\r\n]*")\nrevision: ([1-9][0-9]{0,18})\n---\n/
const unsupportedHeader = /^\uFEFF?---(?:\r\n|\r|\n)[ \t]*[A-Za-z][A-Za-z0-9_-]*[ \t]*:/

export type DraftMarkdown = Readonly<{ title: string; body: string }>

export function normalizeDraftTitle(title: string) {
  // Match the server's String.Trim: separator categories and the remaining Unicode white-space controls.
  return title.replace(/^[\u0009-\u000d\u0085\p{Z}]+|[\u0009-\u000d\u0085\p{Z}]+$/gu, '')
}

export function validDraftTitle(title: string) {
  const name = normalizeDraftTitle(title)
  return name.length > 0 && encoder.encode(name).length <= WireLimits.TitleBytes && !/[\x00-\x1f\x7f-\x9f]/.test(name)
}

export function validDraftBody(body: string) {
  return body.length <= 200_000 && !body.includes('\0') && encoder.encode(body).length <= WireLimits.BodyBytes
}

export async function readDraftMarkdownFile(file: File) {
  if (file.size > maxDraftMarkdownBytes)
    throw new Error('The Markdown file exceeds the draft size limit.')
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer())
  } catch {
    throw new Error('Choose a readable UTF-8 Markdown file.')
  }
}

export function parseDraftMarkdown(text: string, explicitTitle: string): DraftMarkdown {
  if (text.length > maxDraftMarkdownCharacters || invalidSurrogate.test(text))
    throw new Error('The Markdown source exceeds the size limit or contains invalid Unicode.')

  let body = text
  let title = normalizeDraftTitle(explicitTitle)
  const header = exportedHeader.exec(text.slice(0, headerBytes))
  if (header) {
    let exportedTitle: unknown
    try {
      exportedTitle = JSON.parse(header[1])
    } catch {
      throw new Error('The exported Markdown title is invalid.')
    }
    if (typeof exportedTitle !== 'string' || exportedTitle !== normalizeDraftTitle(exportedTitle) || BigInt(header[2]) > 9223372036854775807n)
      throw new Error('The exported Markdown header is invalid.')
    title = exportedTitle
    body = text.slice(header[0].length)
  } else if (unsupportedHeader.test(text)) {
    throw new Error('Use plain Markdown or a Markdown file exported by FsusBlog v2.')
  }

  if (!validDraftTitle(title) || invalidSurrogate.test(title))
    throw new Error('Enter a valid title for the draft.')
  if ((!header && !body.trim()) || !validDraftBody(body))
    throw new Error('Enter Markdown within the draft size limit without NUL characters.')
  return { title, body }
}
