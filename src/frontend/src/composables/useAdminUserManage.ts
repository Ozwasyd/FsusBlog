import { computed, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { adminChangeStatus, adminResetPassword, getAdminUserList, type UserListItem, type UserQueryDto } from '@/api/admin'
import { usePow } from '@/composables/usePow'
import { useMutationFlow } from '@/composables/useMutationFlow'
import { useRowStateMotion } from '@/composables/useRowStateMotion'
import { useViewTask } from '@/composables/useViewTask'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { useAdminSensitiveProof } from '@/composables/useAdminSensitiveProof'
import { TimeUtils } from '@/utils/time'
import { showWarningToast } from '@/utils/errorPresentation'
import { toast } from '@/fsusui/feedback'

export interface UserListViewItem extends UserListItem {
  initials: string
  createdAtText: string
  lastLoginText: string
  roleShort: 'ADM' | 'USR'
  roleLabel: string
  roleClass: string
  statusText: string
  statusLabel: string
  statusCode: 'NORMAL' | 'BANNED' | 'DELETED'
  statusClass: string
  statusDotClass: string
  isAdmin: boolean
  isDeleted: boolean
}

export function useAdminUserManage() {
  const isMobile = useMediaQuery('(max-width: 767px)')
  const route = useRoute()
  const router = useRouter()

  const list = shallowRef<UserListItem[]>([])
  const listView = computed<UserListViewItem[]>(() =>
    list.value.map((item) => {
      const isAdmin = item.role === 'admin'
      const isDeleted = item.status === 2
      const isBanned = item.status === 1
      const statusCode = isDeleted ? 'DELETED' : isBanned ? 'BANNED' : 'NORMAL'
      const statusLabel = isDeleted ? '已注销' : isBanned ? '已封禁' : '正常'
      const roleShort = isAdmin ? 'ADM' : 'USR'
      return {
        ...item,
        initials: item.username.substring(0, 2).toUpperCase(),
        createdAtText: TimeUtils.toFullLocalString(item.createTime),
        lastLoginText: item.lastLoginTime ? TimeUtils.toFullLocalString(item.lastLoginTime) : '--',
        roleShort,
        roleLabel: isAdmin ? '管理员' : '用户',
        roleClass: isAdmin ? 'text-[var(--fsusblog-color-error)]' : 'text-[var(--fsusblog-text-muted)]',
        statusText: statusLabel,
        statusLabel,
        statusCode,
        statusClass: isDeleted ? 'text-[var(--fsusblog-text-muted)]' : isBanned ? 'text-[var(--fsusblog-color-error)]' : 'text-[var(--fsusblog-color-success)]',
        statusDotClass: isDeleted ? 'bg-[var(--fsusblog-panel-border-strong)]' : isBanned ? 'bg-[var(--fsusblog-color-error)]' : 'bg-[var(--fsusblog-color-success)]',
        isAdmin,
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

  const resetDialog = reactive({
    visible: false,
    targetUser: null as UserListItem | null,
    form: {
      newPassword: '',
      confirmUsername: ''
    }
  })

  const banDialog = reactive({
    visible: false,
    targetUser: null as UserListItem | null,
    reason: '',
    confirmUsername: '',
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

  const resetPasswordPolicy = computed(() => {
    const password = resetDialog.form.newPassword
    const username = resetDialog.targetUser?.username ?? ''
    const normalizedPassword = password.toLowerCase()
    const normalizedUsername = username.toLowerCase()
    const checks = [
      password.length >= 10,
      !/\s/.test(password),
      !normalizedUsername || !normalizedPassword.includes(normalizedUsername),
      /[A-Z]/.test(password),
      /[a-z]/.test(password),
      /\d/.test(password),
      /[^A-Za-z0-9]/.test(password)
    ]
    const passed = checks.filter(Boolean).length

    return {
      passed,
      level: passed >= 7 ? '强' : passed >= 5 ? '中' : '弱',
      hasWhitespace: /\s/.test(password),
      isTooShort: password.length > 0 && password.length < 10,
      containsUsername: Boolean(normalizedUsername && normalizedPassword.includes(normalizedUsername))
    }
  })

  const canSubmitResetPassword = computed(() => {
    const targetUsername = resetDialog.targetUser?.username ?? ''
    return Boolean(
      targetUsername &&
      resetDialog.form.confirmUsername.trim() === targetUsername &&
      resetPasswordPolicy.value.passed >= 5 &&
      !resetPasswordPolicy.value.hasWhitespace &&
      !resetPasswordPolicy.value.isTooShort &&
      !resetPasswordPolicy.value.containsUsername
    )
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
    const targetUsername = banDialog.targetUser?.username ?? ''
    return Boolean(
      targetUsername &&
      banDialog.confirmUsername.trim() === targetUsername &&
      !banReasonValidation.value.isEmpty &&
      !banReasonValidation.value.isTooLong &&
      !banReasonValidation.value.hasUnsafeChars
    )
  })

  const generateStrongPassword = (): void => {
    const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*']
    const chars = groups.join('')
    const bytes = new Uint8Array(18 - groups.length)
    crypto.getRandomValues(bytes)
    const suffix = Array.from(bytes, (value) => chars[value % chars.length])
    const seed = groups.map((group) => group[crypto.getRandomValues(new Uint8Array(1))[0] % group.length])
    resetDialog.form.newPassword = [...seed, ...suffix].sort(() => crypto.getRandomValues(new Uint8Array(1))[0] - 128).join('')
  }

  const copyResetPassword = async (): Promise<void> => {
    if (!resetDialog.form.newPassword) {
      showWarningToast('请先生成或输入新密码')
      return
    }

    try {
      await navigator.clipboard.writeText(resetDialog.form.newPassword)
      toast.success('新密码已复制')
    } catch {
      showWarningToast('当前浏览器不允许复制，请手动复制新密码')
    }
  }

  const fetchData = async (): Promise<boolean> => {
    const res = await loadTask.run(
      async (signal) => await getAdminUserList(queryParams, buildSignalConfig(signal)),
      {
        fallbackMessage: '用户列表加载失败',
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
      rowMotion.markUpdated(res.items.slice(0, 20).map((item) => item.id), `用户列表已刷新：${res.items.length} 条可见记录`)
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

  const onResetPasswordChange = (password: string): void => {
    resetDialog.form.newPassword = password
  }

  const onResetPasswordConfirmChange = (value: string): void => {
    resetDialog.form.confirmUsername = value
  }

  const onBanConfirmChange = (value: string): void => {
    banDialog.confirmUsername = value
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

  const handleToggleStatus = async (row: UserListItem): Promise<void> => {
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
      banDialog.confirmUsername = ''
      banDialog.visible = true
      return
    }

    processingId.value = row.id
    submitting.value = true
    rowMotion.markPending(row.id, '正在变更用户状态')

    let completed = false
    try {
      await mutation.confirmThenRun({
        message: `确定要为用户 "${row.username}" 解除封禁吗？当前接口未返回封禁原因，请确认已核对审计记录。`,
        title: '操作确认',
        confirmButtonText: '立即解封'
      }, async (signal) => {
        const mfaProofToken = await ensureAdminSensitiveProof()
        await adminChangeStatus({ userId: row.id, status: 0 }, { ...buildSignalConfig(signal), mfaProofToken })
      }, {
        fallbackMessage: '操作失败',
        successMessage: `用户 ${row.username} 已解封`,
        postSuccessWarningMessage: `用户 ${row.username} 已解封，但列表同步失败，请稍后刷新`,
        onSuccess: async () => {
          completed = true
          return await fetchData()
        }
      })
    } finally {
      if (!completed) {
        rowMotion.clear(row.id)
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
      showWarningToast('请输入目标用户名以确认封禁操作')
      return
    }

    processingId.value = targetUser.id
    submitting.value = true
    rowMotion.markPending(targetUser.id, '正在封禁用户')

    let completed = false
    try {
      await mutation.run(async (signal) => {
        const mfaProofToken = await ensureAdminSensitiveProof()
        await adminChangeStatus(
          {
            userId: targetUser.id,
            status: 1,
            reason: banDialog.reason.trim()
          },
          { ...buildSignalConfig(signal), mfaProofToken }
        )
      }, {
        fallbackMessage: '封禁操作失败',
        successMessage: `用户 ${targetUser.username} 已封禁`,
        postSuccessWarningMessage: `用户 ${targetUser.username} 已封禁，但列表同步失败，请稍后刷新`,
        onSuccess: async () => {
          completed = true
          banDialog.visible = false
          return await fetchData()
        }
      })
    } finally {
      if (!completed) {
        rowMotion.clear(targetUser.id)
      }
      processingId.value = null
      submitting.value = false
    }
  }

  const openResetDialog = (row: UserListItem): void => {
    resetDialog.targetUser = row
    resetDialog.form.newPassword = ''
    resetDialog.form.confirmUsername = ''
    resetDialog.visible = true
  }

  const handleResetSubmit = async (): Promise<void> => {
    const newPassword = resetDialog.form.newPassword
    if (/\s/.test(newPassword)) {
      showWarningToast('密码不能包含空白字符')
      return
    }
    if (newPassword.length < 10 || resetPasswordPolicy.value.passed < 5) {
      showWarningToast('密码安全性不足（需10位以上并包含多种字符）')
      return
    }

    const targetUser = resetDialog.targetUser
    if (!targetUser) {
      return
    }
    if (!canSubmitResetPassword.value) {
      showWarningToast('请输入目标用户名以确认重置密码')
      return
    }

    processingId.value = targetUser.id
    submitting.value = true
    rowMotion.markPending(targetUser.id, '正在重置密码')

    let completed = false
    try {
      await mutation.run(async (signal) => {
        const mfaProofToken = await ensureAdminSensitiveProof()
        await adminResetPassword(
          {
            userId: targetUser.id,
            newPassword
          },
          { ...buildSignalConfig(signal), mfaProofToken }
        )
      }, {
        fallbackMessage: '操作失败',
        successMessage: '密码已重置，用户已强制下线',
        onSuccess: () => {
          completed = true
          rowMotion.markUpdated(targetUser.id, '密码已重置')
          resetDialog.visible = false
        }
      })
    } finally {
      if (!completed) {
        rowMotion.clear(targetUser.id)
      }
      processingId.value = null
      submitting.value = false
    }
  }

  const getTargetInitials = (targetUser: UserListItem | null): string => {
    if (!targetUser?.username) {
      return '--'
    }
    return targetUser.username.substring(0, 2).toUpperCase()
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
    isMobile,
    loading: loadTask.loading,
    list,
    listView,
    total,
    queryParams,
    powProvider,
    isCalculating,
    processingId,
    isProcessing,
    resetDialog,
    banDialog,
    statusFilterLabel,
    activeFilterChips,
    rowMotion,
    resetPasswordPolicy,
    canSubmitResetPassword,
    banReasonValidation,
    canSubmitBan,
    fetchData,
    onKeywordChange,
    onStatusChange,
    onPageChange,
    onPageSizeChange,
    onBanReasonChange,
    onResetPasswordChange,
    onResetPasswordConfirmChange,
    onBanConfirmChange,
    handleSearch,
    resetFilters,
    removeFilter,
    handleToggleStatus,
    handleBanSubmit,
    openResetDialog,
    handleResetSubmit,
    generateStrongPassword,
    copyResetPassword,
    getTargetInitials
  }
}
