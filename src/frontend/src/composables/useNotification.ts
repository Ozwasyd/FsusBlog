import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { getPowChallenge } from '@/api/auth'
import { usePow } from '@/composables/usePow'
import { invalidateSearchIndexMemory } from '@/services/localSearch'
import { forwardCacheControlPayload, forwardSearchIndexUpdate, postSwControlMessage } from '@/services/serviceWorkerRuntime'
import { sseRuntime } from '@/services/sseRuntime'
import { SseEventType, SseFailureCodes, type ArticleUpdatePayload, type CacheControlPayload, type PowParams, type SearchIndexUpdatePayload, type SseEventV2, type SseFailureCode, type UserStatusPayload } from '@/services/sseTypes'
import { useSseStore } from '@/store/sse'
import { useUserStore } from '@/store/user'
import { getBrowserFp } from '@/utils/fingerprint'
import { showErrorToast } from '@/utils/errorPresentation'
import { toast } from '@/utils/toast'
import { decodePowCache, encodePowCache } from '@/services/powProofCodec'

const currentMode = ref<'auth' | 'guest' | ''>('')
const isInitializing = ref(false)

let lastReauthTime = 0
let memoryPowCache: PowParams | null = null
let bindingsInitialized = false
let reauthRetryTimer: ReturnType<typeof setTimeout> | null = null
let initNotificationPromise: Promise<void> | null = null
let pendingInitMode: 'auth' | 'guest' | '' = ''
let articleCreatedToastTimer: ReturnType<typeof setTimeout> | null = null
let pendingArticleCreatedIds: number[] = []

const POW_STORAGE_KEY = 'sse_guest_pow'

function clearReauthRetryTimer(): void {
    if (!reauthRetryTimer) {
        return
    }

    clearTimeout(reauthRetryTimer)
    reauthRetryTimer = null
}

function disposeNotificationBindings(): void {
    clearReauthRetryTimer()
    if (articleCreatedToastTimer) {
        clearTimeout(articleCreatedToastTimer)
        articleCreatedToastTimer = null
    }
    pendingArticleCreatedIds = []
    sseRuntime.onEvent = undefined
    sseRuntime.onCursorChange = undefined
    sseRuntime.onStatusChange = undefined
    sseRuntime.onDuplicateEvent = undefined
    sseRuntime.onProtocolError = undefined
    sseRuntime.onHandshakeFailure = undefined
    sseRuntime.onReconnectSuccess = undefined
    bindingsInitialized = false
}

function scheduleArticleCreatedToast(articleId: number, router: ReturnType<typeof useRouter>): void {
    pendingArticleCreatedIds.push(articleId)
    if (articleCreatedToastTimer) {
        return
    }

    articleCreatedToastTimer = setTimeout(() => {
        articleCreatedToastTimer = null
        const ids = [...new Set(pendingArticleCreatedIds)]
        pendingArticleCreatedIds = []
        if (ids.length === 0) {
            return
        }

        if (ids.length === 1) {
            const targetId = ids[0]!
            toast.article('发现新文章，点击阅读', () => {
                void router.push(`/article/${targetId}`)
            })
            return
        }

        toast.info(`发现 ${ids.length} 篇新文章，列表已更新`, 6000)
    }, 750)
}

