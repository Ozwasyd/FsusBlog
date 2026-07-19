import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { getPowChallenge } from '@/api/auth'
import { SecurityChallengeKind } from '@/api/security'
import { usePow } from '@/composables/usePow'
import { invalidateSearchIndexMemory } from '@/services/localSearch'
import { forwardCacheControlPayload, forwardSearchIndexUpdate, postSwControlMessage } from '@/services/serviceWorkerRuntime'
import { notificationStreamRuntime } from '@/services/notificationStreamRuntime'
import { NotificationStreamEventType, NotificationStreamFailureCodes, type ArticleUpdatePayload, type CacheControlPayload, type PowParams, type SearchIndexUpdatePayload, type NotificationStreamEventV2, type NotificationStreamFailureCode, type AccountStatusPayload } from '@/services/notificationStreamTypes'
import { useNotificationStreamStore } from '@/store/notificationStream'
import { useUserStore } from '@/store/user'
import { getBrowserFp } from '@/utils/fingerprint'
import { isAbortError } from '@/utils/errors'
import { showErrorToast } from '@/utils/errorPresentation'
import { toast } from '@/fsusui/feedback'
import { decodePowCache, encodePowCache } from '@/services/powProofCodec'
import { encodeBinaryPowProofHeader } from '@/services/powProofCodec'
import { safeConsoleError, safeConsoleWarn } from '@/services/safeConsole'
import {
    createSecurityChallengeClient,
    type SecurityChallengeContext,
    type SecurityChallengeProofLease
} from '@/security/challenge-client'

const currentMode = ref<'auth' | 'guest' | ''>('')
const isInitializing = ref(false)

const NOTIFICATION_RECOVERY_RETRY_MS = 5000

let lastReauthTime = 0
let memoryPowCache: PowParams | null = null
let bindingsInitialized = false
let reauthRetryTimer: ReturnType<typeof setTimeout> | null = null
let initNotificationPromise: Promise<void> | null = null
let pendingInitMode: 'auth' | 'guest' | '' = ''
let articleCreatedToastTimer: ReturnType<typeof setTimeout> | null = null
let pendingArticleCreatedIds: number[] = []

