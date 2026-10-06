import { ACCOUNT_ROUTE_PATHS } from '@/public-renderers/publicRoutePaths';
import { PUBLIC_BLOG_CHILD_ROUTES } from '@/public-renderers/publicRouteRegistry';
import type { ManageMetaOptions, SelfMetaOptions } from '@/router/accountRouteMeta';
import { staticRouteTitle } from '@/router/routeTitleContract';

import type { RouteRecordRaw } from 'vue-router';

const selfMeta = ({
    titleKey,
    pageKind: accountPageKind,
    contentMode: accountContentMode = 'standard',
    routeState = 'private-recoverable'
}: SelfMetaOptions) => ({
    titleKey,
    accountArea: 'self' as const,
    accountPageKind,
    accountContentMode,
    routeState,
    allowLoginRedirect: routeState === 'private-recoverable',
    requiresConfirmedIdentity: false,
    requiresAccountSession: true
});

const manageMeta = ({
    titleKey,
    permissions,
    pageKind: accountPageKind,
    contentMode: accountContentMode = 'wide',
    routeState = 'private-recoverable'
}: ManageMetaOptions) => ({
    titleKey,
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
                meta: { ...staticRouteTitle('common.routeTitles.login'), guestOnly: true, routeState: 'session-sensitive' }
            },
            {
                path: 'register',
                name: 'Register',
                component: () => import('@/views/auth/Register.vue'),
                meta: { ...staticRouteTitle('common.routeTitles.register'), guestOnly: true, routeState: 'session-sensitive' }
            },
            {
                path: 'recover',
                name: 'Recover',
                component: () => import('@/views/auth/Recover.vue'),
                meta: { ...staticRouteTitle('common.routeTitles.recover'), guestOnly: true, routeState: 'session-sensitive' }
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
                    { path: ACCOUNT_ROUTE_PATHS.profileChild, name: 'UserProfile', redirect: { name: 'UserIdentityOverview' }, meta: selfMeta({ titleKey: 'identity.profile.pageTitle', pageKind: 'identity-settings' }) },
                    { path: 'comments', name: 'UserComments', component: () => import('@/views/user/Comments.vue'), meta: selfMeta({ titleKey: 'identity.meta.UserIdentityCommentRecords.title', pageKind: 'collection' }) },
                    { path: 'messagebox', name: 'UserMessage', component: () => import('@/views/user/Messages.vue'), meta: selfMeta({ titleKey: 'common.routeTitles.messages', pageKind: 'inbox', contentMode: 'takeover' }) },
                    { path: 'preferences/language', name: 'UserLanguagePreference', component: () => import('@/views/user/LanguagePreference.vue'), meta: selfMeta({ titleKey: 'common.routeTitles.settings', pageKind: 'settings' }) },
                    { path: 'identity', name: 'UserIdentityOverview', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ titleKey: 'identity.meta.UserIdentityOverview.title', pageKind: 'identity-settings' }) },
                    { path: 'identity/passkeys', name: 'UserIdentityPasskeys', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ titleKey: 'identity.meta.UserIdentityPasskeys.title', pageKind: 'identity-settings', routeState: 'session-sensitive' }) },
                    { path: 'identity/recovery-key', name: 'UserIdentityRecoveryKey', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ titleKey: 'identity.meta.UserIdentityRecoveryKey.title', pageKind: 'identity-settings', routeState: 'session-sensitive' }) },
                    { path: 'identity/anonymous', name: 'UserIdentityAnonymous', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ titleKey: 'identity.meta.UserIdentityAnonymous.title', pageKind: 'identity-settings' }) },
                    { path: 'identity/public-profile', name: 'UserIdentityPublicProfile', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ titleKey: 'identity.meta.UserIdentityPublicProfile.title', pageKind: 'identity-settings' }) },
                    { path: 'identity/sessions', name: 'UserIdentitySessions', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ titleKey: 'identity.meta.UserIdentitySessions.title', pageKind: 'identity-settings', routeState: 'session-sensitive' }) },
                    { path: 'identity/mfa', name: 'UserIdentityMfa', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ titleKey: 'identity.meta.UserIdentityMfa.title', pageKind: 'identity-settings', routeState: 'session-sensitive' }) },
                    { path: 'identity/comment-records', name: 'UserIdentityCommentRecords', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ titleKey: 'identity.meta.UserIdentityCommentRecords.title', pageKind: 'identity-settings' }) }
                ]
            },
            {
                path: 'manage',
                components: {
                    default: () => import('@/layouts/AdminWorkspaceFrame.vue'),
                    accountMobileAction: () => import('@/layouts/AccountFrameMobileAction.vue')
                },
                children: [
                    { path: '', name: 'ManageDashboard', component: () => import('@/views/admin/Dashboard.vue'), meta: manageMeta({ titleKey: 'admin.nav.dashboard', permissions: ['admin.manage'], pageKind: 'dashboard' }) },
                    { path: 'analytics', name: 'ManageAnalytics', component: () => import('@/views/admin/Analytics.vue'), meta: manageMeta({ titleKey: 'admin.nav.analytics', permissions: ['admin.manage'], pageKind: 'collection' }) },
                    { path: 'article/write', name: 'ManageWriteArticle', component: () => import('@/views/admin/article/Write.vue'), meta: manageMeta({ titleKey: 'common.routeTitles.writeArticle', permissions: ['article.write'], pageKind: 'form' }) },
                    { path: 'article/edit/:id', name: 'ManageEditArticle', component: () => import('@/views/admin/article/Write.vue'), meta: manageMeta({ titleKey: 'admin.nav.articles', permissions: ['article.write'], pageKind: 'form', routeState: 'memory-only' }) },
                    { path: 'canvas', name: 'ManageAuthoringCanvas', component: () => import('@/views/admin/canvas/AuthoringCanvasView.vue'), meta: manageMeta({ titleKey: 'admin.nav.canvas', permissions: ['article.write'], pageKind: 'collection', routeState: 'memory-only' }) },
                    { path: 'canvas/:id', name: 'ManageAuthoringCanvasDocument', component: () => import('@/views/admin/canvas/AuthoringCanvasView.vue'), meta: manageMeta({ titleKey: 'admin.nav.canvas', permissions: ['article.write'], pageKind: 'form', routeState: 'memory-only' }) },
                    { path: 'article/list', name: 'ManageArticleList', component: () => import('@/views/admin/article/List.vue'), meta: manageMeta({ titleKey: 'admin.nav.articles', permissions: ['article.write'], pageKind: 'collection' }) },
                    { path: 'article/trash', name: 'ManageArticleTrash', component: () => import('@/views/admin/article/Trash.vue'), meta: manageMeta({ titleKey: 'admin.nav.trash', permissions: ['article.write'], pageKind: 'collection' }) },
                    {
                        path: 'security',
                        component: () => import('@/views/admin/security/SecurityLayout.vue'),
                        meta: manageMeta({ titleKey: 'admin.nav.security', permissions: ['system.config'], pageKind: 'console' }),
                        children: [
                            { path: '', name: 'ManageSecurityDashboard', component: () => import('@/views/admin/security/SecurityDashboard.vue'), meta: manageMeta({ titleKey: 'admin.nav.security', permissions: ['system.config'], pageKind: 'collection' }) },
                            { path: 'risk-control', name: 'ManageSecurityRiskControl', component: () => import('@/views/admin/security/SecurityRiskControl.vue'), meta: manageMeta({ titleKey: 'admin.nav.security', permissions: ['system.config'], pageKind: 'console' }) },
                            { path: 'simulator', name: 'ManageSecuritySimulator', component: () => import('@/views/admin/security/SecuritySimulator.vue'), meta: manageMeta({ titleKey: 'admin.nav.security', permissions: ['system.config'], pageKind: 'console' }) },
                            { path: 'challenges', name: 'ManageSecurityChallenges', component: () => import('@/views/admin/security/SecurityChallenges.vue'), meta: manageMeta({ titleKey: 'admin.nav.security', permissions: ['system.config'], pageKind: 'console', routeState: 'session-sensitive' }) },
                            { path: 'policies', name: 'ManageSecurityPolicies', component: () => import('@/views/admin/security/SecurityPolicies.vue'), meta: manageMeta({ titleKey: 'admin.nav.security', permissions: ['system.config'], pageKind: 'collection' }) },
                            { path: 'events', name: 'ManageSecurityEvents', component: () => import('@/views/admin/security/SecurityEvents.vue'), meta: manageMeta({ titleKey: 'admin.nav.security', permissions: ['system.config'], pageKind: 'collection' }) },
                            { path: 'pospace', name: 'ManageSecurityPoSpace', component: () => import('@/views/admin/security/SecurityPoSpace.vue'), meta: manageMeta({ titleKey: 'admin.nav.security', permissions: ['system.config'], pageKind: 'console' }) },
                            { path: 'perception-v2', name: 'ManageSecurityPerceptionV2', component: () => import('@/views/admin/security/SecurityPerceptionV2.vue'), meta: manageMeta({ titleKey: 'admin.nav.security', permissions: ['system.config'], pageKind: 'console' }) },
                            { path: 'crawler', name: 'ManageSecurityCrawler', component: () => import('@/views/admin/security/SecurityCrawler.vue'), meta: manageMeta({ titleKey: 'admin.nav.security', permissions: ['system.config'], pageKind: 'console' }) },
                            { path: 'pow', name: 'ManageSecurityPow', component: () => import('@/views/admin/security/SecurityPow.vue'), meta: manageMeta({ titleKey: 'admin.nav.security', permissions: ['system.config'], pageKind: 'console' }) }
                        ]
                    },
                    {
                        path: 'moderation',
                        component: () => import('@/views/admin/moderation/ModerationLayout.vue'),
                        meta: manageMeta({ titleKey: 'admin.nav.moderation', permissions: ['comment.moderate'], pageKind: 'collection' }),
                        children: [
                            { path: '', name: 'ManageModerationDashboard', component: () => import('@/views/admin/moderation/ModerationDashboard.vue'), meta: manageMeta({ titleKey: 'admin.nav.moderation', permissions: ['comment.moderate'], pageKind: 'collection' }) },
                            { path: 'comments', name: 'ManageModerationComments', component: () => import('@/views/admin/moderation/ModerationComments.vue'), meta: manageMeta({ titleKey: 'common.routeTitles.moderateComments', permissions: ['comment.moderate'], pageKind: 'collection' }) },
                            { path: 'dictionaries', name: 'ManageModerationDictionaries', component: () => import('@/views/admin/moderation/ModerationDictionaries.vue'), meta: manageMeta({ titleKey: 'admin.nav.moderation', permissions: ['comment.moderate'], pageKind: 'collection' }) },
                            { path: 'anonymous-policy', name: 'ManageAnonymousCommentPolicy', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta({ titleKey: 'admin.nav.anonymousPolicy', permissions: ['anonymous.comment.configure'], pageKind: 'console' }) },
                            { path: 'anonymous-risk', name: 'ManageAnonymousRisk', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta({ titleKey: 'admin.nav.anonymousRisk', permissions: ['comment.moderate'], pageKind: 'console' }) },
                            { path: 'anonymous-credentials', name: 'ManageAnonymousCredentials', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta({ titleKey: 'admin.nav.anonymousCredentials', permissions: ['anonymous.credential.revoke'], pageKind: 'console' }) },
                            { path: 'nullifiers', name: 'ManageAnonymousNullifiers', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta({ titleKey: 'admin.nav.anonymousNullifiers', permissions: ['anonymous.nullifier.block'], pageKind: 'console' }) },
                            { path: 'zk-anonymous', name: 'ManageZkAnonymousStatus', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta({ titleKey: 'admin.nav.privacyProof', permissions: ['anonymous.comment.configure'], pageKind: 'console' }) },
                            { path: 'policies', name: 'ManageModerationPolicies', component: () => import('@/views/admin/moderation/ModerationPolicies.vue'), meta: manageMeta({ titleKey: 'admin.nav.moderation', permissions: ['comment.moderate'], pageKind: 'collection' }) },
                            { path: 'regions', name: 'ManageModerationRegions', component: () => import('@/views/admin/moderation/ModerationRegions.vue'), meta: manageMeta({ titleKey: 'admin.nav.moderation', permissions: ['comment.moderate'], pageKind: 'collection' }) },
                            { path: 'region-groups', name: 'ManageModerationRegionGroups', component: () => import('@/views/admin/moderation/ModerationRegionGroups.vue'), meta: manageMeta({ titleKey: 'admin.nav.moderation', permissions: ['comment.moderate'], pageKind: 'collection' }) },
                            { path: 'policy-templates', name: 'ManageModerationPolicyTemplates', component: () => import('@/views/admin/moderation/ModerationPolicyTemplates.vue'), meta: manageMeta({ titleKey: 'admin.nav.moderation', permissions: ['comment.moderate'], pageKind: 'collection' }) },
                            { path: 'replay', name: 'ManageModerationReplay', component: () => import('@/views/admin/moderation/ModerationReplay.vue'), meta: manageMeta({ titleKey: 'admin.nav.moderation', permissions: ['comment.moderate'], pageKind: 'console' }) },
                            { path: 'model', name: 'ManageModerationModel', component: () => import('@/views/admin/moderation/ModerationModel.vue'), meta: manageMeta({ titleKey: 'admin.nav.moderation', permissions: ['comment.moderate'], pageKind: 'console' }) },
                            { path: 'audit', name: 'ManageModerationAudit', component: () => import('@/views/admin/moderation/ModerationAudit.vue'), meta: manageMeta({ titleKey: 'admin.nav.audit', permissions: ['comment.moderate'], pageKind: 'collection' }) }
                        ]
                    },
                    { path: 'comments', name: 'ManageCommentModeration', redirect: { name: 'ManageModerationComments' }, meta: manageMeta({ titleKey: 'common.routeTitles.moderateComments', permissions: ['comment.moderate'], pageKind: 'collection' }) },
                    { path: 'messages', name: 'ManageMessages', component: () => import('@/views/admin/MessageCenter.vue'), meta: manageMeta({ titleKey: 'admin.nav.inbox', permissions: ['admin.manage'], pageKind: 'inbox', contentMode: 'takeover' }) },
                    { path: 'category', name: 'ManageCategory', component: () => import('@/views/admin/Category.vue'), meta: manageMeta({ titleKey: 'admin.nav.categories', permissions: ['article.write'], pageKind: 'collection' }) },
                    { path: 'tag', name: 'ManageTag', component: () => import('@/views/admin/Tag.vue'), meta: manageMeta({ titleKey: 'admin.nav.tags', permissions: ['article.write'], pageKind: 'collection' }) },
                    { path: 'assets', name: 'ManageAssets', component: () => import('@/views/admin/Assets.vue'), meta: manageMeta({ titleKey: 'admin.nav.assets', permissions: ['article.write'], pageKind: 'collection' }) },
                    { path: 'content-tools', name: 'ManageContentTools', component: () => import('@/views/admin/ContentTools.vue'), meta: manageMeta({ titleKey: 'admin.nav.contentTools', permissions: ['system.config'], pageKind: 'console' }) },
                    { path: 'audit', name: 'ManageAuditLog', component: () => import('@/views/admin/AuditLog.vue'), meta: manageMeta({ titleKey: 'admin.nav.audit', permissions: ['audit.read'], pageKind: 'collection' }) },
                    { path: 'ops', name: 'ManageOpsHealth', component: () => import('@/views/admin/OpsHealth.vue'), meta: manageMeta({ titleKey: 'admin.nav.operations', permissions: ['system.config'], pageKind: 'console' }) },
                    { path: 'cluster', name: 'ManageClusterRuntime', component: () => import('@/views/admin/ClusterRuntime.vue'), meta: manageMeta({ titleKey: 'admin.nav.clusterRuntime', permissions: ['system.config'], pageKind: 'console', routeState: 'session-sensitive' }) },
                    { path: 'cache', name: 'ManageCacheDiagnostics', component: () => import('@/views/admin/CacheDiagnostics.vue'), meta: manageMeta({ titleKey: 'admin.nav.cache', permissions: ['system.config'], pageKind: 'console' }) },
                    { path: 'integrity', name: 'ManageIntegrity', component: () => import('@/views/admin/Integrity.vue'), meta: manageMeta({ titleKey: 'admin.nav.integrity', permissions: ['system.config'], pageKind: 'console' }) },
                    { path: 'integrity-proof', name: 'ManageIntegrityProof', component: () => import('@/views/admin/IntegrityProofConsole.vue'), meta: manageMeta({ titleKey: 'admin.nav.integrityProof', permissions: ['system.config'], pageKind: 'console', routeState: 'session-sensitive' }) },
                    { path: 'settings', name: 'ManageSettings', component: () => import('@/views/admin/Settings.vue'), meta: manageMeta({ titleKey: 'admin.nav.settings', permissions: ['system.config'], pageKind: 'settings' }) },
                    { path: 'plugins', name: 'ManagePlugins', component: () => import('@/views/admin/PluginAdmin.vue'), meta: manageMeta({ titleKey: 'admin.nav.plugins', permissions: ['system.config'], pageKind: 'console', routeState: 'session-sensitive' }) },
                    { path: 'themes', name: 'ManageThemes', component: () => import('@/views/admin/ThemeAdmin.vue'), meta: manageMeta({ titleKey: 'admin.nav.settings', permissions: ['system.config'], pageKind: 'console', routeState: 'session-sensitive' }) },
                    { path: 'fonts', name: 'ManageFonts', component: () => import('@/views/admin/FontAdmin.vue'), meta: manageMeta({ titleKey: 'admin.nav.settings', permissions: ['system.config'], pageKind: 'console', routeState: 'session-sensitive' }) },
                    { path: 'users', name: 'ManageUsers', component: () => import('@/views/admin/UserManage.vue'), meta: manageMeta({ titleKey: 'admin.nav.users', permissions: ['admin.manage'], pageKind: 'collection' }) }
                ]
            }
        ]
    },
    // --- 错误页 ---
    { path: '/403', name: 'Forbidden', component: () => import('@/views/error/403.vue'), meta: { ...staticRouteTitle('common.routeTitles.forbidden'), routeState: 'memory-only' } },
    { path: '/:pathMatch(.*)*', name: 'NotFound', component: () => import('@/views/error/404.vue'), meta: { ...staticRouteTitle('common.routeTitles.notFound'), routeState: 'public-shareable' } }
];
