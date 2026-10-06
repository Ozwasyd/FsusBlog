import { messages } from '@/locales';
import type { AccountArea } from '@/router/accountRouteMeta';

export type { AccountArea, AccountContentMode } from '@/router/accountRouteMeta';
export type AccountNavGroupKey =
  | 'self'
  | 'identity'
  | 'workbench'
  | 'content'
  | 'interaction'
  | 'security'
  | 'system'
  | 'ops';
export type AccountWorkspaceFeatureKey = 'anonymousCommentsEnabled' | 'zkAnonymousEnabled' | 'publicSendOptionEnabled';
export type AccountWorkspacePolicyKey = 'anonymousCommentGovernanceAvailable' | 'zkAnonymousConfigurable';

export const ACCOUNT_GLOBAL_MODULE_LIMIT = 7;

export interface AccountNavWorkspaceContext {
    surface: AccountArea;
    canManage: boolean;
    permissions: readonly string[];
    features: Readonly<Record<AccountWorkspaceFeatureKey, boolean>>;
    policies: Readonly<Record<AccountWorkspacePolicyKey, boolean>>;
}

export interface AccountNavItem {
    label: string;
    to: string;
    helper?: string;
    area: AccountArea;
    groupKey: AccountNavGroupKey;
    adminOnly?: boolean;
    requiredPermission?: string;
    requiredFeature?: AccountWorkspaceFeatureKey;
    requiredPolicy?: AccountWorkspacePolicyKey;
    match?: (path: string) => boolean;
}

export interface AccountAreaMeta {
    label: string;
}

export interface AccountNavGroup {
    key: AccountNavGroupKey;
    label: string;
    helper?: string;
    area: AccountArea;
    to: string;
    items: AccountNavItem[];
}

type AccountNavGroupTemplate = Readonly<{
    key: AccountNavGroupKey;
    label: string;
    helper?: string;
    area: AccountArea;
    landingTo: string;
}>;

export const accountAreaMeta: Record<AccountArea, AccountAreaMeta> = {
    self: {
        label: '账户'
    },
    manage: {
        label: '管理'
    }
};

const anonymousGovernancePaths = [
    '/user/manage/moderation/anonymous-policy',
    '/user/manage/moderation/anonymous-risk',
    '/user/manage/moderation/anonymous-credentials',
    '/user/manage/moderation/nullifiers',
    '/user/manage/moderation/zk-anonymous'
] as const;

