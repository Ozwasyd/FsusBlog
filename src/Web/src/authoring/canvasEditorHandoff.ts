export type CanvasEditorTarget = Readonly<{
  articleId: number
  revision: bigint
  sourceOffset: number | null
}>

type Handoff = Readonly<{
  token: string
  target: CanvasEditorTarget
  credentialEpoch: number
  expiresAt: number
}>

export const canvasEditorHandoffKey = 'canvasEditorHandoff'
let pending: Handoff | undefined

export function offerCanvasEditorHandoff(target: CanvasEditorTarget, credentialEpoch: number): string {
  const token = crypto.randomUUID()
  pending = { token, target, credentialEpoch, expiresAt: performance.now() + 20_000 }
  return token
}

export function acceptCanvasEditorHandoff(token: unknown, articleId: number, credentialEpoch: number): CanvasEditorTarget | undefined {
  if (!pending || pending.token !== token) return
  const handoff = pending
  pending = undefined
  if (handoff.target.articleId === articleId && handoff.credentialEpoch === credentialEpoch &&
    handoff.expiresAt > performance.now()) return handoff.target
}

export function cancelCanvasEditorHandoff(token: string) {
  if (pending?.token === token) pending = undefined
}
