import { computed, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { adminChangeStatus, getAdminUserList, type AdminAccountListItem, type UserQueryDto } from '@/api/admin'
import { usePow } from '@/composables/usePow'
import { useMutationFlow } from '@/composables/useMutationFlow'
import { useRowStateMotion } from '@/composables/useRowStateMotion'
import { useViewTask } from '@/composables/useViewTask'
import { useAdminSensitiveProof } from '@/composables/useAdminSensitiveProof'
import { TimeUtils } from '@/utils/time'
import { showWarningToast } from '@/utils/errorPresentation'

export interface UserListViewItem extends AdminAccountListItem {
  initials: string
  id: number
  displayHandle: string
  identityKindLabel: string
  createdAtText: string
  privacyInitializedText: string
  credentialSummary: string
  anonymousCredentialText: string
  riskFlagsText: string
  statusText: string
  statusLabel: string
  statusCode: 'NORMAL' | 'BANNED' | 'DELETED'
  statusClass: string
  statusDotClass: string
  isDeleted: boolean
}

export function useAdminUserManage() {
  const route = useRoute()
  const router = useRouter()

  const list = shallowRef<AdminAccountListItem[]>([])
  const credentialStatusLabel = (value: string): string => {
    switch (value) {
      case 'active':
        return '可用'
      case 'revoked':
        return '已停用'
      case 'pending':
        return '待确认'
      case 'missing':
      case '':
        return '未建立'
      default:
        return '未知状态'
    }
  }

  const credentialLevelSuffix = (value: string): string => {
    switch (value) {
      case 'verified':
        return '（已验证）'
      case 'elevated':
        return '（增强验证）'
      default:
        return ''
    }
  }

  const listView = computed<UserListViewItem[]>(() =>
    list.value.map((item) => {
      const isDeleted = item.status === 2
      const isBanned = item.status === 1
      const statusCode = isDeleted ? 'DELETED' : isBanned ? 'BANNED' : 'NORMAL'
      const statusLabel = isDeleted ? '已注销' : isBanned ? '已封禁' : '正常'
      const displayHandle = item.publicHandle?.trim() || `account-${item.accountId}`
      const identityKindLabel = item.identityKind === 'anonymous_account' ? '匿名账号' : item.identityKind
      const passkeyText = item.passkeyInitialized ? '通行密钥已设置' : '未设置通行密钥'
      const recoveryText = item.recoveryInitialized ? '恢复密钥已设置' : '未设置恢复密钥'
      const anonymousCredentialText = `${credentialStatusLabel(item.anonymousCredentialStatus)}${credentialLevelSuffix(item.anonymousCredentialLevel)}`
      const credentialSummary = `${passkeyText}；${recoveryText}`
      return {
        ...item,
        id: item.accountId,
        initials: displayHandle.substring(0, 2).toUpperCase(),
        displayHandle,
        identityKindLabel,
        createdAtText: TimeUtils.toFullLocalString(item.createTime),
        privacyInitializedText: item.privacyInitializedAt ? TimeUtils.toFullLocalString(item.privacyInitializedAt) : '未完成隐私初始化',
        credentialSummary,
        anonymousCredentialText,
        riskFlagsText: item.riskFlags === 0 ? '无风险标记' : `风险标记 ${item.riskFlags}`,
        statusText: statusLabel,
        statusLabel,
        statusCode,
        statusClass: isDeleted ? 'text-[var(--fsusblog-text-muted)]' : isBanned ? 'text-[var(--fsusblog-color-error)]' : 'text-[var(--fsusblog-color-success)]',
        statusDotClass: isDeleted ? 'bg-[var(--fsusblog-panel-border-strong)]' : isBanned ? 'bg-[var(--fsusblog-color-error)]' : 'bg-[var(--fsusblog-color-success)]',
        isDeleted
      }
    })
  )
  const total = ref(0)
  const queryParams = reactive<UserQueryDto>({
    page: 1,
    pageSize: 20,
    keyword: '',
    status: undefined
  })

  const powProvider = usePow()
  const loadTask = useViewTask()
  const mutation = useMutationFlow()
  const rowMotion = useRowStateMotion({ visibleLimit: 20 })
  const { ensureAdminSensitiveProof } = useAdminSensitiveProof()

  const buildSignalConfig = (signal: AbortSignal) => ({ signal })

  const processingId = ref<number | null>(null)
  const submitting = ref(false)
  const isProcessing = computed(() => submitting.value || powProvider.isCalculating.value)
  const isCalculating = computed(() => powProvider.isCalculating.value)

  const banDialog = reactive({
    visible: false,
    targetUser: null as UserListViewItem | null,
    reason: '',
    confirmAccountLabel: '',
    quickReasons: ['发布违规内容', '恶意刷屏/垃圾信息', '账号安全异常', '违反社区准则']
  })

  const parsePositiveInt = (value: unknown, fallback: number): number => {
    const raw = Array.isArray(value) ? value[0] : value
    const parsed = Number(raw)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
  }

  const parseStatus = (value: unknown): number | undefined => {
    const raw = Array.isArray(value) ? value[0] : value
    if (raw === undefined || raw === null || raw === '') {
      return undefined
    }
    const parsed = Number(raw)
    return [0, 1, 2].includes(parsed) ? parsed : undefined
  }

  const hydrateQueryFromRoute = (): void => {
    queryParams.page = parsePositiveInt(route.query.page, 1)
    queryParams.pageSize = parsePositiveInt(route.query.pageSize, 20)
    queryParams.keyword = typeof route.query.keyword === 'string' ? route.query.keyword : ''
    queryParams.status = parseStatus(route.query.status)
  }

  const buildRouteQuery = (): Record<string, string> => {
    const query: Record<string, string> = {}
    if (queryParams.page && queryParams.page > 1) {
      query.page = String(queryParams.page)
    }
    if (queryParams.pageSize && queryParams.pageSize !== 20) {
      query.pageSize = String(queryParams.pageSize)
    }
    const keyword = queryParams.keyword?.trim()
    if (keyword) {
      query.keyword = keyword
    }
    if (queryParams.status !== undefined) {
      query.status = String(queryParams.status)
    }
    return query
  }

  const syncQueryToRoute = async (): Promise<void> => {
    await router.replace({ name: 'ManageUsers', query: buildRouteQuery() })
  }

  const statusFilterLabel = computed(() => {
    if (queryParams.status === 0) {
      return '正常'
    }
    if (queryParams.status === 1) {
      return '已封禁'
    }
    if (queryParams.status === 2) {
      return '已注销'
    }
    return ''
  })

  const activeFilterChips = computed(() => {
    const chips: Array<{ key: 'status' | 'keyword'; label: string }> = []
    if (statusFilterLabel.value) {
      chips.push({ key: 'status', label: `状态：${statusFilterLabel.value}` })
    }
    const keyword = queryParams.keyword?.trim()
    if (keyword) {
      chips.push({ key: 'keyword', label: `关键词：${keyword}` })
    }
    return chips
  })

  const banReasonValidation = computed(() => {
    const reason = banDialog.reason.trim()
    return {
      isEmpty: reason.length === 0,
      isTooLong: reason.length > 100,
      hasUnsafeChars: /[\u0000-\u001f<>`"\\]/.test(reason),
      preview: reason ? `你已被封禁，原因：${reason}` : '你已被封禁，原因：未填写'
    }
  })

  const canSubmitBan = computed(() => {
    const targetAccountLabel = banDialog.targetUser?.displayHandle ?? ''
    return Boolean(
      targetAccountLabel &&
      banDialog.confirmAccountLabel.trim() === targetAccountLabel &&
      !banReasonValidation.value.isEmpty &&
      !banReasonValidation.value.isTooLong &&
      !banReasonValidation.value.hasUnsafeChars
    )
  })

  const fetchData = async (): Promise<boolean> => {
    const res = await loadTask.run(
      async (signal) => await getAdminUserList(queryParams, buildSignalConfig(signal)),
      {
        fallbackMessage: '账号列表加载失败',
        onError: (error) => {
        console.error('[Admin Users] Load failed:', error)
          list.value = []
          total.value = 0
        }
      }
    )

    if (res) {
      list.value = res.items
      total.value = res.total
      rowMotion.markUpdated(res.items.slice(0, 20).map((item) => item.accountId), `账号列表已刷新：${res.items.length} 条可见记录`)
    }

    return res !== undefined
  }

  const onKeywordChange = (keyword: string): void => {
    queryParams.keyword = keyword
  }

  const onStatusChange = (status: number | undefined): void => {
    queryParams.status = status
    handleSearch()
  }

  const onPageChange = (page: number): void => {
    queryParams.page = page
    void syncQueryToRoute().then(fetchData)
  }

  const onPageSizeChange = (pageSize: number): void => {
    queryParams.pageSize = pageSize
    queryParams.page = 1
    void syncQueryToRoute().then(fetchData)
  }

  const onBanReasonChange = (reason: string): void => {
    banDialog.reason = reason
  }

  const onBanConfirmChange = (value: string): void => {
    banDialog.confirmAccountLabel = value
  }

  const handleSearch = (): void => {
    queryParams.page = 1
    void syncQueryToRoute().then(fetchData)
  }

  const resetFilters = (): void => {
    queryParams.keyword = ''
    queryParams.status = undefined
    queryParams.page = 1
    void syncQueryToRoute().then(fetchData)
  }

  const removeFilter = (key: 'status' | 'keyword'): void => {
    if (key === 'status') {
      queryParams.status = undefined
    } else {
      queryParams.keyword = ''
    }
    queryParams.page = 1
    void syncQueryToRoute().then(fetchData)
  }

  const handleToggleStatus = async (row: UserListViewItem): Promise<void> => {
    if (isProcessing.value) {
      return
    }

    if (row.status === 2) {
      showWarningToast('已注销账户不可再变更状态')
      return
    }

    if (row.status === 0) {
      banDialog.targetUser = row
      banDialog.reason = ''
      banDialog.confirmAccountLabel = ''
      banDialog.visible = true
      return
    }

    processingId.value = row.accountId
    submitting.value = true
    rowMotion.markPending(row.accountId, '正在变更匿名账号状态')

    let completed = false
    try {
      await mutation.confirmThenRun({
        message: `确定要为匿名账号 "${row.displayHandle}" 解除封禁吗？当前接口未返回封禁原因，请确认已核对审计记录。`,
        title: '操作确认',
        confirmButtonText: '立即解封'
      }, async (signal) => {
        const mfaProofToken = await ensureAdminSensitiveProof()
        await adminChangeStatus({ accountId: row.accountId, status: 0 }, { ...buildSignalConfig(signal), mfaProofToken })
      }, {
        fallbackMessage: '操作失败',
        successMessage: `账号 ${row.displayHandle} 已解封`,
        postSuccessWarningMessage: `账号 ${row.displayHandle} 已解封，但列表同步失败，请稍后刷新`,
        onSuccess: async () => {
          completed = true
          return await fetchData()
        }
      })
    } finally {
      if (!completed) {
        rowMotion.clear(row.accountId)
      }
      processingId.value = null
      submitting.value = false
    }
  }

  const handleBanSubmit = async (): Promise<void> => {
    const targetUser = banDialog.targetUser
    if (!targetUser || !banDialog.reason.trim()) {
      showWarningToast('请选择或输入封禁理由')
      return
    }
    if (banReasonValidation.value.isTooLong || banReasonValidation.value.hasUnsafeChars) {
      showWarningToast('封禁原因包含无效字符或长度超过限制')
      return
    }
    if (!canSubmitBan.value) {
      showWarningToast('请输入目标账号标识以确认封禁操作')
      return
    }

    processingId.value = targetUser.accountId
    submitting.value = true
    rowMotion.markPending(targetUser.accountId, '正在封禁匿名账号')

    let completed = false
    try {
      await mutation.run(async (signal) => {
        const mfaProofToken = await ensureAdminSensitiveProof()
        await adminChangeStatus(
          {
            accountId: targetUser.accountId,
            status: 1,
            reason: banDialog.reason.trim()
          },
          { ...buildSignalConfig(signal), mfaProofToken }
        )
      }, {
        fallbackMessage: '封禁操作失败',
        successMessage: `账号 ${targetUser.displayHandle} 已封禁`,
        postSuccessWarningMessage: `账号 ${targetUser.displayHandle} 已封禁，但列表同步失败，请稍后刷新`,
        onSuccess: async () => {
          completed = true
          banDialog.visible = false
          return await fetchData()
        }
      })
    } finally {
      if (!completed) {
        rowMotion.clear(targetUser.accountId)
      }
      processingId.value = null
      submitting.value = false
    }
  }

  const getTargetInitials = (targetUser: UserListViewItem | null): string => {
    if (!targetUser?.displayHandle) {
      return '账号'
    }
    return targetUser.displayHandle.substring(0, 2).toUpperCase()
  }

  watch(() => route.query, () => {
    const before = JSON.stringify(buildRouteQuery())
    hydrateQueryFromRoute()
    const after = JSON.stringify(buildRouteQuery())
    if (before !== after) {
      void fetchData()
    }
  })

  onMounted(() => {
    hydrateQueryFromRoute()
    powProvider.prewarm()
    void fetchData()
  })

  onUnmounted(() => {
    loadTask.cancel()
    mutation.cancel()
  })

  return {
    loading: loadTask.loading,
    list,
    listView,
    total,
    queryParams,
    powProvider,
    isCalculating,
    processingId,
    isProcessing,
    banDialog,
    statusFilterLabel,
    activeFilterChips,
    rowMotion,
    banReasonValidation,
    canSubmitBan,
    fetchData,
    onKeywordChange,
    onStatusChange,
    onPageChange,
    onPageSizeChange,
    onBanReasonChange,
    onBanConfirmChange,
    handleSearch,
    resetFilters,
    removeFilter,
    handleToggleStatus,
    handleBanSubmit,
    getTargetInitials
  }
}
