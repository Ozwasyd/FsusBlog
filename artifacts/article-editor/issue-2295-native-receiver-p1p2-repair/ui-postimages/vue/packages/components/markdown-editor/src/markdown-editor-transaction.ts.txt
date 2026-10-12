import {
  createMarkdownAnchorMap,
  type MarkdownDocumentIdentity,
  type MarkdownStableProjection,
} from '../../../wasm/markdown-runtime'
import type { MarkdownHeavyFeatureDocumentAuthorityRetirementHandle, MarkdownHeavyFeatureDocumentAuthorityTicket } from '../../../hooks/use-markdown-heavy-feature-lifecycle'

export type MarkdownEditorSelectionDirection = 'backward' | 'forward' | 'none'

export interface MarkdownEditorSelection {
  readonly direction?: MarkdownEditorSelectionDirection
  readonly end: number
  readonly start: number
}

/** Snapshot of textarea state captured on beforeinput for merge/history. */
export interface BeforeInputSnapshot {
  readonly data: string | null
  readonly inputType: string
  readonly selection: MarkdownEditorSelection
  readonly value: string
}

export interface MarkdownEditorResolvedSelection extends MarkdownEditorSelection {
  readonly direction: MarkdownEditorSelectionDirection
}

export interface MarkdownEditorChange {
  readonly from: number
  readonly insert: string
  readonly to: number
}

export type MarkdownEditorTransactionOrigin =
  | 'input'
  | 'command'
  | 'paste'
  | 'drop'
  | 'programmatic'
  | 'external'

export type MarkdownEditorHistoryMode = 'merge' | 'separate' | 'skip'

export interface MarkdownEditorTransaction {
  readonly changes: readonly MarkdownEditorChange[]
  readonly documentIdentity?: MarkdownEditorDocumentIdentity
  readonly expectedRevision?: number
  readonly externalUpdate?: MarkdownEditorExternalUpdatePolicy
  readonly history: MarkdownEditorHistoryMode
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly origin: MarkdownEditorTransactionOrigin
  readonly selection?: MarkdownEditorSelection
}

export type MarkdownEditorExternalUpdatePolicy = 'rebase' | 'reset'

export type MarkdownEditorTransactionRejection =
  | 'disabled'
  | 'composition-active'
  | 'document-mismatch'
  | 'invalid-change'
  | 'invalid-external-update'
  | 'invalid-selection'
  | 'no-history'
  | 'stale-revision'

export interface MarkdownEditorHistoryState {
  readonly canRedo: boolean
  readonly canUndo: boolean
  readonly redoDepth: number
  readonly retainedUnits: number
  readonly undoDepth: number
}

export interface MarkdownEditorDispatchResult {
  readonly accepted: boolean
  readonly beforeRevision: number
  readonly documentIdentity: MarkdownEditorDocumentIdentity
  readonly history: MarkdownEditorHistoryState
  readonly positionMap?: MarkdownEditorPositionMap
  readonly reason?: MarkdownEditorTransactionRejection
  readonly revision: number
  readonly selection: MarkdownEditorResolvedSelection
  readonly value: string
}

export interface MarkdownEditorTransactionEvent extends MarkdownEditorDispatchResult {
  readonly transaction: MarkdownEditorTransaction
}

/** A stable identity for a document; callers must replace it on document switch. */
export interface MarkdownEditorDocumentIdentity {
  readonly epoch: number
  readonly id: string
}

export interface MarkdownEditorCommandAnchor {
  readonly end: number
  readonly start: number
}

export type MarkdownEditorPositionAssociation = -1 | 1

export interface MarkdownEditorMappedRange {
  readonly deleted: boolean
  readonly partiallyDeleted: boolean
  readonly range?: MarkdownEditorCommandAnchor
}

export type MarkdownEditorRebasedAnchor =
  | {
      readonly end: number
      readonly start: number
      readonly status: 'mapped' | 'partial'
    }
  | { readonly status: 'deleted' }

/** Maps command anchors through committed transactions without exposing editor internals. */
export interface MarkdownEditorPositionMap {
  map(offset: number, association: MarkdownEditorPositionAssociation): number
  mapRange(range: MarkdownEditorCommandAnchor): MarkdownEditorMappedRange
  rebase(anchor: MarkdownEditorCommandAnchor): MarkdownEditorRebasedAnchor
}

export interface MarkdownEditorPositionMapOptions {
  readonly documentIdentity?: MarkdownDocumentIdentity
  readonly projection?: MarkdownStableProjection
  readonly source?: string
}

const mapMarkdownEditorOffset = (
  changes: readonly MarkdownEditorChange[],
  offset: number,
  association: MarkdownEditorPositionAssociation,
) => {
  let delta = 0
  for (const change of changes) {
    if (offset < change.from) break
    if (offset > change.to) {
      delta += change.insert.length - (change.to - change.from)
      continue
    }
    if (change.from === change.to) {
      if (association < 0) return change.from + delta
      delta += change.insert.length
      continue
    }
    return change.from + delta + (association > 0 ? change.insert.length : 0)
  }
  return offset + delta
}

