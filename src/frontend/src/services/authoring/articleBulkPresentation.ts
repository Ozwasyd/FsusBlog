/** Product projections supplied by the canonical bulk transport owner; never a client registry. */
export type ArticleBulkStrategy = 'per-item-isolated' | 'all-or-nothing';
export type ArticleBulkSelectionKind = 'explicit' | 'current-page' | 'saved-view' | 'query';
export type ArticleBulkTerminalState = 'completed' | 'partial' | 'failed' | 'cancelled' | 'blocked' | 'recovery-required';

export interface ArticleBulkSelectionSummary {
    reference: string;
    digest: string;
    kind: ArticleBulkSelectionKind;
    count: number;
}

export interface ArticleBulkParameterControl {
    name: string;
    label: string;
    type: 'stable-id' | 'stable-id-array' | 'opaque-id' | 'digest' | 'rfc3339-utc';
    options: readonly { id: string; label: string; }[];
}

export interface ArticleBulkOperationOption {
    id: string;
    label: string;
    strategy: ArticleBulkStrategy;
    registryDigest: string;
    available: boolean;
    parameters: readonly ArticleBulkParameterControl[];
}

export interface ArticleBulkPlanSummary {
    reference: string;
    digest: string;
    registryDigest: string;
    operationId: string;
    operationLabel: string;
    strategy: ArticleBulkStrategy;
    selection: ArticleBulkSelectionSummary;
    selectedCount: number;
    eligibleCount: number;
    blockedCount: number;
    conflictCount: number;
    executable: boolean;
    expiresAtUtc: string;
    proposedChange: string;
    impactPageReference: string;
}

export interface ArticleBulkItemResult {
    articleIdentity: string;
    receiptReference: string;
    outcome: 'success' | 'precondition-failure' | 'permission-failure' | 'revision-conflict'
        | 'product-failure' | 'infra-no-conclusion' | 'cancelled' | 'not-executed';
    reason: string;
    retryEligible: boolean;
}

export interface ArticleBulkResultSummary {
    executionReference: string;
    planDigest: string;
    receiptReference: string;
    receiptDigest: string;
    strategy: ArticleBulkStrategy;
    state: ArticleBulkTerminalState;
    selectedCount: number;
    eligibleCount: number;
    succeededCount: number;
    failedCount: number;
    cancelledCount: number;
    blockedCount: number;
    notExecutedCount: number;
    commitOutcome: 'committed-all' | 'zero-written' | 'unknown' | null;
    itemPageReference: string;
}

export interface ArticleBulkItemPage {
    planDigest: string;
    receiptDigest: string;
    reference: string;
    items: readonly ArticleBulkItemResult[];
    nextReference: string | null;
}

export interface ArticleBulkImpactPage {
    planDigest: string;
    reference: string;
    items: readonly {
        articleIdentity: string;
        currentState: string;
        proposedChange: string;
        eligible: boolean;
        reason: string;
    }[];
    nextReference: string | null;
}

export interface ArticleBulkProgress {
    executionReference: string;
    planDigest: string;
    strategy: ArticleBulkStrategy;
    state: 'executing' | 'cancelling';
    selectedCount: number;
    eligibleCount: number;
    succeededCount: number;
    failedCount: number;
    cancelledCount: number;
    cancelAllowed: boolean;
}

export type ArticleBulkExecutionObservation = ArticleBulkProgress | ArticleBulkResultSummary;

/** Implemented by the existing authenticated AEDS transport owner, with no single-call fallback. */
export interface ArticleBulkGateway {
    createPlan(input: {
        selectionReference: string;
        selectionDigest: string;
        operationId: string;
        registryDigest: string;
        parameters: Readonly<Record<string, string | readonly string[]>>;
    }): Promise<ArticleBulkPlanSummary>;
    execute(input: { planReference: string; planDigest: string; idempotencyKey: string; }): Promise<ArticleBulkExecutionObservation>;
    readExecution(executionReference: string): Promise<ArticleBulkExecutionObservation>;
    readExecutionByIdempotency(input: { planReference: string; planDigest: string; idempotencyKey: string; }): Promise<ArticleBulkExecutionObservation>;
    cancel(executionReference: string): Promise<ArticleBulkExecutionObservation>;
    readResultPage(reference: string): Promise<ArticleBulkItemPage>;
    readImpactPage(reference: string): Promise<ArticleBulkImpactPage>;
    retry(input: {
        executionReference: string;
        planDigest: string;
        itemReceiptReferences: readonly string[];
        expectedRevisionPolicyReference: string;
    }): Promise<ArticleBulkPlanSummary>;
    downloadReceipt(reference: string): Promise<Blob>;
}

