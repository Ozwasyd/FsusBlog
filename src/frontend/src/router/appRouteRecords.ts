import { ACCOUNT_ROUTE_PATHS } from '@/public-renderers/publicRoutePaths';
import { PUBLIC_BLOG_CHILD_ROUTES } from '@/public-renderers/publicRouteRegistry';
import type { ManageMetaOptions, SelfMetaOptions } from '@/router/accountRouteMeta';

import type { RouteRecordRaw } from 'vue-router';

const selfMeta = ({
    title,
    pageKind: accountPageKind,
    contentMode: accountContentMode = 'standard',
    routeState = 'private-recoverable'
}: SelfMetaOptions) => ({
    title,
    accountArea: 'self' as const,
    accountPageKind,
    accountContentMode,
    routeState,
    allowLoginRedirect: routeState === 'private-recoverable',
    requiresConfirmedIdentity: false,
    requiresAccountSession: true
});

const manageMeta = ({
    title,
    permissions,
    pageKind: accountPageKind,
    contentMode: accountContentMode = 'wide',
    routeState = 'private-recoverable'
}: ManageMetaOptions) => ({
    title,
    accountArea: 'manage' as const,
    accountPageKind,
    accountContentMode,
    routeState,
    allowLoginRedirect: routeState === 'private-recoverable',
    requiresConfirmedIdentity: false,
    requiresAdminSession: true,
    requiredAdminPermissions: permissions
});

