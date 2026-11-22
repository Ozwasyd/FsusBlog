import { encodeFrame, ProtocolError } from './aeds.ts'
import { post } from './internal/http-methods.ts'
import {
  decodeCanvasLinkPlan, decodeCanvasLinked, encodeCanvasConfirm, encodeCanvasPreview,
  FrameType, WireRoutes, type CanvasLinkPlan, type CanvasPreview,
} from './wire.generated.ts'

export function previewCanvasLink(input: CanvasPreview, host: number, target: number, signal?: AbortSignal, visualOnly = false) {
  const route = visualOnly ? `${WireRoutes.CanvasPreview}?edge=visual-only` : WireRoutes.CanvasPreview
  return post(route, FrameType.CanvasLinkPlan, bytes => {
    const plan = decodeCanvasLinkPlan(bytes)
    if (plan.canvasRevision !== input.canvasRevision || plan.hostRevision !== input.hostRevision ||
      plan.targetRevision !== input.targetRevision || plan.hostArticleId !== host || plan.targetArticleId !== target ||
      plan.sourceOffset !== input.sourceOffset || !plan.insertedMarkdown || plan.expiresAtUnixSeconds <= 0n)
      throw new ProtocolError('Canvas preview coordinates changed')
    return plan
  }, signal, encodeFrame(FrameType.CanvasPreview, encodeCanvasPreview(input)))
}

export function confirmCanvasLink(plan: CanvasLinkPlan, signal?: AbortSignal) {
  return post(WireRoutes.CanvasConfirm, FrameType.CanvasLinked, bytes => {
    const receipt = decodeCanvasLinked(bytes)
    if (receipt.planId !== plan.planId || receipt.articleId !== plan.hostArticleId ||
      receipt.canvasRevision !== plan.canvasRevision + 1n || receipt.articleRevision !== plan.hostRevision + 1n)
      throw new ProtocolError('Canvas conversion receipt coordinates changed')
    return receipt
  }, signal, encodeFrame(FrameType.CanvasConfirm, encodeCanvasConfirm({ planId: plan.planId })))
}
