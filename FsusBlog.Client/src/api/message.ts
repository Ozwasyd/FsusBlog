// src/api/message.ts
import service from '@/api/index' 

/** * 消息分类常量 
 * 使用 as const 保证类型推导为字面量，提高性能与类型安全性
 */
export const MessageCategory = {
    Broadcast: 1,      // 全站公告
    SystemTask: 2,     // 系统任务
    Transactional: 3   // 事务/点对点私信
} as const;

export type CategoryValue = typeof MessageCategory[keyof typeof MessageCategory];

/** * 站内信核心 DTO 
 */
export interface MessageItem {
    id: string;        // 后端 long 映射为 string，防止前端 Number 精度溢出 (Snowflake ID)
    title: string;
    content: string;
    category: CategoryValue;
    categoryName: string;
    isRead: boolean;
    createTime: string;
}

/** * 广播请求负荷 
 */
export interface BroadcastRequest {
    title: string;
    content: string;
}

/** * 管理员定向私信请求 
 */
export interface DirectMessageRequest extends BroadcastRequest {
    targetUserId: string | number;
}

/**
 * 站内信模块 API 服务
 * 逻辑自洽：严格区分用户侧 (/v1/messages) 与 管理员侧 (/v1/admin/messages)
 */
export const messageApi = {
    // =================================================================================
    // 用户侧接口 (User Endpoints)
    // =================================================================================

    /** * 获取分页收件箱 
     * @param page 页码
     * @param size 每页数量 (后端 Math.Clamp 限制最大 50)
     */
    getInbox(page: number, size: number) {
        return service.get<MessageItem[]>('/v1/messages/inbox', {
            params: { page, size }
        })
    },

    /** * 标记单条消息为已读 
     * @param id 消息 ID (string | number)
     */
    markAsRead(id: string | number) {
        return service.post<void>(`/v1/messages/${id}/read`)
    },

    /** * 将所有未读消息标记为已读 
     */
    markAllRead() {
        return service.post<void>('/v1/messages/read-all')
    },
    
    /** * 删除单条消息 (仅从用户个人收件箱移除)
     * @param id 消息 ID
     */
    deleteMessage(id: string | number) {
        return service.delete<void>(`/v1/messages/${id}`)
    },


    // =================================================================================
    // 管理员侧接口 (Admin Endpoints - 需 Admin 角色权限)
    // =================================================================================

    /** * 管理员：发布全站公告 (实时广播)
     */
    adminPublishBroadcast(data: BroadcastRequest) {
        return service.post<void>('/v1/admin/messages/broadcast', data)
    },

    /** * 管理员：向特定用户发送定向通知
     */
    adminSendDirect(data: DirectMessageRequest) {
        return service.post<void>('/v1/admin/messages/direct', data)
    },

    /** * 管理员：获取全站消息分发历史记录 
     * 用于审计及后续的撤回操作
     */
    adminGetHistory(page: number, size: number) {
        return service.get<MessageItem[]>('/v1/admin/messages/history', {
            params: { page, size }
        })
    },

    /** * 管理员：撤回/物理删除消息 
     * 警告：该操作会从所有接收者的收件箱中物理抹除该消息
     * @param id 消息 ID
     */
    adminRevokeMessage(id: string | number) {
        return service.delete<void>(`/v1/admin/messages/${id}`)
    }
}