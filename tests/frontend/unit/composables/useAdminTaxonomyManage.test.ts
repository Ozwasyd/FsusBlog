import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FormInstance } from '@ozwasyd/element-plus'
import { fsusDialogWidths } from '@/fsusui/dialog'
import {
  normalizeTaxonomyDescriptionInput,
  taxonomyDescriptionMaxScalars,
  useAdminTaxonomyManage,
  type AdminTaxonomyItemBase,
  type TaxonomySchema
} from '@/composables/useAdminTaxonomyManage'

const mocks = vi.hoisted(() => ({
  showErrorToast: vi.fn(),
  showWarningToast: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  routerPush: vi.fn()
}))

vi.mock('@/utils/errorPresentation', () => ({
  showErrorToast: mocks.showErrorToast,
  showWarningToast: mocks.showWarningToast
}))

vi.mock('@/fsusui/feedback', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: vi.fn(),
    info: vi.fn()
  }
}))

vi.mock('@/composables/useGlobalConfirm', () => ({
  requestGlobalConfirm: vi.fn().mockResolvedValue(true)
}))

vi.mock('@/composables/usePow', () => ({
  usePow: () => ({
    isCalculating: { value: false },
    prewarm: vi.fn()
  })
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mocks.routerPush
  })
}))

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const sampleRow: AdminTaxonomyItemBase = {
  id: 7,
  name: 'Tech',
  publicArticleCount: 1,
  draftArticleCount: 0,
  scheduledArticleCount: 0,
  archivedArticleCount: 0,
  totalBlockingArticleCount: 1,
  canDelete: false
}

function createSchema(kind: 'category' | 'tag'): TaxonomySchema<AdminTaxonomyItemBase> & {
  loadItems: ReturnType<typeof vi.fn>
  loadExactMetadata: ReturnType<typeof vi.fn>
  createItem: ReturnType<typeof vi.fn>
  updateItem: ReturnType<typeof vi.fn>
  deleteItem: ReturnType<typeof vi.fn>
} {
  const entityLabel = kind === 'category' ? '分类' : '标签'
  return {
    kind,
    entityLabel,
    pageClass: `${kind}-manage-wrapper`,
    pageTitle: `${entityLabel}管理`,
    pageDescription: '',
    summaryAriaLabel: entityLabel,
    summaryDescription: '删除前会检查引用关系。',
    listTitle: `${entityLabel}列表`,
    toolbarLabel: `${entityLabel}筛选`,
    searchPlaceholder: `搜索${entityLabel}`,
    searchAriaLabel: `搜索${entityLabel}`,
    nameColumnLabel: `${entityLabel}名称`,
    nameInputName: `${kind}Name`,
    nameInputLabel: `${entityLabel}名称`,
    nameInputPlaceholder: '名称',
    descriptionInputName: `${kind}Description`,
    descriptionInputLabel: `${entityLabel}描述`,
    descriptionInputPlaceholder: '可选，最多 500 个字符',
    dialogWidth: fsusDialogWidths.extraCompact,
    dialogDescription: 'note',
    dialogNoteClass: '',
    dialogNoteGapClass: 'gap-2',
    emptyTitle: `暂无${entityLabel}`,
    filteredEmptyTitle: '没有匹配项',
    emptyDescription: 'empty',
    filteredEmptyDescription: 'filtered',
    newButtonLabel: `新增${entityLabel}`,
    editLabel: '编辑',
    compactEditLabel: '编辑',
    compactEditIcon: true,
    compactDeleteIcon: true,
    fixActionColumn: true,
    nameDisplay: kind === 'category' ? 'text' : 'tag',
    nameColumnWidth: { compact: 148, wide: 200 },
    relationColumnWidth: { compact: 96, wide: 150 },
    actionColumnWidth: { compact: 156, wide: 300 },
    articleQueryKey: `${kind}Id`,
    dialogTitle: (editing: boolean) => editing ? '编辑' : '创建',
    submitButtonText: '确认提交',
    rules: { name: [{ required: true, message: '名称不能为空', trigger: 'blur' }] },
    loadItems: vi.fn().mockResolvedValue([]),
    loadExactMetadata: vi.fn().mockResolvedValue({ id: 7, name: 'Tech', description: 'cached desc' }),
    createItem: vi.fn().mockResolvedValue({ id: 9 }),
    updateItem: vi.fn().mockResolvedValue(null),
    deleteItem: vi.fn().mockResolvedValue(null),
    loadFallbackMessage: 'load failed',
    loadFailureLog: 'load failed:',
    loadExactMetadataFallbackMessage: '无法读取描述',
    loadExactMetadataFailureLog: 'exact metadata load failed:',
    duplicateWarning: (name: string) => `duplicate ${name}`,
    createFallbackMessage: 'create failed',
    updateFallbackMessage: 'update failed',
    createSuccessMessage: 'created',
    updateSuccessMessage: 'updated',
    postSaveWarningMessage: 'saved but list failed',
    deleteBlockedWarning: () => 'blocked',
    deleteConfirmMessage: () => 'confirm',
    deleteConfirmTitle: 'delete',
    deleteSuccessMessage: 'deleted',
    deleteFallbackMessage: 'delete failed',
    postDeleteWarningMessage: 'deleted but list failed',
    relationLockReason: () => 'locked'
  }
}