const accountNavItems: readonly AccountNavItem[] = [
    { label: '身份中心', to: '/user/identity', area: 'self', groupKey: 'self', match: (path) => path === '/user/identity' },
    { label: '我的消息', to: '/user/messagebox', area: 'self', groupKey: 'self' },
    { label: '语言与区域', to: '/user/preferences/language', area: 'self', groupKey: 'self' },
    { label: '通行密钥', to: '/user/identity/passkeys', helper: '设备', area: 'self', groupKey: 'identity' },
    { label: 'Recovery Key', to: '/user/identity/recovery-key', helper: '恢复', area: 'self', groupKey: 'identity' },
    { label: '公开资料', to: '/user/identity/public-profile', area: 'self', groupKey: 'identity', requiredFeature: 'publicSendOptionEnabled' },
    { label: '公开评论', to: '/user/identity/comment-records', area: 'self', groupKey: 'identity' },
    { label: '设备会话', to: '/user/identity/sessions', area: 'self', groupKey: 'identity' },
    { label: '二次验证', to: '/user/identity/mfa', helper: 'TOTP', area: 'self', groupKey: 'identity' },

    { label: '仪表盘', to: '/user/manage', area: 'manage', groupKey: 'workbench', adminOnly: true, requiredPermission: 'admin.manage', match: (path) => path === '/user/manage' },

    {
        label: '文章',
        to: '/user/manage/article/list',
        area: 'manage',
        groupKey: 'content',
        adminOnly: true,
        requiredPermission: 'article.write',
        match: (path) =>
            path.startsWith('/user/manage/article/list')
      || path.startsWith('/user/manage/article/write')
      || path.startsWith('/user/manage/article/edit/')
    },
    { label: '画布', to: '/user/manage/canvas', area: 'manage', groupKey: 'content', adminOnly: true, requiredPermission: 'article.write' },
    { label: '回收站', to: '/user/manage/article/trash', area: 'manage', groupKey: 'content', adminOnly: true, requiredPermission: 'article.write' },
    { label: '分类', to: '/user/manage/category', area: 'manage', groupKey: 'content', adminOnly: true, requiredPermission: 'article.write' },
    { label: '标签', to: '/user/manage/tag', area: 'manage', groupKey: 'content', adminOnly: true, requiredPermission: 'article.write' },
    { label: '资产库', to: '/user/manage/assets', area: 'manage', groupKey: 'content', adminOnly: true, requiredPermission: 'article.write' },

    {
        label: '审核系统',
        to: '/user/manage/moderation',
        helper: '评论/策略',
        area: 'manage',
        groupKey: 'interaction',
        adminOnly: true,
        requiredPermission: 'comment.moderate',
        match: (path) => (
            path.startsWith('/user/manage/comments')
      || (
          path.startsWith('/user/manage/moderation')
        && !anonymousGovernancePaths.some((governancePath) => (
            path === governancePath || path.startsWith(`${governancePath}/`)
        ))
      )
        )
    },
    { label: '站内信', to: '/user/manage/messages', helper: '工单', area: 'manage', groupKey: 'interaction', adminOnly: true, requiredPermission: 'admin.manage' },
    { label: '用户', to: '/user/manage/users', area: 'manage', groupKey: 'interaction', adminOnly: true, requiredPermission: 'admin.manage' },
    { label: '匿名评论策略', to: '/user/manage/moderation/anonymous-policy', helper: '开关', area: 'manage', groupKey: 'interaction', adminOnly: true, requiredPermission: 'anonymous.comment.configure', requiredPolicy: 'anonymousCommentGovernanceAvailable' },
    { label: '匿名风险', to: '/user/manage/moderation/anonymous-risk', helper: '风险桶', area: 'manage', groupKey: 'interaction', adminOnly: true, requiredPermission: 'comment.moderate', requiredFeature: 'anonymousCommentsEnabled', requiredPolicy: 'anonymousCommentGovernanceAvailable' },
    { label: '匿名资格', to: '/user/manage/moderation/anonymous-credentials', helper: '撤销', area: 'manage', groupKey: 'interaction', adminOnly: true, requiredPermission: 'anonymous.credential.revoke', requiredFeature: 'anonymousCommentsEnabled', requiredPolicy: 'anonymousCommentGovernanceAvailable' },
    { label: '匿名标识', to: '/user/manage/moderation/nullifiers', helper: '封禁', area: 'manage', groupKey: 'interaction', adminOnly: true, requiredPermission: 'anonymous.nullifier.block', requiredFeature: 'anonymousCommentsEnabled', requiredPolicy: 'anonymousCommentGovernanceAvailable' },
    { label: '隐私证明状态', to: '/user/manage/moderation/zk-anonymous', helper: '证明', area: 'manage', groupKey: 'interaction', adminOnly: true, requiredPermission: 'anonymous.comment.configure', requiredPolicy: 'zkAnonymousConfigurable' },

    {
        label: '安全系统',
        to: '/user/manage/security',
        helper: '风险防护',
        area: 'manage',
        groupKey: 'security',
        adminOnly: true,
        requiredPermission: 'system.config',
        match: (path) => path.startsWith('/user/manage/security')
    },

    { label: '系统设置', to: '/user/manage/settings', area: 'manage', groupKey: 'system', adminOnly: true, requiredPermission: 'system.config' },
    { label: '插件', to: '/user/manage/plugins', helper: '运行时', area: 'manage', groupKey: 'system', adminOnly: true, requiredPermission: 'system.config' },
    { label: '备份迁移', to: '/user/manage/content-tools', helper: '导入/导出', area: 'manage', groupKey: 'system', adminOnly: true, requiredPermission: 'system.config' },
    { label: '审计日志', to: '/user/manage/audit', area: 'manage', groupKey: 'system', adminOnly: true, requiredPermission: 'audit.read' },

    { label: '数据概览', to: '/user/manage/analytics', helper: '统计', area: 'manage', groupKey: 'ops', adminOnly: true, requiredPermission: 'admin.manage' },
    { label: '服务与后台状态', to: '/user/manage/ops', helper: '后台', area: 'manage', groupKey: 'ops', adminOnly: true, requiredPermission: 'system.config' },
    { label: '集群与运行时', to: '/user/manage/cluster', helper: '节点', area: 'manage', groupKey: 'ops', adminOnly: true, requiredPermission: 'system.config' },
    { label: '缓存与索引', to: '/user/manage/cache', helper: '索引', area: 'manage', groupKey: 'ops', adminOnly: true, requiredPermission: 'system.config' },
    { label: '内容一致性', to: '/user/manage/integrity', helper: '一致性', area: 'manage', groupKey: 'ops', adminOnly: true, requiredPermission: 'system.config' },
    { label: 'Integrity Proof', to: '/user/manage/integrity-proof', helper: '证明', area: 'manage', groupKey: 'ops', adminOnly: true, requiredPermission: 'system.config' }
];

