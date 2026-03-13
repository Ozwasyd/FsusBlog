import type { MessageItem } from "@/api/message";

export interface NoticePayload { title: string; unreadCount: number; time: string; }
export interface UserStatusPayload { status: number; reason: string | null; time: string; }
export interface GlobalNoticePayload { id: string; title: string; time: string; }
export interface CommentAddedPayload {
    articleId: number;
    comment: { id: string; content: string; createTime: string; userName: string; };
    time: string;
}
export interface CommentRemovedPayload { articleId: number; commentId: string; time: string; }
export interface MessageRevokedPayload { messageId: string; unreadCount: number; time: string; }
export interface ArticleUpdatePayload {
    articleId: number;
    action: 'Created' | 'Updated' | 'Deleted' | 'Restored';
    eventTime: string;
}
export interface PowParams {
    nonce: string; salt: string; fp: string; signature: string; difficulty: number; timestamp: number;
}

class NotificationService {
    private abortController: AbortController | null = null;
    private _isConnected: boolean = false;
    private currentToken: string = "";
    private currentPow: PowParams | undefined;
    
    private retryCount: number = 0;
    private maxRetries: number = 10;
    private isReconnecting: boolean = false;

    // 维持契约不变，对上层 Vue 业务零侵入
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

    private toSafeBase64(json: object): string {
        const str = JSON.stringify(json);
        const bytes = new TextEncoder().encode(str);
        let binary = '';
        bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
        return btoa(binary);
    }

    public async start(token: string, powParams?: PowParams): Promise<void> {
        this.currentToken = token;
        this.currentPow = powParams;
        this.retryCount = 0;
        await this.connect();
    }

    private async connect(): Promise<void> {
        if (this.abortController) this.abortController.abort();
        this.abortController = new AbortController();

        const headers: Record<string, string> = {
            'Accept': 'text/event-stream'
        };

        if (this.currentToken) {
            headers['Authorization'] = `Bearer ${this.currentToken}`;
        }
        
        if (this.currentPow) {
            headers['X-Fsus-Pow-Proof'] = this.toSafeBase64({
                powNonce: this.currentPow.nonce,
                powSalt: this.currentPow.salt,
                browserFp: this.currentPow.fp,
                powSignature: this.currentPow.signature,
                difficulty: this.currentPow.difficulty,
                powTimestamp: this.currentPow.timestamp
            });
        }

        try {
            const response = await fetch('/api/notifications/stream', {
                method: 'GET',
                headers,
                signal: this.abortController.signal
            });

            if (!response.ok) {
                const isCritical = response.status === 401 || response.status === 403;
                if (isCritical) {
                    this.onRequestNewPow?.(`HTTP ${response.status}: Access Denied or PoW Failed`);
                    return;
                }
                throw new Error(`HTTP Error: ${response.status}`);
            }

            this._isConnected = true;
            if (this.isReconnecting) {
                this.isReconnecting = false;
                this.onReconnected?.("sse-reconnected");
            }

            // 非阻塞后台流读取
            this.readStream(response.body!.getReader()).catch(err => this.handleDisconnect(err));
            
        } catch (err: any) {
            if (err.name !== 'AbortError') {
                this.handleDisconnect(err);
                throw err; // 将首次连接错误向上抛出
            }
        }
    }

    private async readStream(reader: ReadableStreamDefaultReader<Uint8Array>) {
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                let boundary = buffer.indexOf('\n\n');

                while (boundary !== -1) {
                    const chunk = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    this.processSseChunk(chunk);
                    boundary = buffer.indexOf('\n\n');
                }
            }
        } finally {
            reader.releaseLock();
            this.handleDisconnect(new Error("Stream closed by server"));
        }
    }

    private processSseChunk(chunk: string) {
        const lines = chunk.split('\n');
        let eventName = '';
        let dataStr = '';

        for (const line of lines) {
            if (line.startsWith('event: ')) eventName = line.substring(7).trim();
            else if (line.startsWith('data: ')) dataStr = line.substring(6).trim();
        }

        if (eventName === 'ping' || !eventName || !dataStr) return; // 拦截心跳包与空包

        try {
            const data = JSON.parse(dataStr);
            this.dispatchEvent(eventName, data);
        } catch (e) {
            console.error('[SSE] Payload Parse Error', e);
        }
    }

    private dispatchEvent(eventName: string, data: any) {
        switch (eventName) {
            case "ReceiveNotice": this.onUnreadUpdate?.(data.unreadCount); break;
            case "ReceiveGlobalNotice": this.onGlobalNotice?.(data); break;
            case "UpdateUnreadCount": this.onUnreadUpdate?.(data); break;
            case "OnUserStatusChanged": this.onUserStatusChanged?.(data); break;
            case "OnCommentAdded": this.onCommentAdded?.(data); break;
            case "OnCommentRemoved": this.onCommentRemoved?.(data); break;
            case "OnMessageReceived": this.onMessageReceived?.(data); break;
            case "ReceiveArticleUpdate": this.onArticleUpdate?.(data); break;
            case "OnMessageRevoked": this.onMessageRevoked?.(data); break;
            case "DecrementUnreadCount": /* 后端如果单独推送空载荷，可配合业务进行弱一致性补偿 */ break;
        }
    }

    private handleDisconnect(error: any) {
        if (error.name === 'AbortError') return; // 主动停止不触发重连
        this._isConnected = false;

        if (!this.currentToken && this.retryCount > 0) {
            this.onRequestNewPow?.("RECONNECT_POW_NEEDED");
            return;
        }

        if (this.retryCount >= this.maxRetries) {
            console.warn("[SSE] Max retries reached. Connection dead.");
            return;
        }

        this.isReconnecting = true;
        this.retryCount++;
        const delay = Math.min(this.retryCount * 2000, 30000); // 指数退避算法最大 30s
        
        setTimeout(() => {
            if (this.isReconnecting) this.connect().catch(() => {});
        }, delay);
    }

    public async stop(): Promise<void> {
        this.isReconnecting = false;
        this._isConnected = false;
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    public isConnected(): boolean {
        return this._isConnected;
    }
}

export const notificationService = new NotificationService();