const validForm = {
  validate: vi.fn(async () => ({ ok: true, value: true }))
} as unknown as FormInstance

function mountManage(schema: TaxonomySchema<AdminTaxonomyItemBase>) {
  let state: ReturnType<typeof useAdminTaxonomyManage> | null = null
  const wrapper = mount(defineComponent({
    setup() {
      state = useAdminTaxonomyManage(schema.kind, schema)
      return () => h('div')
    }
  }))

  return {
    wrapper,
    get state() {
      if (!state) {
        throw new Error('taxonomy manage did not mount')
      }

      return state
    }
  }
}

describe('normalizeTaxonomyDescriptionInput', () => {
  it('submits whitespace-only input as null and rejects 501 unicode scalars', () => {
    expect(normalizeTaxonomyDescriptionInput('')).toEqual({ ok: true, description: null })
    expect(normalizeTaxonomyDescriptionInput('   \n\t')).toEqual({ ok: true, description: null })
    expect(normalizeTaxonomyDescriptionInput('  hello  ')).toEqual({ ok: true, description: 'hello' })
    expect(normalizeTaxonomyDescriptionInput('a'.repeat(taxonomyDescriptionMaxScalars))).toEqual({
      ok: true,
      description: 'a'.repeat(taxonomyDescriptionMaxScalars)
    })
    expect(normalizeTaxonomyDescriptionInput('a'.repeat(taxonomyDescriptionMaxScalars + 1))).toEqual({ ok: false })
    expect(normalizeTaxonomyDescriptionInput(`${'😀'.repeat(taxonomyDescriptionMaxScalars)}`)).toEqual({
      ok: true,
      description: '😀'.repeat(taxonomyDescriptionMaxScalars)
    })
    expect(normalizeTaxonomyDescriptionInput('😀'.repeat(taxonomyDescriptionMaxScalars + 1))).toEqual({ ok: false })
  })
})

