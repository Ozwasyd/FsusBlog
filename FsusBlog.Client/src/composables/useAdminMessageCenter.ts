import { computed, onMounted, onUnmounted, reactive, ref, shallowRef } from 'vue'
import { ElMessage, type FormInstance } from 'element-plus'
import type { AxiosRequestConfig } from 'axios'
import { messageApi, type BroadcastRequest, type MessageItem } from '@/api/message'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { usePow } from '@/composables/usePow'
import { getErrorMessage, isAbortError } from '@/utils/errors'
import { createAdminMessageManageViewContract, type AdminMessageManageViewContract } from '@/view-contracts/adminMessageManage'

const HISTORY_PAGE_SIZE = 15

export function useAdminMessageCenter() {
  const formRef = ref<FormInstance>()
  const powProvider = usePow()

  const submitting = ref(false)
  const loadingHistory = ref(false)
  const lastBroadcastTime = ref(0)
  const currentTime = ref(Date.now())

  const broadcastCooldown = computed(() => {
    if (lastBroadcastTime.value === 0) {
      return 0
    }

    const remaining = Math.ceil((lastBroadcastTime.value + 10000 - currentTime.value) / 1000)
    return remaining > 0 ? remaining : 0
  })

  const isProcessing = computed(() => submitting.value || powProvider.isCalculating.value)

  const sendType = ref<'broadcast' | 'direct'>('broadcast')
  const isBroadcastMode = computed(() => sendType.value === 'broadcast')
  const isDirectMode = computed(() => sendType.value === 'direct')
  const history = shallowRef<MessageItem[]>([])
  const isSubmitDisabled = computed(
    () => isBroadcastMode.value && broadcastCooldown.value > 0
  )
  const messageView = computed<AdminMessageManageViewContract>(() =>
    createAdminMessageManageViewContract({
      sendType: sendType.value,
      targetUserId: form.targetUserId,
      title: form.title,
      content: form.content,
      broadcastCooldown: broadcastCooldown.value,
      isPowCalculating: powProvider.isCalculating.value,
      isProcessing: isProcessing.value,
      loadingHistory: loadingHistory.value,
      history: history.value
    })
  )

  const form = reactive({
    targetUserId: '',
    title: '',
    content: ''
  })

  const historyTask = useAbortableTask()
  const submitTask = useAbortableTask()
  let cooldownTimer: ReturnType<typeof setInterval> | null = null

  const buildSignalConfig = (signal: AbortSignal): AxiosRequestConfig => ({ signal })
  const isCancelError = (error: unknown): boolean => error === 'cancel'
  const clearComposeForm = (): void => {
    form.title = ''
    form.content = ''
    form.targetUserId = ''
    formRef.value?.resetFields()
  }

  const rules = {
    targetUserId: [
      { required: true, message: '必须指定接收者', trigger: 'blur' },
      { pattern: /^\d+$/, message: 'UID必须为纯数字', trigger: 'blur' }
    ],
    title: [
      { required: true, message: '标题不能为空', trigger: 'blur' },
      { pattern: /^[^<|>|'|"]+$/, message: '禁止包含 HTML 标签', trigger: 'blur' }
    ],
    content: [
      { required: true, message: '内容不能为空', trigger: 'blur' },
      { max: 2000, message: '内容长度不得超过 2000 字符', trigger: 'blur' }
    ]
  }

  const fetchHistory = async (): Promise<void> => {
    loadingHistory.value = true
    try {
      await historyTask.run(async (signal) => {
        const res = await messageApi.adminGetHistory(1, HISTORY_PAGE_SIZE, buildSignalConfig(signal))
        history.value = Array.isArray(res) ? res : []
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        console.error('[Admin Message] Sync failed:', error)
      }
    } finally {
      loadingHistory.value = false
    }
  }

  const handleRevoke = async (id: string): Promise<void> => {
    if (isProcessing.value) {
      return
    }

    submitting.value = true
    try {
      await submitTask.run(async (signal) => {
        await messageApi.adminRevokeMessage(id, buildSignalConfig(signal))
        if (!signal.aborted) {
          ElMessage.success('消息已彻底从全网撤回')
          await fetchHistory()
        }
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        console.error('[Admin Message] Revoke Error:', error)
      }
    } finally {
      submitting.value = false
    }
  }

  const submitForm = async (): Promise<void> => {
    if (!formRef.value || isProcessing.value) {
      return
    }
    if (isSubmitDisabled.value) {
      return
    }

    try {
      await formRef.value.validate()
      submitting.value = true

      await submitTask.run(async (signal) => {
        const payload: BroadcastRequest = {
          title: form.title.trim(),
          content: form.content.trim()
        }

        const config = buildSignalConfig(signal)

        if (isBroadcastMode.value) {
          await messageApi.adminPublishBroadcast(payload, config)
          lastBroadcastTime.value = Date.now()
        } else {
          await messageApi.adminSendDirect(
            {
              ...payload,
              targetUserId: form.targetUserId
            },
            config
          )
        }

        ElMessage.success('指令执行成功')
        clearComposeForm()
        await fetchHistory()
      })
    } catch (error: unknown) {
      if (!isAbortError(error) && !isCancelError(error)) {
        console.error('[Admin Message] Distribution Error:', getErrorMessage(error, 'unknown'))
      }
    } finally {
      submitting.value = false
    }
  }

  onMounted(() => {
    void fetchHistory()
    powProvider.prewarm()
    cooldownTimer = setInterval(() => {
      currentTime.value = Date.now()
    }, 1000)
  })

  onUnmounted(() => {
    historyTask.cancel()
    submitTask.cancel()
    if (cooldownTimer) {
      clearInterval(cooldownTimer)
      cooldownTimer = null
    }
  })

  return {
    formRef,
    powProvider,
    loadingHistory,
    isProcessing,
    isBroadcastMode,
    isDirectMode,
    broadcastCooldown,
    isSubmitDisabled,
    messageView,
    sendType,
    history,
    form,
    rules,
    fetchHistory,
    handleRevoke,
    submitForm
  }
}