export function useNotification() {
    const userStore = useUserStore()
    const sseStore = useSseStore()
    const { unreadCount } = storeToRefs(sseStore)
    const router = useRouter()
    const { calculate, prewarm, isCalculating } = usePow()

    const getOrRefreshPow = async (): Promise<PowParams> => {
        const nowInSeconds = Math.floor(Date.now() / 1000)

        if (memoryPowCache && nowInSeconds - memoryPowCache.timestamp < 275) {
            return memoryPowCache
        }

        try {
            const raw = sessionStorage.getItem(POW_STORAGE_KEY)
            if (raw) {
                const cached = decodePowCache(raw)
                if (nowInSeconds - cached.timestamp < 275) {
                    memoryPowCache = cached
                    return cached
                }
            }
        } catch {
            sessionStorage.removeItem(POW_STORAGE_KEY)
        }

        prewarm()
        const fp = getBrowserFp()
        const challengeRes = await getPowChallenge()
        const { salt, difficulty, timestamp, signature } = challengeRes
        const { nonce } = await calculate(salt, fp, difficulty)
        const pow: PowParams = { nonce, salt, fp, signature, difficulty, timestamp }

        memoryPowCache = pow
        sessionStorage.setItem(POW_STORAGE_KEY, encodePowCache(pow))

        return pow
    }

    const handleUserStatusChange = (data: UserStatusPayload): void => {
        const oldStatus = userStore.userInfo?.status
        const newStatus = Number(data.status)
        const isStatusChanged = oldStatus !== undefined && Number(oldStatus) !== newStatus

        userStore.updateStatus(newStatus, data.reason)

        if (!isStatusChanged) {
            return
        }

        if (newStatus === 1) {
            showErrorToast(`账户管控通知：${data.reason || '您的账号已被限制操作'}`, '账户管控通知：您的账号已被限制操作', 10000)
            return
        }

        if (newStatus === 0) {
            toast.success('账户通知：您的账号已恢复正常使用')
        }
    }

    const handleIncomingEvent = (event: SseEventV2): void => {
        sseStore.consumeEvent(event)

        if (event.type === SseEventType.GlobalNoticePublished) {
            const payload = event.payload as { title: string }
            toast.info(`公告：${payload.title}`, 8000)
            return
        }

        if (event.type === SseEventType.ArticleChanged) {
            const payload = event.payload as ArticleUpdatePayload
            postSwControlMessage({ type: 'shell.invalidate', scope: 'content' })
            if (payload.action === 'Created') {
                scheduleArticleCreatedToast(Number(payload.articleId), router)
            }
            return
        }

        if (event.type === SseEventType.CacheControl) {
            forwardCacheControlPayload(event.payload as CacheControlPayload)
            return
        }

        if (event.type === SseEventType.SearchIndexUpdated) {
            invalidateSearchIndexMemory()
            forwardSearchIndexUpdate(event.payload as SearchIndexUpdatePayload)
            return
        }

        if (event.type === SseEventType.UserStatusChanged) {
            handleUserStatusChange(event.payload as UserStatusPayload)
        }
    }

    const handleReauthAndRestart = async (failureCode: SseFailureCode): Promise<void> => {
        if (failureCode === SseFailureCodes.ProtocolMismatch) {
            return
        }

        const now = Date.now()
        if (now - lastReauthTime < 5000) {
            return
        }
        lastReauthTime = now

        if (failureCode === SseFailureCodes.AuthFailed && userStore.isLoggedIn) {
            await userStore.fetchUserInfo(true)

            if (userStore.isLoggedIn) {
                await sseRuntime.start(undefined, sseStore.runtime.cursor)
                currentMode.value = 'auth'
                return
            }
        }

        if (isCalculating.value) {
            clearReauthRetryTimer()
            reauthRetryTimer = setTimeout(() => {
                reauthRetryTimer = null
                void handleReauthAndRestart(failureCode)
            }, 2000)
            return
        }

        try {
            memoryPowCache = null
            sessionStorage.removeItem(POW_STORAGE_KEY)
            const pow = await getOrRefreshPow()
            await sseRuntime.start(pow, sseStore.runtime.cursor)
            currentMode.value = 'guest'
        } catch (error) {
            console.error('[SSE] 恢复访客流失败:', error)
        }
    }

    const ensureBindings = (): void => {
        if (bindingsInitialized) {
            clearReauthRetryTimer()
        }

        bindingsInitialized = true

        sseRuntime.onEvent = handleIncomingEvent
        sseRuntime.onCursorChange = (cursor) => {
            sseStore.syncCursor(cursor)
        }
        sseRuntime.onStatusChange = (status, retryCount) => {
            sseStore.setStatus(status, retryCount)
        }
        sseRuntime.onDuplicateEvent = () => {
            sseStore.recordDuplicateEvent()
        }
        sseRuntime.onProtocolError = (reason) => {
            console.warn('[SSE] protocol_error', reason)
            sseStore.recordProtocolError()
        }
        sseRuntime.onHandshakeFailure = (code) => {
            sseStore.recordHandshakeFailure(code)
            void handleReauthAndRestart(code)
        }
        sseRuntime.onReconnectSuccess = (replayMissed) => {
            sseStore.recordReconnect(replayMissed)
        }
    }

    const stopNotification = async (clearCursor = false): Promise<void> => {
        clearReauthRetryTimer()
        pendingInitMode = ''
        initNotificationPromise = null
        await sseRuntime.stop(clearCursor)
        disposeNotificationBindings()
        currentMode.value = ''
        isInitializing.value = false
    }

    const initNotification = async (isLogged: boolean): Promise<void> => {
        const targetMode = isLogged ? 'auth' : 'guest'
        if (sseRuntime.isConnected() && currentMode.value === targetMode) {
            return
        }

        if (initNotificationPromise) {
            pendingInitMode = targetMode
            await initNotificationPromise

            if (!pendingInitMode
                || (sseRuntime.isConnected() && currentMode.value === pendingInitMode)
                || pendingInitMode === currentMode.value) {
                return
            }
        }

        const runInitialization = async (mode: 'auth' | 'guest'): Promise<void> => {
            isInitializing.value = true
            clearReauthRetryTimer()
            ensureBindings()

            try {
                if (sseRuntime.isConnected()) {
                    await sseRuntime.stop()
                }

                currentMode.value = mode
                if (mode === 'auth') {
                    await sseRuntime.start(undefined, sseStore.runtime.cursor)
                } else {
                    const pow = await getOrRefreshPow()
                    await sseRuntime.start(pow, sseStore.runtime.cursor)
                }
            } catch (error) {
                console.error('[SSE] 初始化失败:', error)
                currentMode.value = ''
            } finally {
                isInitializing.value = false
            }
        }

        pendingInitMode = targetMode
        initNotificationPromise = (async () => {
            while (pendingInitMode) {
                const nextMode = pendingInitMode
                pendingInitMode = ''

                if (nextMode === currentMode.value && sseRuntime.isConnected()) {
                    continue
                }

                await runInitialization(nextMode)
            }
        })()

        try {
            await initNotificationPromise
        } finally {
            initNotificationPromise = null
        }
    }

    return { unreadCount, initNotification, stopNotification }
}