describe.each(['category', 'tag'] as const)('useAdminTaxonomyManage %s', (kind) => {
  let schema: ReturnType<typeof createSchema>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    schema = createSchema(kind)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.showErrorToast.mockReset()
    mocks.showWarningToast.mockReset()
    mocks.toastSuccess.mockReset()
    mocks.toastError.mockReset()
    vi.mocked(validForm.validate).mockResolvedValue({ ok: true, value: true } as never)
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('creates with a null or non-empty description without reading exact metadata', async () => {
    const { wrapper, state } = mountManage(schema)
    await flushPromises()

    state.openDialog()
    expect(schema.loadExactMetadata).not.toHaveBeenCalled()
    expect(state.form.description).toBe('')
    expect(state.canSubmit.value).toBe(true)

    state.form.name = 'Docs'
    await state.submitForm(validForm)
    expect(schema.createItem).toHaveBeenCalledWith(
      { name: 'Docs', description: null },
      expect.anything()
    )

    schema.createItem.mockClear()
    state.openDialog()
    state.form.name = '  Docs  '
    state.form.description = '  about docs  '
    await state.submitForm(validForm)
    expect(schema.createItem).toHaveBeenCalledWith(
      { name: 'Docs', description: 'about docs' },
      expect.anything()
    )

    schema.createItem.mockClear()
    state.openDialog()
    state.form.name = 'Docs'
    state.form.description = '   '
    await state.submitForm(validForm)
    expect(schema.createItem).toHaveBeenCalledWith(
      { name: 'Docs', description: null },
      expect.anything()
    )

    wrapper.unmount()
  })

  it('rejects a 501-character description client-side', async () => {
    const { wrapper, state } = mountManage(schema)
    await flushPromises()
    state.openDialog()
    state.form.name = 'Docs'
    state.form.description = 'x'.repeat(taxonomyDescriptionMaxScalars + 1)
    await state.submitForm(validForm)
    expect(schema.createItem).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('loads exact metadata before allowing edit save and preserves description on name-only edits', async () => {
    const metadata = deferred<{ id: number; name: string; description: string | null }>()
    schema.loadExactMetadata.mockReturnValue(metadata.promise)
    const { wrapper, state } = mountManage(schema)
    await flushPromises()

    state.openDialog(sampleRow)
    expect(state.canSubmit.value).toBe(false)
    expect(schema.loadExactMetadata).toHaveBeenCalledWith(7, expect.objectContaining({ signal: expect.any(AbortSignal) }))

    await state.submitForm(validForm)
    expect(schema.updateItem).not.toHaveBeenCalled()

    metadata.resolve({ id: 7, name: 'Tech', description: 'keep me' })
    await flushPromises()
    expect(state.form.description).toBe('keep me')
    expect(state.canSubmit.value).toBe(true)

    state.form.name = 'Technology'
    await state.submitForm(validForm)
    expect(schema.updateItem).toHaveBeenCalledWith(
      7,
      { name: 'Technology', description: 'keep me' },
      expect.anything()
    )

    wrapper.unmount()
  })

  it('keeps a failed exact-metadata load non-submittable and does not silently submit null', async () => {
    schema.loadExactMetadata.mockRejectedValue(new Error('exact metadata unavailable'))
    const { wrapper, state } = mountManage(schema)
    await flushPromises()

    state.openDialog(sampleRow)
    await flushPromises()
    expect(state.canSubmit.value).toBe(false)
    expect(state.form.description).toBe('')
    expect(mocks.showErrorToast).toHaveBeenCalled()

    await state.submitForm(validForm)
    expect(schema.updateItem).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('clears the textarea as Description = null', async () => {
    schema.loadExactMetadata.mockResolvedValue({ id: 7, name: 'Tech', description: 'remove me' })
    const { wrapper, state } = mountManage(schema)
    await flushPromises()
    state.openDialog(sampleRow)
    await flushPromises()
    expect(state.form.description).toBe('remove me')

    state.form.description = '   '
    await state.submitForm(validForm)
    expect(schema.updateItem).toHaveBeenCalledWith(
      7,
      { name: 'Tech', description: null },
      expect.anything()
    )
    wrapper.unmount()
  })

  it('reopens after a successful edit with a fresh exact-metadata read rather than a stale cache value', async () => {
    schema.loadExactMetadata
      .mockResolvedValueOnce({ id: 7, name: 'Tech', description: 'stale cache' })
      .mockResolvedValueOnce({ id: 7, name: 'Tech', description: 'fresh after invalidation' })
    schema.loadItems.mockResolvedValue([sampleRow])
    const { wrapper, state } = mountManage(schema)
    await flushPromises()

    state.openDialog(sampleRow)
    await flushPromises()
    expect(state.form.description).toBe('stale cache')

    state.form.description = 'fresh after invalidation'
    await state.submitForm(validForm)
    await flushPromises()
    expect(state.dialogVisible.value).toBe(false)

    state.openDialog(sampleRow)
    await flushPromises()
    expect(schema.loadExactMetadata).toHaveBeenCalledTimes(2)
    expect(state.form.description).toBe('fresh after invalidation')
    expect(state.canSubmit.value).toBe(true)

    wrapper.unmount()
  })
})
