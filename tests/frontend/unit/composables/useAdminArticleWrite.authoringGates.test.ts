// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ArticleWriteCommandBar from '@/components/admin/article/ArticleWriteCommandBar.vue'
import { ArticlePublishStatus } from '@/api/article'
import { BinaryTransportError } from '@/services/binaryTransport'
import { useAdminArticleWrite } from '@/composables/useAdminArticleWrite'

const mocks = vi.hoisted(() => ({
  createArticle: vi.fn(),
  updateArticle: vi.fn(),
  getAdminArticleById: vi.fn(),
  saveServerDraft: vi.fn(),
  getServerDraft: vi.fn(),
  discardServerDraft: vi.fn(),
  checkArticlePrepublish: vi.fn(),
  generateAiAssist: vi.fn(),
  getCategories: vi.fn(),
  getTags: vi.fn(),
  getAdminSiteConfig: vi.fn(),
  getAdminSiteComplianceConfig: vi.fn(),
  routerPush: vi.fn(),
  routeParams: {} as Record<string, string>,
  routeQuery: {} as Record<string, string>
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: mocks.routeParams, query: mocks.routeQuery }),
  useRouter: () => ({
    push: mocks.routerPush
  })
}))

vi.mock('@/api/article', () => ({
  ArticlePublishStatus: {
    Draft: 0,
    Published: 1,
    Scheduled: 2,
    Private: 3
  },
  createArticle: mocks.createArticle,
  updateArticle: mocks.updateArticle,
  getAdminArticleById: mocks.getAdminArticleById
}))

vi.mock('@/api/authoring', () => ({
  saveServerDraft: mocks.saveServerDraft,
  getServerDraft: mocks.getServerDraft,
  discardServerDraft: mocks.discardServerDraft,
  checkArticlePrepublish: mocks.checkArticlePrepublish,
  generateAiAssist: mocks.generateAiAssist,
  createArticlePreviewSourceIdentity: vi.fn(),
  cleanupOrphanAssets: vi.fn(),
  listAssetLibrary: vi.fn().mockResolvedValue([]),
  listArticleRevisions: vi.fn().mockResolvedValue([]),
  getArticleRevision: vi.fn(),
  rollbackArticleRevision: vi.fn(),
  previewArticleDraft: vi.fn()
}))

vi.mock('@/services/articleRecoveryJournal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/articleRecoveryJournal')>()
  return {
    ...actual,
    articleRecoveryJournal: {
      write: vi.fn().mockResolvedValue({
        status: 'stored',
        record: { id: 'admin-1:null:tab-1', clientRevision: 'c-1', sourceHash: 'hash-1' }
      }),
      confirm: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue({ status: 'ok', records: [] }),
      discard: vi.fn().mockResolvedValue(true),
      clearScope: vi.fn().mockResolvedValue(true)
    }
  }
})

vi.mock('@/api/category', () => ({
  getCategories: mocks.getCategories,
  createCategory: vi.fn()
}))

vi.mock('@/api/tag', () => ({
  getTags: mocks.getTags,
  createTag: vi.fn()
}))

vi.mock('@/api/system', () => ({
  getAdminSiteConfig: mocks.getAdminSiteConfig,
  getAdminSiteComplianceConfig: mocks.getAdminSiteComplianceConfig
}))

vi.mock('@/store/admin', () => ({
  useAdminStore: () => ({
    setPageTitle: vi.fn(),
    adminPrincipal: { id: 'admin-1', username: 'admin' }
  })
}))

vi.mock('@/composables/useImageUploadPreferences', () => ({
  useImageUploadPreferences: () => ({
    options: {},
    wasmOnlyMode: { value: false },
    setOptions: vi.fn(),
    setWasmOnlyMode: vi.fn()
  })
}))

vi.mock('@/composables/useImageUploadRuntime', () => ({
  useImageUploadRuntime: () => ({})
}))

vi.mock('@/composables/useImageUploadFlow', () => ({
  useImageUploadFlow: () => ({
    run: vi.fn(),
    cancel: vi.fn()
  })
}))

