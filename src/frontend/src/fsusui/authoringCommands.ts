import type {
  MarkdownEditorCommand,
  MarkdownEditorCommandContext,
  MarkdownEditorCommandPresentation,
  MarkdownEditorDocumentIdentity,
  MarkdownEditorSurfaceOptions,
  MarkdownEditorTransaction,
} from '@ozwasyd/element-plus'

export const authoringCommandProjectionSchema =
  'fsusblog.authoring-command-projection.v1' as const
export const maximumAuthoringCommandContributions = 1000

const maximumDocumentBytes = 16 * 1024 * 1024
const utf8Encoder = new TextEncoder()
const digestPattern = /^[a-f0-9]{64}$/u
const controlCharacterPattern = /[\u0000-\u001f\u007f]/u
const executionClasses = ['isolated-worker-wasm', 'out-of-process-service'] as const
const categories = ['edit', 'format', 'insert', 'navigate', 'validate', 'import-export'] as const
const capabilities = [
  'document-range-read', 'document-full-read', 'selection-read',
  'document-mutation-request', 'article-query', 'network-destination',
  'filesystem-root-read', 'filesystem-root-propose-write', 'diagnostic-report',
  'state-storage-read', 'state-storage-write',
] as const
const surfaces = ['toolbar', 'selection', 'slash', 'palette'] as const
const contextFacts = [
  'has-selection', 'is-document-writable', 'is-source-mode', 'is-online',
  'is-extension-enabled',
] as const
const contextOperators = ['is-true', 'is-false'] as const

export type AuthoringCommandExecutionClass = (typeof executionClasses)[number]
export type AuthoringCommandCategory = (typeof categories)[number]
export type AuthoringCommandCapability = (typeof capabilities)[number]
export type AuthoringCommandSurface = (typeof surfaces)[number]
export type AuthoringCommandContextFact = (typeof contextFacts)[number]
export type AuthoringCommandContextOperator = (typeof contextOperators)[number]
export type FsusUiAuthoringCommand = MarkdownEditorCommand
export type FsusUiAuthoringDocumentIdentity = MarkdownEditorDocumentIdentity
export type FsusUiAuthoringSurfaceOptions = MarkdownEditorSurfaceOptions

export interface AuthoringCommandContextCondition {
  readonly fact: AuthoringCommandContextFact
  readonly operator: AuthoringCommandContextOperator
}

export interface AuthoringCommandHostFacts {
  readonly isExtensionEnabled: boolean
  readonly isOnline: boolean
}

export interface AuthoringCommandProjectionSnapshot {
  readonly schema: typeof authoringCommandProjectionSchema
  readonly commandId: string
  readonly extensionId: string
  readonly extensionVersion: string
  readonly contributionId: string
  readonly packageSha256: string
  readonly contentSha256: string
  readonly runtimeIdentity: string
  readonly executionClass: AuthoringCommandExecutionClass
  readonly labelReference: string
  readonly descriptionReference: string
  readonly keywordReferences: readonly string[]
  readonly label: string
  readonly description: string
  readonly keywords: readonly string[]
  readonly category: AuthoringCommandCategory
  readonly when: readonly AuthoringCommandContextCondition[]
  readonly hostFacts: AuthoringCommandHostFacts
  readonly requiredCapabilities: readonly AuthoringCommandCapability[]
  readonly inputSchemaReference: string
  readonly resultSchemaReference: string
  readonly preferredSurfaces: readonly AuthoringCommandSurface[]
  readonly shortcutAccepted: boolean
  readonly shortcut?: string
  readonly shortcutReason?: string
  readonly lifecycleGeneration: number
  readonly visible: boolean
  readonly enabled: boolean
  readonly pending: boolean
  readonly disabledReason?: string
  readonly errorCode?: string
}

