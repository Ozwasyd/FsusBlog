import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { authoringWorkspaceRatioOwner, authoringWorkspaceRatioPolicy, isAuthoringWorkspaceRatioPermille } from './authoringWorkspaceRatioOwner';

import type { AuthoringTabGroupRegistryState, AuthoringTabGroupCommandResult } from './authoringTabGroupRegistry';
import type { AuthoringWorkspaceRatioScope, AuthoringWorkspaceRatioRef, AuthoringWorkspaceRatioChange } from './authoringWorkspaceRatioOwner';

export const openArticleDocumentRegistrySchema = 'fsusblog.open-article-document-registry.v1' as const;
export const openArticleDocumentEntrySchema = 'fsusblog.open-article-document-entry.v1' as const;
export const openArticleDocumentCommandSchema = 'fsusblog.open-article-document-command.v1' as const;
export const openArticleDocumentResultSchema = 'fsusblog.open-article-document-result.v1' as const;

const digestPattern = /^[a-f0-9]{64}$/u;
const stableIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/u;

export interface ArticleDocumentIdentity {
    articleId: number | null;
    draftId: string;
    documentId: string;
}

export interface ArticleDocumentContextRef {
    documentEpoch: number;
    sourceRevision: string | null;
    draftRevision: string | null;
}

export type ArticlePermissionState = 'allowed' | 'read-only' | 'denied' | 'revoked';
export type ArticleLifecycleState = 'current' | 'deleted' | 'archived' | 'draft-replaced' | 'blocked';

export interface ArticleWorkspaceStatusSummary {
    dirty: boolean;
    saving: boolean;
    conflict: boolean;
    recovery: boolean;
    pendingAttachments: boolean;
    permission: ArticlePermissionState;
    lifecycle: ArticleLifecycleState;
    statusRef: string;
}

export interface OpenArticleDocumentEntry {
    schema: typeof openArticleDocumentEntrySchema;
    identity: ArticleDocumentIdentity;
    documentContext: ArticleDocumentContextRef;
    editorSessionRef: string;
    tabId: string;
    isPreview: boolean;
    isPinned: boolean;
    isActive: boolean;
    owningGroupId: string;
    status: ArticleWorkspaceStatusSummary;
    lastActiveAnchorRef: string | null;
    closeRequestRef: string | null;
    lifecycleRevision: number;
    contentDigest: string;
}

declare const retainedDocumentHandleBrand: unique symbol;

/** A selector or a copied entry cannot construct this original Registry capability. */
export interface RetainedArticleDocumentHandle {
    readonly [retainedDocumentHandleBrand]: true;
}

export type RetainedArticleDocumentRevocation = 'final-close' | 'identity-replaced' | 'scope-revoked';

export interface RetainedArticleDocumentInspection {
    readonly state: 'live' | 'blocked' | 'revoked';
    readonly reason: RetainedArticleDocumentRevocation | null;
    readonly registryRevision: number;
    readonly entry: OpenArticleDocumentEntry | null;
    readonly notificationFailed: boolean;
}

interface RetainedArticleDocumentCell {
    readonly registry: OpenArticleDocumentRegistry;
    readonly handle: RetainedArticleDocumentHandle;
    readonly tabId: string;
    readonly initial: OpenArticleDocumentEntry;
    readonly read: () => RetainedArticleDocumentInspection;
    readonly listeners: Set<() => void>;
    reason: RetainedArticleDocumentRevocation | null;
    notificationFailed: boolean;
    notifiedRevision: number;
    notifiedReason: RetainedArticleDocumentRevocation | null;
}

// Provenance is keyed by the opaque object, never article identity or a public ref.
const retainedArticleDocumentCells = new WeakMap<RetainedArticleDocumentHandle, RetainedArticleDocumentCell>();

export function retainedArticleDocumentHandleBelongsTo(handle: RetainedArticleDocumentHandle, registry: OpenArticleDocumentRegistry): boolean
{
    return retainedArticleDocumentCells.get(handle)?.registry === registry;
}

export function inspectRetainedArticleDocumentHandle(handle: RetainedArticleDocumentHandle): RetainedArticleDocumentInspection
{
    const cell = retainedArticleDocumentCells.get(handle);
    if (!cell)
    {
        throw new Error('retained-article-document-handle-invalid');
    }
    return cell.read();
}

export function subscribeRetainedArticleDocumentHandle(handle: RetainedArticleDocumentHandle, listener: () => void): () => void
{
    const cell = retainedArticleDocumentCells.get(handle);
    if (!cell || typeof listener !== 'function')
    {
        throw new Error('retained-article-document-handle-invalid');
    }
    cell.listeners.add(listener);
    return () =>
    {
        cell.listeners.delete(listener);
    };
}

/** Only scope retirement is an explicit revocation; close follows canonical removal. */
export function revokeRetainedArticleDocumentScope(handle: RetainedArticleDocumentHandle): void
{
    const cell = retainedArticleDocumentCells.get(handle);
    if (!cell)
    {
        throw new Error('retained-article-document-handle-invalid');
    }
    cell.reason ??= 'scope-revoked';
    notifyRetainedArticleDocumentCell(cell);
}

function notifyRetainedArticleDocumentCell(cell: RetainedArticleDocumentCell): void
{
    const observation = cell.read();
    if (cell.notifiedRevision === observation.registryRevision && cell.notifiedReason === observation.reason)
    {
        return;
    }
    cell.notifiedRevision = observation.registryRevision;
    cell.notifiedReason = observation.reason;
    for (const listener of [...cell.listeners])
    {
        try
        {
            listener();
        }
        catch
        {
            // The original command already committed. Keep custody and report failed
            // notification rather than return a rejection for a successful command.
            cell.notificationFailed = true;
        }
    }
}

interface RegistryCommandBase {
    schema: typeof openArticleDocumentCommandSchema;
    commandId: string;
    idempotencyKey: string;
    expectedRevision: number;
}

export interface OpenOrActivateArticleCommand extends RegistryCommandBase {
    kind: 'open-or-activate';
    intent: 'workspace' | 'browser-new-tab';
    entrypoint: 'rail' | 'quick-switcher' | 'internal-link' | 'recent-restore' | 'direct-route';
    identity: ArticleDocumentIdentity;
    documentContext: ArticleDocumentContextRef;
    editorSessionRef: string;
    tabId: string;
    targetGroupId: string;
    tabKind: 'preview' | 'pinned';
    status: ArticleWorkspaceStatusSummary;
    lastActiveAnchorRef: string | null;
}

export interface ActivateArticleTabCommand extends RegistryCommandBase {
    kind: 'activate';
    tabId: string;
    lastActiveAnchorRef: string | null;
}

export interface SetArticleTabPinStateCommand extends RegistryCommandBase {
    kind: 'set-pin-state';
    tabId: string;
    pinned: boolean;
}

export interface RequestArticleTabCloseCommand extends RegistryCommandBase {
    kind: 'request-close';
    tabId: string;
}

export interface MarkArticleTabStatusCommand extends RegistryCommandBase {
    kind: 'mark-status';
    tabId: string;
    status: ArticleWorkspaceStatusSummary;
}

export interface ReplaceArticleDraftIdentityCommand extends RegistryCommandBase {
    kind: 'replace-draft-identity';
    tabId: string;
    draftId: string;
    draftRevision: string | null;
    replacementRef: string;
}

export interface InvalidateArticlePermissionCommand extends RegistryCommandBase {
    kind: 'invalidate-permission';
    tabId: string;
    permission: Exclude<ArticlePermissionState, 'allowed'>;
    statusRef: string;
}

export interface InvalidateArticleLifecycleCommand extends RegistryCommandBase {
    kind: 'invalidate-lifecycle';
    tabId: string;
    lifecycle: Exclude<ArticleLifecycleState, 'current'>;
    statusRef: string;
}

export interface DetachArticleOnFinalCloseCommand extends RegistryCommandBase {
    kind: 'detach-on-final-close';
    tabId: string;
    closeDecisionRef: string;
}

export interface UpdateArticleGroupOwnershipCommand extends RegistryCommandBase {
    kind: 'update-group-ownership';
    tabId: string;
    targetGroupId: string;
    ownershipTransactionRef: string;
}

export interface ArticleGroupOwnershipTabRef {
    tabId: string;
    expectedOwningGroupId: string;
    editorSessionRef: string;
    documentEpoch: number;
    lifecycleRevision: number;
}

/** A bounded exact set, never a sequence of single-tab ownership commands. */
export interface UpdateArticleGroupOwnershipSetCommand extends RegistryCommandBase {
    kind: 'update-group-ownership-set';
    tabs: ArticleGroupOwnershipTabRef[];
    targetGroupId: string;
    ownershipTransactionRef: string;
}

export interface ArticleGroupOwnershipTargetRef extends ArticleGroupOwnershipTabRef {
    targetGroupId: string;
}

export interface UpdateArticleGroupOwnershipTransactionCommand extends RegistryCommandBase {
    kind: 'update-group-ownership-transaction';
    tabs: ArticleGroupOwnershipTargetRef[];
    targetGroupIds: string[];
    activeTabId: string | null;
    ownershipTransactionRef: string;
    expectedGroupRevision: number;
    groupStateBeforeDigest: string;
    groupStateAfterDigest: string;
    groupCommandDigest: string;
    ratioRevisionBefore: number;
    ratioRevisionAfter: number;
    splitRatioPermille: number;
}

export interface ArticleGroupOwnershipPublication {
    state: AuthoringTabGroupRegistryState;
    commandHistory: Map<string, { digest: string; result: AuthoringTabGroupCommandResult; }>;
    ratioScope: AuthoringWorkspaceRatioScope;
    splitRatioRef: AuthoringWorkspaceRatioRef;
}

