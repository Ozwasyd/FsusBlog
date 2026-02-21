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

// 安全性保障：提取至全局变量，防止因组件重复挂载导致冷却机制失效
let lastReauthTime = 0;

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

    const getOrRefreshPow = async (): Promise<CachedPow> => {
        const now = Math.floor(Date.now() / 1000);

        try {
            const raw = sessionStorage.getItem(POW_STORAGE_KEY);
            if (raw) {
                const cached = JSON.parse(raw) as CachedPow;
                if (now - cached.timestamp < 280) {
                    return cached;
                }
            }
        } catch (e) { /* ignore */ }

        prewarm();
        const fp = getBrowserFp();
        const challengeRes = await getPowChallenge({ action: 'signalr_connect' } as any) as any;
        const { salt, difficulty, timestamp, signature } = challengeRes.data || challengeRes;

        const { nonce } = await calculate(salt, fp, difficulty);
        const newPow: CachedPow = { nonce, salt, fp, signature, difficulty, timestamp };
        sessionStorage.setItem(POW_STORAGE_KEY, JSON.stringify(newPow));

        return newPow;
    };

    // 核心修复(2026-02-21): 接收异常原因，处理缓存恢复引发的前后端状态脱节
    const handleReauthAndRestart = async (reason?: string) => {
        if (userStore.isLoggedIn) {
            // 逻辑自洽：如果前端认为已登录，但后端明确告知缺少 PoW/Access Denied
            // 证明后端的 Token 已过期或丢失。此时必须主动清除假登录态，降级为游客连接。
            if (reason?.includes('PoW credentials missing') || reason?.includes('Access Denied')) {
                console.warn("[SignalR] Token rejected or expired. Syncing local state and downgrading to guest...");
                userStore.setUserInfo(null); 
            } else {
                // 如果是已登录用户且是其他网络错误，交由 SignalR 原生机制自动重连
                return;
            }
        } else if (currentMode.value !== 'guest') {
            return;
        }

        const now = Date.now();
        if (now - lastReauthTime < 5000) {
            console.warn(" Re-auth too frequent, aborting to prevent infinite loop.");
            return;
        }
        lastReauthTime = now;

        if (isCalculating.value) {
            console.log(" Worker busy, rescheduling re-auth...");
            setTimeout(() => {
                lastReauthTime = 0;
                handleReauthAndRestart(reason);
            }, 2000);
            return;
        }

        try {
            console.log(" Connection invalidated. Re-calculating PoW...");
            sessionStorage.removeItem(POW_STORAGE_KEY);
            const pow = await getOrRefreshPow();
            await notificationService.start('', pow);
            // 确保模式修正
            currentMode.value = 'guest';
        } catch (err) {
            console.error(' Restart with new PoW failed', err);
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