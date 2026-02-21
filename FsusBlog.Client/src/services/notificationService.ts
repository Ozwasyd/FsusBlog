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

    // 核心修复(2026-02-21): 增加 reason 参数，传递异常上下文
    public onRequestNewPow?: (reason?: string) => void;

    private buildFullUrl(baseUrl: string, params?: PowParams): string {
        if (!params) return baseUrl;

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
                    if (!this.currentToken) {
                        console.warn(" Guest connection lost. Automatic reconnect aborted for new PoW.");
                        this.onRequestNewPow?.(retryContext.retryReason?.message);
                        return null;
                    }
                    if (retryContext.previousRetryCount > 10) return null;
                    return Math.min(retryContext.previousRetryCount * 2000, 30000);
                }
            })
            .configureLogging(signalR.LogLevel.Warning)
            .build();

        // 将 403 和 账号受限 等纳入重连捕获池，并透传 message
        this.connection.onclose(async (error) => {
            if (error?.message.includes("Access Denied") || error?.message.includes("PoW credentials missing") || error?.message.includes("403") || error?.message.includes("账号受限")) {
                this.onRequestNewPow?.(error.message);
            }
        });

        this.connection.onreconnecting((error) => {
            if (error?.message.includes("Access Denied") || error?.message.includes("403") || error?.message.includes("账号受限")) {
                console.error(" Reconnect credential invalid.");
                this.onRequestNewPow?.(error.message);
            }
        });

        this.connection.onreconnected((connectionId) => {
            this.onReconnected?.(connectionId);
        });

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
            // 如果 start 失败时遭遇了 403 阻断，平滑处理并透传异常原因
            if (err.message?.includes("Access Denied") || err.message?.includes("PoW credentials missing") || err.message?.includes("403") || err.message?.includes("账号受限")) {
                this.onRequestNewPow?.(err.message);
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
                console.warn(" Stop warning:", e);
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