export const createMarkdownEditorPositionMap = (
  changes: readonly MarkdownEditorChange[],
  options: MarkdownEditorPositionMapOptions = {},
): MarkdownEditorPositionMap => {
  const frozenChanges = cloneChanges(changes)
  const mapRange = (
    range: MarkdownEditorCommandAnchor,
  ): MarkdownEditorMappedRange => {
    if (
      !isFiniteInteger(range.start) ||
      !isFiniteInteger(range.end) ||
      range.start < 0 ||
      range.end < range.start
    ) {
      return Object.freeze({ deleted: true, partiallyDeleted: false })
    }

    let deletedUnits = 0
    for (const change of frozenChanges) {
      const overlapStart = Math.max(range.start, change.from)
      const overlapEnd = Math.min(range.end, change.to)
      if (overlapEnd > overlapStart) deletedUnits += overlapEnd - overlapStart
    }
    const length = range.end - range.start
    const deleted = length > 0 && deletedUnits >= length
    const partiallyDeleted =
      length > 0 && deletedUnits > 0 && deletedUnits < length
    if (deleted) {
      return Object.freeze({ deleted: true, partiallyDeleted: false })
    }

    const start = mapMarkdownEditorOffset(frozenChanges, range.start, -1)
    const end = mapMarkdownEditorOffset(frozenChanges, range.end, 1)
    return Object.freeze({
      deleted: false,
      partiallyDeleted,
      range: Object.freeze({ end: Math.max(start, end), start }),
    })
  }
  const maximumOffset = changes.reduce(
    (maximum, change) => Math.max(maximum, change.from, change.to),
    0,
  )
  // Without a real source the anchor map still needs a length that covers the
  // pre-change document implied by the changes and every post-change anchor,
  // mirroring the synthetic fallback in rebaseMarkdownAttachmentJob.
  const syntheticLength = [...changes]
    .sort((left, right) => left.from - right.from || left.to - right.to)
    .reduce(
      (length, change) =>
        Math.max(change.to + 1, length + change.insert.length) -
        (change.to - change.from),
      Math.max(maximumOffset + 1, 1),
    )
  const originalSource =
    options.source ?? '\u0000'.repeat(Math.max(syntheticLength, maximumOffset + 1, 1))
  const identity = options.documentIdentity ?? {
    id: 'markdown-position-map',
    epoch: 0,
  }
  const orderedChanges = [...changes].sort(
    (left, right) => left.from - right.from || left.to - right.to,
  )

  return Object.freeze({
    map(offset: number, association: MarkdownEditorPositionAssociation) {
      if (!isFiniteInteger(offset) || offset < 0) {
        throw new RangeError(
          'position map offset must be a non-negative integer',
        )
      }
      if (association !== -1 && association !== 1) {
        throw new RangeError('position map association must be -1 or 1')
      }
      return mapMarkdownEditorOffset(frozenChanges, offset, association)
    },
    mapRange,
    rebase(anchor: MarkdownEditorCommandAnchor) {
      let source = originalSource
      let current = Object.freeze({
        start: anchor.start,
        end: anchor.end,
      })
      let status: 'mapped' | 'partial' = 'mapped'
      let delta = 0

      for (const [index, change] of orderedChanges.entries()) {
        const from = change.from + delta
        const to = change.to + delta
        const anchorMap = createMarkdownAnchorMap({
          identity,
          source,
          ...(index === 0 && options.projection
            ? { projection: options.projection }
            : {}),
        })
        const remapped = anchorMap.remapRange(current, {
          ...(from === to ? {} : { delete: [from, to] as const }),
          ...(change.insert
            ? { insert: { at: from, text: change.insert } }
            : {}),
        })
        if (remapped.status === 'deleted') {
          return Object.freeze({ status: 'deleted' as const })
        }
        if (remapped.status === 'partial') status = 'partial'
        current = remapped.range
        source = source.slice(0, from) + change.insert + source.slice(to)
        delta += change.insert.length - (change.to - change.from)
      }

      return Object.freeze({
        start: current.start,
        end: current.end,
        status,
      })
    },
  })
}

export const composeMarkdownEditorPositionMapInstances = (
  maps: readonly MarkdownEditorPositionMap[],
): MarkdownEditorPositionMap => {
  const frozenMaps = Object.freeze([...maps])
  return Object.freeze({
    map(offset: number, association: MarkdownEditorPositionAssociation) {
      return frozenMaps.reduce(
        (mapped, positionMap) => positionMap.map(mapped, association),
        offset,
      )
    },
    mapRange(range: MarkdownEditorCommandAnchor) {
      let mapped: MarkdownEditorMappedRange = Object.freeze({
        deleted: false,
        partiallyDeleted: false,
        range: Object.freeze({ ...range }),
      })
      for (const positionMap of frozenMaps) {
        if (!mapped.range) return mapped
        const next = positionMap.mapRange(mapped.range)
        mapped = Object.freeze({
          deleted: mapped.deleted || next.deleted,
          partiallyDeleted: mapped.partiallyDeleted || next.partiallyDeleted,
          range: next.range,
        })
      }
      return mapped
    },
    rebase(anchor: MarkdownEditorCommandAnchor) {
      let current: MarkdownEditorRebasedAnchor = {
        ...anchor,
        status: 'mapped',
      }
      let partial = false
      for (const positionMap of frozenMaps) {
        if (current.status === 'deleted') return current
        current = positionMap.rebase(current)
        if (current.status === 'partial') partial = true
      }
      if (current.status === 'deleted') return current
      return Object.freeze({
        start: current.start,
        end: current.end,
        status: partial ? ('partial' as const) : ('mapped' as const),
      })
    },
  })
}

export const composeMarkdownEditorPositionMaps = (
  stages: readonly (readonly MarkdownEditorChange[])[],
): MarkdownEditorPositionMap =>
  composeMarkdownEditorPositionMapInstances(
    stages.map((changes) => createMarkdownEditorPositionMap(changes)),
  )

export interface MarkdownEditorTransactionDispatcher {
  dispatch(transaction: MarkdownEditorTransaction): MarkdownEditorDispatchResult
}

export interface MarkdownEditorSelectionEvent {
  /** Always captured by the editor; optional for legacy event-object compatibility. */
  readonly documentIdentity?: MarkdownEditorDocumentIdentity
  readonly revision: number
  readonly selection: MarkdownEditorResolvedSelection
}

export type MarkdownEditorInputMergeDirection = 'backward' | 'forward' | 'none'

export interface MarkdownEditorDispatchContext {
  readonly mergeDirection?: MarkdownEditorInputMergeDirection
  readonly now?: number
}

interface AppliedChanges {
  readonly inverse: readonly MarkdownEditorChange[]
  readonly value: string
}

interface HistoryStep {
  readonly changes: readonly MarkdownEditorChange[]
  readonly inverse: readonly MarkdownEditorChange[]
}

