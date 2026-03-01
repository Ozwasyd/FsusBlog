import { ref, type Ref } from 'vue';
import { useRouter } from 'vue-router';
import {
    notificationService,
    type GlobalNoticePayload,
    type UserStatusPayload,
    type CommentRemovedPayload,
    type CommentAddedPayload,
    type ArticleUpdatePayload,
    type MessageRevokedPayload
} from '@/services/notificationService';
import { toast } from '@/utils/toast';
import { useUserStore } from '@/store/user';
import { type MessageItem } from '@/api/message';
import { getPowChallenge } from '@/api/auth';
import { getBrowserFp } from '@/utils/fingerprint';
import { usePow } from '@/composables/usePow';

const unreadCount: Ref<number> = ref(0);
const currentMode = ref<'auth' | 'guest' | ''>('');
const isInitializing = ref(false);

let lastReauthTime = 0;
let memoryPowCache: CachedPow | null = null; 

interface CachedPow {
    nonce: string;
    salt: string;
    fp: string;
    signature: string;
    difficulty: number;
    timestamp: number;
}
const POW_STORAGE_KEY = 'signalr_guest_pow';

export function useNotification() {
    const userStore = useUserStore();
    const router = useRouter();
    const { calculate, prewarm, isCalculating } = usePow();

    /**
     * [修复 2026-02-24] 时间戳校验增强
     * 逻辑自洽：增加 5 秒的网络时延容差，确保后端 300s 窗口不会因请求往返而失效
     */
    const getOrRefreshPow = async (): Promise<CachedPow> => {
        const nowInSeconds = Math.floor(Date.now() / 1000);

        if (memoryPowCache && (nowInSeconds - memoryPowCache.timestamp < 275)) {
            return memoryPowCache;
        }

        try {
            const raw = sessionStorage.getItem(POW_STORAGE_KEY);
            if (raw) {
                const cached = JSON.parse(raw) as CachedPow;
                if (nowInSeconds - cached.timestamp < 275) {
                    memoryPowCache = cached;
                    return cached;
                }
            }
        } catch (e) { 
            sessionStorage.removeItem(POW_STORAGE_KEY);
        }

        prewarm();
        const fp = getBrowserFp();
        // 核心：增加缓存穿透参数，确保每次重试获取的都是最新挑战
        const challengeRes = await getPowChallenge({ 
            action: 'signalr_connect',
            _t: Date.now() 
        } as any) as any;
        
        const { salt, difficulty, timestamp, signature } = challengeRes.data || challengeRes;

        const { nonce } = await calculate(salt, fp, difficulty);
        const newPow: CachedPow = { nonce, salt, fp, signature, difficulty, timestamp };
        
        memoryPowCache = newPow;
        sessionStorage.setItem(POW_STORAGE_KEY, JSON.stringify(newPow));

        return newPow;
    };

    const handleReauthAndRestart = async (reason?: string) => {
        // [修复 2026-02-24] 异常语义扩展：包含后端传回的中文及具体错误描述
        const isSecurityError = reason?.includes('PoW') || 
                               reason?.includes('Access Denied') || 
                               reason?.includes('403') ||
                               reason?.includes('过期') ||
                               reason?.includes('校验未通过');

        if (userStore.isLoggedIn) {
            if (isSecurityError) {
                console.warn("[SignalR] Security validation failed for logged-in user. Syncing state...");
                // 逻辑自洽：如果是已登录用户报 PoW 错误，可能是 Token 物理过期或被封禁，执行同步
                await userStore.fetchUserInfo(true);
            } else {
                return;
            }
        }

        const now = Date.now();
        if (now - lastReauthTime < 5000) return;
        lastReauthTime = now;

        if (isCalculating.value) {
            setTimeout(() => handleReauthAndRestart(reason), 2000);
            return;
        }

        try {
            console.log("[SignalR] Security state invalidated. Refreshing PoW...");
            memoryPowCache = null;
            sessionStorage.removeItem(POW_STORAGE_KEY);
            const pow = await getOrRefreshPow();
            await notificationService.start('', pow);
            currentMode.value = 'guest';
        } catch (err) {
            console.error('[SignalR] Recovery failed', err);
        }
    };

    const initNotification = async (isLogged: boolean): Promise<void> => {
        if (isInitializing.value) return;
        const targetMode = isLogged ? 'auth' : 'guest';

        if (notificationService.isConnected() && currentMode.value === targetMode) return;
        isInitializing.value = true;

        try {
            if (notificationService.isConnected()) await notificationService.stop();
            currentMode.value = targetMode;

            notificationService.onRequestNewPow = handleReauthAndRestart;

            notificationService.onGlobalNotice = (data: GlobalNoticePayload) => {
                toast.info(`公告：${data.title}`, 8000);
                window.dispatchEvent(new CustomEvent('signalr:refresh-inbox'));
            };
            notificationService.onMessageReceived = (_data: MessageItem) => {
                window.dispatchEvent(new CustomEvent('signalr:refresh-inbox'));
            };
            notificationService.onMessageRevoked = (data: MessageRevokedPayload) => {
                unreadCount.value = data.unreadCount;
                window.dispatchEvent(new CustomEvent('signalr:refresh-inbox'));
            };
            notificationService.onArticleUpdate = (data: ArticleUpdatePayload) => {
                if (data.action === 'Created') {
                    toast.article(`发现新文章，点击阅读`, () => {
                        router.push(`/article/${data.articleId}`);
                    });
                }
                const eventName = `signalr:article-${data.action.toLowerCase()}`;
                window.dispatchEvent(new CustomEvent(eventName, { detail: data }));
            };
            notificationService.onReconnected = () => {
                window.dispatchEvent(new CustomEvent('signalr:reconnected'));
            };
            notificationService.onCommentAdded = (data: CommentAddedPayload) => {
                window.dispatchEvent(new CustomEvent('signalr:comment-added', { detail: data }));
            };
            notificationService.onCommentRemoved = (data: CommentRemovedPayload) => {
                window.dispatchEvent(new CustomEvent('signalr:comment-removed', { detail: data }));
            };

            notificationService.onUserStatusChanged = async (data: UserStatusPayload) => {
                const oldStatus = userStore.userInfo?.status;
                const newStatus = Number(data.status);
                const isStatusChanged = oldStatus !== undefined && Number(oldStatus) !== newStatus;

                userStore.updateStatus(newStatus, data.reason);

                if (isStatusChanged) {
                    if (newStatus === 1) {
                        toast.error(`账户管控通知：${data.reason || '您的账号已被限制操作'}`, 10000);
                    } else if (newStatus === 0) {
                        toast.success('账户通知：您的账号已恢复正常使用');
                    }
                }
            };

            notificationService.onUnreadUpdate = (count: number) => { unreadCount.value = count; };

            if (isLogged) {
                const token = (userStore as any).token || localStorage.getItem('token') || '';
                await notificationService.start(token);
            } else {
                const pow = await getOrRefreshPow();
                await notificationService.start('', pow);
            }
        } catch (err: any) {
            currentMode.value = '';
        } finally {
            isInitializing.value = false;
        }
    };

    return { unreadCount, initNotification };
}