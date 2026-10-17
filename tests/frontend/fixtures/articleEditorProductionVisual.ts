import { computed, createApp, defineComponent, h, nextTick, onUnmounted, reactive, ref } from 'vue'
import {
  ElButton,
  ElCheckbox,
  ElDatePicker,
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  ElOption,
  ElRadioButton,
  ElRadioGroup,
  ElSelect,
  ElSkeleton,
  ElSkeletonItem,
  ElSwitch
} from '@ozwasyd/element-plus'
import '@/assets/main.css'
import './article-editor-production-fixture.css'
import { ArticlePublishStatus } from '@/api/article'
import ArticleWriteCommandBar from '@/components/admin/article/ArticleWriteCommandBar.vue'
import ArticleWriteEditor from '@/components/admin/article/ArticleWriteEditor.vue'
import ArticleWriteInspectorShell from '@/components/admin/article/ArticleWriteInspectorShell.vue'
import ArticleWriteSidebar from '@/components/admin/article/ArticleWriteSidebar.vue'
import ArticleWriteTitleField from '@/components/admin/article/ArticleWriteTitleField.vue'
import { focusFirstArticleValidationError } from '@/components/admin/article/articleEditorAccessibility'
import {
  InMemoryAuthoringCommandProjectionAuthority,
  authoringCommandProjectionSchema,
  createFsusUiAuthoringCommands,
  type AuthoringCommandInvocation,
  type AuthoringCommandProjectionSnapshot,
  type FsusUiAuthoringCommand
} from '@/fsusui/authoringCommands'
import {
  useArticleWriteInspector,
  type ArticleWriteInspectorView
} from '@/composables/useArticleWriteInspector'
import {
  ARTICLE_RECOVERY_JOURNAL_PRIVACY_NOTICE,
  ArticleRecoveryCoordinator,
  articleRecoveryJournal,
  articleRecoverySourceHash,
  createArticleRecoveryOperationRunner,
  createArticleRecoveryClientRevision,
  summarizeArticleRecoveryComparison,
  type ArticleRecoveryJournalRecord,
  type ArticleRecoveryJournalWriteResult,
  type ArticleRecoveryOperationKind
} from '@/services/articleRecoveryJournal'
import contract from './article-editor-production-contract.json'

type FixtureState = 'empty' | 'loading' | 'error' | 'success' | 'partial'
type FixtureSurface = 'title' | 'editor' | 'outline' | 'command' | 'inspector' | 'recovery'
type AuthoringFixtureState = typeof contract.authoringStates[number]
const inspectorViews = contract.inspectorViews as ArticleWriteInspectorView[]
const fixtureStates = contract.states as FixtureState[]
const authoringStates = contract.authoringStates as AuthoringFixtureState[]

const outlineFixtureContent = (headingCount: number): string => {
  if (headingCount <= 0) return ''
  const headings = Array.from({ length: headingCount }, (_, index) => {
    const depth = index === 0 ? 1 : (index % 4) + 1
    const title = index === 0
      ? '文章大纲与当前章节导航'
      : index === 1
        ? '一个可访问且足够长的标题，用于验证完整 accessible name 与稳定换行行为'
        : `第 ${index} 节 · 身份、位置映射与实时编辑`
    return `${'#'.repeat(depth)} ${title}`
  })
  return [headings[0], '正文内容保持在同一文章编辑器实例中。', ...headings.slice(1)].join('\n\n')
}

const fixtureDigest = (character: string): string => character.repeat(64)
const fixtureProjection = (
  index = 0,
  overrides: Partial<AuthoringCommandProjectionSnapshot> = {}
): AuthoringCommandProjectionSnapshot => ({
  schema: authoringCommandProjectionSchema,
  commandId: `fixture.author-tools.insert-callout-${index}`,
  extensionId: 'fixture.author-tools',
  extensionVersion: '1.0.0',
  contributionId: `insert-callout-${index}`,
  packageSha256: fixtureDigest('a'),
  contentSha256: fixtureDigest('b'),
  runtimeIdentity: fixtureDigest('c'),
  executionClass: 'isolated-worker-wasm',
  labelReference: `commands.insert-callout-${index}.label`,
  descriptionReference: `commands.insert-callout-${index}.description`,
  keywordReferences: [`commands.insert-callout-${index}.keyword`],
  label: index === 0 ? '插入提示块' : `扩展命令 ${String(index).padStart(4, '0')}`,
  description: '在当前选区插入由宿主验证的提示块',
  keywords: [index === 0 ? '提示块' : `bounded-${index}`],
  category: 'insert',
  when: [
    { fact: 'is-document-writable', operator: 'is-true' },
    { fact: 'is-extension-enabled', operator: 'is-true' }
  ],
  hostFacts: { isExtensionEnabled: true, isOnline: true },
  requiredCapabilities: ['selection-read', 'document-mutation-request'],
  inputSchemaReference: 'authoring-command-selection/v1',
  resultSchemaReference: 'authoring-command-mutation/v1',
  preferredSurfaces: index === 0
    ? ['toolbar', 'selection', 'slash', 'palette']
    : ['palette'],
  shortcutAccepted: index === 0,
  ...(index === 0
    ? { shortcut: 'Mod+Shift+K' }
    : { shortcutReason: 'shortcut-not-requested' }),
  lifecycleGeneration: 7,
  visible: true,
  enabled: true,
  pending: false,
  ...overrides
})