interface HistoryEntry {
  readonly afterSelection: MarkdownEditorResolvedSelection
  readonly beforeSelection: MarkdownEditorResolvedSelection
  readonly history: Exclude<MarkdownEditorHistoryMode, 'skip'>
  readonly mergeDirection: MarkdownEditorInputMergeDirection
  readonly origin: MarkdownEditorTransactionOrigin
  readonly retainedUnits: number
  readonly steps: readonly HistoryStep[]
  readonly timestamp: number
}

/** Opaque checkpoint retained by the sole transaction/history owner. */
export interface MarkdownEditorRetainedTransactionSnapshot {
  readonly documentIdentity: MarkdownEditorDocumentIdentity
  readonly history: MarkdownEditorHistoryState
  readonly revision: number
  readonly selection: MarkdownEditorResolvedSelection
}

/** Pending metadata only; original history arrays remain in this transaction owner. */
export interface MarkdownEditorRetainedTransactionPreparation {
  readonly snapshot: MarkdownEditorRetainedTransactionSnapshot
}

interface MarkdownEditorStoreMutation extends MarkdownEditorDispatchResult {
  readonly historyChanged: boolean
  readonly selectionChanged: boolean
  readonly valueChanged: boolean
}

const HISTORY_ENTRY_LIMIT = 100
const HISTORY_RETAINED_UNIT_LIMIT = 1_000_000
const INPUT_MERGE_WINDOW_MS = 1000

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined

const isFiniteInteger = (value: number) =>
  Number.isFinite(value) && Number.isInteger(value)

const isSplitSurrogateBoundary = (value: string, offset: number) => {
  if (offset <= 0 || offset >= value.length) return false
  const previous = value.charCodeAt(offset - 1)
  const next = value.charCodeAt(offset)
  return (
    previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
  )
}

const fallbackGraphemeBoundaries = (value: string) => {
  const boundaries = [0]
  for (let offset = 1; offset < value.length; offset += 1) {
    if (!isSplitSurrogateBoundary(value, offset)) boundaries.push(offset)
  }
  boundaries.push(value.length)
  return boundaries
}

const graphemeBoundaries = (value: string) => {
  if (!segmenter) return fallbackGraphemeBoundaries(value)
  const boundaries = [0]
  for (const segment of segmenter.segment(value)) {
    if (segment.index > 0) boundaries.push(segment.index)
  }
  if (boundaries.at(-1) !== value.length) boundaries.push(value.length)
  return boundaries
}

const clampOffset = (value: string, offset: number) => {
  if (!Number.isFinite(offset)) return 0
  return Math.max(0, Math.min(value.length, Math.trunc(offset)))
}

const snapOffset = (
  value: string,
  offset: number,
  affinity: 'nearest' | 'start' | 'end',
) => {
  const clamped = clampOffset(value, offset)
  const boundaries = graphemeBoundaries(value)
  let previous = 0
  for (const boundary of boundaries) {
    if (boundary === clamped) return boundary
    if (boundary > clamped) {
      if (affinity === 'start') return previous
      if (affinity === 'end') return boundary
      return clamped - previous <= boundary - clamped ? previous : boundary
    }
    previous = boundary
  }
  return value.length
}

const isSelectionDirection = (
  direction: unknown,
): direction is MarkdownEditorSelectionDirection =>
  direction === 'backward' || direction === 'forward' || direction === 'none'

export const normalizeMarkdownEditorSelection = (
  value: string,
  selection: MarkdownEditorSelection,
): MarkdownEditorResolvedSelection | undefined => {
  const direction = selection.direction ?? 'none'
  if (
    !isFiniteInteger(selection.start) ||
    !isFiniteInteger(selection.end) ||
    selection.start > selection.end ||
    !isSelectionDirection(direction)
  ) {
    return undefined
  }

  if (selection.start === selection.end) {
    const caret = snapOffset(value, selection.start, 'nearest')
    return {
      direction,
      end: caret,
      start: caret,
    }
  }

  return {
    direction,
    end: snapOffset(value, selection.end, 'end'),
    start: snapOffset(value, selection.start, 'start'),
  }
}

const cloneSelection = (
  selection: MarkdownEditorSelection,
): MarkdownEditorResolvedSelection =>
  Object.freeze({
    direction: selection.direction ?? 'none',
    end: selection.end,
    start: selection.start,
  })

const cloneChanges = (changes: readonly MarkdownEditorChange[]) =>
  Object.freeze(
    changes.map((change) =>
      Object.freeze({
        from: change.from,
        insert: change.insert,
        to: change.to,
      }),
    ),
  )

export const validateMarkdownEditorChanges = (
  value: string,
  changes: readonly MarkdownEditorChange[],
) => {
  let previousTo = 0
  for (const [index, change] of changes.entries()) {
    if (
      !isFiniteInteger(change.from) ||
      !isFiniteInteger(change.to) ||
      typeof change.insert !== 'string' ||
      change.from < 0 ||
      change.to < change.from ||
      change.to > value.length ||
      (index > 0 && change.from < previousTo) ||
      isSplitSurrogateBoundary(value, change.from) ||
      isSplitSurrogateBoundary(value, change.to)
    ) {
      return false
    }
    previousTo = change.to
  }
  return true
}

export const applyMarkdownEditorChanges = (
  value: string,
  changes: readonly MarkdownEditorChange[],
): AppliedChanges | undefined => {
  if (!validateMarkdownEditorChanges(value, changes)) return undefined

  let cursor = 0
  let delta = 0
  const output: string[] = []
  const inverse: MarkdownEditorChange[] = []

  for (const change of changes) {
    output.push(value.slice(cursor, change.from), change.insert)
    const deleted = value.slice(change.from, change.to)
    const inverseFrom = change.from + delta
    inverse.push({
      from: inverseFrom,
      insert: deleted,
      to: inverseFrom + change.insert.length,
    })
    delta += change.insert.length - (change.to - change.from)
    cursor = change.to
  }
  output.push(value.slice(cursor))

  return {
    inverse: cloneChanges(inverse),
    value: output.join(''),
  }
}