const ElButtonStub = defineComponent({
  inheritAttrs: false,
  props: {
    disabled: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    type: { type: String, default: 'default' }
  },
  emits: ['click'],
  template: '<button v-bind="$attrs" :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>'
})

const FsusUiTaskPageHeaderStub = defineComponent({
  template: '<header class="fsus-task-page-header"><slot name="title" /><slot name="actions" /></header>'
})

async function mountAuthoring(params: Record<string, string> = {}, query: Record<string, string> = {}) {
  mocks.routeParams = params
  mocks.routeQuery = query
  const instance: { authoring: ReturnType<typeof useAdminArticleWrite> | null } = { authoring: null }
  const TestComp = defineComponent({
    setup() {
      const authoring = useAdminArticleWrite()
      instance.authoring = authoring
      return authoring
    },
    template: '<div></div>'
  })
  const wrapper = mount(TestComp)
  await flushPromises()
  while (instance.authoring?.pageLoading.value) {
    await flushPromises()
  }
  return { wrapper, authoring: instance.authoring! }
}

function installWindowTimerHarness() {
  let nextId = 1
  const timers = new Map<number, { handler: TimerHandler; delay: number }>()
  const timerWindow: Pick<Window, 'setTimeout' | 'clearTimeout'> = window
  vi.spyOn(timerWindow, 'setTimeout').mockImplementation((handler: TimerHandler, delay?: number) => {
    const id = nextId++
    timers.set(id, { handler, delay: delay ?? 0 })
    return id
  })
  vi.spyOn(timerWindow, 'clearTimeout').mockImplementation((id?: number) => {
    if (typeof id === 'number') {
      timers.delete(id)
    }
  })

  return {
    run(delay: number) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay)
      if (!entry) {
        throw new Error(`timer_not_scheduled:${delay}`)
      }
      timers.delete(entry[0])
      if (typeof entry[1].handler === 'function') {
        entry[1].handler()
      }
    }
  }
}