export interface AuthoringCommandInvocation {
  readonly commandId: string
  readonly extensionId: string
  readonly extensionVersion: string
  readonly contributionId: string
  readonly packageSha256: string
  readonly contentSha256: string
  readonly runtimeIdentity: string
  readonly executionClass: AuthoringCommandExecutionClass
  readonly requiredCapabilities: readonly AuthoringCommandCapability[]
  readonly inputSchemaReference: string
  readonly resultSchemaReference: string
  readonly documentEpoch: number
  readonly documentId: string
  readonly lifecycleGeneration: number
  readonly requestId: string
  readonly selection: Readonly<{
    direction: 'backward' | 'forward' | 'none'
    end: number
    start: number
  }>
  readonly selectionIdentity: string
  readonly sourceRevision: number
}

export interface AuthoringCommandInvocationResult {
  readonly commandId: string
  readonly contentSha256: string
  readonly contributionId: string
  readonly documentEpoch: number
  readonly documentId: string
  readonly executionClass: AuthoringCommandExecutionClass
  readonly extensionId: string
  readonly extensionVersion: string
  readonly inputSchemaReference: string
  readonly lifecycleGeneration: number
  readonly packageSha256: string
  readonly requestId: string
  readonly resultSchemaReference: string
  readonly runtimeIdentity: string
  readonly selectionIdentity: string
  readonly sourceRevision: number
  readonly transaction: Pick<MarkdownEditorTransaction, 'changes' | 'selection'>
}

export type AuthoringCommandExecutor = (
  invocation: AuthoringCommandInvocation,
  signal: AbortSignal,
) => Promise<unknown>

export interface AuthoringCommandProjectionAuthority {
  current(commandId: string): AuthoringCommandProjectionSnapshot | undefined
  isCurrent(projection: AuthoringCommandProjectionSnapshot): boolean
  signal(projection: AuthoringCommandProjectionSnapshot): AbortSignal
}

const projectionKeys = Object.freeze([
  'schema', 'commandId', 'extensionId', 'extensionVersion', 'contributionId',
  'packageSha256', 'contentSha256', 'runtimeIdentity', 'executionClass',
  'labelReference', 'descriptionReference', 'keywordReferences', 'label',
  'description', 'keywords', 'category', 'requiredCapabilities',
  'when', 'hostFacts',
  'inputSchemaReference', 'resultSchemaReference', 'preferredSurfaces',
  'shortcutAccepted', 'shortcut', 'shortcutReason', 'lifecycleGeneration',
  'visible', 'enabled', 'pending', 'disabledReason', 'errorCode',
] as const)
const requiredProjectionKeys = projectionKeys.filter((key) => ![
  'shortcut', 'shortcutReason', 'disabledReason', 'errorCode',
].includes(key))
const resultKeys = Object.freeze([
  'commandId', 'contentSha256', 'contributionId', 'documentEpoch', 'documentId',
  'executionClass', 'extensionId', 'extensionVersion', 'inputSchemaReference',
  'lifecycleGeneration', 'packageSha256', 'requestId', 'resultSchemaReference',
  'runtimeIdentity', 'selectionIdentity', 'sourceRevision', 'transaction',
] as const)

const neverAbortController = new AbortController()
const abortedController = new AbortController()
abortedController.abort('authoring-command-stale')
let requestSequence = 0