/** Created by the canonical owner, retained privately by the unique group owner. */
export interface ArticleGroupOwnershipCell {
    value: ArticleGroupOwnershipPublication;
    /** Immutable owner-issued guard; reads canonical lifetime authority, never public snapshots. */
    readonly isUnusedForStartup: (expected: ArticleGroupOwnershipPublication) => boolean;
}

export interface ArticleGroupOwnershipChange {
    entryBefore: OpenArticleDocumentEntry;
    entryAfter: OpenArticleDocumentEntry;
}

export type OpenArticleDocumentCommand =
  | OpenOrActivateArticleCommand
  | ActivateArticleTabCommand
  | SetArticleTabPinStateCommand
  | RequestArticleTabCloseCommand
  | MarkArticleTabStatusCommand
  | ReplaceArticleDraftIdentityCommand
  | InvalidateArticlePermissionCommand
  | InvalidateArticleLifecycleCommand
  | DetachArticleOnFinalCloseCommand
  | UpdateArticleGroupOwnershipCommand
  | UpdateArticleGroupOwnershipSetCommand
  | UpdateArticleGroupOwnershipTransactionCommand;

export type OpenArticleDocumentResultStatus =
  | 'applied'
  | 'activated-existing'
  | 'replayed'
  | 'ignored-browser-new-tab'
  | 'rejected-cas'
  | 'rejected-idempotency-conflict'
  | 'rejected-invalid-command'
  | 'rejected-not-found'
  | 'rejected-duplicate-identity'
  | 'rejected-duplicate-session'
  | 'rejected-preview-risk'
  | 'rejected-state';

export interface OpenArticleDocumentCommandResult {
    schema: typeof openArticleDocumentResultSchema;
    commandId: string;
    idempotencyKey: string;
    commandKind: OpenArticleDocumentCommand['kind'] | 'unknown';
    status: OpenArticleDocumentResultStatus;
    reason: string | null;
    revisionBefore: number;
    revisionAfter: number;
    tabId: string | null;
    editorSessionRef: string | null;
    owningGroupId: string | null;
    replacedPreviewTabId: string | null;
    replacedPreviewSessionRef: string | null;
    authorityRef: string | null;
    entryBefore: OpenArticleDocumentEntry | null;
    entryAfter: OpenArticleDocumentEntry | null;
    commandDigest: string;
    contentDigest: string;
    ownershipChanges?: ArticleGroupOwnershipChange[];
    groupRevisionBefore?: number | null;
    groupRevisionAfter?: number | null;
    groupStateBeforeDigest?: string | null;
    groupStateAfterDigest?: string | null;
    groupCommandDigest?: string | null;
}

export interface OpenArticleDocumentRegistryState {
    schema: typeof openArticleDocumentRegistrySchema;
    revision: number;
    entries: OpenArticleDocumentEntry[];
    processedCommandDigests: string[];
    contentDigest: string;
}

interface ProcessedCommand {
    commandDigest: string;
    result: OpenArticleDocumentCommandResult;
}

const commandKeys: Record<OpenArticleDocumentCommand['kind'], readonly string[]> = {
    'open-or-activate': [
        'schema',
        'kind',
        'commandId',
        'idempotencyKey',
        'expectedRevision',
        'intent',
        'entrypoint',
        'identity',
        'documentContext',
        'editorSessionRef',
        'tabId',
        'targetGroupId',
        'tabKind',
        'status',
        'lastActiveAnchorRef'
    ],
    activate: ['schema', 'kind', 'commandId', 'idempotencyKey', 'expectedRevision', 'tabId', 'lastActiveAnchorRef'],
    'set-pin-state': ['schema', 'kind', 'commandId', 'idempotencyKey', 'expectedRevision', 'tabId', 'pinned'],
    'request-close': ['schema', 'kind', 'commandId', 'idempotencyKey', 'expectedRevision', 'tabId'],
    'mark-status': ['schema', 'kind', 'commandId', 'idempotencyKey', 'expectedRevision', 'tabId', 'status'],
    'replace-draft-identity': [
        'schema',
        'kind',
        'commandId',
        'idempotencyKey',
        'expectedRevision',
        'tabId',
        'draftId',
        'draftRevision',
        'replacementRef'
    ],
    'invalidate-permission': [
        'schema',
        'kind',
        'commandId',
        'idempotencyKey',
        'expectedRevision',
        'tabId',
        'permission',
        'statusRef'
    ],
    'invalidate-lifecycle': [
        'schema',
        'kind',
        'commandId',
        'idempotencyKey',
        'expectedRevision',
        'tabId',
        'lifecycle',
        'statusRef'
    ],
    'detach-on-final-close': [
        'schema',
        'kind',
        'commandId',
        'idempotencyKey',
        'expectedRevision',
        'tabId',
        'closeDecisionRef'
    ],
    'update-group-ownership': [
        'schema',
        'kind',
        'commandId',
        'idempotencyKey',
        'expectedRevision',
        'tabId',
        'targetGroupId',
        'ownershipTransactionRef'
    ],
    'update-group-ownership-set': [
        'schema', 'kind', 'commandId', 'idempotencyKey', 'expectedRevision',
        'tabs', 'targetGroupId', 'ownershipTransactionRef'
    ],
    'update-group-ownership-transaction': [
        'schema', 'kind', 'commandId', 'idempotencyKey', 'expectedRevision', 'tabs', 'targetGroupIds',
        'activeTabId', 'ownershipTransactionRef', 'expectedGroupRevision', 'groupStateBeforeDigest',
        'groupStateAfterDigest', 'groupCommandDigest', 'ratioRevisionBefore', 'ratioRevisionAfter', 'splitRatioPermille'
    ]
};

