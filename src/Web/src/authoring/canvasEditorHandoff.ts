export type CanvasEditorTarget = Readonly<{
  articleId: number
  revision: bigint
  sourceOffset: number | null
}>

export type SearchEditorTarget = Readonly<{
  articleId: number
  revision: bigint
  field: 'title' | 'body'
  sourceStart: number
  sourceEnd: number
  sourceByteStart: number
  sourceByteEnd: number
  sourceDigest: Uint8Array
  match: string
}>

export type EditorSourceTarget =
  | Readonly<{ kind: 'canvas'; target: CanvasEditorTarget }>
  | Readonly<{ kind: 'search'; target: SearchEditorTarget }>

type SeekGuard = Readonly<{ sessionId: number; current: () => boolean }>
export type EditorSourceSeek =
  | (SeekGuard & Readonly<{ kind: 'canvas'; revision: bigint; offset: number }>)
  | (SeekGuard & Readonly<{ kind: 'search'; target: SearchEditorTarget }>)

type Handoff = Readonly<{
  token: string
  source: EditorSourceTarget
  credentialEpoch: number
  handle?: string
  expiresAt: number
}>

// Retain the existing history state key. Its only value is an opaque, one-use token.
export const editorSourceHandoffKey = 'canvasEditorHandoff'
export const canvasEditorHandoffKey = editorSourceHandoffKey
let pending: Handoff | undefined

function offer(source: EditorSourceTarget, credentialEpoch: number, handle?: string): string {
  const token = crypto.randomUUID()
  pending = { token, source, credentialEpoch, handle, expiresAt: performance.now() + 20_000 }
  return token
}

export function offerCanvasEditorHandoff(target: CanvasEditorTarget, credentialEpoch: number): string {
  return offer({ kind: 'canvas', target }, credentialEpoch)
}

export function offerSearchEditorHandoff(target: SearchEditorTarget, credentialEpoch: number, handle: string): string {
  return offer({ kind: 'search', target: { ...target, sourceDigest: target.sourceDigest.slice() } }, credentialEpoch, handle)
}

export function acceptEditorSourceHandoff(token: unknown, articleId: number, credentialEpoch: number,
  handle?: string): EditorSourceTarget | undefined {
  if (!pending || pending.token !== token) return
  const handoff = pending
  pending = undefined
  if (handoff.credentialEpoch === credentialEpoch && handoff.source.target.articleId === articleId &&
    handoff.expiresAt > performance.now() && (handoff.handle === undefined || handoff.handle === handle)) return handoff.source
}

export function acceptCanvasEditorHandoff(token: unknown, articleId: number, credentialEpoch: number): CanvasEditorTarget | undefined {
  const source = acceptEditorSourceHandoff(token, articleId, credentialEpoch)
  if (source?.kind === 'canvas') return source.target
}

export function cancelEditorSourceHandoff(token: string) {
  if (pending?.token === token) pending = undefined
}

export const cancelCanvasEditorHandoff = cancelEditorSourceHandoff