export { deriveMarkdownEditorChange } from '../../../wasm/markdown-syntax-identity'

const selectionsEqual = (
  first: MarkdownEditorResolvedSelection,
  second: MarkdownEditorResolvedSelection,
) =>
  first.start === second.start &&
  first.end === second.end &&
  first.direction === second.direction

const retainedUnitsFor = (
  changes: readonly MarkdownEditorChange[],
  inverse: readonly MarkdownEditorChange[],
) =>
  changes.reduce((total, change) => total + change.insert.length, 0) +
  inverse.reduce((total, change) => total + change.insert.length, 0)

const isCollapsed = (selection: MarkdownEditorResolvedSelection) =>
  selection.start === selection.end

const isMergeAdjacent = (
  previous: HistoryEntry,
  changes: readonly MarkdownEditorChange[],
  beforeSelection: MarkdownEditorResolvedSelection,
  afterSelection: MarkdownEditorResolvedSelection,
  direction: MarkdownEditorInputMergeDirection,
) => {
  if (
    direction === 'none' ||
    previous.mergeDirection !== direction ||
    changes.length !== 1 ||
    !isCollapsed(previous.afterSelection) ||
    !isCollapsed(beforeSelection) ||
    !isCollapsed(afterSelection) ||
    !selectionsEqual(previous.afterSelection, beforeSelection)
  ) {
    return false
  }

  const [change] = changes
  if (direction === 'backward') {
    return change.insert === '' && change.to === beforeSelection.start
  }
  return change.from === beforeSelection.start
}

const freezeTransaction = (
  transaction: MarkdownEditorTransaction,
): MarkdownEditorTransaction =>
  Object.freeze({
    changes: cloneChanges(transaction.changes),
    documentIdentity: transaction.documentIdentity
      ? Object.freeze({ ...transaction.documentIdentity })
      : undefined,
    expectedRevision: transaction.expectedRevision,
    externalUpdate: transaction.externalUpdate,
    history: transaction.history,
    metadata: transaction.metadata
      ? Object.freeze({ ...transaction.metadata })
      : undefined,
    origin: transaction.origin,
    selection: transaction.selection
      ? cloneSelection(transaction.selection)
      : undefined,
  })

interface DocumentAuthorityRetirementRegistration {
  receiver: (() => void) | undefined
  previous: DocumentAuthorityRetirementRegistration | undefined
  next: DocumentAuthorityRetirementRegistration | undefined
  registered: boolean
  releasing: boolean
  releaseFailed: boolean
  failed: boolean
  cause: unknown
}