describe('useAdminArticleWrite authoring gates and draft isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.routeParams = {}
    mocks.routeQuery = {}
    mocks.createArticle.mockReset()
    mocks.updateArticle.mockReset()
    mocks.getAdminArticleById.mockReset()
    mocks.saveServerDraft.mockReset()
    mocks.getServerDraft.mockReset().mockResolvedValue(null)
    mocks.discardServerDraft.mockReset()
    mocks.checkArticlePrepublish.mockReset()
    mocks.generateAiAssist.mockReset()
    mocks.getCategories.mockResolvedValue([])
    mocks.getTags.mockResolvedValue([])
    mocks.getAdminSiteConfig.mockResolvedValue({
      siteName: "Fsu's Blog",
      baseUrl: 'https://fsus.blog',
      enableArticleRights: false,
      rights: {}
    })
    mocks.getAdminSiteComplianceConfig.mockResolvedValue({})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('edit -> autosave/draft save only calls draft owner and never calls prepublish or publish APIs', async () => {
    mocks.saveServerDraft.mockResolvedValue({
      clientRevision: 'rev-c-1',
      serverRevision: 1,
      savedAt: Date.now(),
      updatedAt: new Date().toISOString()
    })

    const timers = installWindowTimerHarness()
    const { wrapper, authoring } = await mountAuthoring()

    authoring.articleForm.title = '草稿标题'
    authoring.articleForm.content = '草稿正文内容进行编辑'

    await nextTick()
    timers.run(700)
    await flushPromises()

    expect(mocks.saveServerDraft).toHaveBeenCalled()
    expect(mocks.checkArticlePrepublish).not.toHaveBeenCalled()
    expect(mocks.createArticle).not.toHaveBeenCalled()
    expect(mocks.updateArticle).not.toHaveBeenCalled()

    // Second edit & draft save
    authoring.articleForm.content = '草稿正文二次编辑'
    authoring.saveDraftNow()
    await flushPromises()

    expect(mocks.saveServerDraft).toHaveBeenCalledTimes(2)
    expect(mocks.checkArticlePrepublish).not.toHaveBeenCalled()
    expect(mocks.createArticle).not.toHaveBeenCalled()
    expect(mocks.updateArticle).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('retries a transient draft-save failure without publishing and deduplicates an identical in-flight save', async () => {
    let resolveRetry: (value: unknown) => void = () => {}
    mocks.saveServerDraft
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveRetry = resolve
      }))

    const timers = installWindowTimerHarness()
    const { wrapper, authoring } = await mountAuthoring()
    authoring.articleForm.title = '可恢复草稿'
    authoring.articleForm.content = '失败后仍保留的正文'

    authoring.saveDraftNow()
    authoring.saveDraftNow()
    await flushPromises()
    expect(mocks.saveServerDraft).toHaveBeenCalledTimes(1)
    expect(mocks.createArticle).not.toHaveBeenCalled()
    expect(mocks.updateArticle).not.toHaveBeenCalled()

    timers.run(1_200)
    await flushPromises()
    expect(mocks.saveServerDraft).toHaveBeenCalledTimes(2)

    resolveRetry({
      clientRevision: 'rev-retry',
      serverRevision: 2,
      savedAt: Date.now(),
      updatedAt: new Date().toISOString()
    })
    await flushPromises()
    expect(authoring.articleForm.content).toBe('失败后仍保留的正文')
    expect(authoring.draftStatusText.value).toContain('服务端草稿已保存')

    wrapper.unmount()
  })

  it('pauses on a server draft conflict without losing editor content or promoting it to publication success', async () => {
    mocks.saveServerDraft.mockRejectedValue(new BinaryTransportError({
      kind: 'conflict',
      message: 'draft_conflict',
      status: 409,
      details: '{"currentServerRevision":3,"currentUpdatedAt":"2026-07-20T08:00:00.000Z","titleSummary":"remote"}'
    }))

    const { authoring } = await mountAuthoring()
    authoring.articleForm.title = '冲突草稿'
    authoring.articleForm.content = '必须保留的本地正文'
    authoring.saveDraftNow()
    await flushPromises()

    expect(authoring.draftConflictText.value).toContain('版本 3')
    expect(authoring.articleForm.content).toBe('必须保留的本地正文')
    expect(mocks.createArticle).not.toHaveBeenCalled()
    expect(mocks.updateArticle).not.toHaveBeenCalled()
    expect(mocks.routerPush).not.toHaveBeenCalled()
  })

  it('blocks publication when prepublish check finds blocking error issues', async () => {
    mocks.checkArticlePrepublish.mockResolvedValue({
      canPublish: false,
      issues: [
        { code: 'TITLE_MISSING', message: '文章标题缺失', severity: 'error' }
      ]
    })

    const { authoring } = await mountAuthoring()

    authoring.articleForm.title = ''
    authoring.articleForm.content = '正文'

    const canPublish = await authoring.refreshPrepublishCheck()

    expect(canPublish).toBe(false)
    expect(authoring.seoIssues.value.some((issue) => issue.severity.toLowerCase() === 'error')).toBe(true)
    expect(mocks.checkArticlePrepublish).toHaveBeenCalledOnce()
    expect(mocks.createArticle).not.toHaveBeenCalled()
    expect(mocks.updateArticle).not.toHaveBeenCalled()
  })

  it('gates warning overrides: rejects short reason and requires explicit >=8 char confirmation before publishing', async () => {
    mocks.checkArticlePrepublish.mockResolvedValue({
      canPublish: true,
      issues: [
        { code: 'SUMMARY_SHORT', message: '摘要较短', severity: 'warning' }
      ]
    })
    mocks.createArticle.mockResolvedValue({
      articleId: 42,
      revisionId: 'rev-1',
      revisionNo: 1
    })

    const { authoring } = await mountAuthoring()

    authoring.articleForm.title = '有效标题'
    authoring.articleForm.content = '这是一篇内容充实的正文。'
    authoring.articleForm.status = ArticlePublishStatus.Published

    // Refresh check discovers warning
    await authoring.refreshPrepublishCheck()
    expect(authoring.prepublishWarningsNeedOverride.value).toBe(true)

    // Override reason < 8 characters is rejected
    authoring.prepublishWarningOverrideReason.value = '太短'
    const shortOverrideResult = await authoring.confirmPrepublishWarningOverride()
    expect(shortOverrideResult).toBe(false)
    expect(mocks.createArticle).not.toHaveBeenCalled()

    // Valid override reason >= 8 characters allows confirmation
    authoring.prepublishWarningOverrideReason.value = '已知摘要简略，符合当前专栏发布规范'
    const validOverrideResult = await authoring.confirmPrepublishWarningOverride()
    expect(validOverrideResult).toBe(true)

    // Submit now proceeds with createArticle
    await authoring.submitForm()
    expect(mocks.createArticle).toHaveBeenCalledOnce()
  })

  it('invalidates a late prepublish result when article revision content changes and requires a fresh current check', async () => {
    mocks.getAdminArticleById.mockResolvedValue({
      id: 10,
      title: '已有文章',
      content: '检查时正文',
      currentRevisionId: '100',
      status: ArticlePublishStatus.Draft,
      tags: [],
      rights: {}
    })
    let resolveCheck: (value: unknown) => void = () => {}
    mocks.checkArticlePrepublish.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCheck = resolve
    }))
    mocks.updateArticle.mockResolvedValue({ revisionId: '101', revisionNo: 2 })

    const { authoring } = await mountAuthoring({ id: '10' })
    authoring.articleForm.status = ArticlePublishStatus.Published

    const pendingCheck = authoring.refreshPrepublishCheck()
    expect(mocks.checkArticlePrepublish).toHaveBeenCalledWith(expect.objectContaining({
      articleId: 10,
      baseRevisionId: '100',
      content: '检查时正文'
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }))

    authoring.articleForm.content = '确认前修改的新正文'
    resolveCheck({ canPublish: true, issues: [] })
    await expect(pendingCheck).resolves.toBe(false)

    await authoring.submitForm()
    expect(mocks.updateArticle).not.toHaveBeenCalled()

    mocks.checkArticlePrepublish.mockResolvedValueOnce({ canPublish: true, issues: [] })
    await expect(authoring.refreshPrepublishCheck()).resolves.toBe(true)
    await authoring.submitForm()
    expect(mocks.updateArticle).toHaveBeenCalledOnce()
    expect(mocks.updateArticle.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      content: '确认前修改的新正文',
      baseRevisionId: '100'
    }))
  })

  it('deduplicates concurrent prepublish commands while the current check is pending', async () => {
    let resolveCheck: (value: unknown) => void = () => {}
    mocks.checkArticlePrepublish.mockImplementation(() => new Promise((resolve) => {
      resolveCheck = resolve
    }))

    const { authoring } = await mountAuthoring()
    authoring.articleForm.title = '待检查文章'
    authoring.articleForm.content = '待检查正文'
    authoring.articleForm.status = ArticlePublishStatus.Published

    const first = authoring.refreshPrepublishCheck()
    const second = authoring.refreshPrepublishCheck()
    await expect(second).resolves.toBe(false)
    expect(mocks.checkArticlePrepublish).toHaveBeenCalledTimes(1)

    resolveCheck({ canPublish: true, issues: [] })
    await expect(first).resolves.toBe(true)
  })

  it('preserves draft conflict state and does not mark publication successful on draft save or publish conflict', async () => {
    mocks.getAdminArticleById.mockResolvedValue({
      id: 10,
      title: '已有文章',
      content: '原正文',
      currentRevisionId: '100',
      status: 0,
      tags: [],
      rights: {}
    })
    mocks.updateArticle.mockRejectedValue(new BinaryTransportError({
      kind: 'conflict',
      message: 'article_revision_conflict',
      status: 409,
      details: '{"currentRevisionId":"105","revisionNo":5,"status":0,"updatedAt":"2026-07-20T08:00:00.0000000Z"}'
    }))

    const { authoring } = await mountAuthoring({ id: '10' })

    authoring.articleForm.title = '已有文章'
    authoring.articleForm.content = '新编辑内容'

    await authoring.submitForm()

    expect(authoring.draftConflictText.value).toContain('5')
    expect(mocks.routerPush).not.toHaveBeenCalled()
  })

  it('guards duplicate submits allowing only one concurrent submission in-flight', async () => {
    let resolveSubmit: (val: unknown) => void = () => {}
    mocks.createArticle.mockImplementation(() => new Promise((resolve) => {
      resolveSubmit = resolve
    }))

    mocks.checkArticlePrepublish.mockResolvedValue({ canPublish: true, issues: [] })
    const { authoring } = await mountAuthoring()

    authoring.articleForm.title = '新文章'
    authoring.articleForm.content = '正文'
    authoring.articleForm.status = ArticlePublishStatus.Published
    await expect(authoring.refreshPrepublishCheck()).resolves.toBe(true)

    const p1 = authoring.submitForm()
    const p2 = authoring.submitForm()

    expect(mocks.createArticle).toHaveBeenCalledTimes(1)

    resolveSubmit({ articleId: 50, revisionId: 'rev-2', revisionNo: 1 })
    await Promise.all([p1, p2])

    expect(mocks.createArticle).toHaveBeenCalledTimes(1)
  })

  it('aborts an in-flight submit on unmount so a late result cannot navigate or publish stale success state', async () => {
    let resolveSubmit: (value: unknown) => void = () => {}
    mocks.createArticle.mockImplementation(() => new Promise((resolve) => {
      resolveSubmit = resolve
    }))

    mocks.checkArticlePrepublish.mockResolvedValue({ canPublish: true, issues: [] })
    const { wrapper, authoring } = await mountAuthoring()
    authoring.articleForm.title = '取消中的文章'
    authoring.articleForm.content = '不应由迟到结果完成导航'
    authoring.articleForm.status = ArticlePublishStatus.Published
    await expect(authoring.refreshPrepublishCheck()).resolves.toBe(true)

    const pending = authoring.submitForm()
    const signal = mocks.createArticle.mock.calls[0]?.[1]?.signal as AbortSignal
    expect(signal.aborted).toBe(false)

    wrapper.unmount()
    expect(signal.aborted).toBe(true)
    resolveSubmit({ articleId: 50, revisionId: 'rev-late', revisionNo: 1 })
    await pending

    expect(mocks.routerPush).not.toHaveBeenCalled()
  })

  it('mounts ArticleWriteCommandBar and verifies save draft vs publish button contracts', async () => {
    const wrapper = mount(ArticleWriteCommandBar, {
      props: {
        pageTitle: '撰写博文',
        articleStateText: '新草稿',
        statusText: '就绪',
        primaryActionText: '发布博文',
        showSaveDraft: true,
        submitting: false
      },
      global: {
        stubs: {
          ElButton: ElButtonStub,
          FsusUiTaskPageHeader: FsusUiTaskPageHeaderStub
        }
      }
    })

    const saveDraftBtn = wrapper.get('.article-write-command-bar__save-draft')
    expect(saveDraftBtn.text()).toBe('保存草稿')
    await saveDraftBtn.trigger('click')
    expect(wrapper.emitted('saveDraft')).toHaveLength(1)

    const primaryBtn = wrapper.get('.article-write-command-bar__primary')
    expect(primaryBtn.text()).toBe('发布博文')
    await primaryBtn.trigger('click')
    expect(wrapper.emitted('submit')).toHaveLength(1)

    // Disabled when submitting
    await wrapper.setProps({ submitting: true })
    expect(saveDraftBtn.attributes()).toHaveProperty('disabled')
    expect(primaryBtn.attributes()).toHaveProperty('disabled')
  })
})
