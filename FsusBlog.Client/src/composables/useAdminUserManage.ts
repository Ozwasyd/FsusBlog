import { computed, onMounted, onUnmounted, reactive, ref, shallowRef } from 'vue'
import { adminChangeStatus, adminResetPassword, getAdminUserList, type UserListItem, type UserQueryDto } from '@/api/admin'
import { usePow } from '@/composables/usePow'
import { useMutationFlow } from '@/composables/useMutationFlow'
import { useViewTask } from '@/composables/useViewTask'
import { useWindowEvents } from '@/composables/useWindowEvents'
import { TimeUtils } from '@/utils/time'
import { showWarningToast } from '@/utils/errorPresentation'

export interface UserListViewItem extends UserListItem {
  initials: string
  createdAtText: string
  lastLoginText: string
  roleShort: 'ADM' | 'USR'
  roleClass: string
  statusText: 'NORMAL' | 'BANNED' | 'DELETED'
  statusClass: string
  statusDotClass: string
  isAdmin: boolean
  isDeleted: boolean
}

export function useAdminUserManage() {
  const screenWidth = ref(window.innerWidth)
  const updateWidth = (): void => {
    screenWidth.value = window.innerWidth
  }
  useWindowEvents([{ name: 'resize', handler: updateWidth }])

  const isMobile = computed(() => screenWidth.value < 768)

  const loading = ref(false)
  const list = shallowRef<UserListItem[]>([])
  const listView = computed<UserListViewItem[]>(() =>
    list.value.map((item) => {
      const isAdmin = item.role === 'admin'
      const isDeleted = item.status === 2
      const isBanned = item.status === 1
      return {
        ...item,
        initials: item.username.substring(0, 2).toUpperCase(),
        createdAtText: TimeUtils.toFullLocalString(item.createTime),
        lastLoginText: item.lastLoginTime ? TimeUtils.toFullLocalString(item.lastLoginTime) : '--',
        roleShort: isAdmin ? 'ADM' : 'USR',
        roleClass: isAdmin ? 'text-red-500' : 'text-[#A1A1AA]',
        statusText: isDeleted ? 'DELETED' : isBanned ? 'BANNED' : 'NORMAL',
        statusClass: isDeleted ? 'text-[#A1A1AA]' : isBanned ? 'text-red-500' : 'text-emerald-600',
        statusDotClass: isDeleted ? 'bg-[#D4D4D8]' : isBanned ? 'bg-red-400' : 'bg-emerald-400',
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

  const buildSignalConfig = (signal: AbortSignal) => ({ signal })

  const processingId = ref<number | null>(null)
  const submitting = ref(false)
  const isProcessing = computed(() => submitting.value || powProvider.isCalculating.value)
  const isCalculating = computed(() => powProvider.isCalculating.value)

  const resetDialog = reactive({
    visible: false,
    targetUser: null as UserListItem | null,
    form: { newPassword: '' }
  })

  const banDialog = reactive({
    visible: false,
    targetUser: null as UserListItem | null,
    reason: '',
    quickReasons: ['发布违规内容', '恶意刷屏/垃圾信息', '账号安全异常', '违反社区准则']
  })

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
  }

  const onPageSizeChange = (pageSize: number): void => {
    queryParams.pageSize = pageSize
  }

  const onBanReasonChange = (reason: string): void => {
    banDialog.reason = reason
  }

  const onResetPasswordChange = (password: string): void => {
    resetDialog.form.newPassword = password
  }

  const handleSearch = (): void => {
    queryParams.page = 1
    void fetchData()
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
      banDialog.visible = true
      return
    }

    processingId.value = row.id
    submitting.value = true

    try {
      await mutation.confirmThenRun({
        message: `确定要为用户 "${row.username}" 解除封禁吗？`,
        title: '操作确认',
        confirmButtonText: '立即解封',
        type: 'info'
      }, async (signal) => {
        await adminChangeStatus({ userId: row.id, status: 0 }, buildSignalConfig(signal))
      }, {
        fallbackMessage: '操作失败',
        successMessage: `用户 ${row.username} 已解封`,
        postSuccessWarningMessage: `用户 ${row.username} 已解封，但列表同步失败，请稍后刷新`,
        onSuccess: fetchData
      })
    } finally {
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

    processingId.value = targetUser.id
    submitting.value = true

    try {
      await mutation.run(async (signal) =>
        await adminChangeStatus(
          {
            userId: targetUser.id,
            status: 1,
            reason: banDialog.reason
          },
          buildSignalConfig(signal)
        )
      , {
        fallbackMessage: '封禁操作失败',
        successMessage: `用户 ${targetUser.username} 已封禁`,
        postSuccessWarningMessage: `用户 ${targetUser.username} 已封禁，但列表同步失败，请稍后刷新`,
        onSuccess: async () => {
          banDialog.visible = false
          return await fetchData()
        }
      })
    } finally {
      processingId.value = null
      submitting.value = false
    }
  }

  const openResetDialog = (row: UserListItem): void => {
    resetDialog.targetUser = row
    resetDialog.form.newPassword = ''
    resetDialog.visible = true
  }

  const handleResetSubmit = async (): Promise<void> => {
    const newPassword = resetDialog.form.newPassword.trim()
    if (newPassword.length < 6) {
      showWarningToast('密码安全性不足（需6位以上）')
      return
    }

    const targetUser = resetDialog.targetUser
    if (!targetUser) {
      return
    }

    submitting.value = true

    try {
      await mutation.run(async (signal) =>
        await adminResetPassword(
          {
            userId: targetUser.id,
            newPassword
          },
          buildSignalConfig(signal)
        )
      , {
        fallbackMessage: '操作失败',
        successMessage: '密码重置成功',
        onSuccess: () => {
          resetDialog.visible = false
        }
      })
    } finally {
      submitting.value = false
    }
  }

  const getTargetInitials = (targetUser: UserListItem | null): string => {
    if (!targetUser?.username) {
      return '--'
    }
    return targetUser.username.substring(0, 2).toUpperCase()
  }

  onMounted(() => {
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
    fetchData,
    onKeywordChange,
    onStatusChange,
    onPageChange,
    onPageSizeChange,
    onBanReasonChange,
    onResetPasswordChange,
    handleSearch,
    handleToggleStatus,
    handleBanSubmit,
    openResetDialog,
    handleResetSubmit,
    getTargetInitials
  }
}