const navLabelKeys = {
    '/user/identity': 'identityCenter', '/user/messagebox': 'messages',
    '/user/preferences/language': 'languageAndRegion',
    '/user/identity/passkeys': 'passkeys',
    '/user/identity/recovery-key': 'recoveryKey', '/user/identity/public-profile': 'publicProfile',
    '/user/identity/comment-records': 'publicComments', '/user/identity/sessions': 'sessions', '/user/identity/mfa': 'mfa',
    '/user/manage': 'dashboard', '/user/manage/article/list': 'articles', '/user/manage/article/trash': 'trash',
    '/user/manage/canvas': 'canvas',
    '/user/manage/category': 'categories', '/user/manage/tag': 'tags', '/user/manage/assets': 'assets',
    '/user/manage/moderation': 'moderation', '/user/manage/messages': 'inbox', '/user/manage/users': 'users',
    '/user/manage/moderation/anonymous-policy': 'anonymousPolicy', '/user/manage/moderation/anonymous-risk': 'anonymousRisk',
    '/user/manage/moderation/anonymous-credentials': 'anonymousCredentials', '/user/manage/moderation/nullifiers': 'anonymousNullifiers',
    '/user/manage/moderation/zk-anonymous': 'privacyProof', '/user/manage/security': 'security',
    '/user/manage/settings': 'settings', '/user/manage/plugins': 'plugins', '/user/manage/content-tools': 'contentTools', '/user/manage/audit': 'audit',
    '/user/manage/analytics': 'analytics', '/user/manage/ops': 'operations', '/user/manage/cluster': 'clusterRuntime', '/user/manage/cache': 'cache',
    '/user/manage/integrity': 'integrity', '/user/manage/integrity-proof': 'integrityProof'
} as const;

const helperKeys = {
    '设备': 'devices', '恢复': 'recovery', '评论/策略': 'commentsPolicies', '工单': 'tickets', '开关': 'toggle',
    '风险桶': 'riskBuckets', '撤销': 'revoke', '封禁': 'block', '证明': 'proof', '风险防护': 'riskProtection',
    '导入/导出': 'importExport', '运行时': 'runtime', '统计': 'statistics', '后台': 'background', '节点': 'nodes', '索引': 'index', '一致性': 'consistency'
} as const;

const navGroupTemplates: readonly AccountNavGroupTemplate[] = [
    { key: 'self', label: '账户', helper: '身份与消息', area: 'self', landingTo: '/user/identity' },
    { key: 'identity', label: '身份', helper: '凭证与会话', area: 'self', landingTo: '/user/identity/passkeys' },
    { key: 'workbench', label: '工作台', helper: '今日待办', area: 'manage', landingTo: '/user/manage' },
    { key: 'content', label: '内容', helper: '文章与素材', area: 'manage', landingTo: '/user/manage/article/list' },
    { key: 'interaction', label: '互动', helper: '审核与用户', area: 'manage', landingTo: '/user/manage/moderation' },
    { key: 'security', label: '安全', helper: '风险防护', area: 'manage', landingTo: '/user/manage/security' },
    { key: 'system', label: '系统', helper: '配置与审计', area: 'manage', landingTo: '/user/manage/settings' },
    { key: 'ops', label: '运维', helper: '指标与一致性', area: 'manage', landingTo: '/user/manage/analytics' }
];

export function getAccountNavGroups(context: AccountNavWorkspaceContext): AccountNavGroup[]
{
    const groups = navGroupTemplates
        .filter((group) => group.area === context.surface)
        .map((group): AccountNavGroup | null =>
        {
            const items = accountNavItems.filter((item) => (
                item.groupKey === group.key && isNavItemVisible(item, context)
            ));
            const landingItem = items.find((item) => item.to === group.landingTo) ?? items[0];
            const adminMessages = messages.value.admin;

            return landingItem ? {
        key: group.key,
        label: adminMessages?.groups?.[group.key] ?? group.label,
        helper: adminMessages?.groupHelpers?.[group.key] ?? group.helper,
        area: group.area,
        to: landingItem.to,
        items: items.map((item) =>
{
          const labelKey = navLabelKeys[item.to as keyof typeof navLabelKeys];
          return {
            ...item,
            label: labelKey ? adminMessages?.nav?.[labelKey] ?? item.label : item.label,
            helper: item.helper
              ? adminMessages?.helpers?.[helperKeys[item.helper as keyof typeof helperKeys]] ?? item.helper
              : undefined
          };
        })
      } : null;
        })
        .filter((group): group is AccountNavGroup => group !== null);

    return groups.slice(0, ACCOUNT_GLOBAL_MODULE_LIMIT);
}

export function isAccountNavItemActive(item: AccountNavItem, path: string): boolean
{
    if (item.match)
    {
        return item.match(path);
    }

    return path === item.to || path.startsWith(`${item.to}/`);
}

export function isAccountNavGroupActive(group: AccountNavGroup, path: string): boolean
{
    return group.items.some((item) => isAccountNavItemActive(item, path));
}

function isNavItemVisible(item: AccountNavItem, context: AccountNavWorkspaceContext): boolean
{
    if (item.area !== context.surface)
    {
        return false;
    }

    if (item.area === 'manage' && !context.canManage)
    {
        return false;
    }

    if (item.adminOnly && !context.canManage)
    {
        return false;
    }

    if (item.requiredPermission && !hasPermission(context.permissions, item.requiredPermission))
    {
        return false;
    }

    if (item.requiredFeature && context.features[item.requiredFeature] !== true)
    {
        return false;
    }

    if (item.requiredPolicy && context.policies[item.requiredPolicy] !== true)
    {
        return false;
    }

    return true;
}

function hasPermission(permissions: readonly string[], permission: string): boolean
{
    return permissions.includes(permission);
}
