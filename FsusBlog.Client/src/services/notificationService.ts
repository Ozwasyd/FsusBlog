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
    nonce: string; 
    salt: string; 
    fp: string; 
    signature: string; 
    difficulty: number; 
    timestamp: number;
}

class NotificationService {
    private connection: signalR.HubConnection | null = null;
    private currentToken: string = "";

    public onUnreadUpdate?: (count: number) => void;
    public onGlobalNotice?: (data: GlobalNoticePayload) => void;
    public onUserStatusChanged?: (data: UserStatusPayload) => void;
    public onCommentAdded?: (data: CommentAddedPayload) => void;
    public onCommentRemoved?: (data: CommentRemovedPayload) => void;
    public onMessageReceived?: (data: MessageItem) => void;
    public onArticleUpdate?: (data: ArticleUpdatePayload) => void;
    public onMessageRevoked?: (data: MessageRevokedPayload) => void;

    public onReconnected?: (connectionId?: string) => void;
    public onRequestNewPow?: (reason?: string) => void;

    /**
     * [修复 2026-02-24] 算法最优：UTF-8 安全的 Base64 编码
     * 逻辑自洽：修正 TS 2345 错误，改用 forEach 确保索引访问的类型安全
     */
    private toSafeBase64(json: object): string {
      const str = JSON.stringify(json);
      const bytes = new TextEncoder().encode(str);
      let binary = '';
      
      // 性能最大化：forEach 自动处理迭代，物理消除 bytes[i] 可能为 undefined 的类型风险
      bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
      });
      
      return btoa(binary);
    }

    /**
     * 凭证封装逻辑
     */
    private buildFullUrl(baseUrl: string, params?: PowParams): string {
        if (!params) return baseUrl;

        // 严格匹配后端 VirtualPowRequest 的 [JsonPropertyName] 契约
        const powProof = {
            powNonce: params.nonce,
            powSalt: params.salt,
            browserFp: params.fp,
            powSignature: params.signature,
            difficulty: params.difficulty,
            powTimestamp: params.timestamp
        };

        const proofBase64 = this.toSafeBase64(powProof);
        return `${baseUrl}?pow=${encodeURIComponent(proofBase64)}`;
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
                    "X-Fsus-Pow-Proof": this.toSafeBase64({
                        powNonce: powParams.nonce,
                        powSalt: powParams.salt,
                        browserFp: powParams.fp,
                        powSignature: powParams.signature,
                        difficulty: powParams.difficulty,
                        powTimestamp: powParams.timestamp
                    })
                } : {}
            })
            .withAutomaticReconnect({
                nextRetryDelayInMilliseconds: retryContext => {
                    if (!this.currentToken && retryContext.previousRetryCount > 0) {
                        this.onRequestNewPow?.("RECONNECT_POW_NEEDED");
                        return null; 
                    }
                    if (retryContext.previousRetryCount > 10) return null;
                    return Math.min(retryContext.previousRetryCount * 2000, 30000);
                }
            })
            .configureLogging(signalR.LogLevel.Warning)
            .build();

        const handleConnectionError = (error?: Error) => {
            if (!error) return;
            const isCritical = error instanceof signalR.HttpError && (error.statusCode === 401 || error.statusCode === 403);
            const isPowProblem = error.message.includes("PoW") || 
                               error.message.includes("安全校验") || 
                               error.message.includes("凭证") ||
                               error.message.includes("Access Denied");

            if (isCritical || isPowProblem) {
                this.onRequestNewPow?.(error.message);
            }
        };

        this.connection.onclose(handleConnectionError);
        this.connection.onreconnecting(handleConnectionError);

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
            handleConnectionError(err);
            this.connection = null;
            throw err;
        }
    }

    public async stop(): Promise<void> {
        if (this.connection) {
            try {
                this.connection.off("ReceiveNotice");
                this.connection.off("ReceiveGlobalNotice");
                this.connection.off("UpdateUnreadCount");
                this.connection.off("OnUserStatusChanged");
                this.connection.off("OnCommentAdded");
                this.connection.off("OnCommentRemoved");
                this.connection.off("OnMessageReceived");
                this.connection.off("ReceiveArticleUpdate");
                this.connection.off("OnMessageRevoked");
                await this.connection.stop();
            } catch (e) {
                console.warn(" SignalR Stop warning:", e);
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