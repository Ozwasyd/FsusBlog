import type { AxiosRequestConfig } from 'axios'
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
 * 修复日期: 2026-02-23 (适配物理中断与高危操作 PoW 校验)
 */
export const messageApi = {
    // =================================================================================
    // 用户侧接口 (User Endpoints)
    // =================================================================================

    /** * 获取分页收件箱 
     * [修复 2026-02-23] 增加 config 支持物理中断，优化长列表加载体验
     */
    getInbox(page: number, size: number, config?: AxiosRequestConfig) {
        return service.get<MessageItem[]>('/v1/messages/inbox', {
            ...config,
            params: { page, size }
        })
    },

    /** * 标记单条消息为已读 
     */
    markAsRead(id: string | number, config?: AxiosRequestConfig) {
        return service.post<void>(`/v1/messages/${id}/read`, {}, config)
    },

    /** * 将所有未读消息标记为已读 
     * 逻辑自洽：在大规模消息标记时支持 Abort 操作
     */
    markAllRead(config?: AxiosRequestConfig) {
        return service.post<void>('/v1/messages/read-all', {}, config)
    },
    
    /** * 删除单条消息 (仅从用户个人收件箱移除)
     */
    deleteMessage(id: string | number, config?: AxiosRequestConfig) {
        return service.delete<void>(`/v1/messages/${id}`, config)
    },


    // =================================================================================
    // 管理员侧接口 (Admin Endpoints - 需 Admin 角色权限)
    // =================================================================================

    /** * 管理员：发布全站公告 (实时广播)
     * 安全性保障：发布全站消息属于极高危操作，强制要求 PoW 证明，
     * 物理隔离针对广播接口的 CC 攻击或自动化灌水。
     */
    adminPublishBroadcast(data: BroadcastRequest, config?: AxiosRequestConfig) {
        return service.post<void>('/v1/admin/messages/broadcast', data, {
            ...config,
            requiresPow: true
        } as AxiosRequestConfig)
    },

    /** * 管理员：向特定用户发送定向通知
     * 安全性保障：防止自动化脚本利用此接口对特定用户进行私信骚扰
     */
    adminSendDirect(data: DirectMessageRequest, config?: AxiosRequestConfig) {
        return service.post<void>('/v1/admin/messages/direct', data, {
            ...config,
            requiresPow: true
        } as AxiosRequestConfig)
    },

    /** * 管理员：获取全站消息分发历史记录 
     */
    adminGetHistory(page: number, size: number, config?: AxiosRequestConfig) {
        return service.get<MessageItem[]>('/v1/admin/messages/history', {
            ...config,
            params: { page, size }
        })
    },

    /** * 管理员：撤回/物理删除消息 
     * 安全性保障：撤回操作涉及全库索引变更，属于高成本操作，强制开启 PoW 校验
     */
    adminRevokeMessage(id: string | number, config?: AxiosRequestConfig) {
        return service.delete<void>(`/v1/admin/messages/${id}`, {
            ...config,
            requiresPow: true
        } as AxiosRequestConfig)
    }
}