function serializeCanonicalJson(value: unknown): string
{
    if (value === null || typeof value !== 'object')
    {
        return JSON.stringify(value) ?? 'null';
    }

    if (Array.isArray(value))
    {
        return `[${value.map(serializeCanonicalJson).join(',')}]`;
    }

    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .filter(key => record[key] !== undefined)
        .sort()
        .map(key => `${JSON.stringify(key)}:${serializeCanonicalJson(record[key])}`)
        .join(',')}}`;
}

export function calculateOpenArticleDocumentDigest(value: unknown): string
{
    return bytesToHex(sha256(utf8ToBytes(serializeCanonicalJson(value))));
}

function cloneValue<T>(value: T): T
{
    return structuredClone(value);
}

function omitContentDigest<T extends { contentDigest: string; }>(value: T): Omit<T, 'contentDigest'>
{
    const result: Partial<T> = { ...value };
    delete result.contentDigest;
    return result as Omit<T, 'contentDigest'>;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown>
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }

    const actualKeys = Object.keys(value).sort();
    return actualKeys.length === keys.length && actualKeys.every((key, index) => key === [...keys].sort()[index]);
}

function isStableId(value: unknown): value is string
{
    return typeof value === 'string' && stableIdPattern.test(value);
}

function isNullableStableId(value: unknown): value is string | null
{
    return value === null || isStableId(value);
}

function isIdentity(value: unknown): value is ArticleDocumentIdentity
{
    if (!hasExactKeys(value, ['articleId', 'draftId', 'documentId']))
    {
        return false;
    }

    const articleId = value.articleId;
    return (
        (articleId === null || (Number.isSafeInteger(articleId) && Number(articleId) > 0))
        && isStableId(value.draftId)
        && isStableId(value.documentId)
    );
}

function isDocumentContext(value: unknown): value is ArticleDocumentContextRef
{
    return hasExactKeys(value, ['documentEpoch', 'sourceRevision', 'draftRevision'])
        && Number.isSafeInteger(value.documentEpoch)
        && Number(value.documentEpoch) > 0
        && isNullableStableId(value.sourceRevision)
        && isNullableStableId(value.draftRevision);
}

function isStatus(value: unknown): value is ArticleWorkspaceStatusSummary
{
    if (!hasExactKeys(value, [
        'dirty',
        'saving',
        'conflict',
        'recovery',
        'pendingAttachments',
        'permission',
        'lifecycle',
        'statusRef'
    ]))
    {
        return false;
    }

    return [value.dirty, value.saving, value.conflict, value.recovery, value.pendingAttachments]
        .every(flag => typeof flag === 'boolean')
        && ['allowed', 'read-only', 'denied', 'revoked'].includes(String(value.permission))
        && ['current', 'deleted', 'archived', 'draft-replaced', 'blocked'].includes(String(value.lifecycle))
        && isStableId(value.statusRef);
}

function isOwnershipTabSet(value: unknown, memberLimit: number, withTargets = false): value is ArticleGroupOwnershipTabRef[]
{
    if (!Array.isArray(value) || !withTargets && value.length === 0 || value.length > memberLimit)
    {
        return false;
    }
    const tabIds = new Set<string>();
    for (let index = 0; index < value.length; index += 1)
    {
        if (!Object.prototype.hasOwnProperty.call(value, index))
        {
            return false;
        }
        const tab: unknown = value[index];
        if (!hasExactKeys(tab, ['tabId', 'expectedOwningGroupId', 'editorSessionRef', 'documentEpoch', 'lifecycleRevision',
            ...(withTargets ? ['targetGroupId'] : [])])
            || !isStableId(tab.tabId) || !isStableId(tab.expectedOwningGroupId) || !isStableId(tab.editorSessionRef)
            || !Number.isSafeInteger(tab.documentEpoch) || Number(tab.documentEpoch) < 1
            || !Number.isSafeInteger(tab.lifecycleRevision) || Number(tab.lifecycleRevision) < 1
            || withTargets && !isStableId(tab.targetGroupId)
            || tabIds.has(tab.tabId))
        {
            return false;
        }
        tabIds.add(tab.tabId);
    }
    return true;
}

function isValidCommand(command: unknown, ownershipMemberLimit = Number.MAX_SAFE_INTEGER): command is OpenArticleDocumentCommand
{
    if (!command || typeof command !== 'object' || Array.isArray(command))
    {
        return false;
    }

    const record = command as Record<string, unknown>;
    const kind = record.kind as OpenArticleDocumentCommand['kind'];
    const keys = Object.prototype.hasOwnProperty.call(commandKeys, kind) ? commandKeys[kind] : undefined;
    if (
        !keys
        || !hasExactKeys(record, keys)
        || record.schema !== openArticleDocumentCommandSchema
        || !isStableId(record.commandId)
        || !isStableId(record.idempotencyKey)
        || !Number.isSafeInteger(record.expectedRevision)
        || Number(record.expectedRevision) < 0
    )
    {
        return false;
    }

    switch (kind)
    {
        case 'open-or-activate':
            return ['workspace', 'browser-new-tab'].includes(String(record.intent))
                && ['rail', 'quick-switcher', 'internal-link', 'recent-restore', 'direct-route']
                    .includes(String(record.entrypoint))
                && isIdentity(record.identity)
                && isDocumentContext(record.documentContext)
                && isStableId(record.editorSessionRef)
                && isStableId(record.tabId)
                && isStableId(record.targetGroupId)
                && ['preview', 'pinned'].includes(String(record.tabKind))
                && isStatus(record.status)
                && isNullableStableId(record.lastActiveAnchorRef);
        case 'activate':
            return isStableId(record.tabId) && isNullableStableId(record.lastActiveAnchorRef);
        case 'set-pin-state':
            return isStableId(record.tabId) && typeof record.pinned === 'boolean';
        case 'request-close':
            return isStableId(record.tabId);
        case 'mark-status':
            return isStableId(record.tabId) && isStatus(record.status);
        case 'replace-draft-identity':
            return isStableId(record.tabId)
                && isStableId(record.draftId)
                && isNullableStableId(record.draftRevision)
                && isStableId(record.replacementRef);
        case 'invalidate-permission':
            return isStableId(record.tabId)
                && ['read-only', 'denied', 'revoked'].includes(String(record.permission))
                && isStableId(record.statusRef);
        case 'invalidate-lifecycle':
            return isStableId(record.tabId)
                && ['deleted', 'archived', 'draft-replaced', 'blocked'].includes(String(record.lifecycle))
                && isStableId(record.statusRef);
        case 'detach-on-final-close':
            return isStableId(record.tabId) && isStableId(record.closeDecisionRef);
        case 'update-group-ownership':
            return isStableId(record.tabId)
                && isStableId(record.targetGroupId)
                && isStableId(record.ownershipTransactionRef);
        case 'update-group-ownership-set':
            return isStableId(record.targetGroupId)
                && isStableId(record.ownershipTransactionRef)
                && isOwnershipTabSet(record.tabs, ownershipMemberLimit);
        case 'update-group-ownership-transaction': {
            const targets = record.targetGroupIds;
            return isOwnershipTabSet(record.tabs, ownershipMemberLimit, true)
                && Array.isArray(targets) && targets.length >= 1 && targets.length <= 2
                && targets.every((target, index) => Object.prototype.hasOwnProperty.call(targets, index) && isStableId(target))
                && Object.keys(targets).length === targets.length && new Set(targets).size === targets.length
                && record.tabs.every(tab => targets.includes((tab as ArticleGroupOwnershipTargetRef).targetGroupId))
                && isNullableStableId(record.activeTabId) && (record.activeTabId === null || record.tabs.some(tab => tab.tabId === record.activeTabId))
                && isStableId(record.ownershipTransactionRef) && Number.isSafeInteger(record.expectedGroupRevision) && Number(record.expectedGroupRevision) >= 0
                && typeof record.groupStateBeforeDigest === 'string' && digestPattern.test(record.groupStateBeforeDigest)
                && typeof record.groupStateAfterDigest === 'string' && digestPattern.test(record.groupStateAfterDigest)
                && typeof record.groupCommandDigest === 'string' && digestPattern.test(record.groupCommandDigest)
                && Number.isSafeInteger(record.ratioRevisionBefore) && Number(record.ratioRevisionBefore) >= 0
                && Number.isSafeInteger(record.ratioRevisionAfter) && Number(record.ratioRevisionAfter) >= Number(record.ratioRevisionBefore)
                && isAuthoringWorkspaceRatioPermille(record.splitRatioPermille);
        }
    }
}

function identityKey(identity: ArticleDocumentIdentity): string
{
    return identity.articleId === null ? `draft:${identity.draftId}` : `article:${identity.articleId}`;
}

function isRiskyPreview(entry: OpenArticleDocumentEntry): boolean
{
    return entry.status.dirty
        || entry.status.saving
        || entry.status.conflict
        || entry.status.recovery
        || entry.status.pendingAttachments
        || entry.status.permission !== 'allowed'
        || entry.status.lifecycle !== 'current'
        || entry.closeRequestRef !== null;
}

function computeEntryDigest(entry: Omit<OpenArticleDocumentEntry, 'contentDigest'>): string
{
    return calculateOpenArticleDocumentDigest(entry);
}

function withEntryDigest(entry: Omit<OpenArticleDocumentEntry, 'contentDigest'>): OpenArticleDocumentEntry
{
    return {
        ...entry,
        contentDigest: computeEntryDigest(entry)
    };
}

function makeRejectedResult(
    command: unknown,
    status: OpenArticleDocumentResultStatus,
    revision: number,
    reason: string,
    commandDigest = calculateOpenArticleDocumentDigest(command)
): OpenArticleDocumentCommandResult
{
    const record = command && typeof command === 'object' ? command as Record<string, unknown> : {};
    const base = {
        schema: openArticleDocumentResultSchema,
        commandId: isStableId(record.commandId) ? record.commandId : 'invalid-command',
        idempotencyKey: isStableId(record.idempotencyKey) ? record.idempotencyKey : 'invalid-idempotency',
        commandKind: typeof record.kind === 'string'
            && Object.prototype.hasOwnProperty.call(commandKeys, record.kind)
            ? record.kind as OpenArticleDocumentCommand['kind']
            : 'unknown' as const,
        status,
        reason,
        revisionBefore: revision,
        revisionAfter: revision,
        tabId: null,
        editorSessionRef: null,
        owningGroupId: null,
        replacedPreviewTabId: null,
        replacedPreviewSessionRef: null,
        authorityRef: null,
        entryBefore: null,
        entryAfter: null,
        commandDigest,
        ...(['update-group-ownership-set', 'update-group-ownership-transaction'].includes(String(record.kind)) ? { ownershipChanges: [] } : {}),
        ...(record.kind === 'update-group-ownership-transaction' ? { groupRevisionBefore: null, groupRevisionAfter: null,
            groupStateBeforeDigest: null, groupStateAfterDigest: null, groupCommandDigest: null } : {})
    };

    return {
        ...base,
        contentDigest: calculateOpenArticleDocumentDigest(base)
    };
}

export class OpenArticleDocumentRegistry
{
    private entriesByTabId = new Map<string, OpenArticleDocumentEntry>();
    private tabIdByIdentity = new Map<string, string>();
    private tabIdBySessionRef = new Map<string, string>();
    private processedCommands = new Map<string, ProcessedCommand>();
    private revision = 0;
    #ownershipTransactionPending = false;
    #groupOwnershipCell: ArticleGroupOwnershipCell | null = null;
    private readonly retainedDocumentCells = new Set<RetainedArticleDocumentCell>();
    private retainedNotificationPending = false;

    public issueRetainedDocumentHandle(tabId: string): RetainedArticleDocumentHandle
    {
        const entry = this.entriesByTabId.get(tabId);
        if (!entry || this.#ownershipTransactionPending || this.retainedNotificationPending)
        {
            throw new Error('retained-article-document-member-unavailable');
        }
        const existing = [...this.retainedDocumentCells].find(cell => cell.tabId === tabId && cell.reason === null);
        if (existing)
        {
            const observation = existing.read();
            if (observation.state !== 'revoked')
            {
                return existing.handle;
            }
        }
        // A scope-retired member cannot mint a replacement handle before final close.
        if ([...this.retainedDocumentCells].some(cell => cell.tabId === tabId
            && cell.reason === 'scope-revoked' && cell.initial.editorSessionRef === entry.editorSessionRef
            && cell.initial.identity.documentId === entry.identity.documentId))
        {
            throw new Error('retained-article-document-scope-revoked');
        }
        const handle = Object.freeze({}) as RetainedArticleDocumentHandle;
        const cell: RetainedArticleDocumentCell = {
            registry: this,
            handle,
            tabId,
            initial: cloneValue(entry),
            reason: null,
            notificationFailed: false,
            notifiedRevision: this.revision,
            notifiedReason: null,
            listeners: new Set(),
            read: () =>
            {
                const current = this.entriesByTabId.get(tabId);
                if (!cell.reason)
                {
                    if (!current)
                    {
                        cell.reason = 'final-close';
                    }
                    else if (current.editorSessionRef !== cell.initial.editorSessionRef
                        || current.identity.articleId !== cell.initial.identity.articleId
                        || current.identity.draftId !== cell.initial.identity.draftId
                        || current.identity.documentId !== cell.initial.identity.documentId
                        || current.documentContext.documentEpoch !== cell.initial.documentContext.documentEpoch)
                    {
                        cell.reason = 'identity-replaced';
                    }
                }
                return Object.freeze({
                    state: cell.reason ? 'revoked' : current?.status.permission === 'allowed'
                        && current.status.lifecycle === 'current' && !cell.notificationFailed ? 'live' : 'blocked',
                    reason: cell.reason,
                    registryRevision: this.revision,
                    entry: !current || cell.reason === 'final-close' || cell.reason === 'identity-replaced' ? null : cloneValue(current),
                    notificationFailed: cell.notificationFailed
                });
            }
        };
        this.retainedDocumentCells.add(cell);
        retainedArticleDocumentCells.set(handle, cell);
        return handle;
    }

    private notifyRetainedDocuments(): void
    {
        if (this.retainedNotificationPending)
        {
            return;
        }
        this.retainedNotificationPending = true;
        try
        {
            for (const cell of this.retainedDocumentCells)
            {
                notifyRetainedArticleDocumentCell(cell);
            }
        }
        finally
        {
            this.retainedNotificationPending = false;
        }
    }

    public createGroupOwnershipCell(initial: ArticleGroupOwnershipPublication): ArticleGroupOwnershipCell
    {
        if (this.#groupOwnershipCell)
        {
            throw new Error('article-group-owner-already-attached');
        }
        const active = [...this.entriesByTabId.values()].find(entry => entry.isActive)?.tabId ?? null;
        if (!initial || !(initial.commandHistory instanceof Map) || initial.commandHistory.size !== 0
            || initial.state.revision !== 0 || initial.state.articleRegistryRevision !== this.revision
            || calculateOpenArticleDocumentDigest(omitContentDigest(initial.state)) !== initial.state.contentDigest
            || !this.isExactGroupProjection(initial.state, this.entriesByTabId, active))
        {
            throw new Error('article-group-initial-publication-invalid');
        }
        const ratio = authoringWorkspaceRatioOwner.resolve(initial.ratioScope, initial.splitRatioRef);
        if (initial.state.splitRatio.revision !== ratio.revision || initial.state.splitRatio.splitRatioPermille !== ratio.splitRatioPermille)
        {
            throw new Error('article-group-initial-ratio-invalid');
        }
        const cell: ArticleGroupOwnershipCell = { value: this.cloneGroupPublication(initial),
            isUnusedForStartup: (expected: ArticleGroupOwnershipPublication) =>
                this.#groupOwnershipCell === cell && cell.value === expected && !this.#ownershipTransactionPending
                && this.revision === 0 && this.entriesByTabId.size === 0 && this.processedCommands.size === 0 };
        // This original-owner closure observes the real monotonic revision, including
        // open/close/detach back to empty. It introduces no separate usage ledger.
        Object.defineProperty(cell, 'isUnusedForStartup', { writable: false, configurable: false, enumerable: false });
        this.#groupOwnershipCell = cell;
        return cell;
    }

    public executeGroupOwnershipTransaction(command: UpdateArticleGroupOwnershipTransactionCommand,
        expected: ArticleGroupOwnershipPublication, next: ArticleGroupOwnershipPublication,
        ratioChange?: AuthoringWorkspaceRatioChange): OpenArticleDocumentCommandResult
    {
        const result = this.executeCore(command, { expected, next, ratioChange });
        this.notifyRetainedDocuments();
        return result;
    }

    private cloneGroupPublication(publication: ArticleGroupOwnershipPublication): ArticleGroupOwnershipPublication
    {
        return { ...cloneValue({ state: publication.state, commandHistory: publication.commandHistory }),
            ratioScope: publication.ratioScope, splitRatioRef: publication.splitRatioRef };
    }

    public getRevision(): number
    {
        return this.revision;
    }

    public getEntry(tabId: string): OpenArticleDocumentEntry | null
    {
        const entry = this.entriesByTabId.get(tabId);
        return entry ? cloneValue(entry) : null;
    }

    public getEntryByIdentity(identity: ArticleDocumentIdentity): OpenArticleDocumentEntry | null
    {
        const tabId = this.tabIdByIdentity.get(identityKey(identity));
        return tabId ? this.getEntry(tabId) : null;
    }

    public listEntries(): OpenArticleDocumentEntry[]
    {
        return [...this.entriesByTabId.values()]
            .sort((left, right) => left.tabId.localeCompare(right.tabId))
            .map(cloneValue);
    }

    public openOrActivate(command: OpenOrActivateArticleCommand): OpenArticleDocumentCommandResult
    {
        return this.execute(command);
    }

    public execute(command: unknown): OpenArticleDocumentCommandResult
    {
        const result = this.executeCore(command);
        this.notifyRetainedDocuments();
        return result;
    }

    private executeCore(command: unknown, groupPublication?: { expected: ArticleGroupOwnershipPublication;
        next: ArticleGroupOwnershipPublication; ratioChange?: AuthoringWorkspaceRatioChange; }): OpenArticleDocumentCommandResult
    {
        if (this.#ownershipTransactionPending || this.retainedNotificationPending)
        {
            return makeRejectedResult(command, 'rejected-state', this.revision, 'ownership-transaction-pending');
        }
        const commandDigest = calculateOpenArticleDocumentDigest(command);
        // Shape validation is independent of the current live membership. A
        // saved success remains replayable after members have legally closed.
        if (!isValidCommand(command))
        {
            return makeRejectedResult(
                command,
                'rejected-invalid-command',
                this.revision,
                'command-schema-invalid',
                commandDigest
            );
        }

        const processed = this.processedCommands.get(command.idempotencyKey);
        if (processed)
        {
            if (processed.commandDigest !== commandDigest)
            {
                return makeRejectedResult(
                    command,
                    'rejected-idempotency-conflict',
                    this.revision,
                    'idempotency-key-reused-with-different-command',
                    commandDigest
                );
            }

            return this.asReplay(processed.result);
        }

        if (!isValidCommand(command, this.entriesByTabId.size))
        {
            return makeRejectedResult(command, 'rejected-invalid-command', this.revision, 'command-schema-invalid', commandDigest);
        }

        if (command.expectedRevision !== this.revision)
        {
            return makeRejectedResult(command, 'rejected-cas', this.revision, 'registry-revision-mismatch', commandDigest);
        }

        if (command.kind === 'update-group-ownership-transaction')
        {
            if (!groupPublication)
            {
                return makeRejectedResult(command, 'rejected-state', this.revision, 'joint-group-publication-required', commandDigest);
            }
            this.#ownershipTransactionPending = true;
            try
            {
                return this.applyGroupOwnershipTransaction(command, commandDigest, groupPublication.expected, groupPublication.next, groupPublication.ratioChange);
            }
            finally
            {
                this.#ownershipTransactionPending = false;
            }
        }

        if (command.kind === 'update-group-ownership-set')
        {
            this.#ownershipTransactionPending = true;
            try
            {
                return this.applyOwnershipSet(command, commandDigest);
            }
            finally
            {
                this.#ownershipTransactionPending = false;
            }
        }

        const result = this.applyCommand(command, commandDigest);
        if (result.status === 'applied' || result.status === 'activated-existing')
        {
            this.processedCommands.set(command.idempotencyKey, {
                commandDigest,
                result: cloneValue(result)
            });
        }
        return cloneValue(result);
    }

    public exportState(): OpenArticleDocumentRegistryState
    {
        const base = {
            schema: openArticleDocumentRegistrySchema,
            revision: this.revision,
            entries: this.listEntries(),
            processedCommandDigests: [...this.processedCommands.values()]
                .map(processed => processed.commandDigest)
                .sort()
        };
        return {
            ...base,
            contentDigest: calculateOpenArticleDocumentDigest(base)
        };
    }

    private applyCommand(
        command: OpenArticleDocumentCommand,
        commandDigest: string
    ): OpenArticleDocumentCommandResult
    {
        switch (command.kind)
        {
            case 'open-or-activate':
                return this.applyOpenOrActivate(command, commandDigest);
            case 'activate':
                return this.applyActivate(command, commandDigest);
            case 'set-pin-state':
                return this.applySetPinState(command, commandDigest);
            case 'request-close':
                return this.applyEntryMutation(command, commandDigest, entry => ({
                    ...entry,
                    closeRequestRef: command.commandId
                }));
            case 'mark-status':
                return this.applyEntryMutation(command, commandDigest, entry => ({
                    ...entry,
                    status: cloneValue(command.status),
                    isPreview: isRiskStatus(command.status) ? false : entry.isPreview,
                    isPinned: isRiskStatus(command.status) ? true : entry.isPinned
                }));
            case 'replace-draft-identity':
                return this.applyDraftReplacement(command, commandDigest);
            case 'invalidate-permission':
                return this.applyEntryMutation(command, commandDigest, entry => ({
                    ...entry,
                    status: {
                        ...entry.status,
                        permission: command.permission,
                        statusRef: command.statusRef
                    }
                }));
            case 'invalidate-lifecycle':
                return this.applyEntryMutation(command, commandDigest, entry => ({
                    ...entry,
                    status: {
                        ...entry.status,
                        lifecycle: command.lifecycle,
                        statusRef: command.statusRef
                    }
                }));
            case 'detach-on-final-close':
                return this.applyDetach(command, commandDigest);
            case 'update-group-ownership':
                return this.applyEntryMutation(command, commandDigest, entry => ({
                    ...entry,
                    owningGroupId: command.targetGroupId
                }));
            case 'update-group-ownership-set':
                return this.applyOwnershipSet(command, commandDigest);
            case 'update-group-ownership-transaction':
                return makeRejectedResult(command, 'rejected-state', this.revision, 'joint-group-publication-required', commandDigest);
        }
    }

    private applyOwnershipSet(
        command: UpdateArticleGroupOwnershipSetCommand,
        commandDigest: string
    ): OpenArticleDocumentCommandResult
    {
        const entries: OpenArticleDocumentEntry[] = [];
        for (const reference of command.tabs)
        {
            const entry = this.entriesByTabId.get(reference.tabId);
            if (!entry)
            {
                return makeRejectedResult(command, 'rejected-not-found', this.revision, 'tab-not-found', commandDigest);
            }
            if (entry.owningGroupId !== reference.expectedOwningGroupId
                || entry.editorSessionRef !== reference.editorSessionRef
                || entry.documentContext.documentEpoch !== reference.documentEpoch
                || entry.lifecycleRevision !== reference.lifecycleRevision)
            {
                return makeRejectedResult(command, 'rejected-cas', this.revision, 'ownership-reference-mismatch', commandDigest);
            }
            if (entry.owningGroupId === command.targetGroupId)
            {
                return makeRejectedResult(command, 'rejected-state', this.revision, 'tab-already-in-target-group', commandDigest);
            }
            if (!Number.isSafeInteger(entry.lifecycleRevision + 1) || !Number.isSafeInteger(this.revision + 1))
            {
                return makeRejectedResult(command, 'rejected-state', this.revision, 'ownership-revision-exhausted', commandDigest);
            }
            entries.push(entry);
        }

        // Every hash, clone and receipt is prepared before publishing the owner's
        // map/revision/idempotency state. Identity/session indices stay untouched.
        try
        {
            const nextEntries = new Map(this.entriesByTabId);
            const changes = entries.map(entry => ({
                entryBefore: cloneValue(entry),
                entryAfter: withEntryDigest({
                    ...omitContentDigest(entry),
                    owningGroupId: command.targetGroupId,
                    lifecycleRevision: entry.lifecycleRevision + 1
                })
            }));
            for (const change of changes)
            {
                nextEntries.set(change.entryAfter.tabId, change.entryAfter);
            }
            const base = {
                ...omitContentDigest(makeRejectedResult(command, 'applied', this.revision, '', commandDigest)),
                reason: null,
                revisionAfter: this.revision + 1,
                authorityRef: command.ownershipTransactionRef,
                ownershipChanges: changes
            };
            const result: OpenArticleDocumentCommandResult = {
                ...base,
                contentDigest: calculateOpenArticleDocumentDigest(base)
            };
            const outward = cloneValue(result);
            const nextProcessed = new Map(this.processedCommands);
            nextProcessed.set(command.idempotencyKey, { commandDigest, result: cloneValue(result) });
            this.entriesByTabId = nextEntries;
            this.processedCommands = nextProcessed;
            this.revision = result.revisionAfter;
            return outward;
        }
        catch
        {
            return makeRejectedResult(command, 'rejected-state', this.revision, 'ownership-preparation-failed', commandDigest);
        }
    }

    private applyGroupOwnershipTransaction(command: UpdateArticleGroupOwnershipTransactionCommand, commandDigest: string,
        expected: ArticleGroupOwnershipPublication, next: ArticleGroupOwnershipPublication,
        ratioChange?: AuthoringWorkspaceRatioChange): OpenArticleDocumentCommandResult
    {
        const cell = this.#groupOwnershipCell;
        if (cell?.value !== expected || expected.state.revision !== command.expectedGroupRevision
            || expected.state.contentDigest !== command.groupStateBeforeDigest)
        {
            return makeRejectedResult(command, 'rejected-cas', this.revision, 'group-publication-mismatch', commandDigest);
        }
        if (command.tabs.length !== this.entriesByTabId.size || !Number.isSafeInteger(this.revision + 1))
        {
            return makeRejectedResult(command, 'rejected-state', this.revision, 'complete-owned-tab-set-required', commandDigest);
        }
        try
        {
            const currentRatio = authoringWorkspaceRatioOwner.resolve(expected.ratioScope, expected.splitRatioRef);
            const proposedRatio = ratioChange ? authoringWorkspaceRatioOwner.readPrepared(expected.ratioScope, ratioChange) : currentRatio;
            if (next.ratioScope !== expected.ratioScope || next.splitRatioRef !== proposedRatio.ratioRef
                || ratioChange && 'expectedRatioRef' in proposedRatio && proposedRatio.expectedRatioRef !== expected.splitRatioRef
                || command.ratioRevisionBefore !== currentRatio.revision || command.ratioRevisionAfter !== proposedRatio.revision
                || command.splitRatioPermille !== proposedRatio.splitRatioPermille
                || next.state.splitRatio.revision !== proposedRatio.revision || next.state.splitRatio.splitRatioPermille !== proposedRatio.splitRatioPermille)
            {
                return makeRejectedResult(command, 'rejected-cas', this.revision, 'ratio-publication-mismatch', commandDigest);
            }
            const changes: ArticleGroupOwnershipChange[] = [];
            const nextEntries = new Map(this.entriesByTabId);
            for (const reference of command.tabs)
            {
                const entry = this.entriesByTabId.get(reference.tabId);
                if (entry?.owningGroupId !== reference.expectedOwningGroupId
                    || entry.editorSessionRef !== reference.editorSessionRef
                    || entry.documentContext.documentEpoch !== reference.documentEpoch
                    || entry.lifecycleRevision !== reference.lifecycleRevision)
                {
                    return makeRejectedResult(command, 'rejected-cas', this.revision, 'ownership-reference-mismatch', commandDigest);
                }
                const active = command.activeTabId === entry.tabId;
                if (active && !entry.isActive && (entry.status.permission === 'denied' || entry.status.permission === 'revoked'
                    || entry.status.lifecycle !== 'current'))
                {
                    return makeRejectedResult(command, 'rejected-state', this.revision, 'activation-blocked', commandDigest);
                }
                const changed = entry.owningGroupId !== reference.targetGroupId || entry.isActive !== active;
                const after = changed ? withEntryDigest({ ...omitContentDigest(entry), owningGroupId: reference.targetGroupId,
                    isActive: active, lifecycleRevision: entry.lifecycleRevision + 1 }) : entry;
                if (!Number.isSafeInteger(after.lifecycleRevision))
                {
                    return makeRejectedResult(command, 'rejected-state', this.revision, 'revision-exhausted', commandDigest);
                }
                changes.push({ entryBefore: cloneValue(entry), entryAfter: cloneValue(after) });
                nextEntries.set(entry.tabId, after);
            }
            const state = next.state;
            if (state.revision !== command.expectedGroupRevision + 1 || !Number.isSafeInteger(state.revision)
                || state.articleRegistryRevision !== this.revision + 1 || state.contentDigest !== command.groupStateAfterDigest
                || calculateOpenArticleDocumentDigest(omitContentDigest(state)) !== state.contentDigest
                || calculateOpenArticleDocumentDigest(state.groups.map(group => group.groupId)) !== calculateOpenArticleDocumentDigest(command.targetGroupIds)
                || !this.isExactGroupProjection(state, nextEntries, command.activeTabId))
            {
                return makeRejectedResult(command, 'rejected-state', this.revision, 'group-projection-mismatch', commandDigest);
            }
            if (!(next.commandHistory instanceof Map))
            {
                return makeRejectedResult(command, 'rejected-state', this.revision, 'group-idempotency-publication-mismatch', commandDigest);
            }
            const cached = next.commandHistory.get(command.idempotencyKey);
            const currentActiveTabId = [...this.entriesByTabId.values()].find(entry => entry.isActive)?.tabId ?? null;
            if (next.commandHistory.size !== expected.commandHistory.size + 1
                || [...expected.commandHistory].some(([key, value]) => next.commandHistory.get(key) !== value)
                || !cached || !hasExactKeys(cached, ['digest', 'result'])
                || !hasExactKeys(cached.result, ['schema', 'commandId', 'idempotencyKey', 'status', 'reason', 'commandDigest',
                    'revisionBefore', 'revisionAfter', 'articleRevisionBefore', 'articleRevisionAfter', 'ownershipTransactionRef',
                    'before', 'after', 'contentDigest'])
                || cached.digest !== command.groupCommandDigest || cached.result.commandId !== command.commandId
                || cached.result.idempotencyKey !== command.idempotencyKey || cached.result.after.contentDigest !== state.contentDigest
                || cached.result.schema !== 'fsusblog.authoring-tab-group-result.v1'
                || cached.result.commandDigest !== command.groupCommandDigest || cached.result.status !== 'applied' || cached.result.reason !== null
                || cached.result.ownershipTransactionRef !== command.ownershipTransactionRef
                || cached.result.revisionBefore !== command.expectedGroupRevision || cached.result.revisionAfter !== state.revision
                || cached.result.articleRevisionBefore !== this.revision || cached.result.articleRevisionAfter !== state.articleRegistryRevision
                || cached.result.before.revision !== command.expectedGroupRevision || cached.result.before.articleRegistryRevision !== this.revision
                || !this.isExactGroupProjection(cached.result.before, this.entriesByTabId, currentActiveTabId)
                || calculateOpenArticleDocumentDigest(cached.result.before.groups.map(group => group.groupId))
                    !== calculateOpenArticleDocumentDigest(expected.state.groups.map(group => group.groupId))
                || calculateOpenArticleDocumentDigest(omitContentDigest(cached.result.before)) !== cached.result.before.contentDigest
                || calculateOpenArticleDocumentDigest(omitContentDigest(cached.result.after)) !== state.contentDigest
                || calculateOpenArticleDocumentDigest(omitContentDigest(cached.result)) !== cached.result.contentDigest)
            {
                return makeRejectedResult(command, 'rejected-state', this.revision, 'group-idempotency-publication-mismatch', commandDigest);
            }
            const base = { ...omitContentDigest(makeRejectedResult(command, 'applied', this.revision, '', commandDigest)), reason: null,
                revisionAfter: this.revision + 1, authorityRef: command.ownershipTransactionRef, ownershipChanges: changes,
                groupRevisionBefore: expected.state.revision, groupRevisionAfter: state.revision,
                groupStateBeforeDigest: expected.state.contentDigest, groupStateAfterDigest: state.contentDigest, groupCommandDigest: command.groupCommandDigest };
            const result: OpenArticleDocumentCommandResult = { ...base, contentDigest: calculateOpenArticleDocumentDigest(base) };
            const outward = cloneValue(result);
            const nextProcessed = new Map(this.processedCommands);
            nextProcessed.set(command.idempotencyKey, { commandDigest, result: cloneValue(result) });
            const publication = this.cloneGroupPublication(next);
            const descriptor = Object.getOwnPropertyDescriptor(cell, 'value');
            if (!descriptor?.writable || descriptor.get || descriptor.set)
            {
                return makeRejectedResult(command, 'rejected-state', this.revision, 'group-publication-cell-not-writable', commandDigest);
            }
            for (const field of ['entriesByTabId', 'processedCommands', 'revision'])
            {
                const property = Object.getOwnPropertyDescriptor(this, field);
                if (!property?.writable || property.get || property.set)
                {
                    return makeRejectedResult(command, 'rejected-state', this.revision, 'registry-publication-field-not-writable', commandDigest);
                }
            }
            // The registered cell is created here as a plain own data property.
            // All fallible work has finished; no publisher callback or await runs.
            // The actual ratio owner performs its exact-ref CAS before the plain
            // assignments. Its refusal occurs before any Registry publication.
            if (ratioChange)
            {
                authoringWorkspaceRatioOwner.commit(expected.ratioScope, ratioChange);
            }
            this.entriesByTabId = nextEntries;
            this.processedCommands = nextProcessed;
            this.revision = result.revisionAfter;
            cell.value = publication;
            return outward;
        }
        catch
        {
            return makeRejectedResult(command, 'rejected-state', this.revision, 'joint-ownership-preparation-failed', commandDigest);
        }
    }

    private isExactGroupProjection(state: AuthoringTabGroupRegistryState, entries: Map<string, OpenArticleDocumentEntry>, activeTabId: string | null): boolean
    {
        if (!hasExactKeys(state, ['schema', 'revision', 'articleRegistryRevision', 'layoutState', 'effectiveLayoutState', 'groups',
            'activeGroupId', 'focusedGroupId', 'effectiveFocusedGroupId', 'focusHistory', 'activationHistory', 'historyCapacity',
            'splitRatio', 'collapsedByViewportRef', 'contentDigest'])
            || state.schema !== 'fsusblog.authoring-tab-group-registry.v1'
            || !Array.isArray(state.groups) || state.groups.length < 1 || state.groups.length > 2
            || Object.keys(state.groups).length !== state.groups.length
            || new Set(state.groups.map(group => group.groupId)).size !== state.groups.length
            || !state.groups.some(group => group.groupId === state.activeGroupId)
            || !state.groups.some(group => group.groupId === state.focusedGroupId)
            || !hasExactKeys(state.splitRatio, ['policySchema', 'revision', 'splitRatioPermille'])
            || state.splitRatio.policySchema !== authoringWorkspaceRatioPolicy.schema
            || !Number.isSafeInteger(state.splitRatio.revision) || state.splitRatio.revision < 0
            || !isAuthoringWorkspaceRatioPermille(state.splitRatio.splitRatioPermille)
            || !isNullableStableId(state.collapsedByViewportRef)
            || !Number.isSafeInteger(state.historyCapacity) || state.historyCapacity < 1
            || state.layoutState !== (state.groups.length === 2 ? 'horizontal-two-group' : 'single-group')
            || state.effectiveLayoutState !== (state.collapsedByViewportRef ? 'single-group' : state.layoutState)
            || state.effectiveFocusedGroupId !== state.focusedGroupId
            || !Array.isArray(state.focusHistory) || Object.keys(state.focusHistory).length !== state.focusHistory.length
            || state.focusHistory.length > state.historyCapacity || new Set(state.focusHistory).size !== state.focusHistory.length
            || state.focusHistory.some(id => !state.groups.some(group => group.groupId === id))
            || !Array.isArray(state.activationHistory) || Object.keys(state.activationHistory).length !== state.activationHistory.length
            || state.activationHistory.length > state.historyCapacity
            || new Set(state.activationHistory.map(ref => ref.tabId)).size !== state.activationHistory.length
            || state.activationHistory.some(ref => !hasExactKeys(ref, ['groupId', 'tabId', 'editorSessionRef'])
                || !state.groups.some(group => group.groupId === ref.groupId
                    && group.tabs.some(tab => tab.tabId === ref.tabId && tab.editorSessionRef === ref.editorSessionRef))))
        {
            return false;
        }
        const seen = new Set<string>();
        for (const group of state.groups)
        {
            if (!hasExactKeys(group, ['groupId', 'revision', 'tabs', 'activeTabId'])
                || !isStableId(group.groupId) || !Number.isSafeInteger(group.revision) || group.revision < 0
                || !Array.isArray(group.tabs) || Object.keys(group.tabs).length !== group.tabs.length
                || group.activeTabId !== null && !group.tabs.some(tab => tab.tabId === group.activeTabId))
            {
                return false;
            }
            for (const tab of group.tabs)
            {
                const entry = entries.get(tab.tabId);
                if (!hasExactKeys(tab, ['tabId', 'editorSessionRef', 'documentEpoch', 'lifecycleRevision'])
                    || !entry || seen.has(tab.tabId) || entry.owningGroupId !== group.groupId
                    || entry.editorSessionRef !== tab.editorSessionRef || entry.documentContext.documentEpoch !== tab.documentEpoch
                    || entry.lifecycleRevision !== tab.lifecycleRevision)
                {
                    return false;
                }
                seen.add(tab.tabId);
            }
        }
        const active = state.groups.find(group => group.groupId === state.activeGroupId)!;
        return seen.size === entries.size && (activeTabId === null || active.activeTabId === activeTabId);
    }

    private applyOpenOrActivate(
        command: OpenOrActivateArticleCommand,
        commandDigest: string
    ): OpenArticleDocumentCommandResult
    {
        if (command.intent === 'browser-new-tab')
        {
            return this.makeResult(command, commandDigest, 'ignored-browser-new-tab', null);
        }

        const existingTabId = this.tabIdByIdentity.get(identityKey(command.identity));
        if (existingTabId)
        {
            const entry = this.entriesByTabId.get(existingTabId)!;
            if (entry.status.permission === 'denied' || entry.status.permission === 'revoked')
            {
                return makeRejectedResult(command, 'rejected-state', this.revision, 'permission-blocked', commandDigest);
            }
            if (entry.status.lifecycle !== 'current')
            {
                return makeRejectedResult(command, 'rejected-state', this.revision, 'lifecycle-blocked', commandDigest);
            }

            const entryBefore = cloneValue(entry);
            this.deactivateAll();
            const updated = this.updateEntry(entry, {
                ...entry,
                isActive: true,
                lastActiveAnchorRef: command.lastActiveAnchorRef ?? entry.lastActiveAnchorRef
            });
            this.revision += 1;
            return this.makeResult(command, commandDigest, 'activated-existing', updated, null, entryBefore);
        }

        if (this.entriesByTabId.has(command.tabId))
        {
            return makeRejectedResult(command, 'rejected-duplicate-identity', this.revision, 'tab-id-already-open', commandDigest);
        }
        if (this.tabIdBySessionRef.has(command.editorSessionRef))
        {
            return makeRejectedResult(
                command,
                'rejected-duplicate-session',
                this.revision,
                'editor-session-ref-already-owned',
                commandDigest
            );
        }

        const preview = command.tabKind === 'preview'
            ? [...this.entriesByTabId.values()].find(entry => (
                entry.owningGroupId === command.targetGroupId
                && entry.isPreview
                && !entry.isPinned
            ))
            : undefined;
        if (preview && isRiskyPreview(preview))
        {
            return makeRejectedResult(
                command,
                'rejected-preview-risk',
                this.revision,
                'existing-preview-has-protected-state',
                commandDigest
            );
        }

        if (preview)
        {
            this.removeEntry(preview);
        }

        this.deactivateAll();
        const mustPin = command.tabKind === 'pinned' || isRiskStatus(command.status);
        const newEntry = withEntryDigest({
            schema: openArticleDocumentEntrySchema,
            identity: cloneValue(command.identity),
            documentContext: cloneValue(command.documentContext),
            editorSessionRef: command.editorSessionRef,
            tabId: command.tabId,
            isPreview: !mustPin,
            isPinned: mustPin,
            isActive: true,
            owningGroupId: command.targetGroupId,
            status: cloneValue(command.status),
            lastActiveAnchorRef: command.lastActiveAnchorRef,
            closeRequestRef: null,
            lifecycleRevision: 1
        });
        this.addEntry(newEntry);
        this.revision += 1;
        return this.makeResult(command, commandDigest, 'applied', newEntry, preview ?? null, preview ?? null);
    }

    private applyActivate(
        command: ActivateArticleTabCommand,
        commandDigest: string
    ): OpenArticleDocumentCommandResult
    {
        const entry = this.entriesByTabId.get(command.tabId);
        if (!entry)
        {
            return makeRejectedResult(command, 'rejected-not-found', this.revision, 'tab-not-found', commandDigest);
        }
        if (entry.status.permission === 'denied' || entry.status.permission === 'revoked')
        {
            return makeRejectedResult(command, 'rejected-state', this.revision, 'permission-blocked', commandDigest);
        }
        if (entry.status.lifecycle !== 'current')
        {
            return makeRejectedResult(command, 'rejected-state', this.revision, 'lifecycle-blocked', commandDigest);
        }

        const entryBefore = cloneValue(entry);
        this.deactivateAll();
        const updated = this.updateEntry(entry, {
            ...entry,
            isActive: true,
            lastActiveAnchorRef: command.lastActiveAnchorRef ?? entry.lastActiveAnchorRef
        });
        this.revision += 1;
        return this.makeResult(command, commandDigest, 'applied', updated, null, entryBefore);
    }

    private applySetPinState(
        command: SetArticleTabPinStateCommand,
        commandDigest: string
    ): OpenArticleDocumentCommandResult
    {
        const entry = this.entriesByTabId.get(command.tabId);
        if (!entry)
        {
            return makeRejectedResult(command, 'rejected-not-found', this.revision, 'tab-not-found', commandDigest);
        }
        if (!command.pinned && isRiskyPreview(entry))
        {
            return makeRejectedResult(command, 'rejected-preview-risk', this.revision, 'risky-tab-cannot-be-preview', commandDigest);
        }

        return this.applyEntryMutation(command, commandDigest, current => ({
            ...current,
            isPinned: command.pinned,
            isPreview: !command.pinned
        }));
    }

    private applyDraftReplacement(
        command: ReplaceArticleDraftIdentityCommand,
        commandDigest: string
    ): OpenArticleDocumentCommandResult
    {
        const entry = this.entriesByTabId.get(command.tabId);
        if (!entry)
        {
            return makeRejectedResult(command, 'rejected-not-found', this.revision, 'tab-not-found', commandDigest);
        }

        const oldKey = identityKey(entry.identity);
        const newIdentity = {
            ...entry.identity,
            draftId: command.draftId
        };
        const newKey = identityKey(newIdentity);
        const existingTabId = this.tabIdByIdentity.get(newKey);
        if (existingTabId && existingTabId !== entry.tabId)
        {
            return makeRejectedResult(
                command,
                'rejected-duplicate-identity',
                this.revision,
                'replacement-identity-already-open',
                commandDigest
            );
        }

        this.tabIdByIdentity.delete(oldKey);
        this.tabIdByIdentity.set(newKey, entry.tabId);
        const updated = this.updateEntry(entry, {
            ...entry,
            identity: newIdentity,
            documentContext: {
                ...entry.documentContext,
                draftRevision: command.draftRevision
            },
            status: {
                ...entry.status,
                statusRef: command.replacementRef
            }
        });
        this.revision += 1;
        return this.makeResult(command, commandDigest, 'applied', updated, null, entry);
    }

    private applyDetach(
        command: DetachArticleOnFinalCloseCommand,
        commandDigest: string
    ): OpenArticleDocumentCommandResult
    {
        const entry = this.entriesByTabId.get(command.tabId);
        if (!entry)
        {
            return makeRejectedResult(command, 'rejected-not-found', this.revision, 'tab-not-found', commandDigest);
        }
        if (!entry.closeRequestRef)
        {
            return makeRejectedResult(
                command,
                'rejected-state',
                this.revision,
                'final-close-requires-close-request',
                commandDigest
            );
        }

        this.removeEntry(entry);
        this.revision += 1;
        return this.makeResult(command, commandDigest, 'applied', null, null, entry);
    }

    private applyEntryMutation(
        command: Exclude<OpenArticleDocumentCommand, OpenOrActivateArticleCommand | UpdateArticleGroupOwnershipSetCommand | UpdateArticleGroupOwnershipTransactionCommand>,
        commandDigest: string,
        mutate: (entry: OpenArticleDocumentEntry) => OpenArticleDocumentEntry
    ): OpenArticleDocumentCommandResult
    {
        const entry = this.entriesByTabId.get(command.tabId);
        if (!entry)
        {
            return makeRejectedResult(command, 'rejected-not-found', this.revision, 'tab-not-found', commandDigest);
        }

        const updated = this.updateEntry(entry, mutate(entry));
        this.revision += 1;
        return this.makeResult(command, commandDigest, 'applied', updated, null, entry);
    }

    private updateEntry(
        previous: OpenArticleDocumentEntry,
        next: OpenArticleDocumentEntry
    ): OpenArticleDocumentEntry
    {
        const nextWithoutDigest = omitContentDigest(next);
        const updated = withEntryDigest({
            ...nextWithoutDigest,
            lifecycleRevision: previous.lifecycleRevision + 1
        });
        this.entriesByTabId.set(updated.tabId, updated);
        return updated;
    }

    private addEntry(entry: OpenArticleDocumentEntry): void
    {
        this.entriesByTabId.set(entry.tabId, entry);
        this.tabIdByIdentity.set(identityKey(entry.identity), entry.tabId);
        this.tabIdBySessionRef.set(entry.editorSessionRef, entry.tabId);
    }

    private removeEntry(entry: OpenArticleDocumentEntry): void
    {
        for (const cell of this.retainedDocumentCells)
        {
            if (cell.tabId === entry.tabId && !cell.reason)
            {
                cell.reason = 'final-close';
            }
        }
        this.entriesByTabId.delete(entry.tabId);
        this.tabIdByIdentity.delete(identityKey(entry.identity));
        this.tabIdBySessionRef.delete(entry.editorSessionRef);
    }

    private deactivateAll(): void
    {
        for (const entry of this.entriesByTabId.values())
        {
            if (entry.isActive)
            {
                this.updateEntry(entry, {
                    ...entry,
                    isActive: false
                });
            }
        }
    }

    private makeResult(
        command: OpenArticleDocumentCommand,
        commandDigest: string,
        status: OpenArticleDocumentResultStatus,
        entryAfter: OpenArticleDocumentEntry | null,
        replacedPreview: OpenArticleDocumentEntry | null = null,
        entryBefore: OpenArticleDocumentEntry | null = null
    ): OpenArticleDocumentCommandResult
    {
        const revisionBefore = command.expectedRevision;
        const effectiveEntry = entryAfter ?? entryBefore;
        const base = {
            schema: openArticleDocumentResultSchema,
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            commandKind: command.kind,
            status,
            reason: null,
            revisionBefore,
            revisionAfter: this.revision,
            tabId: effectiveEntry?.tabId ?? null,
            editorSessionRef: effectiveEntry?.editorSessionRef ?? null,
            owningGroupId: effectiveEntry?.owningGroupId ?? null,
            replacedPreviewTabId: replacedPreview?.tabId ?? null,
            replacedPreviewSessionRef: replacedPreview?.editorSessionRef ?? null,
            authorityRef: authorityRefForCommand(command),
            entryBefore: entryBefore ? cloneValue(entryBefore) : null,
            entryAfter: entryAfter ? cloneValue(entryAfter) : null,
            commandDigest
        };
        return {
            ...base,
            contentDigest: calculateOpenArticleDocumentDigest(base)
        };
    }

    private asReplay(result: OpenArticleDocumentCommandResult): OpenArticleDocumentCommandResult
    {
        const base = {
            ...cloneValue(result),
            status: 'replayed' as const,
            reason: result.status
        };
        const withoutDigest = omitContentDigest(base);
        return {
            ...withoutDigest,
            contentDigest: calculateOpenArticleDocumentDigest(withoutDigest)
        };
    }
}

function authorityRefForCommand(command: OpenArticleDocumentCommand): string | null
{
    switch (command.kind)
    {
        case 'open-or-activate':
            return command.status.statusRef;
        case 'activate':
            return command.lastActiveAnchorRef;
        case 'set-pin-state':
        case 'request-close':
            return command.commandId;
        case 'mark-status':
            return command.status.statusRef;
        case 'replace-draft-identity':
            return command.replacementRef;
        case 'invalidate-permission':
        case 'invalidate-lifecycle':
            return command.statusRef;
        case 'detach-on-final-close':
            return command.closeDecisionRef;
        case 'update-group-ownership':
        case 'update-group-ownership-set':
        case 'update-group-ownership-transaction':
            return command.ownershipTransactionRef;
    }
}

function isRiskStatus(status: ArticleWorkspaceStatusSummary): boolean
{
    return status.dirty
        || status.saving
        || status.conflict
        || status.recovery
        || status.pendingAttachments
        || status.permission !== 'allowed'
        || status.lifecycle !== 'current';
}

export function verifyOpenArticleDocumentResult(result: OpenArticleDocumentCommandResult, originalCommand?: unknown): boolean
{
    try
    {
        return verifyResultAgainstCommand(result, originalCommand);
    }
    catch
    {
        return false;
    }
}

function verifyResultAgainstCommand(result: OpenArticleDocumentCommandResult, originalCommand?: unknown): boolean
{
    if (!result || typeof result !== 'object')
    {
        return false;
    }
    if (!hasExactKeys(result, [
        'schema',
        'commandId',
        'idempotencyKey',
        'commandKind',
        'status',
        'reason',
        'revisionBefore',
        'revisionAfter',
        'tabId',
        'editorSessionRef',
        'owningGroupId',
        'replacedPreviewTabId',
        'replacedPreviewSessionRef',
        'authorityRef',
        'entryBefore',
        'entryAfter',
        'commandDigest',
        'contentDigest',
        ...(['update-group-ownership-set', 'update-group-ownership-transaction'].includes(result.commandKind) ? ['ownershipChanges'] : []),
        ...(result.commandKind === 'update-group-ownership-transaction' ? ['groupRevisionBefore', 'groupRevisionAfter',
            'groupStateBeforeDigest', 'groupStateAfterDigest', 'groupCommandDigest'] : [])
    ]))
    {
        return false;
    }
    if (
        result.schema !== openArticleDocumentResultSchema
        || !isStableId(result.commandId)
        || !isStableId(result.idempotencyKey)
        || (result.commandKind !== 'unknown' && !Object.prototype.hasOwnProperty.call(commandKeys, result.commandKind))
        || ![
            'applied',
            'activated-existing',
            'replayed',
            'ignored-browser-new-tab',
            'rejected-cas',
            'rejected-idempotency-conflict',
            'rejected-invalid-command',
            'rejected-not-found',
            'rejected-duplicate-identity',
            'rejected-duplicate-session',
            'rejected-preview-risk',
            'rejected-state'
        ].includes(result.status)
        || (result.reason !== null && typeof result.reason !== 'string')
        || !Number.isSafeInteger(result.revisionBefore)
        || !Number.isSafeInteger(result.revisionAfter)
        || result.revisionAfter < result.revisionBefore
        || !isNullableStableId(result.tabId)
        || !isNullableStableId(result.editorSessionRef)
        || !isNullableStableId(result.owningGroupId)
        || !isNullableStableId(result.replacedPreviewTabId)
        || !isNullableStableId(result.replacedPreviewSessionRef)
        || !isNullableStableId(result.authorityRef)
        || (result.entryBefore !== null && !isValidEntry(result.entryBefore))
        || (result.entryAfter !== null && !isValidEntry(result.entryAfter))
        || !digestPattern.test(result.commandDigest)
    )
    {
        return false;
    }
    if (result.commandKind === 'update-group-ownership-set' || result.commandKind === 'update-group-ownership-transaction')
    {
        const changes = result.ownershipChanges;
        if (!isValidCommand(originalCommand) || (originalCommand.kind !== 'update-group-ownership-set'
            && originalCommand.kind !== 'update-group-ownership-transaction') || originalCommand.kind !== result.commandKind
            || result.commandId !== originalCommand.commandId || result.idempotencyKey !== originalCommand.idempotencyKey
            || result.commandDigest !== calculateOpenArticleDocumentDigest(originalCommand)
            || !['applied', 'replayed', 'rejected-cas', 'rejected-idempotency-conflict',
                'rejected-invalid-command', 'rejected-not-found', 'rejected-state'].includes(result.status)
            || result.tabId !== null || result.editorSessionRef !== null || result.owningGroupId !== null
            || result.replacedPreviewTabId !== null || result.replacedPreviewSessionRef !== null
            || result.entryBefore !== null || result.entryAfter !== null
            || !Array.isArray(changes) || changes.length > originalCommand.tabs.length)
        {
            return false;
        }
        const applied = result.status === 'applied' || result.status === 'replayed';
        if (originalCommand.kind === 'update-group-ownership-transaction'
            && (applied ? result.groupRevisionBefore !== originalCommand.expectedGroupRevision
                || result.groupRevisionAfter !== originalCommand.expectedGroupRevision + 1
                || result.groupStateBeforeDigest !== originalCommand.groupStateBeforeDigest
                || result.groupStateAfterDigest !== originalCommand.groupStateAfterDigest
                || result.groupCommandDigest !== originalCommand.groupCommandDigest
                : result.groupRevisionBefore !== null || result.groupRevisionAfter !== null
                    || result.groupStateBeforeDigest !== null || result.groupStateAfterDigest !== null || result.groupCommandDigest !== null))
        {
            return false;
        }
        for (let index = 0; index < changes.length; index += 1)
        {
            if (!Object.prototype.hasOwnProperty.call(changes, index))
            {
                return false;
            }
            const change: unknown = changes[index];
            if (!hasExactKeys(change, ['entryBefore', 'entryAfter'])
                || !isValidEntry(change.entryBefore) || !isValidEntry(change.entryAfter))
            {
                return false;
            }
        }
        if (new Set(changes.map(change => change.entryBefore.tabId)).size !== changes.length)
        {
            return false;
        }
        if (applied && (changes.length !== originalCommand.tabs.length
            || result.revisionBefore !== originalCommand.expectedRevision
            || result.revisionAfter !== originalCommand.expectedRevision + 1
            || result.authorityRef !== originalCommand.ownershipTransactionRef
            || result.reason !== (result.status === 'replayed' ? 'applied' : null))
            || !applied && (changes.length !== 0 || result.revisionAfter !== result.revisionBefore
                || result.authorityRef !== null
                || !['rejected-cas', 'rejected-idempotency-conflict', 'rejected-invalid-command'].includes(result.status)
                    && result.revisionBefore !== originalCommand.expectedRevision))
        {
            return false;
        }
        for (const [index, change] of changes.entries())
        {
            const reference = originalCommand.tabs[index];
            const before = change.entryBefore;
            const after = change.entryAfter;
            const joint = originalCommand.kind === 'update-group-ownership-transaction';
            const targetGroupId = joint ? (reference as ArticleGroupOwnershipTargetRef).targetGroupId : originalCommand.targetGroupId;
            const active = joint ? originalCommand.activeTabId === before.tabId : before.isActive;
            const changed = before.owningGroupId !== targetGroupId || before.isActive !== active;
            if (before.tabId !== reference.tabId || before.owningGroupId !== reference.expectedOwningGroupId
                || before.editorSessionRef !== reference.editorSessionRef
                || before.documentContext.documentEpoch !== reference.documentEpoch
                || before.lifecycleRevision !== reference.lifecycleRevision
                || after.owningGroupId !== targetGroupId
                || !joint && after.owningGroupId === before.owningGroupId
                || after.isActive !== active
                || after.lifecycleRevision !== before.lifecycleRevision + (changed ? 1 : 0)
                || calculateOpenArticleDocumentDigest({
                    ...omitContentDigest(before),
                    owningGroupId: after.owningGroupId,
                    isActive: active,
                    lifecycleRevision: after.lifecycleRevision
                }) !== after.contentDigest)
            {
                return false;
            }
        }
    }
    const { contentDigest, ...base } = result;
    return digestPattern.test(contentDigest)
        && calculateOpenArticleDocumentDigest(base) === contentDigest;
}

export function verifyOpenArticleDocumentRegistryState(state: OpenArticleDocumentRegistryState): boolean
{
    if (!hasExactKeys(state, ['schema', 'revision', 'entries', 'processedCommandDigests', 'contentDigest']))
    {
        return false;
    }
    if (
        state.schema !== openArticleDocumentRegistrySchema
        || !Number.isSafeInteger(state.revision)
        || state.revision < 0
        || !Array.isArray(state.entries)
        || !Array.isArray(state.processedCommandDigests)
        || !state.processedCommandDigests.every(digest => typeof digest === 'string' && digestPattern.test(digest))
    )
    {
        return false;
    }

    const tabIds = new Set<string>();
    const identityKeys = new Set<string>();
    const sessionRefs = new Set<string>();
    let activeCount = 0;
    for (const entry of state.entries)
    {
        if (!isValidEntry(entry))
        {
            return false;
        }
        const key = identityKey(entry.identity);
        if (tabIds.has(entry.tabId) || identityKeys.has(key) || sessionRefs.has(entry.editorSessionRef))
        {
            return false;
        }
        tabIds.add(entry.tabId);
        identityKeys.add(key);
        sessionRefs.add(entry.editorSessionRef);
        activeCount += entry.isActive ? 1 : 0;
    }
    if (activeCount > 1)
    {
        return false;
    }

    const { contentDigest, ...base } = state;
    return digestPattern.test(contentDigest)
        && calculateOpenArticleDocumentDigest(base) === contentDigest;
}

function isValidEntry(entry: unknown): entry is OpenArticleDocumentEntry
{
    if (!hasExactKeys(entry, [
        'schema',
        'identity',
        'documentContext',
        'editorSessionRef',
        'tabId',
        'isPreview',
        'isPinned',
        'isActive',
        'owningGroupId',
        'status',
        'lastActiveAnchorRef',
        'closeRequestRef',
        'lifecycleRevision',
        'contentDigest'
    ]))
    {
        return false;
    }
    if (
        entry.schema !== openArticleDocumentEntrySchema
        || !isIdentity(entry.identity)
        || !isDocumentContext(entry.documentContext)
        || !isStableId(entry.editorSessionRef)
        || !isStableId(entry.tabId)
        || typeof entry.isPreview !== 'boolean'
        || typeof entry.isPinned !== 'boolean'
        || entry.isPreview === entry.isPinned
        || typeof entry.isActive !== 'boolean'
        || !isStableId(entry.owningGroupId)
        || !isStatus(entry.status)
        || !isNullableStableId(entry.lastActiveAnchorRef)
        || !isNullableStableId(entry.closeRequestRef)
        || typeof entry.lifecycleRevision !== 'number'
        || !Number.isSafeInteger(entry.lifecycleRevision)
        || Number(entry.lifecycleRevision) < 1
        || typeof entry.contentDigest !== 'string'
        || !digestPattern.test(entry.contentDigest)
    )
    {
        return false;
    }

    const base: Omit<OpenArticleDocumentEntry, 'contentDigest'> = {
        schema: entry.schema,
        identity: entry.identity,
        documentContext: entry.documentContext,
        editorSessionRef: entry.editorSessionRef,
        tabId: entry.tabId,
        isPreview: entry.isPreview,
        isPinned: entry.isPinned,
        isActive: entry.isActive,
        owningGroupId: entry.owningGroupId,
        status: entry.status,
        lastActiveAnchorRef: entry.lastActiveAnchorRef,
        closeRequestRef: entry.closeRequestRef,
        lifecycleRevision: entry.lifecycleRevision
    };
    return computeEntryDigest(base) === entry.contentDigest;
}

export interface OpenArticleDocumentReplayResult {
    accepted: boolean;
    failingCommandIndex: number | null;
    results: OpenArticleDocumentCommandResult[];
    state: OpenArticleDocumentRegistryState;
}

export function replayOpenArticleDocumentCommands(
    commands: readonly OpenArticleDocumentCommand[]
): OpenArticleDocumentReplayResult
{
    const registry = new OpenArticleDocumentRegistry();
    const results: OpenArticleDocumentCommandResult[] = [];
    let failingCommandIndex: number | null = null;
    for (const [index, command] of commands.entries())
    {
        const result = registry.execute(command);
        results.push(result);
        if (result.status.startsWith('rejected-'))
        {
            failingCommandIndex = index;
            break;
        }
    }

    const state = registry.exportState();
    return {
        accepted: failingCommandIndex === null
            && results.every((result, index) => verifyOpenArticleDocumentResult(result, commands[index]))
            && verifyOpenArticleDocumentRegistryState(state),
        failingCommandIndex,
        results,
        state
    };
}
