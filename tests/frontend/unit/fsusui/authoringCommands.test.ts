import { describe, expect, it, vi } from 'vitest'

import {
  InMemoryAuthoringCommandProjectionAuthority,
  authoringCommandProjectionSchema,
  createFsusUiAuthoringCommands,
  mergeFsusUiAuthoringCommands,
  parseAuthoringCommandProjectionSnapshots,
  type AuthoringCommandInvocation,
  type AuthoringCommandProjectionSnapshot,
} from '@/fsusui/authoringCommands'
import type { MarkdownEditorCommandContext, MarkdownEditorDispatchResult } from '@ozwasyd/element-plus'

const digest = (character: string): string => character.repeat(64)

const projection = (
  overrides: Partial<AuthoringCommandProjectionSnapshot> = {},
): AuthoringCommandProjectionSnapshot => ({
  schema: authoringCommandProjectionSchema,
  commandId: 'acme.author-tools.insert-callout',
  extensionId: 'acme.author-tools',
  extensionVersion: '1.2.3',
  contributionId: 'insert-callout',
  packageSha256: digest('a'),
  contentSha256: digest('b'),
  runtimeIdentity: digest('c'),
  executionClass: 'isolated-worker-wasm',
  labelReference: 'commands.insert-callout.label',
  descriptionReference: 'commands.insert-callout.description',
  keywordReferences: ['commands.insert-callout.keyword.callout'],
  label: '插入提示块',
  description: '在当前选区插入提示块',
  keywords: ['提示块'],
  category: 'insert',
  when: [
    { fact: 'has-selection', operator: 'is-true' },
    { fact: 'is-document-writable', operator: 'is-true' },
    { fact: 'is-source-mode', operator: 'is-true' },
    { fact: 'is-online', operator: 'is-true' },
    { fact: 'is-extension-enabled', operator: 'is-true' },
  ],
  hostFacts: { isExtensionEnabled: true, isOnline: true },
  requiredCapabilities: ['selection-read', 'document-mutation-request'],
  inputSchemaReference: 'authoring-command-selection/v1',
  resultSchemaReference: 'authoring-command-mutation/v1',
  preferredSurfaces: ['toolbar', 'selection', 'slash', 'palette'],
  shortcutAccepted: true,
  shortcut: 'Mod+Shift+K',
  lifecycleGeneration: 7,
  visible: true,
  enabled: true,
  pending: false,
  ...overrides,
})

const acceptedDispatchResult: MarkdownEditorDispatchResult = {
  accepted: true,
  beforeRevision: 11,
  documentIdentity: { epoch: 3, id: 'article-42' },
  history: { canRedo: false, canUndo: true, redoDepth: 0, retainedUnits: 1, undoDepth: 1 },
  revision: 12,
  selection: { direction: 'none', end: 8, start: 8 },
  value: 'be> noteore',
}

const context = (
  overrides: Partial<MarkdownEditorCommandContext> = {},
): MarkdownEditorCommandContext => ({
  dispatch: { dispatch: vi.fn(() => acceptedDispatchResult) },
  documentIdentity: { epoch: 3, id: 'article-42' },
  mode: 'source',
  readonly: false,
  revision: 11,
  selection: { direction: 'forward', end: 6, start: 2 },
  signal: new AbortController().signal,
  value: 'before',
  ...overrides,
}) as MarkdownEditorCommandContext

const resultFor = (invocation: AuthoringCommandInvocation) => ({
  commandId: invocation.commandId,
  contentSha256: invocation.contentSha256,
  contributionId: invocation.contributionId,
  documentEpoch: invocation.documentEpoch,
  documentId: invocation.documentId,
  executionClass: invocation.executionClass,
  extensionId: invocation.extensionId,
  extensionVersion: invocation.extensionVersion,
  inputSchemaReference: invocation.inputSchemaReference,
  lifecycleGeneration: invocation.lifecycleGeneration,
  packageSha256: invocation.packageSha256,
  requestId: invocation.requestId,
  resultSchemaReference: invocation.resultSchemaReference,
  runtimeIdentity: invocation.runtimeIdentity,
  selectionIdentity: invocation.selectionIdentity,
  sourceRevision: invocation.sourceRevision,
  transaction: {
    changes: [{ from: 2, insert: '> note', to: 6 }],
    selection: { direction: 'none' as const, end: 8, start: 8 },
  },
})

