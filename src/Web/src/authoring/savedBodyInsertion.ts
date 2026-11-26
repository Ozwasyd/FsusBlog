import { createMarkdownSourceCoordinateMap } from '@ozwasyd/element-plus/markdown-runtime'
import type { MarkdownEditorTransactionEvent } from '@ozwasyd/element-plus'
import type { BodyEdit } from '../../../Contracts/article-body-insertion'
import { WireLimits } from '../../../Contracts/wire.generated'
import { restoreCrlf, validBoundary } from './sourceCoordinates'

export function captureBodyEdits(source: string, model: string, crlf: boolean,
  event: MarkdownEditorTransactionEvent): readonly BodyEdit[] | undefined {
  const { changes, origin } = event.transaction
  const positionMap = event.positionMap
  if (!event.accepted || origin !== 'command' || !positionMap || !changes.length ||
    changes.length > WireLimits.ArticleBodyInsertionOperations || event.revision !== event.beforeRevision + 1) return

  const coordinates = source === model ? undefined : createMarkdownSourceCoordinateMap(source)
  if (coordinates && (!crlf || coordinates.normalizedSource !== model)) return
  function rawBoundary(position: number): number | undefined {
    if (!coordinates) return position
    const candidates = coordinates.rawCaretsAtNormalized(position).filter(offset => validBoundary(source, offset))
    if (candidates.length === 1) return candidates[0]
  }
  const edits: BodyEdit[] = []
  let body = source
  let editedModel = model
  let previousEnd = -1
  let modelDelta = 0
  for (const change of changes) {
    const position = change.from + modelDelta
    // A shared start can already belong to the preceding replacement in the editor's point map.
    const boundary = change.from === previousEnd ? change.to : change.from
    if (change.from > change.to || change.from < previousEnd || (change.from === previousEnd && change.from === change.to) ||
      change.insert.includes('\0') || /\p{Surrogate}/u.test(change.insert) ||
      !validBoundary(model, change.from) || !validBoundary(model, change.to) ||
      positionMap.map(boundary, -1) !== position ||
      positionMap.map(boundary, 1) !== position + change.insert.length) return

    const from = rawBoundary(change.from)
    const to = rawBoundary(change.to)
    if (from === undefined || to === undefined || to < from) return
    const offset = from + body.length - source.length
    const removedLength = to - from
    const insert = crlf ? restoreCrlf(change.insert) : change.insert
    const next = body.slice(0, offset) + insert + body.slice(offset + removedLength)
    if (next.length > WireLimits.BodyBytes || !validBoundary(body, offset) || !validBoundary(body, offset + removedLength) ||
      !validBoundary(next, offset) || !validBoundary(next, offset + insert.length)) return
    edits.push({ offset, removedLength, insert })
    body = next
    editedModel = editedModel.slice(0, position) + change.insert + editedModel.slice(change.to + modelDelta)
    previousEnd = change.to
    modelDelta += change.insert.length - (change.to - change.from)
  }
  if (editedModel === event.value && body === (crlf ? restoreCrlf(event.value) : event.value)) return edits
}