export async function mountArticleEditorProductionFixture(): Promise<void> {
  const params = new URL(window.location.href).searchParams
  const requestedTitle = params.get('title') as keyof typeof contract.titles | null
  const titleKey = requestedTitle && requestedTitle in contract.titles ? requestedTitle : 'empty'
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
  const requestedSurface = params.get('surface') as FixtureSurface | null
  const surface: FixtureSurface = ['editor', 'outline', 'command', 'inspector', 'recovery'].includes(requestedSurface ?? '')
    ? requestedSurface as FixtureSurface
    : 'title'
  const requestedState = params.get('state') as FixtureState | null
  const fixtureState = fixtureStates.includes(requestedState ?? 'success')
    ? requestedState as FixtureState
    : 'success'
  const requestedView = params.get('view') as ArticleWriteInspectorView | null
  const initialInspector = inspectorViews.includes(requestedView ?? 'publish')
    ? requestedView
    : null
  const requestedAuthoringState = params.get('authoring') as AuthoringFixtureState | null
  const initialAuthoringState: AuthoringFixtureState = authoringStates.includes(requestedAuthoringState ?? 'ready')
    ? requestedAuthoringState as AuthoringFixtureState
    : 'ready'
  const outlineHeadingCount = Math.max(0, Math.min(10000, Number.parseInt(params.get('outlineCount') ?? '8', 10) || 0))
  const outlineArticle = params.get('article') === 'b' ? 'b' : 'a'
  // Explicit fixture-owner lifecycle controls are absent from every default/geometry route.
  const outlineLifecycleControls = surface === 'outline' && params.get('outlineLifecycle') === 'unmount'

  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.dataset.themeMode = theme
  document.documentElement.dataset.themeResolved = theme
  document.body.className = 'account-shell'

  const fixtureHost = document.getElementById('article-editor-production-fixture')
  if (!fixtureHost) {
    throw new Error('article_editor_production_fixture_host_missing')
  }

  const revisionItems = Array.from(
    { length: contract.largeContent.revisions },
    (_, index) => `v${contract.largeContent.revisions - index} · 修订 ${index + 1} · 已保存`
  )
  const assetItems = Array.from(
    { length: contract.largeContent.assets },
    (_, index) => `article-asset-${String(index + 1).padStart(4, '0')}.webp`
  )
  const issueItems = Array.from(
    { length: contract.largeContent.issues },
    (_, index) => `检查项 ${index + 1}：补充第 ${index + 1} 节的来源或上下文。`
  )
  const rightsParagraphs = Array.from(
    { length: contract.largeContent.rightsParagraphs },
    (_, index) => `版权条款 ${index + 1}：署名、摘录、代码复制与证明绑定沿用本文设置，长文本必须在检查器内部滚动。`
  )

  const EditorIdentitySentinel = defineComponent({
    name: 'EditorIdentitySentinel',
    setup() {
      return () => h('article', {
        class: 'article-editor-production-fixture__editor-sentinel',
        'data-editor-instance': 'article-editor-instance-1803',
        'data-editor-content': '正文保持不变',
        'data-editor-selection': 'anchor:18-focus:18',
        'data-editor-history': 'undo:7-redo:2',
        tabindex: '0'
      }, [
        h('p', {
          'data-document-wrap-signature': 'true'
        }, '固定正文列必须在打开发布、版权、检查、预览、版本和资源检查器时保持同一行宽与换行签名。This mixed paragraph is deliberately long enough to wrap across several stable lines.'),
        h('p', '编辑器实例、正文、选区、撤销历史与滚动位置都由这个 sentinel 直接证明。')
      ])
    }
  })

  const app = createApp({
    setup() {
      const title = ref(contract.titles[titleKey])
      const outlineEditorMounted = ref(true)
      const outlineFixtureFocusTarget = ref<HTMLButtonElement | null>(null)
      const outlineFixtureEditorRoot = ref<HTMLElement | null>(null)
      const content = ref(surface === 'outline'
        ? outlineFixtureContent(outlineHeadingCount)
        : '先写下可以验证的正文，再检查预览。')
      const recoveryContent = ref('')
      const recoveryCandidates = ref<readonly ArticleRecoveryJournalRecord[]>([])
      const selectedRecoveryId = ref('')
      const recoveryStorageStatus = ref('')
      const recoveryComparison = ref('')
      const recoveryOperationKind = ref<ArticleRecoveryOperationKind | null>(null)
      const recoveryOperationError = ref('')
      const state = ref<FixtureState>(fixtureState)
      const editorState = ref<'editing' | 'saving' | 'saved' | 'failed' | 'published'>('editing')
      const authoringState = ref<AuthoringFixtureState>(initialAuthoringState)
      const outlineArticleIdentity = ref(surface === 'outline'
        ? `fixture-outline-article-${outlineArticle}`
        : 'fixture-article:fixture-tab')
      const authoringDocumentIdentity = ref({ id: outlineArticleIdentity.value, epoch: 1 })
      const articleEditorRef = ref<{ openCommandPalette?: () => void } | null>(null)
      const authoringAuthority = new InMemoryAuthoringCommandProjectionAuthority()
      const authoringCommands = ref<readonly FsusUiAuthoringCommand[]>([])
      const authoringInvocationCount = ref(0)
      let pendingAuthoringInvocation: AuthoringCommandInvocation | null = null
      let resolvePendingAuthoring: ((value: unknown) => void) | null = null
      let rejectPendingAuthoring: ((reason?: unknown) => void) | null = null
      const actionCounts = reactive({ back: 0, saveDraft: 0, submit: 0 })
      const loadCounts = reactive<Record<ArticleWriteInspectorView, number>>({
        publish: 0,
        rights: 0,
        check: 0,
        preview: 0,
        versions: 0,
        resources: 0
      })
      const statusByState = {
        editing: '自动保存已就绪',
        saving: '正在保存',
        saved: '已保存',
        failed: '保存失败，请重试',
        published: '发布完成'
      } as const
      const resultForInvocation = (invocation: AuthoringCommandInvocation) => {
        const insert = '> 由扩展宿主验证的提示\n'
        return {
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
            changes: [{
              from: invocation.selection.start,
              insert,
              to: invocation.selection.end
            }],
            selection: {
              direction: 'none' as const,
              start: invocation.selection.start + insert.length,
              end: invocation.selection.start + insert.length
            }
          }
        }
      }
      const executeAuthoringCommand = async (
        invocation: AuthoringCommandInvocation,
        signal: AbortSignal
      ): Promise<unknown> => {
        authoringInvocationCount.value += 1
        if (authoringState.value === 'stale') {
          return {
            ...resultForInvocation(invocation),
            sourceRevision: invocation.sourceRevision + 1
          }
        }
        if (authoringState.value === 'generation-replaced' || authoringState.value === 'aborted' ||
          (authoringState.value === 'thousand' && invocation.commandId.endsWith('-999'))) {
          pendingAuthoringInvocation = invocation
          return await new Promise<unknown>((resolve, reject) => {
            resolvePendingAuthoring = resolve
            rejectPendingAuthoring = reject
            signal.addEventListener('abort', () => {
              reject(new DOMException('Authoring command aborted', 'AbortError'))
            }, { once: true })
          })
        }
        return resultForInvocation(invocation)
      }
      const projectionsForAuthoringState = (
        nextState: AuthoringFixtureState
      ): readonly AuthoringCommandProjectionSnapshot[] => {
        if (nextState === 'thousand') {
          return Array.from({ length: 1000 }, (_, index) => fixtureProjection(index))
        }
        if (nextState === 'permission-denied') {
          return [fixtureProjection(0, {
            enabled: false,
            disabledReason: 'command-permission-insufficient'
          })]
        }
        if (nextState === 'pending') {
          return [fixtureProjection(0, {
            enabled: false,
            pending: true,
            disabledReason: 'command-pending'
          })]
        }
        if (nextState === 'error') {
          return [fixtureProjection(0, {
            enabled: false,
            disabledReason: 'command-error',
            errorCode: 'fixture-command-error'
          })]
        }
        return [fixtureProjection()]
      }
      const installAuthoringState = (nextState: AuthoringFixtureState): void => {
        authoringState.value = nextState
        const projections = authoringAuthority.replace(projectionsForAuthoringState(nextState))
        authoringCommands.value = createFsusUiAuthoringCommands(
          projections,
          executeAuthoringCommand,
          authoringAuthority
        )
      }
      const resolvePendingAuthoringCommand = (): void => {
        if (pendingAuthoringInvocation && resolvePendingAuthoring) {
          resolvePendingAuthoring(resultForInvocation(pendingAuthoringInvocation))
        }
        pendingAuthoringInvocation = null
        resolvePendingAuthoring = null
        rejectPendingAuthoring = null
      }
      installAuthoringState(initialAuthoringState)
      const form = reactive({
        title: contract.titles.mixed,
        content: '用于验证检查器生命周期的正文。',
        summary: '一段保留业务语义的 fixture 摘要。',
        coverImageUrl: '',
        categoryId: 1 as number | undefined,
        tagIds: [1],
        status: ArticlePublishStatus.Draft,
        scheduledPublishAt: '2026-08-01T09:30:00'
      })
      const inspector = useArticleWriteInspector({
        initialInspector,
        loadView: Object.fromEntries(inspectorViews.map((view) => [
          view,
          () => {
            loadCounts[view] += 1
          }
        ])) as Partial<Record<ArticleWriteInspectorView, () => void>>
      })
      const recoveryIdentity = 'fixture-admin-1813'
      const recoveryCoordinator = surface === 'recovery'
        ? new ArticleRecoveryCoordinator({
            tabId: params.get('tabId')?.trim() || undefined
          })
        : null
      const fixedRecoveryClientRevision = params.get('clientRevision')?.trim() || null
      const recoveryAuthoritativeContent = '初始化时的服务端权威正文'
      let failNextRecoveryOperation: ArticleRecoveryOperationKind | null = null
      let recoveryWriteQueue = Promise.resolve<ArticleRecoveryJournalWriteResult>({
        status: 'unavailable',
        record: null
      })
      let recoveryRefreshTimer: ReturnType<typeof window.setInterval> | null = null
      let unsubscribeRecoveryCoordination: (() => void) | null = null

      const selectedRecovery = computed(() => (
        recoveryCandidates.value.find(candidate => candidate.id === selectedRecoveryId.value)
        ?? recoveryCandidates.value[0]
        ?? null
      ))
      const recoveryOperationPending = computed(() => recoveryOperationKind.value !== null)
      const recoveryOperationStatusText = computed(() => {
        switch (recoveryOperationKind.value) {
          case 'compare':
            return '正在比较所选正文'
          case 'recover':
            return '正在恢复所选正文'
          case 'discard':
            return '正在丢弃所选正文'
          default:
            return ''
        }
      })
      const runRecoveryOperation = createArticleRecoveryOperationRunner((state) => {
        recoveryOperationKind.value = state.kind
        recoveryOperationError.value = state.error
      })

      const performRecoveryOperation = (
        kind: ArticleRecoveryOperationKind,
        failureMessage: string,
        operation: () => void | Promise<void>
      ): Promise<boolean> => runRecoveryOperation(kind, failureMessage, async () => {
        await new Promise(resolvePromise => window.setTimeout(resolvePromise, 400))
        if (failNextRecoveryOperation === kind) {
          failNextRecoveryOperation = null
          throw new Error(`fixture_recovery_${kind}_failure`)
        }
        await operation()
      })

      const refreshRecoveryCandidates = async (): Promise<void> => {
        const [result, currentSourceHash] = await Promise.all([
          articleRecoveryJournal.list(recoveryIdentity, null),
          articleRecoverySourceHash(recoveryContent.value)
        ])
        if (result.status === 'unavailable') {
          recoveryStorageStatus.value = '浏览器短期恢复不可用，服务端自动保存继续'
          recoveryCandidates.value = []
          selectedRecoveryId.value = ''
          return
        }
        const candidates = result.records.filter(record => record.sourceHash !== currentSourceHash)
        recoveryCandidates.value = Object.freeze(candidates)
        if (!candidates.some(candidate => candidate.id === selectedRecoveryId.value)) {
          selectedRecoveryId.value = candidates[0]?.id ?? ''
        }
      }

      const writeRecoveryContent = (value: string): Promise<ArticleRecoveryJournalWriteResult> => {
        recoveryContent.value = value
        const clientRevision = fixedRecoveryClientRevision ?? createArticleRecoveryClientRevision()
        recoveryWriteQueue = recoveryWriteQueue.then(async () => {
          const result = await articleRecoveryJournal.write({
            identityId: recoveryIdentity,
            articleId: null,
            tabId: recoveryCoordinator?.tabId ?? 'fixture-tab-missing',
            baseRevisionId: null,
            serverRevision: null,
            clientRevision,
            content: value
          })
          recoveryStorageStatus.value = result.status === 'stored'
            ? ''
            : '浏览器短期恢复不可用，服务端自动保存继续'
          if (result.status === 'stored') {
            recoveryCoordinator?.notify('changed', null)
          }
          await refreshRecoveryCandidates()
          return result
        })
        return recoveryWriteQueue
      }

      const compareSelectedRecovery = async (): Promise<void> => {
        await performRecoveryOperation('compare', '所选正文比较失败，请保留当前选择并重试', () => {
          const record = selectedRecovery.value
          if (!record) throw new Error('fixture_recovery_comparison_selection_required')
          recoveryComparison.value = summarizeArticleRecoveryComparison(record, [{
            label: '初始化时的服务端权威正文',
            content: recoveryAuthoritativeContent
          }])
        })
      }

      const performRestoreSelectedRecovery = async (): Promise<void> => {
        const record = selectedRecovery.value
        if (!record) return
        recoveryContent.value = record.content
        await articleRecoveryJournal.discard(record.id)
        recoveryCoordinator?.notify('cleared', null)
        await writeRecoveryContent(record.content)
      }

      const restoreSelectedRecovery = async (): Promise<void> => {
        await performRecoveryOperation(
          'recover',
          '正文恢复失败，所选版本仍保留，请重试',
          performRestoreSelectedRecovery
        )
      }

      const performDiscardSelectedRecovery = async (): Promise<void> => {
        const record = selectedRecovery.value
        if (!record) return
        await articleRecoveryJournal.discard(record.id)
        recoveryCoordinator?.notify('cleared', null)
        await refreshRecoveryCandidates()
      }

      const discardSelectedRecovery = async (): Promise<void> => {
        await performRecoveryOperation(
          'discard',
          '正文丢弃失败，所选版本仍保留，请重试',
          performDiscardSelectedRecovery
        )
      }

      const confirmCurrentRecovery = async (): Promise<boolean> => {
        await recoveryWriteQueue
        const result = await articleRecoveryJournal.list(recoveryIdentity, null)
        const record = result.records.find(candidate => candidate.tabId === recoveryCoordinator?.tabId)
        if (!record) return false
        const confirmed = await articleRecoveryJournal.confirm({
          id: record.id,
          clientRevision: record.clientRevision,
          sourceHash: record.sourceHash
        })
        if (confirmed) {
          recoveryCoordinator?.notify('cleared', null)
        }
        await refreshRecoveryCandidates()
        return confirmed
      }

      const clearRecovery = async (): Promise<void> => {
        await articleRecoveryJournal.clearScope(recoveryIdentity, null)
        recoveryCoordinator?.notify('cleared', null)
        recoveryContent.value = ''
        await refreshRecoveryCandidates()
      }

      if (recoveryCoordinator) {
        unsubscribeRecoveryCoordination = recoveryCoordinator.subscribe((message) => {
          if (message.articleKey === 'create') {
            void refreshRecoveryCandidates()
          }
        })
        recoveryRefreshTimer = window.setInterval(() => {
          void refreshRecoveryCandidates()
        }, 500)
        void refreshRecoveryCandidates()
      }

      onUnmounted(() => {
        authoringAuthority.replace([])
        rejectPendingAuthoring?.(new DOMException('Fixture unmounted', 'AbortError'))
        unsubscribeRecoveryCoordination?.()
        recoveryCoordinator?.dispose()
        if (recoveryRefreshTimer !== null) {
          window.clearInterval(recoveryRefreshTimer)
        }
      })

      const openInspector = (
        view: ArticleWriteInspectorView,
        trigger?: HTMLElement | null
      ): void => {
        void inspector.open(view, trigger)
      }

      Object.assign(window, {
        __articleEditorFixtureSetState: (nextState: typeof editorState.value) => {
          editorState.value = nextState
        },
        __articleEditorFixtureSetInspectorState: (nextState: FixtureState) => {
          state.value = nextState
        },
        __articleEditorFixtureSetAuthoringState: (nextState: AuthoringFixtureState) => {
          installAuthoringState(nextState)
        },
        __articleEditorFixtureOpenAuthoringPalette: () => {
          articleEditorRef.value?.openCommandPalette?.()
        },
        __articleEditorFixtureReplaceAuthoringGeneration: () => {
          const projections = authoringAuthority.replace([
            fixtureProjection(0, { lifecycleGeneration: 8 })
          ])
          authoringCommands.value = createFsusUiAuthoringCommands(
            projections,
            executeAuthoringCommand,
            authoringAuthority
          )
        },
        __articleEditorFixtureReplaceAuthoringDocument: () => {
          authoringDocumentIdentity.value = {
            id: authoringDocumentIdentity.value.id,
            epoch: authoringDocumentIdentity.value.epoch + 1
          }
        },
        __articleEditorFixtureSwitchOutlineArticle: (nextArticle: 'a' | 'b') => {
          if (surface !== 'outline') return
          outlineArticleIdentity.value = `fixture-outline-article-${nextArticle}`
          authoringDocumentIdentity.value = {
            id: outlineArticleIdentity.value,
            epoch: authoringDocumentIdentity.value.epoch + 1
          }
        },
        __articleEditorFixtureResolveAuthoringCommand: resolvePendingAuthoringCommand,
        __articleEditorFixtureAuthoringInvocationCount: () => authoringInvocationCount.value,
        __articleEditorFixtureOpenInspector: (view: ArticleWriteInspectorView) => {
          openInspector(view)
        },
        __articleEditorFixtureCloseInspector: () => {
          inspector.close()
        },
        __articleEditorFixtureWriteRecovery: writeRecoveryContent,
        __articleEditorFixtureConfirmRecovery: confirmCurrentRecovery,
        __articleEditorFixtureClearRecovery: clearRecovery,
        __articleEditorFixtureFailNextRecoveryOperation: (kind: ArticleRecoveryOperationKind) => {
          failNextRecoveryOperation = kind
        },
        __articleEditorFixtureActionCounts: actionCounts,
        __articleEditorFixtureLoadCounts: loadCounts
      })

      const renderState = (
        view: ArticleWriteInspectorView,
        successContent: () => ReturnType<typeof h>
      ) => {
        if (state.value === 'loading') {
          return h('div', {
            class: 'article-editor-production-fixture__state',
            'data-fixture-state': 'loading',
            'aria-busy': 'true'
          }, '正在载入检查器内容…')
        }
        if (state.value === 'error') {
          return h('div', {
            class: 'article-editor-production-fixture__state',
            'data-fixture-state': 'error',
            role: 'alert'
          }, `${view} 暂时不可用，请重试。`)
        }
        if (state.value === 'empty') {
          return h('div', {
            class: 'article-editor-production-fixture__state',
            'data-fixture-state': 'empty'
          }, `${view} 暂无内容。`)
        }
        if (state.value === 'partial') {
          return h('div', {
            class: 'article-editor-production-fixture__state',
            'data-fixture-state': 'partial'
          }, [
            h('p', '部分内容已载入，其余内容可重试。'),
            successContent()
          ])
        }
        return h('div', {
          class: 'article-editor-production-fixture__state',
          'data-fixture-state': 'success'
        }, [successContent()])
      }

      const renderList = (
        view: 'versions' | 'resources' | 'check',
        items: string[]
      ) => h('section', {
        class: 'article-editor-production-fixture__large-list',
        'data-large-list': view
      }, [
        h('h2', `${view} · ${items.length}`),
        h('ol', items.map((item) => h('li', { key: item }, item)))
      ])

      const renderInspector = () => h('div', {
        class: 'write-workspace article-editor-production-fixture__inspector-surface'
      }, [
        h(ArticleWriteCommandBar, {
          pageTitle: '编辑文章',
          articleStateText: '草稿',
          statusText: '已保存',
          statusTone: 'quiet',
          criticalStatusText: '120 项发布检查需处理',
          criticalStatusTarget: 'check',
          primaryActionText: '更新文章',
          showSaveDraft: true,
          onOpenInspector: openInspector
        }),
        h(ElForm, {
          model: form,
          class: 'write-validation-form article-editor-production-fixture__inspector-form'
        }, () => [
          h('section', {
            class: 'article-editor-production-fixture__document-column',
            'data-editor-document-column': 'stable',
            'data-route-state': '/manage/write/fixture',
            'data-draft-state': 'draft-1803'
          }, [
            h('h1', '编辑文章'),
            h(EditorIdentitySentinel)
          ]),
          h(ArticleWriteInspectorShell, {
            activeInspector: inspector.activeInspector.value,
            registerTriggerElement: inspector.registerTrigger,
            registerScrollElement: inspector.registerScrollContainer,
            onActivate: openInspector,
            onSwitch: inspector.switchTo,
            onClose: inspector.close,
            onClosed: inspector.restoreFocus,
            onScroll: inspector.updateScroll
          }, {
            publish: () => h(ArticleWriteSidebar, {
              form,
              categories: [{ id: 1, name: '工程', articleCount: 12 }],
              tags: [{ id: 1, name: '契约', articleCount: 8 }],
              submitting: false,
              quickCreatingCategory: false,
              quickCreatingTag: false
            }),
            rights: () => renderState('rights', () => h('section', {
              class: 'article-editor-production-fixture__long-rights'
            }, rightsParagraphs.map((paragraph) => h('p', { key: paragraph }, paragraph)))),
            check: () => renderState('check', () => renderList(
              'check',
              state.value === 'partial' ? issueItems.slice(0, 12) : issueItems
            )),
            preview: () => renderState('preview', () => h('article', [
              h('h2', '阅读预览'),
              h('p', '预览沿用正文阅读列，不改变编辑器实例。')
            ])),
            versions: () => renderState('versions', () => renderList(
              'versions',
              state.value === 'partial' ? revisionItems.slice(0, 10) : revisionItems
            )),
            resources: () => renderState('resources', () => renderList(
              'resources',
              state.value === 'partial' ? assetItems.slice(0, 25) : assetItems
            ))
          })
        ])
      ])

      if (outlineLifecycleControls) {
        Object.assign(window, {
          __articleEditorFixtureCloseAndUnmount: async (closeButton: HTMLButtonElement): Promise<void> => {
            if (!(closeButton instanceof HTMLButtonElement) || !closeButton.isConnected || closeButton.disabled
              || !outlineFixtureEditorRoot.value?.isConnected || !outlineFixtureEditorRoot.value.contains(closeButton)
              || closeButton.getAttribute('aria-label') !== '关闭文章大纲') {
              throw new Error('outline_fixture_owned_native_close_required')
            }
            // A single host call stack runs the real native close handler before
            // scheduling the owner unmount, without a listener-boundary DOM flush.
            closeButton.click()
            outlineEditorMounted.value = false
            await nextTick()
            outlineFixtureFocusTarget.value?.focus()
          }
        })
      }

      const renderEditor = () => h('div', {
        class: 'write-workspace article-editor-production-fixture__editor-component',
        'data-authoring-state': authoringState.value,
        'data-authoring-generation': authoringAuthority.current(fixtureProjection().commandId)?.lifecycleGeneration,
        ref: outlineLifecycleControls ? outlineFixtureEditorRoot : undefined
      }, [
        h(ArticleWriteCommandBar, {
          pageTitle: '编辑文章',
          articleStateText: '草稿',
          statusText: statusByState[editorState.value],
          statusTone: editorState.value === 'failed' ? 'danger' : 'quiet',
          primaryActionText: '更新文章',
          showSaveDraft: true
        }),
        h('section', {
          class: 'write-document-canvas',
          'aria-label': '文章文档',
          'data-editor-document-column': 'stable'
        }, [
          h('h2', {
            id: 'article-body-heading',
            class: 'sr-only'
          }, '正文'),
          outlineEditorMounted.value ? h(ArticleWriteEditor, {
            ref: articleEditorRef,
            modelValue: content.value,
            authoringCommands: authoringCommands.value,
            commandSurfaces: {
              toolbar: true,
              selectionToolbar: true,
              slashMenu: true,
              commandPalette: true
            },
            articleIdentity: outlineArticleIdentity.value,
            documentIdentity: authoringDocumentIdentity.value,
            loading: editorState.value === 'saving',
            saving: editorState.value === 'saving',
            'onUpdate:modelValue': (value: string) => {
              content.value = value
            }
          }) : null
        ])
      ])

      const renderCommand = () => h('div', {
        class: 'write-workspace article-editor-production-fixture__command-surface'
      }, [
        h(ArticleWriteCommandBar, {
          pageTitle: '编辑文章',
          articleStateText: editorState.value === 'published' ? '已发布' : '草稿',
          statusText: statusByState[editorState.value],
          statusTone: editorState.value === 'failed' ? 'danger' : 'quiet',
          criticalStatusText: editorState.value === 'failed' ? '保存冲突需处理' : '',
          criticalStatusTarget: editorState.value === 'failed' ? 'publish' : null,
          primaryActionText: '更新文章',
          showSaveDraft: true,
          onBack: () => {
            actionCounts.back += 1
          },
          onSaveDraft: () => {
            actionCounts.saveDraft += 1
          },
          onSubmit: () => {
            actionCounts.submit += 1
            focusFirstArticleValidationError(fixtureHost)
          }
        }),
        h('form', { class: 'write-validation-form' }, [
          h('div', { class: 'article-validation-field' }, [
            h('label', { for: 'fixture-invalid-title' }, '缺失标题'),
            h('input', {
              id: 'fixture-invalid-title',
              'aria-invalid': 'true',
              value: ''
            })
          ])
        ]),
        h('div', {
          class: 'article-editor-production-fixture__command-canvas',
          role: 'textbox',
          'aria-label': '命令栏下方正文',
          tabindex: '0'
        }, [
          h('span', { 'data-fixture-last-line': 'true' }, '正文最后一行必须保持可达。')
        ])
      ])

      const renderRecovery = () => h('section', {
        class: 'article-editor-production-fixture__recovery',
        'aria-label': '文章未同步正文恢复'
      }, [
        h('header', { class: 'article-editor-production-fixture__task' }, [
          h('div', [
            h('h1', '撰写文章'),
            h('p', '服务端草稿是长期权威')
          ]),
          h('button', { type: 'button' }, '发布')
        ]),
        recoveryCandidates.value.length > 0
          ? h('section', {
              class: 'article-editor-production-fixture__recovery-prompt',
              'data-article-recovery-prompt': 'true',
              'aria-live': 'polite',
              'aria-labelledby': 'fixture-recovery-title',
              'aria-busy': recoveryOperationPending.value
            }, [
              h('div', { class: 'article-editor-production-fixture__recovery-copy' }, [
                h('h2', { id: 'fixture-recovery-title' }, (
                  recoveryCandidates.value.length > 1
                    ? `${recoveryCandidates.value.length} 个标签页的未同步正文`
                    : '未同步正文'
                )),
                h('p', recoveryCandidates.value.length > 1
                  ? '不同标签页各自保留版本，没有 last-write-wins。请选择一个版本恢复或逐个丢弃。'
                  : '此正文尚未得到服务端确认。恢复只替换当前表单正文，随后继续现有自动保存。'),
                h('p', ARTICLE_RECOVERY_JOURNAL_PRIVACY_NOTICE),
                h('fieldset', {
                  'aria-label': '选择要恢复的未同步正文版本'
                }, recoveryCandidates.value.map((candidate, index) => h('label', {
                  class: 'article-editor-production-fixture__recovery-candidate',
                  key: candidate.id
                }, [
                  h('input', {
                    type: 'radio',
                    name: 'fixture-article-recovery-candidate',
                    value: candidate.id,
                    checked: candidate.id === selectedRecovery.value?.id,
                    onChange: () => {
                      selectedRecoveryId.value = candidate.id
                      recoveryComparison.value = ''
                      recoveryOperationError.value = ''
                    }
                  }),
                  h('span', [
                    h('strong', `标签页版本 ${index + 1} · ${new Date(candidate.updatedAt).toLocaleString()}`),
                    h('small', `${candidate.content.length.toLocaleString()} 字 · client revision 独立归属`),
                    h('span', candidate.content.replace(/\s+/gu, ' ').trim().slice(0, 120) || '（空正文）')
                  ])
                ]))),
                recoveryComparison.value
                  ? h('p', {
                      class: 'article-editor-production-fixture__recovery-comparison',
                      'data-article-recovery-comparison': 'true',
                      'aria-live': 'polite'
                    }, recoveryComparison.value)
                  : null,
                recoveryOperationStatusText.value
                  ? h('p', {
                      class: 'article-editor-production-fixture__recovery-operation-status',
                      role: 'status'
                    }, recoveryOperationStatusText.value)
                  : null,
                recoveryOperationError.value
                  ? h('p', {
                      class: 'article-editor-production-fixture__recovery-operation-error',
                      role: 'alert'
                    }, recoveryOperationError.value)
                  : null
              ]),
              h('div', { class: 'article-editor-production-fixture__recovery-actions' }, [
                h(ElButton, {
                  disabled: recoveryOperationPending.value,
                  loading: recoveryOperationKind.value === 'compare',
                  onClick: () => {
                    void compareSelectedRecovery()
                  }
                }, () => '比较所选正文'),
                h(ElButton, {
                  type: 'primary',
                  disabled: recoveryOperationPending.value,
                  loading: recoveryOperationKind.value === 'recover',
                  onClick: () => {
                    void restoreSelectedRecovery()
                  }
                }, () => '恢复所选正文'),
                h(ElButton, {
                  disabled: recoveryOperationPending.value,
                  loading: recoveryOperationKind.value === 'discard',
                  onClick: () => {
                    void discardSelectedRecovery()
                  }
                }, () => '丢弃所选正文')
              ])
            ])
          : null,
        recoveryStorageStatus.value
          ? h('p', {
              class: 'article-editor-production-fixture__recovery-status',
              role: 'status'
            }, recoveryStorageStatus.value)
          : null,
        h('label', {
          class: 'article-editor-production-fixture__recovery-editor'
        }, [
          h('span', '正文'),
          h('textarea', {
            value: recoveryContent.value,
            'aria-label': '未同步正文编辑区',
            onInput: (event: Event) => {
              void writeRecoveryContent((event.target as HTMLTextAreaElement).value)
            }
          })
        ])
      ])

      return () => h('main', {
        class: 'article-editor-production-fixture',
        'aria-label': '文章编辑器 production fixture'
      }, surface === 'editor' || surface === 'outline' ? [
        outlineLifecycleControls ? h('button', {
          ref: outlineFixtureFocusTarget,
          type: 'button',
          'data-outline-fixture-focus-target': 'true'
        }, '卸载后焦点目标') : null,
        renderEditor()
      ] : surface === 'command' ? [renderCommand()] : surface === 'inspector' ? [renderInspector()] : surface === 'recovery' ? [renderRecovery()] : [
        h('header', { class: 'article-editor-production-fixture__task' }, [
          h('div', [
            h('h1', '撰写文章'),
            h('p', '草稿 · 已保存')
          ]),
          h('button', { type: 'button' }, '发布')
        ]),
        h(ElForm, { model: { title: title.value } }, () => [
          h('section', {
            class: 'write-document-canvas article-editor-production-fixture__title',
            'aria-label': '文章文档',
            'data-editor-document-column': 'stable'
          }, [
            h(ArticleWriteTitleField, {
              modelValue: title.value,
              'onUpdate:modelValue': (value: string) => {
                title.value = value
              }
            }),
            h('h2', {
              id: 'article-body-heading',
              class: 'sr-only'
            }, '正文'),
            h('div', {
              class: 'article-editor-production-fixture__canvas write-editor-panel',
              contenteditable: 'true',
              role: 'textbox',
              'aria-labelledby': 'article-body-heading',
              'aria-label': '正文'
            }, '从这里开始写正文。')
          ])
        ])
      ])
    }
  })

  for (const [name, component] of Object.entries({
    ElButton,
    ElCheckbox,
    ElDatePicker,
    ElForm,
    ElFormItem,
    ElInput,
    ElInputNumber,
    ElOption,
    ElRadioButton,
    ElRadioGroup,
    ElSelect,
    ElSkeleton,
    ElSkeletonItem,
    ElSwitch
  })) {
    app.component(name, component)
  }
  app.mount(fixtureHost)

  await nextTick()
  Object.assign(window, {
    __articleEditorFixtureEditorNode: document.querySelector('[data-editor-instance]')
  })
  document.documentElement.dataset.articleEditorFixtureReady = 'true'
}