export function articleBulkSelectionLabel(kind: ArticleBulkSelectionKind): string
{
    switch (kind)
    {
        case 'explicit': return '手工选择的确切文章';
        case 'current-page': return '当前页的确切文章';
        case 'saved-view': return '已冻结的保存视图结果';
        case 'query': return '已冻结的查询结果';
        default: throw new Error('article-bulk.selection-kind-invalid');
    }
}

export function articleBulkStrategyLabel(strategy: ArticleBulkStrategy): string
{
    switch (strategy)
    {
        case 'all-or-nothing': return '全部成功才提交；任一失败则全部不提交';
        case 'per-item-isolated': return '逐篇独立处理，可能部分完成';
        default: throw new Error('article-bulk.strategy-invalid');
    }
}

export function articleBulkResultLabel(result: ArticleBulkResultSummary): string
{
    switch (result.state)
    {
        case 'recovery-required': return '结果待核实，请先完成恢复';
        case 'blocked': return '操作被阻止';
        case 'cancelled': return '操作已取消';
        case 'failed': return result.strategy === 'all-or-nothing' ? '未提交任何文章' : '处理失败';
        case 'partial': return '部分处理成功';
        case 'completed': return result.strategy === 'all-or-nothing' ? '全部文章已提交'
            : result.blockedCount > 0 ? '可执行文章已处理，仍有阻止项' : '已处理全部文章';
        default: throw new Error('article-bulk.result-state-invalid');
    }
}

export function articleBulkItemResultLabel(outcome: ArticleBulkItemResult['outcome']): string
{
    switch (outcome)
    {
        case 'success': return '成功';
        case 'precondition-failure': return '条件不满足';
        case 'permission-failure': return '权限已变化';
        case 'revision-conflict': return '版本冲突';
        case 'product-failure': return '处理失败';
        case 'infra-no-conclusion': return '结果待核实';
        case 'cancelled': return '已取消';
        case 'not-executed': return '未执行';
        default: throw new Error('article-bulk.item-outcome-invalid');
    }
}

export function validateArticleBulkResult(result: ArticleBulkResultSummary, plan: ArticleBulkPlanSummary): void
{
    articleBulkResultLabel(result);
    articleBulkStrategyLabel(result.strategy);
    const counts = [result.selectedCount, result.eligibleCount, result.succeededCount, result.failedCount,
        result.cancelledCount, result.blockedCount, result.notExecutedCount];
    if (!result.executionReference || !result.receiptReference || !result.receiptDigest || !result.itemPageReference
        || result.planDigest !== plan.digest || result.strategy !== plan.strategy
        || counts.some(value => !Number.isSafeInteger(value) || value < 0 || value > 10_000)
        || result.selectedCount !== plan.selectedCount || result.eligibleCount !== plan.eligibleCount
        || result.blockedCount !== plan.blockedCount
        || result.succeededCount + result.failedCount + result.cancelledCount + result.notExecutedCount !== result.eligibleCount
        || result.state === 'completed' && result.succeededCount !== result.eligibleCount
        || result.strategy === 'per-item-isolated' && result.commitOutcome !== null
        || result.strategy === 'all-or-nothing' && (result.state === 'partial'
            || result.state === 'completed' && result.commitOutcome !== 'committed-all'
            || ['failed', 'blocked', 'cancelled'].includes(result.state) && (result.commitOutcome !== 'zero-written' || result.succeededCount !== 0)
            || result.state === 'recovery-required' && result.commitOutcome !== 'unknown'))
    {
        throw new Error('article-bulk.result-inexact');
    }
}