export const APP_ROUTE_RECORDS: RouteRecordRaw[] = [
    // --- 前台公共路由 ---
    {
        path: '/',
        component: () => import('@/layouts/BlogLayout.vue'),
        children: [...PUBLIC_BLOG_CHILD_ROUTES]
    },
    // --- 认证路由 ---
    {
        path: '/',
        component: () => import('@/layouts/PublicAuthLayout.vue'),
        children: [
            {
                path: 'login',
                name: 'Login',
                component: () => import('@/views/auth/Login.vue'),
                meta: { title: '登录', guestOnly: true, routeState: 'session-sensitive' }
            },
            {
                path: 'register',
                name: 'Register',
                component: () => import('@/views/auth/Register.vue'),
                meta: { title: '注册', guestOnly: true, routeState: 'session-sensitive' }
            },
            {
                path: 'recover',
                name: 'Recover',
                component: () => import('@/views/auth/Recover.vue'),
                meta: { title: '恢复访问', guestOnly: true, routeState: 'session-sensitive' }
            }
        ]
    },
    // --- 统一账户中心 ---
    {
        path: '/user',
        component: () => import('@/layouts/AccountLayout.vue'),
        meta: {
            requiresConfirmedIdentity: true,
            accountArea: 'self',
            accountContentMode: 'standard',
            routeState: 'memory-only',
            allowLoginRedirect: false
        },
        children: [
            {
                path: '',
                components: {
                    default: () => import('@/layouts/AccountIdentityFrame.vue'),
                    accountMobileAction: () => import('@/layouts/AccountFrameMobileAction.vue')
                },
                children: [
                    { path: ACCOUNT_ROUTE_PATHS.profileChild, name: 'UserProfile', redirect: { name: 'UserIdentityOverview' }, meta: selfMeta({ title: '身份中心', pageKind: 'identity-settings' }) },
                    { path: 'comments', name: 'UserComments', component: () => import('@/views/user/Comments.vue'), meta: selfMeta({ title: '公开评论记录', pageKind: 'collection' }) },
                    { path: 'messagebox', name: 'UserMessage', component: () => import('@/views/user/Messages.vue'), meta: selfMeta({ title: '我的消息', pageKind: 'inbox', contentMode: 'takeover' }) },
                    { path: 'identity', name: 'UserIdentityOverview', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ title: '身份总览', pageKind: 'identity-settings' }) },
                    { path: 'identity/passkeys', name: 'UserIdentityPasskeys', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ title: '通行密钥', pageKind: 'identity-settings', routeState: 'session-sensitive' }) },
                    { path: 'identity/recovery-key', name: 'UserIdentityRecoveryKey', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ title: 'Recovery Key', pageKind: 'identity-settings', routeState: 'session-sensitive' }) },
                    { path: 'identity/anonymous', name: 'UserIdentityAnonymous', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ title: '匿名身份', pageKind: 'identity-settings' }) },
                    { path: 'identity/public-profile', name: 'UserIdentityPublicProfile', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ title: '公开资料', pageKind: 'identity-settings' }) },
                    { path: 'identity/sessions', name: 'UserIdentitySessions', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ title: '设备会话', pageKind: 'identity-settings', routeState: 'session-sensitive' }) },
                    { path: 'identity/mfa', name: 'UserIdentityMfa', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ title: '二次验证', pageKind: 'identity-settings', routeState: 'session-sensitive' }) },
                    { path: 'identity/comment-records', name: 'UserIdentityCommentRecords', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ title: '公开评论记录', pageKind: 'identity-settings' }) }
                ]
            },
            {
                path: 'manage',
                components: {
                    default: () => import('@/layouts/AdminWorkspaceFrame.vue'),
                    accountMobileAction: () => import('@/layouts/AccountFrameMobileAction.vue')
                },
                children: [
                    { path: '', name: 'ManageDashboard', component: () => import('@/views/admin/Dashboard.vue'), meta: manageMeta({ title: '仪表盘', permissions: ['admin.manage'], pageKind: 'dashboard' }) },
                    { path: 'analytics', name: 'ManageAnalytics', component: () => import('@/views/admin/Analytics.vue'), meta: manageMeta({ title: '数据概览', permissions: ['admin.manage'], pageKind: 'collection' }) },
                    { path: 'article/write', name: 'ManageWriteArticle', component: () => import('@/views/admin/article/Write.vue'), meta: manageMeta({ title: '写文章', permissions: ['article.write'], pageKind: 'form' }) },
                    { path: 'article/edit/:id', name: 'ManageEditArticle', component: () => import('@/views/admin/article/Write.vue'), meta: manageMeta({ title: '编辑文章', permissions: ['article.write'], pageKind: 'form', routeState: 'memory-only' }) },
                    { path: 'article/list', name: 'ManageArticleList', component: () => import('@/views/admin/article/List.vue'), meta: manageMeta({ title: '文章管理', permissions: ['article.write'], pageKind: 'collection' }) },
                    { path: 'article/trash', name: 'ManageArticleTrash', component: () => import('@/views/admin/article/Trash.vue'), meta: manageMeta({ title: '回收站', permissions: ['article.write'], pageKind: 'collection' }) },
                    {
                        path: 'security',
                        component: () => import('@/views/admin/security/SecurityLayout.vue'),
                        meta: manageMeta({ title: '安全系统', permissions: ['system.config'], pageKind: 'console' }),
                        children: [
                            { path: '', name: 'ManageSecurityDashboard', component: () => import('@/views/admin/security/SecurityDashboard.vue'), meta: manageMeta({ title: '安全系统', permissions: ['system.config'], pageKind: 'collection' }) },
                            { path: 'risk-control', name: 'ManageSecurityRiskControl', component: () => import('@/views/admin/security/SecurityRiskControl.vue'), meta: manageMeta({ title: '风险控制', permissions: ['system.config'], pageKind: 'console' }) },
                            { path: 'simulator', name: 'ManageSecuritySimulator', component: () => import('@/views/admin/security/SecuritySimulator.vue'), meta: manageMeta({ title: '风险模拟器', permissions: ['system.config'], pageKind: 'console' }) },
                            { path: 'challenges', name: 'ManageSecurityChallenges', component: () => import('@/views/admin/security/SecurityChallenges.vue'), meta: manageMeta({ title: '验证任务', permissions: ['system.config'], pageKind: 'console', routeState: 'session-sensitive' }) },
                            { path: 'policies', name: 'ManageSecurityPolicies', component: () => import('@/views/admin/security/SecurityPolicies.vue'), meta: manageMeta({ title: '策略版本', permissions: ['system.config'], pageKind: 'collection' }) },
                            { path: 'events', name: 'ManageSecurityEvents', component: () => import('@/views/admin/security/SecurityEvents.vue'), meta: manageMeta({ title: '风险事件', permissions: ['system.config'], pageKind: 'collection' }) },
                            { path: 'pospace', name: 'ManageSecurityPoSpace', component: () => import('@/views/admin/security/SecurityPoSpace.vue'), meta: manageMeta({ title: 'PoSpace 验证', permissions: ['system.config'], pageKind: 'console' }) },
                            { path: 'perception-v2', name: 'ManageSecurityPerceptionV2', component: () => import('@/views/admin/security/SecurityPerceptionV2.vue'), meta: manageMeta({ title: '人机感知验证', permissions: ['system.config'], pageKind: 'console' }) },
                            { path: 'crawler', name: 'ManageSecurityCrawler', component: () => import('@/views/admin/security/SecurityCrawler.vue'), meta: manageMeta({ title: '反爬虫系统', permissions: ['system.config'], pageKind: 'console' }) },
                            { path: 'pow', name: 'ManageSecurityPow', component: () => import('@/views/admin/security/SecurityPow.vue'), meta: manageMeta({ title: 'PoW 系统', permissions: ['system.config'], pageKind: 'console' }) }
                        ]
                    },
                    {
                        path: 'moderation',
                        component: () => import('@/views/admin/moderation/ModerationLayout.vue'),
                        meta: manageMeta({ title: '审核系统', permissions: ['comment.moderate'], pageKind: 'collection' }),
                        children: [
                            { path: '', name: 'ManageModerationDashboard', component: () => import('@/views/admin/moderation/ModerationDashboard.vue'), meta: manageMeta({ title: '审核系统', permissions: ['comment.moderate'], pageKind: 'collection' }) },
                            { path: 'comments', name: 'ManageModerationComments', component: () => import('@/views/admin/moderation/ModerationComments.vue'), meta: manageMeta({ title: '评论审核', permissions: ['comment.moderate'], pageKind: 'collection' }) },
                            { path: 'dictionaries', name: 'ManageModerationDictionaries', component: () => import('@/views/admin/moderation/ModerationDictionaries.vue'), meta: manageMeta({ title: '词库管理', permissions: ['comment.moderate'], pageKind: 'collection' }) },
                            { path: 'anonymous-policy', name: 'ManageAnonymousCommentPolicy', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta({ title: '匿名评论策略', permissions: ['anonymous.comment.configure'], pageKind: 'console' }) },
                            { path: 'anonymous-risk', name: 'ManageAnonymousRisk', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta({ title: '匿名风险', permissions: ['comment.moderate'], pageKind: 'console' }) },
                            { path: 'anonymous-credentials', name: 'ManageAnonymousCredentials', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta({ title: '匿名资格', permissions: ['anonymous.credential.revoke'], pageKind: 'console' }) },
                            { path: 'nullifiers', name: 'ManageAnonymousNullifiers', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta({ title: '匿名标识', permissions: ['anonymous.nullifier.block'], pageKind: 'console' }) },
                            { path: 'zk-anonymous', name: 'ManageZkAnonymousStatus', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta({ title: '隐私证明状态', permissions: ['anonymous.comment.configure'], pageKind: 'console' }) },
                            { path: 'policies', name: 'ManageModerationPolicies', component: () => import('@/views/admin/moderation/ModerationPolicies.vue'), meta: manageMeta({ title: '地区策略', permissions: ['comment.moderate'], pageKind: 'collection' }) },
                            { path: 'regions', name: 'ManageModerationRegions', component: () => import('@/views/admin/moderation/ModerationRegions.vue'), meta: manageMeta({ title: '地区管理', permissions: ['comment.moderate'], pageKind: 'collection' }) },
                            { path: 'region-groups', name: 'ManageModerationRegionGroups', component: () => import('@/views/admin/moderation/ModerationRegionGroups.vue'), meta: manageMeta({ title: '大区管理', permissions: ['comment.moderate'], pageKind: 'collection' }) },
                            { path: 'policy-templates', name: 'ManageModerationPolicyTemplates', component: () => import('@/views/admin/moderation/ModerationPolicyTemplates.vue'), meta: manageMeta({ title: '策略模板', permissions: ['comment.moderate'], pageKind: 'collection' }) },
                            { path: 'replay', name: 'ManageModerationReplay', component: () => import('@/views/admin/moderation/ModerationReplay.vue'), meta: manageMeta({ title: '策略回放', permissions: ['comment.moderate'], pageKind: 'console' }) },
                            { path: 'model', name: 'ManageModerationModel', component: () => import('@/views/admin/moderation/ModerationModel.vue'), meta: manageMeta({ title: '审核模型', permissions: ['comment.moderate'], pageKind: 'console' }) },
                            { path: 'audit', name: 'ManageModerationAudit', component: () => import('@/views/admin/moderation/ModerationAudit.vue'), meta: manageMeta({ title: '审核审计', permissions: ['comment.moderate'], pageKind: 'collection' }) }
                        ]
                    },
                    { path: 'comments', name: 'ManageCommentModeration', redirect: { name: 'ManageModerationComments' }, meta: manageMeta({ title: '评论审核', permissions: ['comment.moderate'], pageKind: 'collection' }) },
                    { path: 'messages', name: 'ManageMessages', component: () => import('@/views/admin/MessageCenter.vue'), meta: manageMeta({ title: '站内信中心', permissions: ['admin.manage'], pageKind: 'inbox', contentMode: 'takeover' }) },
                    { path: 'category', name: 'ManageCategory', component: () => import('@/views/admin/Category.vue'), meta: manageMeta({ title: '分类管理', permissions: ['article.write'], pageKind: 'collection' }) },
                    { path: 'tag', name: 'ManageTag', component: () => import('@/views/admin/Tag.vue'), meta: manageMeta({ title: '标签管理', permissions: ['article.write'], pageKind: 'collection' }) },
                    { path: 'assets', name: 'ManageAssets', component: () => import('@/views/admin/Assets.vue'), meta: manageMeta({ title: '资产库', permissions: ['article.write'], pageKind: 'collection' }) },
                    { path: 'content-tools', name: 'ManageContentTools', component: () => import('@/views/admin/ContentTools.vue'), meta: manageMeta({ title: '备份与迁移', permissions: ['system.config'], pageKind: 'console' }) },
                    { path: 'audit', name: 'ManageAuditLog', component: () => import('@/views/admin/AuditLog.vue'), meta: manageMeta({ title: '审计日志', permissions: ['audit.read'], pageKind: 'collection' }) },
                    { path: 'ops', name: 'ManageOpsHealth', component: () => import('@/views/admin/OpsHealth.vue'), meta: manageMeta({ title: '服务与后台状态', permissions: ['system.config'], pageKind: 'console' }) },
                    { path: 'cluster', name: 'ManageClusterRuntime', component: () => import('@/views/admin/ClusterRuntime.vue'), meta: manageMeta({ title: '集群与运行时', permissions: ['system.config'], pageKind: 'console', routeState: 'session-sensitive' }) },
                    { path: 'cache', name: 'ManageCacheDiagnostics', component: () => import('@/views/admin/CacheDiagnostics.vue'), meta: manageMeta({ title: '缓存与索引', permissions: ['system.config'], pageKind: 'console' }) },
                    { path: 'integrity', name: 'ManageIntegrity', component: () => import('@/views/admin/Integrity.vue'), meta: manageMeta({ title: '内容一致性', permissions: ['system.config'], pageKind: 'console' }) },
                    { path: 'integrity-proof', name: 'ManageIntegrityProof', component: () => import('@/views/admin/IntegrityProofConsole.vue'), meta: manageMeta({ title: 'Integrity Proof', permissions: ['system.config'], pageKind: 'console', routeState: 'session-sensitive' }) },
                    { path: 'settings', name: 'ManageSettings', component: () => import('@/views/admin/Settings.vue'), meta: manageMeta({ title: '系统设置', permissions: ['system.config'], pageKind: 'settings' }) },
                    { path: 'users', name: 'ManageUsers', component: () => import('@/views/admin/UserManage.vue'), meta: manageMeta({ title: '用户管理', permissions: ['admin.manage'], pageKind: 'collection' }) }
                ]
            }
        ]
    },
    // --- 错误页 ---
    { path: '/403', name: 'Forbidden', component: () => import('@/views/error/403.vue'), meta: { title: '无权访问', routeState: 'memory-only' } },
    { path: '/:pathMatch(.*)*', name: 'NotFound', component: () => import('@/views/error/404.vue'), meta: { title: '页面不存在', routeState: 'public-shareable' } }
];
