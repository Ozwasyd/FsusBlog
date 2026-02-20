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

    const handleReauthAndRestart = async () => {
        if (currentMode.value !== 'guest' || userStore.isLoggedIn) return;

        // 安全性保障核心修正：增加 5 秒冷却期。
        // 如果后端彻底决绝了凭证（如时钟严重不同步），这能防止浏览器陷入算力无限死循环并拖垮服务器。
        const now = Date.now();
        if (now - lastReauthTime < 5000) {
            console.warn("[SignalR] Re-auth too frequent, aborting to prevent infinite loop.");
            return;
        }
        lastReauthTime = now;

        // 性能最大化：如果 Worker 正在忙于其他计算（如发表评论），稍后重试
        if (isCalculating.value) {
            console.log("[SignalR] Worker busy, rescheduling re-auth...");
            setTimeout(() => {
                lastReauthTime = 0; // 重置冷却使之能正常运行
                handleReauthAndRestart();
            }, 2000);
            return;
        }

        try {
            console.log("[SignalR] Connection invalidated. Re-calculating PoW...");
            sessionStorage.removeItem(POW_STORAGE_KEY);
            const pow = await getOrRefreshPow();
            await notificationService.start('', pow);
        } catch (err) {
            console.error('[SignalR] Restart with new PoW failed', err);
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

            // 逻辑自洽：采用单例回调，移除原有的 window.addEventListener 导致的幽灵请求现象
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
                if (data.status === 1) {
                    userStore.updateStatus(data.status, data.reason);
                    toast.error(`账户管控通知：${data.reason || '您的账号已被限制操作'}`, 10000);
                } else if (data.status === 0) {
                    userStore.updateStatus(0, null);
                    toast.success('账户通知：您的账号已恢复正常使用');
                }
            };
            notificationService.onUnreadUpdate = (count: number) => { unreadCount.value = count; };

            if (isLogged) {
                // 必须在此传入真实的 JWT Token！传入空字符串会导致后端身份识别回退至访客模式，
                // 从而引发无谓的 PoW 校验和 Access Denied！
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