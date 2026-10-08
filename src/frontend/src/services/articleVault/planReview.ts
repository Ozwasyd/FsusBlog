/**
 * Read-only presentation of the canonical ArticleVaultSyncPlanContracts.cs DTOs.
 * This consumer cannot validate currentness, authorize execution, or derive sync state.
 * The shared article-vault-sync-plan.schema.json remains the wire authority.
 */
export type VaultPlanReviewDocument = Readonly<{
    siteIdentity: string;
    vaultIdentity: string;
    deviceIdentity: string;
    direction: 'pull' | 'push' | 'sync';
    createdAtUnixMs: number;
    expiresAtUnixMs: number;
    status: 'ready' | 'no-op' | 'blocked' | 'cancelled';
    cancelPolicy: 'before-execution-only';
    contentSha256: string;
    rootManifestSha256: string;
    operationOrder: readonly string[];
    groups: readonly Readonly<{
        groupIdentity: string;
        allOrNothing: boolean;
        portableArticleIdentities: readonly string[];
        dependencies: readonly Readonly<{
            prerequisitePortableArticleIdentity: string;
            dependentPortableArticleIdentity: string;
        }>[];
        items: readonly VaultPlanReviewItem[];
    }>[];
    conflicts: readonly Readonly<{
        groupIdentity: string;
        portableArticleIdentity: string;
        reasonCode: string;
    }>[];
}>;

export type VaultPlanReviewItem = Readonly<{
    operationIdentity: string;
    sequence: number;
    groupIdentity: string;
    portableArticleIdentity: string;
    serverArticleIdentity: string | null;
    decision: 'no-op' | 'pull-create' | 'pull-update' | 'pull-delete'
        | 'push-create' | 'push-update' | 'push-delete' | 'blocked';
    base: VaultPlanReviewCoordinate;
    local: VaultPlanReviewCoordinate;
    server: VaultPlanReviewCoordinate;
    preconditions: Readonly<{
        articleManifestSha256: string;
        serverObservationSha256: string;
        expectedServerRevision: number | null;
        expectedPermissionSha256: string | null;
        expectedLifecycle: string | null;
    }>;
    dependsOnOperationIdentities: readonly string[];
}>;

export type VaultPlanReviewCoordinate = Readonly<{
    serverRevision: number | null;
    contentSha256: string;
    metadataManifestSha256: string | null;
    dependencySha256: string | null;
    permissionSha256: string | null;
    lifecycle: string | null;
}>;

const directionLabels = {
    pull: '仅拉取计划',
    push: '仅推送计划',
    sync: '同步计划'
} as const;

const decisionLabels = {
    'no-op': '无变更',
    'pull-create': '本地创建',
    'pull-update': '本地更新',
    'pull-delete': '本地删除',
    'push-create': '服务端创建',
    'push-update': '服务端更新',
    'push-delete': '服务端删除',
    blocked: '阻塞'
} as const;

/** Counts/display order are presentation only and never grant confirmation. */
export function presentVaultPlan(plan: VaultPlanReviewDocument)
{
    const items = plan.groups.flatMap((group) => group.items);
    const byOperation = new Map(items.map((item) => [item.operationIdentity, item]));
    const uniqueOrder = new Set(plan.operationOrder);
    // Reject ambiguous display membership instead of silently dropping/reordering an article.
    const orderAvailable = byOperation.size === items.length
        && uniqueOrder.size === plan.operationOrder.length
        && plan.operationOrder.length === items.length
        && plan.operationOrder.every((identity) => byOperation.has(identity));
    return {
        directionLabel: directionLabels[plan.direction],
        articleCount: plan.groups.reduce((count, group) => count + group.portableArticleIdentities.length, 0),
        dependencyCount: plan.groups.reduce((count, group) => count + group.dependencies.length, 0),
        conflictCount: plan.conflicts.length,
        orderAvailable,
        items: orderAvailable ? plan.operationOrder.map((identity) => byOperation.get(identity)!) : [],
        counts: Object.entries(decisionLabels).map(([decision, label]) => ({
            decision,
            label,
            count: items.filter((item) => item.decision === decision).length
        }))
    };
}

/** Changes only displayed rows; canonical order and operation identities are preserved. */
export function filterVaultPlanItems(items: readonly VaultPlanReviewItem[], query: string)
{
    const search = query.trim().toLocaleLowerCase();
    return items.filter((item) => !search || [
        item.portableArticleIdentity,
        item.serverArticleIdentity ?? '',
        item.operationIdentity,
        item.groupIdentity
    ].some((value) => value.toLocaleLowerCase().includes(search)));
}

export function vaultPlanDecisionLabel(decision: VaultPlanReviewItem['decision'])
{
    return decisionLabels[decision];
}
