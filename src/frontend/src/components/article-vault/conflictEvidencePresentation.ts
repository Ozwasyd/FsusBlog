/** Display vocabulary is injected from the actual shared #2116 JSON schema by the host.
 * No schema/registry copy or frontend contract qualification lives here.
 */
export interface ConflictDisplaySchema {
    readonly properties: {
        readonly schema: { readonly const: string; };
        readonly schemaVersion: { readonly const: number; };
        readonly items: { readonly maxItems: number; };
    };
    readonly $defs: {
        readonly type: { readonly enum: readonly string[]; };
        readonly action: { readonly enum: readonly string[]; };
        readonly disposition: { readonly enum: readonly string[]; };
    };
}

/** Read-only projection of codec-decoded #2116 evidence, never a verification or transport contract.
 * The host must supply authorized, current-bound evidence from the canonical owner. These types
 * deliberately carry no source values, plan decisions, execution state or verification flag.
 */
export interface ConflictEvidencePresentation {
    readonly schema: string;
    readonly schemaVersion: number;
    readonly registrySha256: string;
    readonly contentSha256: string;
    readonly binding: {
        readonly portableArticleIdentity: string;
        readonly operationIdentity: string;
        readonly planSha256: string;
        readonly coordinates: Readonly<Record<'base' | 'local' | 'server', ConflictCoordinatePresentation>>;
    };
    readonly items: readonly ConflictItemPresentation[];
}

export interface ConflictCoordinatePresentation {
    readonly present: boolean;
    readonly deleted: boolean;
    readonly serverRevision: number | null;
    readonly lifecycle: string | null;
    readonly source: { readonly sha256: string; } | null;
    readonly metadataManifestSha256: string | null;
    readonly dependencySha256: string | null;
    readonly permissionSha256: string | null;
    readonly contentSha256: string;
}

export interface ConflictItemPresentation {
    readonly type: string;
    readonly disposition: string;
    readonly allowedActions: readonly string[];
    readonly observation: {
        readonly source?: {
            readonly localChanges: readonly ConflictRangePresentation[];
            readonly serverChanges: readonly ConflictRangePresentation[];
        } | null;
        readonly metadata?: {
            readonly changes: readonly {
                readonly field: string;
                readonly entityIdentity: string | null;
            }[];
        } | null;
        readonly authority?: { readonly kind: string; } | null;
    };
}

export interface ConflictRangePresentation {
    readonly start: number;
    readonly end: number;
    readonly semanticNodeIdentity: string;
}

/** An intent for the plan owner to revalidate, not a closed decision or permission to execute. */
export interface ConflictActionIntent {
    readonly evidenceSha256: string;
    readonly operationIdentity: string;
    readonly portableArticleIdentity: string;
    readonly type: string;
    readonly action: string;
}

const typeLabels: Readonly<Record<string, string>> = {
    'source-disjoint': '正文：不相交的更改',
    'source-overlap': '正文：重叠的更改',
    'metadata-disjoint': '元数据：不相交的更改',
    'metadata-overlap': '元数据：重叠的更改',
    'rename-vs-edit': '重命名与编辑',
    'delete-vs-edit': '删除与编辑',
    'create-create': '重复创建',
    'lifecycle-conflict': '生命周期冲突',
    'permission-conflict': '权限冲突',
    'schema-conflict': '结构冲突',
    'dependency-conflict': '依赖冲突',
    'git-marker-present': '正文存在未解决标记'
};

const actionLabels: Readonly<Record<string, string>> = {
    'prepare-source-candidate': '请求正文候选',
    'prepare-metadata-candidate': '请求元数据候选',
    'propose-source-replacement': '提出正文解决方案',
    'propose-metadata-replacement': '提出元数据解决方案',
    'request-refactor-plan': '请求重命名计划',
    'request-deletion-plan': '请求删除计划',
    'refresh-evidence': '重新加载冲突',
    'cancel-operation': '请求取消操作'
};

/** Closed names come from the shared schema. This is display compatibility, not evidence validation. */
export function conflictTypeLabel(type: string, conflictSchema: ConflictDisplaySchema): string | null
{
    return conflictSchema.$defs.type.enum.includes(type) ? typeLabels[type] ?? null : null;
}

export function conflictActionLabel(action: string, conflictSchema: ConflictDisplaySchema): string | null
{
    return conflictSchema.$defs.action.enum.includes(action) ? actionLabels[action] ?? null : null;
}

export function conflictDispositionLabel(disposition: string, conflictSchema: ConflictDisplaySchema): string | null
{
    const labels: Readonly<Record<string, string>> = {
        automatic: '可请求验证候选', manual: '需要逐项决定', rejected: '已阻止'
    };
    return conflictSchema.$defs.disposition.enum.includes(disposition) ? labels[disposition] ?? null : null;
}

export function conflictEvidenceDisplayCompatible(evidence: ConflictEvidencePresentation, conflictSchema: ConflictDisplaySchema): boolean
{
    return evidence.schema === conflictSchema.properties.schema.const
        && evidence.schemaVersion === conflictSchema.properties.schemaVersion.const
        && evidence.items.length > 0
        && evidence.items.length <= conflictSchema.properties.items.maxItems
        && evidence.items.every(item => conflictTypeLabel(item.type, conflictSchema) !== null
            && conflictDispositionLabel(item.disposition, conflictSchema) !== null
            && item.allowedActions.length > 0
            && item.allowedActions.every(action => conflictActionLabel(action, conflictSchema) !== null));
}

/** Bind every request to the exact evidence and item visible when it was activated. */
export function conflictActionIntent(
    evidence: ConflictEvidencePresentation,
    item: ConflictItemPresentation,
    action: string,
    conflictSchema: ConflictDisplaySchema
): ConflictActionIntent | null
{
    if (!conflictEvidenceDisplayCompatible(evidence, conflictSchema)
        || !evidence.items.includes(item) || !item.allowedActions.includes(action))
    {
        return null;
    }
    return {
        evidenceSha256: evidence.contentSha256,
        operationIdentity: evidence.binding.operationIdentity,
        portableArticleIdentity: evidence.binding.portableArticleIdentity,
        type: item.type,
        action
    };
}

export function conflictEvidenceKey(evidence: ConflictEvidencePresentation): string
{
    return JSON.stringify([
        evidence.binding.operationIdentity, evidence.binding.portableArticleIdentity, evidence.contentSha256
    ]);
}

export function conflictAuthorityExplanation(item: ConflictItemPresentation): string | null
{
    switch (item.type)
    {
        case 'lifecycle-conflict':
            return '生命周期与发布状态由服务端决定；此项不能自动覆盖。';
        case 'permission-conflict':
            return '权限由服务端决定；本地选择不能授予写入权限。';
        case 'dependency-conflict':
            return '依赖尚未满足；必须重新验证后才能继续。';
        case 'schema-conflict':
            return '当前结构不兼容；必须重新加载并验证。';
        case 'git-marker-present':
            return '未解决标记阻止正文同步与发布。';
        default:
            return item.disposition === 'rejected' ? '此项已阻止；重新加载后再审阅。' : null;
    }
}