const POW_STORAGE_KEY = 'notification_stream_guest_pow'
const NOTIFICATION_SUBSCRIBE_ACTION = 'notification.subscribe'
const NOTIFICATION_SUBSCRIBE_ROUTE_KEY = 'notification.subscribe'
const GUEST_RECOVERY_POW_FAILURES: ReadonlySet<NotificationStreamFailureCode> = new Set([
    NotificationStreamFailureCodes.PowFailed
])
const RISK_CHALLENGE_RECOVERY_FAILURES: ReadonlySet<NotificationStreamFailureCode> = new Set([
    NotificationStreamFailureCodes.RiskChallengeRequired,
    NotificationStreamFailureCodes.RiskChallengeRejected,
    NotificationStreamFailureCodes.RiskChallengeExpired,
    NotificationStreamFailureCodes.RiskChallengeReplayed,
    NotificationStreamFailureCodes.RiskChallengeBindingMismatch,
    NotificationStreamFailureCodes.RiskChallengeRevoked,
    NotificationStreamFailureCodes.RiskChallengeKindMismatch
])
type NotificationSubscribeChallengeProofResult = SecurityChallengeProofLease | 'allow' | 'unavailable'

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
    notificationStreamRuntime.onEvent = undefined
    notificationStreamRuntime.onCursorChange = undefined
    notificationStreamRuntime.onStatusChange = undefined
    notificationStreamRuntime.onDuplicateEvent = undefined
    notificationStreamRuntime.onProtocolError = undefined
    notificationStreamRuntime.onHandshakeFailure = undefined
    notificationStreamRuntime.onReconnectSuccess = undefined
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
    const notificationStreamStore = useNotificationStreamStore()
    const { unreadCount } = storeToRefs(notificationStreamStore)
    const router = useRouter()
    const { calculate, prewarm, isCalculating } = usePow()
    const notificationChallengeClient = createSecurityChallengeClient()

    const notificationChallengeContext = (): SecurityChallengeContext => ({
        action: NOTIFICATION_SUBSCRIBE_ACTION,
        routeKey: NOTIFICATION_SUBSCRIBE_ROUTE_KEY,
        attributes: { mode: 'notification-stream' },
        deviceFingerprint: getBrowserFp()
    })

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

    const ensureNotificationSubscribeChallengeProof = async (forceRefresh = false): Promise<NotificationSubscribeChallengeProofResult> => {
        const context = notificationChallengeContext()
        if (!forceRefresh) {
            const reserved = notificationChallengeClient.reserveProof(context)
            if (reserved) {
                return reserved
            }
        } else {
            notificationChallengeClient.clearProof(context)
        }

        const issue = forceRefresh
            ? await notificationChallengeClient.refresh(context)
            : await notificationChallengeClient.issue(context)

        if (issue.status === 'verified' && issue.proof) {
            return notificationChallengeClient.reserveProof(context) ?? 'unavailable'
        }

        if (issue.status === 'allow') {
            return 'allow'
        }

        if (
            issue.status !== 'challenge' ||
            issue.assignment?.kind !== SecurityChallengeKind.Sha256PowV1 ||
            !issue.providerPayload
        ) {
            return 'unavailable'
        }

        const payload = issue.providerPayload.payload
        const salt = payload.salt?.trim()
        const signature = payload.signature?.trim()
        const difficulty = Number(payload.difficulty)
        const timestamp = Number(payload.timestamp)
        if (!salt || !signature || !Number.isFinite(difficulty) || !Number.isFinite(timestamp)) {
            return 'unavailable'
        }

        prewarm()
        const browserFp = getBrowserFp()
        const { nonce } = await calculate(salt, browserFp, difficulty)
        const proof = encodeBinaryPowProofHeader({
            salt,
            nonce,
            timestamp,
            difficulty,
            signature,
            browserFp
        })
        const verified = await notificationChallengeClient.verify(context, {
            challengeId: issue.assignment.challengeId,
            kind: issue.assignment.kind,
            action: NOTIFICATION_SUBSCRIBE_ACTION,
            routeKey: NOTIFICATION_SUBSCRIBE_ROUTE_KEY,
            providerPayload: { proof }
        })

        return verified.status === 'verified' && verified.proof
            ? notificationChallengeClient.reserveProof(context) ?? 'unavailable'
            : 'unavailable'
    }

    const handleAccountStatusChange = (data: AccountStatusPayload): void => {
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

    const handleIncomingEvent = (event: NotificationStreamEventV2): void => {
        notificationStreamStore.consumeEvent(event)

        if (event.type === NotificationStreamEventType.GlobalNoticePublished) {
            const payload = event.payload as { title: string }
            toast.info(`公告：${payload.title}`, 8000)
            return
        }

        if (event.type === NotificationStreamEventType.ArticleChanged) {
            const payload = event.payload as ArticleUpdatePayload
            postSwControlMessage({ type: 'shell.invalidate', scope: 'content' })
            if (payload.action === 'Created') {
                scheduleArticleCreatedToast(Number(payload.articleId), router)
            }
            return
        }

        if (event.type === NotificationStreamEventType.CacheControl) {
            forwardCacheControlPayload(event.payload as CacheControlPayload)
            return
        }

        if (event.type === NotificationStreamEventType.SearchIndexUpdated) {
            invalidateSearchIndexMemory()
            forwardSearchIndexUpdate(event.payload as SearchIndexUpdatePayload)
            return
        }

        if (event.type === NotificationStreamEventType.AccountStatusChanged) {
            handleAccountStatusChange(event.payload as AccountStatusPayload)
        }
    }

    const handleReauthAndRestart = async (failureCode: NotificationStreamFailureCode): Promise<void> => {
        if (failureCode === NotificationStreamFailureCodes.ProtocolMismatch) {
            return
        }

        if (RISK_CHALLENGE_RECOVERY_FAILURES.has(failureCode)) {
            if (isCalculating.value) {
                scheduleReauthRetry(failureCode, 2000)
                return
            }

            const proof = await ensureNotificationSubscribeChallengeProof(true)
            if (proof === 'unavailable') {
                return
            }

            await notificationStreamRuntime.start(
                undefined,
                notificationStreamStore.runtime.cursor,
                'auth',
                proof === 'allow' ? null : proof
            )
            currentMode.value = 'auth'
            return
        }

        if (!GUEST_RECOVERY_POW_FAILURES.has(failureCode)) {
            return
        }

        const now = Date.now()
        if (now - lastReauthTime < 5000) {
            return
        }
        lastReauthTime = now

        if (failureCode === NotificationStreamFailureCodes.AuthFailed && userStore.isLoggedIn) {
            await userStore.fetchUserInfo(true)

            if (userStore.isLoggedIn) {
                await notificationStreamRuntime.start(undefined, notificationStreamStore.runtime.cursor, 'auth')
                currentMode.value = 'auth'
                return
            }
        }

        if (isCalculating.value) {
            scheduleReauthRetry(failureCode, 2000)
            return
        }

        try {
            memoryPowCache = null
            sessionStorage.removeItem(POW_STORAGE_KEY)
            const pow = await getOrRefreshPow()
            await notificationStreamRuntime.start(pow, notificationStreamStore.runtime.cursor, 'guest')
            currentMode.value = 'guest'
        } catch (error) {
            if (isAbortError(error)) {
                scheduleReauthRetry(failureCode, 2000)
                return
            }

            safeConsoleError('[NotificationStream] 恢复访客流失败:', error)
            scheduleReauthRetry(failureCode)
        }
    }

    function scheduleReauthRetry(
        failureCode: NotificationStreamFailureCode,
        delayMs = NOTIFICATION_RECOVERY_RETRY_MS
    ): void {
        clearReauthRetryTimer()
        reauthRetryTimer = setTimeout(() => {
            reauthRetryTimer = null
            void handleReauthAndRestart(failureCode)
        }, delayMs)
    }

    const ensureBindings = (): void => {
        if (bindingsInitialized) {
            clearReauthRetryTimer()
        }

        bindingsInitialized = true

        notificationStreamRuntime.onEvent = handleIncomingEvent
        notificationStreamRuntime.onCursorChange = (cursor) => {
            notificationStreamStore.syncCursor(cursor)
        }
        notificationStreamRuntime.onStatusChange = (status, retryCount) => {
            notificationStreamStore.setStatus(status, retryCount)
        }
        notificationStreamRuntime.onDuplicateEvent = () => {
            notificationStreamStore.recordDuplicateEvent()
        }
        notificationStreamRuntime.onProtocolError = (reason) => {
            safeConsoleWarn('[NotificationStream] protocol_error', reason)
            notificationStreamStore.recordProtocolError()
        }
        notificationStreamRuntime.onHandshakeFailure = (code) => {
            notificationStreamStore.recordHandshakeFailure(code)
            void handleReauthAndRestart(code)
        }
        notificationStreamRuntime.onReconnectSuccess = (replayMissed) => {
            notificationStreamStore.recordReconnect(replayMissed)
        }
    }

    const stopNotification = async (clearCursor = false): Promise<void> => {
        clearReauthRetryTimer()
        pendingInitMode = ''
        initNotificationPromise = null
        await notificationStreamRuntime.stop(clearCursor)
        disposeNotificationBindings()
        currentMode.value = ''
        isInitializing.value = false
    }

    const initNotification = async (isLogged: boolean): Promise<void> => {
        const targetMode = isLogged ? 'auth' : 'guest'
        if (notificationStreamRuntime.isConnected() && currentMode.value === targetMode) {
            return
        }

        if (initNotificationPromise) {
            pendingInitMode = targetMode
            await initNotificationPromise

            if (!pendingInitMode
                || (notificationStreamRuntime.isConnected() && currentMode.value === pendingInitMode)
                || pendingInitMode === currentMode.value) {
                return
            }
        }

        const runInitialization = async (mode: 'auth' | 'guest'): Promise<void> => {
            isInitializing.value = true
            clearReauthRetryTimer()
            ensureBindings()

            try {
                if (notificationStreamRuntime.isConnected()) {
                    await notificationStreamRuntime.stop()
                }

                currentMode.value = mode
                if (mode === 'auth') {
                    const proof = await ensureNotificationSubscribeChallengeProof(true)
                    if (proof === 'unavailable') {
                        currentMode.value = ''
                        return
                    }

                    await notificationStreamRuntime.start(
                        undefined,
                        notificationStreamStore.runtime.cursor,
                        'auth',
                        proof === 'allow' ? null : proof
                    )
                } else {
                    const pow = await getOrRefreshPow()
                    await notificationStreamRuntime.start(pow, notificationStreamStore.runtime.cursor, 'guest')
                }
            } catch (error) {
                if (isAbortError(error)) {
                    currentMode.value = ''
                    clearReauthRetryTimer()
                    reauthRetryTimer = setTimeout(() => {
                        reauthRetryTimer = null
                        void initNotification(mode === 'auth')
                    }, 1500)
                    return
                }

                safeConsoleError('[NotificationStream] 初始化失败:', error)
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

                if (nextMode === currentMode.value && notificationStreamRuntime.isConnected()) {
                    continue
                }

                await runInitialization(nextMode)
                if (pendingInitMode === nextMode) {
                    pendingInitMode = ''
                }
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