export class MarkdownEditorTransactionStore {
  #documentIdentity: MarkdownEditorDocumentIdentity
  #documentAuthorityGeneration = 0
  #documentAuthorityRetired = false
  #documentWriteDepth = 0
  #capturingDocumentAuthority = false
  #documentAuthority: MarkdownHeavyFeatureDocumentAuthorityTicket | undefined
  #retirementReceivers: DocumentAuthorityRetirementRegistration | undefined
  #notifyingRetirement = false
  #registeringRetirement = false
  #releasingRetirement = 0
  #preparedRetainedSnapshot: {
    readonly preparation: MarkdownEditorRetainedTransactionPreparation
    readonly identity: MarkdownEditorDocumentIdentity
    readonly revision: number
    readonly selection: MarkdownEditorResolvedSelection
    readonly undo: readonly HistoryEntry[]
    readonly redo: readonly HistoryEntry[]
    readonly previous: MarkdownEditorRetainedTransactionSnapshot | undefined
    readonly mergeBlocked: boolean
    readonly authorityGeneration: number
    allocatedHistory: readonly HistoryEntry[] | undefined
    allocatedRedo: readonly HistoryEntry[] | undefined
  } | undefined
  #retainedSnapshot: MarkdownEditorRetainedTransactionSnapshot | undefined
  #retainedHistory: readonly HistoryEntry[] | undefined
  #retainedRedo: readonly HistoryEntry[] | undefined
  #mergeBlocked = false
  #redo: HistoryEntry[] = []
  #revision = 0
  #selection: MarkdownEditorResolvedSelection
  #undo: HistoryEntry[] = []
  #value: string

  constructor(
    value: string,
    selection?: MarkdownEditorSelection,
    documentIdentity: MarkdownEditorDocumentIdentity = {
      epoch: 0,
      id: 'anonymous',
    },
  ) {
    this.#documentIdentity = Object.freeze({ ...documentIdentity })
    this.#value = value
    this.#selection = normalizeMarkdownEditorSelection(
      value,
      selection ?? {
        direction: 'none',
        end: value.length,
        start: value.length,
      },
    ) ?? {
      direction: 'none',
      end: value.length,
      start: value.length,
    }
  }

  get revision() {
    return this.#revision
  }

  /** Same original transaction owner; one immutable live ticket per actual write generation. */
  captureDocumentAuthority(): MarkdownHeavyFeatureDocumentAuthorityTicket | null {
    if (this.#documentAuthorityRetired || this.#documentWriteDepth || this.#capturingDocumentAuthority ||
        this.#notifyingRetirement || this.#registeringRetirement || this.#releasingRetirement) return null
    if (this.#documentAuthority) return this.#documentAuthority
    const generation = this.#documentAuthorityGeneration
    const identity = this.#documentIdentity
    const revision = this.#revision
    this.#capturingDocumentAuthority = true
    try {
      const ticket: MarkdownHeavyFeatureDocumentAuthorityTicket = Object.freeze({
        scope: 'native-transaction-document', documentKey: identity.id, documentEpoch: identity.epoch, revision,
      })
      if (this.#documentAuthorityRetired || this.#documentWriteDepth || this.#documentAuthorityGeneration !== generation ||
          this.#documentIdentity !== identity || this.#revision !== revision) return null
      this.#documentAuthority = ticket
      return ticket
    } finally {
      this.#capturingDocumentAuthority = false
    }
  }

  hasDocumentAuthorityCustody(ticket: MarkdownHeavyFeatureDocumentAuthorityTicket): boolean {
    return !this.#documentAuthorityRetired && this.#documentWriteDepth === 0 && !this.#capturingDocumentAuthority &&
      !this.#notifyingRetirement && !this.#registeringRetirement && this.#releasingRetirement === 0 &&
      this.#documentAuthority !== undefined && this.#documentAuthority === ticket
  }

  subscribeDocumentAuthorityRetirement(receiver: () => void): MarkdownHeavyFeatureDocumentAuthorityRetirementHandle {
    if (typeof receiver !== 'function') throw new TypeError('editor-document-retirement-receiver-invalid')
    if (this.#documentAuthorityRetired || this.#documentWriteDepth || this.#notifyingRetirement || this.#registeringRetirement || this.#releasingRetirement)
      throw new Error('editor-document-retirement-registration-unavailable')
    const generation = this.#documentAuthorityGeneration
    this.#registeringRetirement = true
    try {
      const record: DocumentAuthorityRetirementRegistration = {
        receiver, previous: undefined, next: undefined, registered: false, releasing: false, releaseFailed: false, failed: false, cause: undefined,
      }
      const handle: MarkdownHeavyFeatureDocumentAuthorityRetirementHandle = Object.freeze({
        unsubscribe: () => this.#unsubscribeDocumentAuthorityRetirement(record),
        hasCustody: () => record.registered,
        failureCause: () => record.cause,
      })
      if (this.#documentAuthorityRetired || this.#documentWriteDepth || this.#notifyingRetirement ||
          this.#documentAuthorityGeneration !== generation)
        throw new Error('editor-document-retirement-registration-stale')
      record.next = this.#retirementReceivers
      if (record.next) record.next.previous = record
      this.#retirementReceivers = record
      record.registered = true
      return handle
    } finally {
      this.#registeringRetirement = false
    }
  }

  #failDocumentAuthorityRegistration(record: DocumentAuthorityRetirementRegistration, cause: unknown): void {
    record.failed = true
    record.cause = cause
    if (record.releasing) record.releaseFailed = true
    this.#documentAuthorityRetired = true
    this.#documentAuthority = undefined
  }

  #unsubscribeDocumentAuthorityRetirement(record: DocumentAuthorityRetirementRegistration): boolean {
    if (!record.registered) return false
    if (this.#notifyingRetirement || record.releasing) {
      const cause = new Error('editor-document-retirement-release-active')
      this.#failDocumentAuthorityRegistration(record, cause)
      throw cause
    }
    record.releaseFailed = false
    record.releasing = true
    this.#releasingRetirement += 1
    try {
      record.receiver!()
      if (record.releaseFailed) throw record.cause
      // Only original private pointer assignments follow successful receiver retirement.
      if (record.previous) record.previous.next = record.next
      else this.#retirementReceivers = record.next
      if (record.next) record.next.previous = record.previous
      record.registered = false
      record.receiver = undefined
      record.previous = undefined
      record.next = undefined
      record.failed = false
      record.cause = undefined
      return true
    } catch (cause) {
      this.#failDocumentAuthorityRegistration(record, cause)
      throw cause
    } finally {
      this.#releasingRetirement -= 1
      record.releasing = false
    }
  }

  #notifyDocumentAuthorityRetirement(): void {
    if (this.#notifyingRetirement) throw new Error('editor-document-retirement-notification-active')
    this.#notifyingRetirement = true
    let failed = false
    let firstCause: unknown
    try {
      for (let record = this.#retirementReceivers; record; record = record.next) {
        try {
          if (record.releasing) throw new Error('editor-document-retirement-release-active')
          record.receiver!()
          // A receiver can catch its own failed unsubscribe; retain and propagate that real cause too.
          if (record.failed) {
            if (!failed) firstCause = record.cause
            failed = true
          }
        } catch (cause) {
          this.#failDocumentAuthorityRegistration(record, cause)
          if (!failed) firstCause = cause
          failed = true
        }
      }
    } finally {
      this.#notifyingRetirement = false
    }
    if (failed) throw firstCause
  }

  /** Actual original unmount retirement; no cleanup/disposal success assertion. */
  retireDocumentAuthority(): void {
    this.#documentAuthorityRetired = true
    this.#documentAuthority = undefined
    this.#notifyDocumentAuthorityRetirement()
  }

  #beginDocumentWrite(): void {
    if (this.#notifyingRetirement || this.#releasingRetirement)
      throw new Error('editor-document-retirement-notification-active')
    const outermost = this.#documentWriteDepth === 0
    // Close authority before touching caller arguments, getters, arrays or callback-bearing work.
    if (outermost) {
      this.#documentAuthority = undefined
      if (this.#documentAuthorityGeneration === Number.MAX_SAFE_INTEGER) this.#documentAuthorityRetired = true
      else this.#documentAuthorityGeneration += 1
    }
    this.#documentWriteDepth += 1
    if (!outermost) return
    try {
      this.#notifyDocumentAuthorityRetirement()
    } catch (cause) {
      this.#documentWriteDepth -= 1
      throw cause
    }
  }

  #endDocumentWrite(): void {
    this.#documentWriteDepth -= 1
  }

  get selection() {
    return cloneSelection(this.#selection)
  }

  get value() {
    return this.#value
  }

  get history(): MarkdownEditorHistoryState {
    const entries = [...this.#undo, ...this.#redo]
    return Object.freeze({
      canRedo: this.#redo.length > 0,
      canUndo: this.#undo.length > 0,
      redoDepth: this.#redo.length,
      retainedUnits: entries.reduce(
        (total, entry) => total + entry.retainedUnits,
        0,
      ),
      undoDepth: this.#undo.length,
    })
  }

  get retainedSessionUnits() {
    const entries = new Set([
      ...this.#undo, ...this.#redo,
      ...(this.#retainedHistory ?? []), ...(this.#retainedRedo ?? []),
    ])
    return [...entries].reduce((total, entry) => total + entry.retainedUnits, 0)
  }

  get documentIdentity() {
    return Object.freeze({ ...this.#documentIdentity })
  }

  retainSnapshot(): MarkdownEditorRetainedTransactionSnapshot {
    if (this.#documentAuthorityRetired || this.#documentWriteDepth) throw new Error('editor-history-document-authority-unavailable')
    if (this.#preparedRetainedSnapshot) throw new Error('editor-history-snapshot-preparation-pending')
    const snapshot = Object.freeze({
      documentIdentity: this.documentIdentity,
      history: this.history,
      revision: this.#revision,
      selection: this.selection,
    })
    // History entries are immutable. Only this store retains and restores them;
    // consumers receive neither the source nor the undo/redo entries.
    this.#retainedSnapshot = snapshot
    this.#retainedHistory = this.#undo.slice()
    this.#retainedRedo = this.#redo.slice()
    return snapshot
  }

  prepareRetainedSnapshot(): MarkdownEditorRetainedTransactionPreparation {
    if (this.#documentAuthorityRetired || this.#documentWriteDepth) throw new Error('editor-history-document-authority-unavailable')
    if (this.#preparedRetainedSnapshot) throw new Error('editor-history-snapshot-preparation-pending')
    const authorityGeneration = this.#documentAuthorityGeneration
    const snapshot = Object.freeze({
      documentIdentity: this.documentIdentity,
      history: this.history,
      revision: this.#revision,
      selection: Object.freeze(this.selection),
    })
    const preparation = Object.freeze({ snapshot })
    if (this.#documentAuthorityRetired || this.#documentWriteDepth || this.#documentAuthorityGeneration !== authorityGeneration)
      throw new Error('editor-history-document-authority-changed')
    this.#preparedRetainedSnapshot = {
      preparation, identity: this.#documentIdentity, revision: this.#revision,
      selection: this.#selection, undo: this.#undo, redo: this.#redo,
      previous: this.#retainedSnapshot, mergeBlocked: this.#mergeBlocked,
      authorityGeneration,
      allocatedHistory: undefined, allocatedRedo: undefined,
    }
    return preparation
  }

  /** Callback-free private slot and original live-history continuity check. */
  validatePreparedRetainedSnapshot(preparation: MarkdownEditorRetainedTransactionPreparation): boolean {
    return this.#isPreparedRetainedSnapshotCurrent(preparation)
  }

  #isPreparedRetainedSnapshotCurrent(preparation: MarkdownEditorRetainedTransactionPreparation): boolean {
    const custody = this.#preparedRetainedSnapshot
    return custody !== undefined && custody.preparation === preparation && this.#documentIdentity === custody.identity &&
      !this.#documentAuthorityRetired && this.#documentWriteDepth === 0 && this.#documentAuthorityGeneration === custody.authorityGeneration &&
      !this.#notifyingRetirement && !this.#registeringRetirement && this.#releasingRetirement === 0 &&
      this.#revision === custody.revision && this.#selection === custody.selection &&
      this.#undo === custody.undo && this.#redo === custody.redo && this.#retainedSnapshot === custody.previous &&
      this.#mergeBlocked === custody.mergeBlocked
  }

  allocatePreparedRetainedSnapshot(preparation: MarkdownEditorRetainedTransactionPreparation): boolean {
    if (!this.#isPreparedRetainedSnapshotCurrent(preparation)) return false
    const custody = this.#preparedRetainedSnapshot!
    const history = custody.undo.slice()
    const redo = custody.redo.slice()
    if (!this.#isPreparedRetainedSnapshotCurrent(preparation)) return false
    custody.allocatedHistory = history
    custody.allocatedRedo = redo
    return true
  }

  commitPreparedRetainedSnapshot(preparation: MarkdownEditorRetainedTransactionPreparation): MarkdownEditorRetainedTransactionSnapshot | null {
    if (!this.#isPreparedRetainedSnapshotCurrent(preparation)) return null
    const custody = this.#preparedRetainedSnapshot!
    if (!custody.allocatedHistory || !custody.allocatedRedo) return null
    // Allocation and the session's final full owner guard are already complete.
    // Only callback-free private checks and assignments follow this boundary.
    this.#retainedSnapshot = preparation.snapshot
    this.#retainedHistory = custody.allocatedHistory
    this.#retainedRedo = custody.allocatedRedo
    this.#preparedRetainedSnapshot = undefined
    return preparation.snapshot
  }

  discardPreparedRetainedSnapshot(preparation: MarkdownEditorRetainedTransactionPreparation): boolean {
    if (!this.#preparedRetainedSnapshot || this.#preparedRetainedSnapshot.preparation !== preparation) return false
    this.#preparedRetainedSnapshot = undefined
    return true
  }

  /** Read only this store's actual bounded token/history custody; never restore or retain. */
  validateRetainedSnapshot(snapshot: MarkdownEditorRetainedTransactionSnapshot): boolean {
    return snapshot === this.#retainedSnapshot &&
      snapshot.documentIdentity.id === this.#documentIdentity.id &&
      snapshot.documentIdentity.epoch === this.#documentIdentity.epoch &&
      snapshot.revision === this.#revision &&
      this.#retainedHistory !== undefined && this.#retainedRedo !== undefined
  }

  restoreRetainedSnapshot(snapshot: MarkdownEditorRetainedTransactionSnapshot) {
    this.#beginDocumentWrite()
    try {
      if (
        snapshot !== this.#retainedSnapshot ||
        snapshot.documentIdentity.id !== this.#documentIdentity.id ||
        snapshot.documentIdentity.epoch !== this.#documentIdentity.epoch ||
        snapshot.revision !== this.#revision ||
        !this.#retainedHistory ||
        !this.#retainedRedo
      ) {
        return false
      }
      this.#undo = [...this.#retainedHistory]
      this.#redo = [...this.#retainedRedo]
      this.#selection = snapshot.selection
      // A resumed session must never merge into input preceding suspension.
      this.breakMergeGroup()
      return true
    } finally {
      this.#endDocumentWrite()
    }
  }

  releaseRetainedSnapshot() {
    this.#beginDocumentWrite()
    try {
      this.#preparedRetainedSnapshot = undefined
      this.#retainedSnapshot = undefined
      this.#retainedHistory = undefined
      this.#retainedRedo = undefined
    } finally {
      this.#endDocumentWrite()
    }
  }

  switchDocument(
    documentIdentity: MarkdownEditorDocumentIdentity,
    value: string,
    selection?: MarkdownEditorSelection,
  ) {
    this.#beginDocumentWrite()
    try {
      this.releaseRetainedSnapshot()
      this.#documentIdentity = Object.freeze({ ...documentIdentity })
      this.#value = value
      this.#selection = normalizeMarkdownEditorSelection(
        value,
        selection ?? {
          direction: 'none',
          end: value.length,
          start: value.length,
        },
      ) ?? {
        direction: 'none',
        end: value.length,
        start: value.length,
      }
      this.#revision = 0
      this.#undo = []
      this.#redo = []
      this.#mergeBlocked = true
    } finally {
      this.#endDocumentWrite()
    }
  }

  breakMergeGroup() {
    this.#beginDocumentWrite()
    try {
      this.#mergeBlocked = true
    } finally {
      this.#endDocumentWrite()
    }
  }

  reset(
    value: string,
    selection?: MarkdownEditorSelection,
  ): MarkdownEditorStoreMutation {
    this.#beginDocumentWrite()
    try {
      const beforeSelection = this.selection
      const nextSelection = normalizeMarkdownEditorSelection(
        value,
        selection ?? {
          direction: 'none',
          end: value.length,
          start: value.length,
        },
      ) ?? {
        direction: 'none' as const,
        end: value.length,
        start: value.length,
      }
      const historyChanged = this.#undo.length > 0 || this.#redo.length > 0
      const selectionChanged = !selectionsEqual(beforeSelection, nextSelection)
      const valueChanged = this.#value !== value

      this.#value = value
      this.#selection = nextSelection
      this.#undo = []
      this.#redo = []
      this.#revision += 1
      this.breakMergeGroup()

      return Object.freeze({
        ...this.#result(true),
        historyChanged,
        selectionChanged,
        valueChanged,
      })
    } finally {
      this.#endDocumentWrite()
    }
  }

  setSelection(selection: MarkdownEditorSelection, breakMerge = true) {
    this.#beginDocumentWrite()
    try {
      const normalized = normalizeMarkdownEditorSelection(this.#value, selection)
      if (!normalized) return false
      const changed = !selectionsEqual(this.#selection, normalized)
      this.#selection = normalized
      if (changed && breakMerge) this.breakMergeGroup()
      return changed
    } finally {
      this.#endDocumentWrite()
    }
  }

  dispatch(
    transaction: MarkdownEditorTransaction,
    context: MarkdownEditorDispatchContext = {},
  ): MarkdownEditorStoreMutation {
    this.#beginDocumentWrite()
    try {
      const frozenTransaction = freezeTransaction(transaction)
      const beforeRevision = this.#revision
      if (
        frozenTransaction.documentIdentity &&
        (frozenTransaction.documentIdentity.id !== this.#documentIdentity.id ||
          frozenTransaction.documentIdentity.epoch !==
            this.#documentIdentity.epoch)
      ) {
        return this.#result(false, 'document-mismatch', beforeRevision)
      }
      if (
        frozenTransaction.expectedRevision !== undefined &&
        frozenTransaction.expectedRevision !== this.#revision
      ) {
        return this.#result(false, 'stale-revision', beforeRevision)
      }
      if (
        frozenTransaction.origin === 'external' &&
        frozenTransaction.history !== 'skip'
      ) {
        return this.#result(false, 'invalid-external-update', beforeRevision)
      }
      const externalUpdate =
        frozenTransaction.origin === 'external'
          ? (frozenTransaction.externalUpdate ?? 'reset')
          : undefined
      if (
        frozenTransaction.externalUpdate !== undefined &&
        frozenTransaction.origin !== 'external'
      ) {
        return this.#result(false, 'invalid-external-update', beforeRevision)
      }

      const beforeSelection = this.selection
      const applied = applyMarkdownEditorChanges(
        this.#value,
        frozenTransaction.changes,
      )
      if (!applied) return this.#result(false, 'invalid-change', beforeRevision)
      const positionMap = createMarkdownEditorPositionMap(
        frozenTransaction.changes,
        {
          documentIdentity: this.#documentIdentity,
          source: this.#value,
        },
      )

      const nextSelection = frozenTransaction.selection
        ? normalizeMarkdownEditorSelection(
            applied.value,
            frozenTransaction.selection,
          )
        : externalUpdate === 'reset'
          ? normalizeMarkdownEditorSelection(applied.value, {
              direction: 'none',
              end: applied.value.length,
              start: applied.value.length,
            })
          : externalUpdate === 'rebase'
            ? (() => {
                const range = positionMap.mapRange(beforeSelection).range
                return normalizeMarkdownEditorSelection(
                  applied.value,
                  range
                    ? { ...range, direction: beforeSelection.direction }
                    : {
                        direction: beforeSelection.direction,
                        end: applied.value.length,
                        start: applied.value.length,
                      },
                )
              })()
            : normalizeMarkdownEditorSelection(applied.value, beforeSelection)
      if (!nextSelection) {
        return this.#result(false, 'invalid-selection', beforeRevision)
      }

      const valueChanged = applied.value !== this.#value
      const selectionChanged = !selectionsEqual(beforeSelection, nextSelection)
      if (
        !valueChanged &&
        !selectionChanged &&
        frozenTransaction.origin !== 'external'
      ) {
        return this.#result(true, undefined, beforeRevision, positionMap)
      }

      this.#value = applied.value
      this.#selection = nextSelection
      if (valueChanged) this.#revision += 1

      let historyChanged = false
      if (frozenTransaction.origin === 'external') {
        historyChanged = this.#undo.length > 0 || this.#redo.length > 0
        this.#undo = []
        this.#redo = []
        this.breakMergeGroup()
      } else if (valueChanged && frozenTransaction.history !== 'skip') {
        historyChanged = true
        this.#recordHistory(
          frozenTransaction,
          applied.inverse,
          beforeSelection,
          nextSelection,
          context,
        )
      } else if (valueChanged) {
        if (this.#redo.length) historyChanged = true
        this.#redo = []
        this.breakMergeGroup()
      }

      return {
        ...this.#result(true, undefined, beforeRevision, positionMap),
        historyChanged,
        selectionChanged,
        valueChanged,
      }
    } finally {
      this.#endDocumentWrite()
    }
  }

  undo(): MarkdownEditorStoreMutation {
    this.#beginDocumentWrite()
    try {
      const beforeRevision = this.#revision
      const entry = this.#undo.pop()
      if (!entry) return this.#result(false, 'no-history', beforeRevision)

      let nextValue = this.#value
      const stages: MarkdownEditorChange[][] = []
      for (const step of [...entry.steps].reverse()) {
        const applied = applyMarkdownEditorChanges(nextValue, step.inverse)
        if (!applied) {
          this.#undo.push(entry)
          return this.#result(false, 'invalid-change', beforeRevision)
        }
        stages.push([...step.inverse])
        nextValue = applied.value
      }

      const selectionChanged = !selectionsEqual(
        this.#selection,
        entry.beforeSelection,
      )
      this.#value = nextValue
      this.#selection = entry.beforeSelection
      this.#revision += 1
      this.#redo.push(entry)
      this.breakMergeGroup()
      return {
        ...this.#result(
          true,
          undefined,
          beforeRevision,
          composeMarkdownEditorPositionMaps(stages),
        ),
        historyChanged: true,
        selectionChanged,
        valueChanged: true,
      }
    } finally {
      this.#endDocumentWrite()
    }
  }

  redo(): MarkdownEditorStoreMutation {
    this.#beginDocumentWrite()
    try {
      const beforeRevision = this.#revision
      const entry = this.#redo.pop()
      if (!entry) return this.#result(false, 'no-history', beforeRevision)

      let nextValue = this.#value
      const stages: MarkdownEditorChange[][] = []
      for (const step of entry.steps) {
        const applied = applyMarkdownEditorChanges(nextValue, step.changes)
        if (!applied) {
          this.#redo.push(entry)
          return this.#result(false, 'invalid-change', beforeRevision)
        }
        stages.push([...step.changes])
        nextValue = applied.value
      }

      const selectionChanged = !selectionsEqual(
        this.#selection,
        entry.afterSelection,
      )
      this.#value = nextValue
      this.#selection = entry.afterSelection
      this.#revision += 1
      this.#undo.push(entry)
      this.breakMergeGroup()
      return {
        ...this.#result(
          true,
          undefined,
          beforeRevision,
          composeMarkdownEditorPositionMaps(stages),
        ),
        historyChanged: true,
        selectionChanged,
        valueChanged: true,
      }
    } finally {
      this.#endDocumentWrite()
    }
  }

  #recordHistory(
    transaction: MarkdownEditorTransaction,
    inverse: readonly MarkdownEditorChange[],
    beforeSelection: MarkdownEditorResolvedSelection,
    afterSelection: MarkdownEditorResolvedSelection,
    context: MarkdownEditorDispatchContext,
  ) {
    const timestamp = context.now ?? Date.now()
    const mergeDirection = context.mergeDirection ?? 'none'
    const step = Object.freeze({
      changes: cloneChanges(transaction.changes),
      inverse: cloneChanges(inverse),
    })
    const retainedUnits = retainedUnitsFor(step.changes, step.inverse)
    const previous = this.#undo.at(-1)
    const canMerge =
      transaction.history === 'merge' &&
      !this.#mergeBlocked &&
      previous?.history === 'merge' &&
      previous.origin === 'input' &&
      transaction.origin === 'input' &&
      timestamp - previous.timestamp <= INPUT_MERGE_WINDOW_MS &&
      isMergeAdjacent(
        previous,
        transaction.changes,
        beforeSelection,
        afterSelection,
        mergeDirection,
      )

    if (canMerge && previous) {
      this.#undo[this.#undo.length - 1] = Object.freeze({
        ...previous,
        afterSelection: cloneSelection(afterSelection),
        retainedUnits: previous.retainedUnits + retainedUnits,
        steps: Object.freeze([...previous.steps, step]),
        timestamp,
      })
    } else {
      this.#undo.push(
        Object.freeze({
          afterSelection: cloneSelection(afterSelection),
          beforeSelection: cloneSelection(beforeSelection),
          history: transaction.history === 'merge' ? 'merge' : 'separate',
          mergeDirection,
          origin: transaction.origin,
          retainedUnits,
          steps: Object.freeze([step]),
          timestamp,
        }),
      )
    }

    this.#redo = []
    this.#mergeBlocked = false
    this.#evictHistory()
  }

  #evictHistory() {
    while (
      this.#undo.length > HISTORY_ENTRY_LIMIT ||
      this.history.retainedUnits > HISTORY_RETAINED_UNIT_LIMIT
    ) {
      this.#undo.shift()
    }
  }

  #result(
    accepted: boolean,
    reason?: MarkdownEditorTransactionRejection,
    beforeRevision = this.#revision,
    positionMap?: MarkdownEditorPositionMap,
  ): MarkdownEditorStoreMutation {
    return Object.freeze({
      accepted,
      beforeRevision,
      documentIdentity: this.documentIdentity,
      history: this.history,
      historyChanged: false,
      positionMap,
      reason,
      revision: this.#revision,
      selection: this.selection,
      selectionChanged: false,
      value: this.#value,
      valueChanged: false,
    })
  }
}

export const toMarkdownEditorTransactionEvent = (
  transaction: MarkdownEditorTransaction,
  result: MarkdownEditorDispatchResult,
): MarkdownEditorTransactionEvent =>
  Object.freeze({
    ...result,
    transaction: freezeTransaction(transaction),
  })