describe('FsusUI authoring command adapter', () => {
  it('validates closed metadata and projects one command into all public surfaces', async () => {
    const snapshot = projection()
    const authority = new InMemoryAuthoringCommandProjectionAuthority([snapshot])
    const execute = vi.fn(async (invocation: AuthoringCommandInvocation) => resultFor(invocation))
    const [command] = createFsusUiAuthoringCommands([snapshot], execute, authority)
    const editorContext = context()

    expect(command?.presentation).toEqual(['toolbar', 'selection', 'slash', 'palette'])
    expect(command?.group).toBe('extension.insert')
    expect(command?.when?.(editorContext)).toBe(true)
    expect(command?.enabled?.(editorContext)).toBe(true)
    const commandResult = await command?.run(editorContext)

    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      commandId: snapshot.commandId,
      contributionId: snapshot.contributionId,
      documentEpoch: 3,
      documentId: 'article-42',
      lifecycleGeneration: 7,
      requiredCapabilities: ['selection-read', 'document-mutation-request'],
      runtimeIdentity: snapshot.runtimeIdentity,
      selection: { direction: 'forward', end: 6, start: 2 },
      sourceRevision: 11,
    })
    expect(editorContext.dispatch.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      changes: [{ from: 2, insert: '> note', to: 6 }],
      documentIdentity: { epoch: 3, id: 'article-42' },
      expectedRevision: 11,
      history: 'separate',
      origin: 'command',
    }))
    expect(commandResult).toEqual({ focus: 'none' })
  })

  it.each([
    ['unknown property', { unexpected: true }],
    ['trusted host execution', { executionClass: 'trusted-host-adapter' }],
    ['control character', { label: 'Bad\u0000label' }],
    ['broad capability', { requiredCapabilities: ['all'] }],
    ['duplicate surface', { preferredSurfaces: ['toolbar', 'toolbar'] }],
    ['unbound command id', { commandId: 'another-extension.command' }],
    ['unknown when fact', { when: [{ fact: 'unknown', operator: 'is-true' }] }],
    ['broad host facts', { hostFacts: { isExtensionEnabled: true, isOnline: true, extra: true } }],
  ])('rejects %s in a projection', (_label, mutation) => {
    expect(() => parseAuthoringCommandProjectionSnapshots([
      { ...projection(), ...mutation },
    ])).toThrow(/closed|malformed|identity-bound/u)
  })

  it('evaluates the closed host and live editor context without ambient browser state', () => {
    const snapshot = projection()
    const authority = new InMemoryAuthoringCommandProjectionAuthority([snapshot])
    const [command] = createFsusUiAuthoringCommands([snapshot], vi.fn(), authority)

    expect(command?.when?.(context({ selection: { end: 0, start: 0 } }))).toBe(false)
    expect(command?.when?.(context({ mode: 'live' }))).toBe(false)
    expect(command?.when?.(context({ readonly: true }))).toBe(false)

    const offline = projection({ hostFacts: { isExtensionEnabled: true, isOnline: false } })
    const offlineAuthority = new InMemoryAuthoringCommandProjectionAuthority([offline])
    const [offlineCommand] = createFsusUiAuthoringCommands([offline], vi.fn(), offlineAuthority)
    expect(offlineCommand?.when?.(context())).toBe(false)
  })

  it('rejects response identity drift and an exact CAS rejection without returning a rebased transaction', async () => {
    const snapshot = projection()
    const authority = new InMemoryAuthoringCommandProjectionAuthority([snapshot])
    const [drifted] = createFsusUiAuthoringCommands([snapshot], async (invocation) => ({
      ...resultFor(invocation),
      sourceRevision: invocation.sourceRevision + 1,
    }), authority)
    await expect(drifted?.run(context())).rejects.toThrow(/stale or identity-drifted/u)

    const rejectedContext = context({
      dispatch: {
        dispatch: vi.fn(() => ({
          ...acceptedDispatchResult,
          accepted: false,
          reason: 'stale-revision' as const,
        })),
      },
    })
    const [rejected] = createFsusUiAuthoringCommands(
      [snapshot],
      async (invocation) => resultFor(invocation),
      authority,
    )
    await expect(rejected?.run(rejectedContext)).rejects.toThrow(/stale-revision/u)
  })

  it('keeps permission-disabled state shared and never calls the executor', async () => {
    const disabled = projection({
      enabled: false,
      disabledReason: 'command-permission-insufficient',
    })
    const authority = new InMemoryAuthoringCommandProjectionAuthority([disabled])
    const execute = vi.fn()
    const [command] = createFsusUiAuthoringCommands([disabled], execute, authority)
    const editorContext = context()

    expect(command?.when?.(editorContext)).toBe(true)
    expect(command?.enabled?.(editorContext)).toBe(false)
    expect(command?.disabledReason?.(editorContext)).toBe('command-permission-insufficient')
    await expect(command?.run(editorContext)).rejects.toThrow(/disabled/u)
    expect(execute).not.toHaveBeenCalled()
  })

  it('aborts a pending old-generation execution before it can dispatch', async () => {
    const initial = projection()
    const authority = new InMemoryAuthoringCommandProjectionAuthority([initial])
    let release: ((value: unknown) => void) | undefined
    let invocation: AuthoringCommandInvocation | undefined
    let executionSignal: AbortSignal | undefined
    const execute = vi.fn((captured: AuthoringCommandInvocation, signal: AbortSignal) => {
      invocation = captured
      executionSignal = signal
      return new Promise<unknown>((resolve) => { release = resolve })
    })
    const [command] = createFsusUiAuthoringCommands([initial], execute, authority)
    const editorContext = context()
    const pending = command!.run(editorContext)
    await vi.waitFor(() => expect(invocation).toBeDefined())

    authority.replace([projection({ lifecycleGeneration: 8 })])
    expect(executionSignal?.aborted).toBe(true)
    release?.(resultFor(invocation!))

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(editorContext.dispatch.dispatch).not.toHaveBeenCalled()
  })

  it('rejects malformed mutation plans before the public dispatcher', async () => {
    const snapshot = projection()
    const authority = new InMemoryAuthoringCommandProjectionAuthority([snapshot])
    const [command] = createFsusUiAuthoringCommands([snapshot], async (invocation) => ({
      ...resultFor(invocation),
      transaction: {
        changes: [
          { from: 1, insert: 'one', to: 4 },
          { from: 3, insert: 'two', to: 5 },
        ],
      },
    }), authority)
    const editorContext = context()

    await expect(command?.run(editorContext)).rejects.toThrow(/invalid or overlapping/u)
    expect(editorContext.dispatch.dispatch).not.toHaveBeenCalled()
  })

  it('rejects a reversed result selection before the public dispatcher', async () => {
    const snapshot = projection()
    const authority = new InMemoryAuthoringCommandProjectionAuthority([snapshot])
    const [command] = createFsusUiAuthoringCommands([snapshot], async (invocation) => ({
      ...resultFor(invocation),
      transaction: {
        changes: [{ from: 2, insert: '> note', to: 6 }],
        selection: { end: 4, start: 5 },
      },
    }), authority)
    const editorContext = context()

    await expect(command?.run(editorContext)).rejects.toThrow(/selection is invalid/u)
    expect(editorContext.dispatch.dispatch).not.toHaveBeenCalled()
  })

  it('accepts one thousand contributions plus the trusted core and rejects contribution 1001', () => {
    const thousand = Array.from({ length: 1000 }, (_, index) => projection({
      commandId: `acme.author-tools.command-${index}`,
      contributionId: `command-${index}`,
      shortcutAccepted: false,
      shortcut: undefined,
      shortcutReason: 'shortcut-not-requested',
    }))
    const parsed = parseAuthoringCommandProjectionSnapshots(thousand)
    const authority = new InMemoryAuthoringCommandProjectionAuthority(parsed)
    const commands = createFsusUiAuthoringCommands(parsed, vi.fn(), authority)

    expect(commands).toHaveLength(1000)
    expect(mergeFsusUiAuthoringCommands([
      { key: 'core.bold', group: 'core', label: 'Core', run: vi.fn() },
    ], commands)).toHaveLength(1001)
    expect(() => parseAuthoringCommandProjectionSnapshots([
      ...thousand,
      projection({ commandId: 'acme.author-tools.command-1000', contributionId: 'command-1000' }),
    ])).toThrow(/closed contribution bound/u)
  })

  it('rejects a core key collision', () => {
    const snapshot = projection()
    const authority = new InMemoryAuthoringCommandProjectionAuthority([snapshot])
    const [command] = createFsusUiAuthoringCommands([snapshot], vi.fn(), authority)

    expect(() => mergeFsusUiAuthoringCommands(
      [{ key: command!.key, group: 'core', label: 'Core', run: vi.fn() }],
      [command!],
    )).toThrow(/conflicts with the core/u)
  })
})