const createRequestId = (): string => {
  requestSequence += 1
  return `authoring-command-${requestSequence.toString(36)}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): boolean => {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every((key) => allowedKeys.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
}

const isBoundedText = (
  value: unknown,
  maximumLength: number,
  options: { allowEmpty?: boolean; trim?: boolean } = {},
): value is string =>
  typeof value === 'string' && value.length <= maximumLength &&
  (options.allowEmpty === true || value.length > 0) &&
  (options.trim === false || value === value.trim()) &&
  !controlCharacterPattern.test(value)

const isStringArray = (
  value: unknown,
  maximumItems: number,
  validate: (item: unknown) => item is string,
): value is string[] =>
  Array.isArray(value) && value.length <= maximumItems && value.every(validate) &&
  new Set(value).size === value.length

const enumValue = <T extends string>(value: unknown, values: readonly T[]): value is T =>
  typeof value === 'string' && values.includes(value as T)

const projectionIdentity = (projection: AuthoringCommandProjectionSnapshot): string =>
  JSON.stringify(projectionKeys.map((key) => [key, projection[key]]))

const validateProjection = (value: unknown): AuthoringCommandProjectionSnapshot => {
  if (!isRecord(value) || !hasExactKeys(value, projectionKeys, requiredProjectionKeys)) {
    throw new TypeError('Authoring command projection is not a closed object.')
  }

  const keywords = value.keywords
  const keywordReferences = value.keywordReferences
  const requiredCapabilities = value.requiredCapabilities
  const preferredSurfaces = value.preferredSurfaces
  const when = value.when
  const hostFacts = value.hostFacts
  const shortcut = value.shortcut
  const shortcutReason = value.shortcutReason
  const disabledReason = value.disabledReason
  const errorCode = value.errorCode

  if (
    value.schema !== authoringCommandProjectionSchema ||
    !isBoundedText(value.commandId, 256) ||
    !isBoundedText(value.extensionId, 128) ||
    !String(value.commandId).startsWith(`${String(value.extensionId)}.`) ||
    String(value.commandId).startsWith('fsusblog.core.') ||
    !isBoundedText(value.extensionVersion, 64) ||
    !isBoundedText(value.contributionId, 256) ||
    typeof value.packageSha256 !== 'string' || !digestPattern.test(value.packageSha256) ||
    typeof value.contentSha256 !== 'string' || !digestPattern.test(value.contentSha256) ||
    typeof value.runtimeIdentity !== 'string' || !digestPattern.test(value.runtimeIdentity) ||
    !enumValue(value.executionClass, executionClasses) ||
    !isBoundedText(value.labelReference, 256) ||
    !isBoundedText(value.descriptionReference, 256) ||
    !isStringArray(keywordReferences, 32, (item): item is string => isBoundedText(item, 256)) ||
    !isBoundedText(value.label, 256) ||
    !isBoundedText(value.description, 1024, { allowEmpty: true }) ||
    !isStringArray(keywords, 32, (item): item is string => isBoundedText(item, 256)) ||
    keywordReferences.length !== keywords.length ||
    !enumValue(value.category, categories) ||
    !Array.isArray(when) || when.length > 16 ||
    when.some((condition) => !isRecord(condition) ||
      !hasExactKeys(condition, ['fact', 'operator']) ||
      !enumValue(condition.fact, contextFacts) ||
      !enumValue(condition.operator, contextOperators)) ||
    new Set(when.map((condition) => JSON.stringify(condition))).size !== when.length ||
    !isRecord(hostFacts) ||
    !hasExactKeys(hostFacts, ['isExtensionEnabled', 'isOnline']) ||
    typeof hostFacts.isExtensionEnabled !== 'boolean' || typeof hostFacts.isOnline !== 'boolean' ||
    !Array.isArray(requiredCapabilities) ||
    requiredCapabilities.some((item) => !enumValue(item, capabilities)) ||
    new Set(requiredCapabilities).size !== requiredCapabilities.length ||
    !isBoundedText(value.inputSchemaReference, 256) ||
    !isBoundedText(value.resultSchemaReference, 256) ||
    !Array.isArray(preferredSurfaces) || preferredSurfaces.length === 0 ||
    preferredSurfaces.some((item) => !enumValue(item, surfaces)) ||
    new Set(preferredSurfaces).size !== preferredSurfaces.length ||
    typeof value.shortcutAccepted !== 'boolean' ||
    (shortcut !== undefined && !isBoundedText(shortcut, 64)) ||
    (shortcutReason !== undefined && !isBoundedText(shortcutReason, 128)) ||
    (value.shortcutAccepted ? shortcut === undefined || shortcutReason !== undefined : shortcut !== undefined) ||
    (!value.shortcutAccepted && shortcutReason === undefined) ||
    !Number.isSafeInteger(value.lifecycleGeneration) || Number(value.lifecycleGeneration) < 1 ||
    typeof value.visible !== 'boolean' || typeof value.enabled !== 'boolean' ||
    typeof value.pending !== 'boolean' ||
    (disabledReason !== undefined && !isBoundedText(disabledReason, 128)) ||
    (errorCode !== undefined && !isBoundedText(errorCode, 128)) ||
    (value.enabled && (!value.visible || value.pending || disabledReason !== undefined || errorCode !== undefined)) ||
    (!value.enabled && disabledReason === undefined)
  ) {
    throw new TypeError('Authoring command projection is malformed, broad, or not identity-bound.')
  }

  return Object.freeze({
    ...(value as unknown as AuthoringCommandProjectionSnapshot),
    keywordReferences: Object.freeze([...keywordReferences]),
    keywords: Object.freeze([...keywords]),
    preferredSurfaces: Object.freeze([...preferredSurfaces]) as readonly AuthoringCommandSurface[],
    requiredCapabilities: Object.freeze([...requiredCapabilities]) as readonly AuthoringCommandCapability[],
    hostFacts: Object.freeze({
      isExtensionEnabled: hostFacts.isExtensionEnabled,
      isOnline: hostFacts.isOnline,
    }),
    when: Object.freeze(when.map((condition) => Object.freeze({ ...condition }))) as
      readonly AuthoringCommandContextCondition[],
  })
}

export const parseAuthoringCommandProjectionSnapshots = (
  value: unknown,
): readonly AuthoringCommandProjectionSnapshot[] => {
  if (!Array.isArray(value) || value.length > maximumAuthoringCommandContributions) {
    throw new RangeError('Authoring command projection exceeds the closed contribution bound.')
  }

  const commandIds = new Set<string>()
  return Object.freeze(value.map((item) => {
    const projection = validateProjection(item)
    if (commandIds.has(projection.commandId)) {
      throw new TypeError('Authoring command projection contains a duplicate command identity.')
    }
    commandIds.add(projection.commandId)
    return projection
  }))
}

export class InMemoryAuthoringCommandProjectionAuthority implements AuthoringCommandProjectionAuthority {
  private projections = new Map<string, AuthoringCommandProjectionSnapshot>()
  private aborts = new Map<string, AbortController>()

  public constructor(initial: unknown = []) {
    this.replace(initial)
  }

  public replace(value: unknown): readonly AuthoringCommandProjectionSnapshot[] {
    const next = parseAuthoringCommandProjectionSnapshots(value)
    const nextById = new Map(next.map((projection) => [projection.commandId, projection]))
    const nextAborts = new Map<string, AbortController>()

    for (const [commandId, previous] of this.projections) {
      const current = nextById.get(commandId)
      const controller = this.aborts.get(commandId)
      if (!current || projectionIdentity(previous) !== projectionIdentity(current)) {
        controller?.abort(new DOMException(
          'Authoring command projection was replaced.',
          'AbortError',
        ))
      } else if (controller) {
        nextAborts.set(commandId, controller)
      }
    }
    for (const projection of next) {
      if (!nextAborts.has(projection.commandId)) {
        nextAborts.set(projection.commandId, new AbortController())
      }
    }
    this.projections = nextById
    this.aborts = nextAborts
    return next
  }

  public current(commandId: string): AuthoringCommandProjectionSnapshot | undefined {
    return this.projections.get(commandId)
  }

  public isCurrent(projection: AuthoringCommandProjectionSnapshot): boolean {
    const current = this.current(projection.commandId)
    return current !== undefined && projectionIdentity(current) === projectionIdentity(projection)
  }

  public signal(projection: AuthoringCommandProjectionSnapshot): AbortSignal {
    if (!this.isCurrent(projection)) return abortedController.signal
    return this.aborts.get(projection.commandId)?.signal ?? neverAbortController.signal
  }
}

const combineSignals = (...signals: readonly AbortSignal[]): Readonly<{
  dispose: () => void
  signal: AbortSignal
}> => {
  const controller = new AbortController()
  const removers: Array<() => void> = []
  const abort = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason)
  }
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal)
      break
    }
    const listener = (): void => abort(signal)
    signal.addEventListener('abort', listener, { once: true })
    removers.push(() => signal.removeEventListener('abort', listener))
  }
  return Object.freeze({
    dispose: () => removers.splice(0).forEach((remove) => remove()),
    signal: controller.signal,
  })
}

const createSelectionIdentity = (context: MarkdownEditorCommandContext): string => JSON.stringify([
  context.documentIdentity.id,
  context.documentIdentity.epoch,
  context.revision,
  context.selection.start,
  context.selection.end,
  context.selection.direction ?? 'none',
])

const matchesContext = (
  projection: AuthoringCommandProjectionSnapshot,
  context: MarkdownEditorCommandContext,
): boolean => projection.when.every((condition) => {
  let value: boolean
  switch (condition.fact) {
    case 'has-selection':
      value = context.selection.start !== context.selection.end
      break
    case 'is-document-writable':
      value = !context.readonly
      break
    case 'is-source-mode':
      value = context.mode === 'source'
      break
    case 'is-online':
      value = projection.hostFacts.isOnline
      break
    case 'is-extension-enabled':
      value = projection.hostFacts.isExtensionEnabled
      break
  }
  return condition.operator === 'is-true' ? value : !value
})

const validateResult = (
  value: unknown,
  invocation: AuthoringCommandInvocation,
  sourceValue: string,
): AuthoringCommandInvocationResult => {
  if (!isRecord(value) || !hasExactKeys(value, resultKeys) || !isRecord(value.transaction)) {
    throw new TypeError('Authoring command result is not a closed object.')
  }
  if (!hasExactKeys(value.transaction, ['changes', 'selection'], ['changes'])) {
    throw new TypeError('Authoring command transaction is not a closed object.')
  }

  const changes = value.transaction.changes
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 1000) {
    throw new RangeError('Authoring command transaction change count is outside its bound.')
  }

  let previousEnd = -1
  let lengthDelta = 0
  let finalBytes = utf8Encoder.encode(sourceValue).byteLength
  const closedChanges = changes.map((change) => {
    if (!isRecord(change) || !hasExactKeys(change, ['from', 'insert', 'to']) ||
      !Number.isSafeInteger(change.from) || !Number.isSafeInteger(change.to) ||
      Number(change.from) < previousEnd || Number(change.from) < 0 ||
      Number(change.to) < Number(change.from) || Number(change.to) > sourceValue.length ||
      typeof change.insert !== 'string') {
      throw new TypeError('Authoring command transaction contains an invalid or overlapping change.')
    }
    const insertedBytes = utf8Encoder.encode(change.insert).byteLength
    if (insertedBytes > maximumDocumentBytes) {
      throw new RangeError('Authoring command transaction insert exceeds the document byte bound.')
    }
    previousEnd = Number(change.to)
    lengthDelta += change.insert.length - (Number(change.to) - Number(change.from))
    finalBytes += insertedBytes - utf8Encoder.encode(
      sourceValue.slice(Number(change.from), Number(change.to)),
    ).byteLength
    return Object.freeze({ from: Number(change.from), insert: change.insert, to: Number(change.to) })
  })

  const finalLength = sourceValue.length + lengthDelta
  if (finalLength < 0 || finalBytes < 0 || finalBytes > maximumDocumentBytes) {
    throw new RangeError('Authoring command transaction exceeds the document bound.')
  }

  const selection = value.transaction.selection
  let closedSelection: MarkdownEditorTransaction['selection']
  if (selection !== undefined) {
    if (!isRecord(selection) ||
      !hasExactKeys(selection, ['direction', 'end', 'start'], ['end', 'start']) ||
      !Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end) ||
      Number(selection.start) < 0 || Number(selection.end) < 0 ||
      Number(selection.end) < Number(selection.start) ||
      Number(selection.start) > finalLength || Number(selection.end) > finalLength) {
      throw new TypeError('Authoring command transaction selection is invalid.')
    }
    const direction = selection.direction
    if (direction !== undefined &&
      !enumValue(direction, ['backward', 'forward', 'none'] as const)) {
      throw new TypeError('Authoring command transaction selection direction is invalid.')
    }
    closedSelection = Object.freeze({
      ...(direction === undefined ? {} : { direction }),
      end: Number(selection.end),
      start: Number(selection.start),
    })
  }

  if (value.commandId !== invocation.commandId ||
    value.contentSha256 !== invocation.contentSha256 ||
    value.contributionId !== invocation.contributionId ||
    value.documentId !== invocation.documentId ||
    value.documentEpoch !== invocation.documentEpoch ||
    value.executionClass !== invocation.executionClass ||
    value.extensionId !== invocation.extensionId ||
    value.extensionVersion !== invocation.extensionVersion ||
    value.inputSchemaReference !== invocation.inputSchemaReference ||
    value.sourceRevision !== invocation.sourceRevision ||
    value.lifecycleGeneration !== invocation.lifecycleGeneration ||
    value.packageSha256 !== invocation.packageSha256 ||
    value.requestId !== invocation.requestId || value.runtimeIdentity !== invocation.runtimeIdentity ||
    value.resultSchemaReference !== invocation.resultSchemaReference ||
    value.selectionIdentity !== invocation.selectionIdentity) {
    throw new Error('Authoring command result is stale or identity-drifted.')
  }

  return Object.freeze({
    ...(value as unknown as AuthoringCommandInvocationResult),
    transaction: Object.freeze({
      changes: Object.freeze(closedChanges),
      ...(closedSelection === undefined ? {} : { selection: closedSelection }),
    }),
  })
}

const runProjectedCommand = async (
  initialProjection: AuthoringCommandProjectionSnapshot,
  context: MarkdownEditorCommandContext,
  execute: AuthoringCommandExecutor,
  authority: AuthoringCommandProjectionAuthority,
) => {
  const projection = authority.current(initialProjection.commandId)
  if (!projection || !authority.isCurrent(initialProjection) || !projection.visible ||
    !projection.enabled || projection.pending || context.readonly || !matchesContext(projection, context) ||
    !isBoundedText(context.documentIdentity.id, 256) ||
    !Number.isSafeInteger(context.documentIdentity.epoch) || context.documentIdentity.epoch < 1 ||
    !Number.isSafeInteger(context.revision) || context.revision < 0 ||
    utf8Encoder.encode(context.value).byteLength > maximumDocumentBytes ||
    !Number.isSafeInteger(context.selection.start) ||
    !Number.isSafeInteger(context.selection.end) ||
    context.selection.start < 0 || context.selection.end < context.selection.start ||
    context.selection.end > context.value.length ||
    (context.selection.direction !== undefined &&
      !enumValue(context.selection.direction, ['backward', 'forward', 'none'] as const))) {
    throw new Error('Authoring command is disabled, stale, or not document-bound.')
  }

  const combined = combineSignals(context.signal, authority.signal(projection))
  combined.signal.throwIfAborted()
  const requestId = createRequestId()
  const selection = Object.freeze({
    direction: context.selection.direction ?? 'none',
    end: context.selection.end,
    start: context.selection.start,
  })
  const invocation: AuthoringCommandInvocation = Object.freeze({
    commandId: projection.commandId,
    extensionId: projection.extensionId,
    extensionVersion: projection.extensionVersion,
    contributionId: projection.contributionId,
    packageSha256: projection.packageSha256,
    contentSha256: projection.contentSha256,
    runtimeIdentity: projection.runtimeIdentity,
    executionClass: projection.executionClass,
    requiredCapabilities: projection.requiredCapabilities,
    inputSchemaReference: projection.inputSchemaReference,
    resultSchemaReference: projection.resultSchemaReference,
    documentEpoch: context.documentIdentity.epoch,
    documentId: context.documentIdentity.id,
    lifecycleGeneration: projection.lifecycleGeneration,
    requestId,
    selection,
    selectionIdentity: createSelectionIdentity(context),
    sourceRevision: context.revision,
  })
  try {
    const rawResult = await execute(invocation, combined.signal)
    combined.signal.throwIfAborted()
    if (!authority.isCurrent(projection)) {
      throw new Error('Authoring command result is stale or lifecycle-drifted.')
    }
    const result = validateResult(rawResult, invocation, context.value)
    const dispatchResult = context.dispatch.dispatch({
      changes: result.transaction.changes,
      documentIdentity: Object.freeze({ ...context.documentIdentity }),
      expectedRevision: invocation.sourceRevision,
      history: 'separate',
      metadata: Object.freeze({ command: invocation.commandId, requestId }),
      origin: 'command',
      selection: result.transaction.selection,
    })
    if (!dispatchResult.accepted) {
      throw new Error(`Authoring command transaction rejected: ${dispatchResult.reason ?? 'unknown'}.`)
    }
    return { focus: 'none' as const }
  } finally {
    combined.dispose()
  }
}

const presentationFor = (
  projection: AuthoringCommandProjectionSnapshot,
): readonly MarkdownEditorCommandPresentation[] => Object.freeze(
  projection.preferredSurfaces.map((surface) => surface as MarkdownEditorCommandPresentation),
)

export const createFsusUiAuthoringCommands = (
  input: unknown,
  execute: AuthoringCommandExecutor,
  authority: AuthoringCommandProjectionAuthority,
): readonly MarkdownEditorCommand[] => {
  const projections = parseAuthoringCommandProjectionSnapshots(input)
  return Object.freeze(projections.map((projection) => Object.freeze<MarkdownEditorCommand>({
    key: projection.commandId,
    label: projection.label,
    description: projection.description,
    group: `extension.${projection.category}`,
    keywords: projection.keywords,
    presentation: presentationFor(projection),
    shortcut: projection.shortcutAccepted ? projection.shortcut : undefined,
    when: (context) => authority.current(projection.commandId)?.visible === true &&
      authority.isCurrent(projection) && matchesContext(projection, context),
    enabled: (context) => {
      const current = authority.current(projection.commandId)
      return current?.enabled === true && current.pending === false && !context.readonly &&
        context.documentIdentity.epoch >= 1 && context.revision >= 0 &&
        matchesContext(projection, context) && authority.isCurrent(projection)
    },
    disabledReason: () => authority.current(projection.commandId)?.disabledReason,
    run: (context) => runProjectedCommand(projection, context, execute, authority),
  })))
}

export const mergeFsusUiAuthoringCommands = (
  coreCommands: readonly MarkdownEditorCommand[],
  authoringCommands: readonly MarkdownEditorCommand[],
): readonly MarkdownEditorCommand[] => {
  if (authoringCommands.length > maximumAuthoringCommandContributions) {
    throw new RangeError('Authoring command registry exceeds the closed contribution bound.')
  }
  const keys = new Set(coreCommands.map((command) => command.key))
  for (const command of authoringCommands) {
    if (keys.has(command.key)) {
      throw new Error('Authoring command key conflicts with the core command registry.')
    }
    keys.add(command.key)
  }
  return Object.freeze([...coreCommands, ...authoringCommands])
}
