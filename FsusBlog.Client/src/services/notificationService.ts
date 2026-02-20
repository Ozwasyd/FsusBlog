import type { MessageItem } from "@/api/message";
import * as signalR from "@microsoft/signalr";

export interface NoticePayload { title: string; unreadCount: number; time: string; }
export interface UserStatusPayload { status: number; reason: string | null; time: string; }
export interface GlobalNoticePayload { id: string; title: string; time: string; }
export interface CommentAddedPayload {
    articleId: number;
    comment: { id: string; content: string; createTime: string; userName: string; };
    time: string;
}
export interface CommentRemovedPayload { articleId: number; commentId: string; time: string; }

export interface MessageRevokedPayload {
    messageId: string;
    unreadCount: number;
    time: string;
}

export interface ArticleUpdatePayload {
    articleId: number;
    action: 'Created' | 'Updated' | 'Deleted' | 'Restored';
    eventTime: string;
}

export interface PowParams {
    nonce: string; salt: string; fp: string; signature: string; difficulty: number; timestamp: number;
}

class NotificationService {
    private connection: signalR.HubConnection | null = null;
    private currentToken: string = "";

    // 钩子定义
    public onUnreadUpdate?: (count: number) => void;
    public onGlobalNotice?: (data: GlobalNoticePayload) => void;
    public onUserStatusChanged?: (data: UserStatusPayload) => void;
    public onCommentAdded?: (data: CommentAddedPayload) => void;
    public onCommentRemoved?: (data: CommentRemovedPayload) => void;
    public onMessageReceived?: (data: MessageItem) => void;
    public onArticleUpdate?: (data: ArticleUpdatePayload) => void;
    public onMessageRevoked?: (data: MessageRevokedPayload) => void;

    public onReconnected?: (connectionId?: string) => void;

    // 逻辑自洽：使用类属性回调替代 DOM 广播事件，彻底杜绝 Vue 组件多次销毁挂载导致的内存泄漏
    public onRequestNewPow?: () => void;

    private buildFullUrl(baseUrl: string, params?: PowParams): string {
        if (!params) return baseUrl;

        // 逻辑自洽防范：同时传入缩写与标准头格式的 Query 参数
        // 确保后端 SignalRPoWFilter 无论怎么取值（精确匹配或 Header 映射）都能命中
        const queryObj: Record<string, string> = {
            nonce: params.nonce, salt: params.salt, fp: params.fp,
            signature: params.signature, difficulty: params.difficulty.toString(),
            timestamp: params.timestamp.toString(),
            "X-PoW-Nonce": params.nonce,
            "X-PoW-Salt": params.salt,
            "X-PoW-Fp": params.fp,
            "X-PoW-Signature": params.signature,
            "X-PoW-Difficulty": params.difficulty.toString(),
            "X-PoW-Timestamp": params.timestamp.toString()
        };
        const query = new URLSearchParams(queryObj).toString();
        return `${baseUrl}?${query}`;
    }

    public async start(token: string, powParams?: PowParams): Promise<void> {
        if (this.connection) await this.stop();

        this.currentToken = token;
        const baseUrl = "/hubs/notifications";
        const fullUrl = this.buildFullUrl(baseUrl, powParams);

        this.connection = new signalR.HubConnectionBuilder()
            .withUrl(fullUrl, {
                accessTokenFactory: () => this.currentToken || "",
                // 性能最大化：为可能存在的降级请求（如 LongPolling 或初始的 Negotiate 握手）附加真实的 Header
                headers: powParams ? {
                    "X-PoW-Nonce": powParams.nonce,
                    "X-PoW-Salt": powParams.salt,
                    "X-PoW-Fp": powParams.fp,
                    "X-PoW-Signature": powParams.signature,
                    "X-PoW-Difficulty": powParams.difficulty.toString(),
                    "X-PoW-Timestamp": powParams.timestamp.toString()
                } : {}
            })
            .withAutomaticReconnect({
                nextRetryDelayInMilliseconds: retryContext => {
                    // 逻辑自洽：访客模式下，Nonce 是一次性的
                    // 如果连接断开，自动重连必将触发后端的重放攻击检测
                    // 因此，如果是访客（没有 token），我们在第一次重连尝试前就强制中断
                    if (!this.currentToken) {
                        console.warn("[SignalR] Guest connection lost. Automatic reconnect aborted for new PoW.");
                        this.onRequestNewPow?.();
                        return null; // 返回 null 立即停止重连循环
                    }

                    if (retryContext.previousRetryCount > 10) return null;
                    return Math.min(retryContext.previousRetryCount * 2000, 30000);
                }
            })
            .configureLogging(signalR.LogLevel.Warning)
            .build();

        // 处理手动重连期间可能出现的凭证异常
        this.connection.onclose(async (error) => {
            if (error?.message.includes("Access Denied") || error?.message.includes("PoW credentials missing")) {
                this.onRequestNewPow?.();
            }
        });

        // 捕获重连中的状态
        this.connection.onreconnecting((error) => {
            if (error?.message.includes("Access Denied")) {
                console.error("[SignalR] Reconnect credential invalid.");
                this.onRequestNewPow?.();
            }
        });

        this.connection.onreconnected((connectionId) => {
            this.onReconnected?.(connectionId);
        });

        // 绑定信令通道
        this.connection.on("ReceiveNotice", (data: NoticePayload) => this.onUnreadUpdate?.(data.unreadCount));
        this.connection.on("ReceiveGlobalNotice", (data: GlobalNoticePayload) => this.onGlobalNotice?.(data));
        this.connection.on("UpdateUnreadCount", (count: number) => this.onUnreadUpdate?.(count));
        this.connection.on("OnUserStatusChanged", (data: UserStatusPayload) => this.onUserStatusChanged?.(data));
        this.connection.on("OnCommentAdded", (data: CommentAddedPayload) => this.onCommentAdded?.(data));
        this.connection.on("OnCommentRemoved", (data: CommentRemovedPayload) => this.onCommentRemoved?.(data));
        this.connection.on("OnMessageReceived", (data: MessageItem) => this.onMessageReceived?.(data));
        this.connection.on("ReceiveArticleUpdate", (data: ArticleUpdatePayload) => this.onArticleUpdate?.(data));
        this.connection.on("OnMessageRevoked", (data: MessageRevokedPayload) => this.onMessageRevoked?.(data));

        try {
            await this.connection.start();
        } catch (err: any) {
            if (err.message?.includes("Access Denied") || err.message?.includes("PoW credentials missing")) {
                this.onRequestNewPow?.();
            }
            this.connection = null;
            throw err;
        }
    }

    public async stop(): Promise<void> {
        if (this.connection) {
            try {
                await this.connection.stop();
            } catch (e) {
                console.warn("[SignalR] Stop warning:", e);
            } finally {
                this.connection = null;
            }
        }
    }

    public isConnected(): boolean {
        return this.connection?.state === signalR.HubConnectionState.Connected;
    }
}

export const notificationService = new NotificationService();