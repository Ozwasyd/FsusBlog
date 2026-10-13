import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import type { ArticleAnchorContext } from './articleAnchorContext';
import type { AuthoringTabGroup } from './authoringTabGroupRegistry';
import type {
    ArticleDocumentContextRef,
    ArticleDocumentIdentity,
    OpenArticleDocumentEntry,
    OpenArticleDocumentRegistry
} from './openArticleDocumentRegistry';

export const authoringNavigationHistorySchema = 'fsusblog.authoring-navigation-history.v1' as const;
export const authoringNavigationCommandSchema = 'fsusblog.authoring-navigation-command.v1' as const;
export const authoringNavigationReceiptSchema = 'fsusblog.authoring-navigation-receipt.v1' as const;
export const authoringNavigationTargetSchema = 'fsusblog.authoring-navigation-target.v1' as const;

/** Explicit user commands only; automatic activation, input and scrolling have no cause ID. */
export const authoringNavigationVisitCauses = Object.freeze([
    'internal-link', 'relation-inspector', 'rail', 'quick-switcher',
    'global-search', 'explicit-anchor-reveal', 'recent-closed-restore'
] as const);

export const authoringNavigationPolicy = Object.freeze({
    maxEntries: 128,
    commandWindow: 256,
    coalesceWindowMs: 500,
    retention: 'current-session',
    reload: 'discard',
    persistence: 'none',
    sameAction: 'same-action-time-sequence-and-target-route-to-anchor-within-window',
    rapidRepeat: 'same-document-anchor-groups-cause-and-revision',
    branch: 'truncate-forward-on-user-visit',
    cancellation: 'keep-cursor-and-invalidate-pending-intent',
    reentry: 'reject-while-pending',
    unavailable: 'do-not-skip-or-advance',
    excludedEvents: Object.freeze(['automatic-tab-activation', 'workspace-restore', 'background-refresh',
        'caret', 'scroll', 'input'] as const)
} as const);

export type AuthoringNavigationVisitCause = typeof authoringNavigationVisitCauses[number];
export type AuthoringNavigationValidityStatus = 'current' | 'stale-revision' | 'missing'
    | 'deleted' | 'archived' | 'permission-revoked' | 'anchor-missing' | 'anchor-partial'
    | 'group-missing' | 'unknown';

/** Numeric Anchor revision and Registry string revision are separate original coordinates. */
export interface AuthoringNavigationAnchor {
    nodeId: NonNullable<ArticleAnchorContext['nodeId']>;
    range: ArticleAnchorContext['range'];
    affinity: ArticleAnchorContext['affinity'];
    document: Pick<ArticleAnchorContext['document'], 'articleId' | 'draftId' | 'documentId'
        | 'documentEpoch' | 'sourceRevision' | 'draftRevision' | 'siteScope' | 'userScope'
        | 'sourceIdentityDigest' | 'contentDigest' | 'contextDigest'>;
    anchorContextDigest: ArticleAnchorContext['contentDigest'];
}

/** Evidence coordinates, never an access grant or a reconstructed owner capability. */
export interface AuthoringNavigationValidity {
    status: AuthoringNavigationValidityStatus;
    statusRef: OpenArticleDocumentEntry['status']['statusRef'] | null;
    registryRevision: number;
    groupRevision: AuthoringTabGroup['revision'] | null;
    observationRef: string;
}

/** Only the upstream entry and restore receipt coordinates; no recent stack/session payload. */
export interface AuthoringNavigationRecentRestoreRef {
    entryRef: string;
    restoreReceiptRef: string;
    restoreReceiptDigest: string;
}

export interface AuthoringNavigationVisit {
    entryId: string;
    identity: ArticleDocumentIdentity;
    documentContext: ArticleDocumentContextRef;
    anchor: AuthoringNavigationAnchor | null;
    owningGroupId: OpenArticleDocumentEntry['owningGroupId'];
    targetGroupId: AuthoringTabGroup['groupId'];
    cause: AuthoringNavigationVisitCause;
    userActionId: string;
    userSequence: number;
    userInitiatedAt: number;
    recordedAt: number;
    validity: AuthoringNavigationValidity;
    recentRestore: AuthoringNavigationRecentRestoreRef | null;
}

export interface AuthoringNavigationEntry extends AuthoringNavigationVisit {
    contentDigest: string;
}

export interface AuthoringNavigationScope {
    sessionRef: string;
    workspaceRef: string;
    userScope: ArticleAnchorContext['document']['userScope'];
    siteScope: ArticleAnchorContext['document']['siteScope'];
}

export interface AuthoringNavigationTargetIntent {
    schema: typeof authoringNavigationTargetSchema;
    intentRef: string;
    entryId: string;
    entryDigest: string;
    historyRevision: number;
    scope: AuthoringNavigationScope;
    identity: ArticleDocumentIdentity;
    documentContext: ArticleDocumentContextRef;
    anchor: AuthoringNavigationAnchor | null;
    owningGroupId: string;
    targetGroupId: string;
    cause: AuthoringNavigationVisitCause;
    validity: AuthoringNavigationValidity;
    disposition: 'resolve-through-existing-owners' | 'unavailable';
    contentDigest: string;
}

interface NavigationPending {
    intentRef: string;
    entryId: string;
    entryDigest: string;
    fromCursor: number;
    toCursor: number;
}

interface NavigationProcessedCommand {
    commandId: string;
    idempotencyKey: string;
    commandDigest: string;
    revisionAfter: number;
}

export interface AuthoringNavigationHistoryState {
    schema: typeof authoringNavigationHistorySchema;
    scope: AuthoringNavigationScope;
    capacity: number;
    revision: number;
    entries: readonly AuthoringNavigationEntry[];
    cursor: number;
    lastCommandSequence: number;
    lastUserSequence: number;
    lastUserInitiatedAt: number;
    pending: NavigationPending | null;
    processed: readonly NavigationProcessedCommand[];
    contentDigest: string;
}

interface NavigationCommandBase {
    schema: typeof authoringNavigationCommandSchema;
    scope: AuthoringNavigationScope;
    commandId: string;
    idempotencyKey: string;
    commandSequence: number;
    expectedRevision: number;
}

export type AuthoringNavigationCommand = NavigationCommandBase & (
    | { kind: 'append' | 'coalesce'; visit: AuthoringNavigationVisit; }
    | { kind: 'back' | 'forward'; entryId: string; expectedEntryDigest: string; validity: AuthoringNavigationValidity; }
    | { kind: 'replace-invalid'; entryId: string; expectedEntryDigest: string; validity: AuthoringNavigationValidity; }
    | { kind: 'settle-navigation'; intentRef: string; outcome: 'completed' | 'cancelled' | 'failed'; }
    | { kind: 'clear-current-session'; }
);

export type AuthoringNavigationCommandStatus = 'applied' | 'coalesced' | 'replayed'
    | 'unavailable' | 'rejected-invalid-command' | 'rejected-cas' | 'rejected-state'
    | 'rejected-idempotency-conflict' | 'rejected-sequence' | 'rejected-pending';

export interface AuthoringNavigationReceipt {
    schema: typeof authoringNavigationReceiptSchema;
    commandId: string;
    idempotencyKey: string;
    commandKind: AuthoringNavigationCommand['kind'];
    commandDigest: string;
    status: AuthoringNavigationCommandStatus;
    revisionBefore: number;
    revisionAfter: number;
    cursorBefore: number;
    cursorAfter: number;
    beforeDigest: string;
    afterDigest: string;
    entryId: string | null;
    cause: AuthoringNavigationVisitCause | null;
    validity: AuthoringNavigationValidity | null;
    targetDigest: string | null;
    invalidatedIntentRef: string | null;
    contentDigest: string;
}

export interface AuthoringNavigationTransition {
    state: AuthoringNavigationHistoryState;
    receipt: AuthoringNavigationReceipt;
    target: AuthoringNavigationTargetIntent | null;
}

const refPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const validityStatuses: readonly AuthoringNavigationValidityStatus[] = [
    'current', 'stale-revision', 'missing', 'deleted', 'archived', 'permission-revoked',
    'anchor-missing', 'anchor-partial', 'group-missing', 'unknown'
];
const visitKeys = ['entryId', 'identity', 'documentContext', 'anchor', 'owningGroupId', 'targetGroupId',
    'cause', 'userActionId', 'userSequence', 'userInitiatedAt', 'recordedAt', 'validity', 'recentRestore'];
const stateKeys = ['schema', 'scope', 'capacity', 'revision', 'entries', 'cursor', 'lastCommandSequence',
    'lastUserSequence', 'lastUserInitiatedAt', 'pending', 'processed', 'contentDigest'];
const commonCommandKeys = ['schema', 'scope', 'commandId', 'idempotencyKey', 'commandSequence', 'expectedRevision', 'kind'];
const commandKeys: Record<AuthoringNavigationCommand['kind'], readonly string[]> = {
    append: ['visit'],
    coalesce: ['visit'],
    back: ['entryId', 'expectedEntryDigest', 'validity'],
    forward: ['entryId', 'expectedEntryDigest', 'validity'],
    'replace-invalid': ['entryId', 'expectedEntryDigest', 'validity'],
    'settle-navigation': ['intentRef', 'outcome'],
    'clear-current-session': []
};

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown>
{
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype
        && Reflect.ownKeys(value).length === keys.length
        && keys.every(key => Object.hasOwn(value, key)
            && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}

function isRef(value: unknown): value is string
{
    return typeof value === 'string' && refPattern.test(value);
}

function isDigest(value: unknown): value is string
{
    return typeof value === 'string' && digestPattern.test(value);
}

function isSequence(value: unknown): value is number
{
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedDenseArray(value: unknown, capacity: number): boolean
{
    return Array.isArray(value) && value.length <= capacity
        && Reflect.ownKeys(value).length === value.length + 1
        && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean);
}

function isNullableRef(value: unknown): boolean
{
    return value === null || isRef(value);
}

function isScope(value: unknown): value is AuthoringNavigationScope
{
    return exactKeys(value, ['sessionRef', 'workspaceRef', 'userScope', 'siteScope'])
        && Object.values(value).every(isRef);
}

function isIdentity(value: unknown): value is ArticleDocumentIdentity
{
    return exactKeys(value, ['articleId', 'draftId', 'documentId'])
        && (value.articleId === null || isSequence(value.articleId) && value.articleId > 0)
        && isRef(value.draftId) && isRef(value.documentId);
}

function isDocumentContext(value: unknown): value is ArticleDocumentContextRef
{
    return exactKeys(value, ['documentEpoch', 'sourceRevision', 'draftRevision'])
        && isSequence(value.documentEpoch) && value.documentEpoch > 0
        && isNullableRef(value.sourceRevision) && isNullableRef(value.draftRevision);
}

function isValidity(value: unknown): value is AuthoringNavigationValidity
{
    return exactKeys(value, ['status', 'statusRef', 'registryRevision', 'groupRevision', 'observationRef'])
        && validityStatuses.includes(value.status as AuthoringNavigationValidityStatus)
        && isNullableRef(value.statusRef) && isSequence(value.registryRevision)
        && (value.groupRevision === null || isSequence(value.groupRevision)) && isRef(value.observationRef)
        && (value.status !== 'current' || value.statusRef !== null && value.groupRevision !== null);
}

function isAnchor(value: unknown): value is AuthoringNavigationAnchor
{
    if (!exactKeys(value, ['nodeId', 'range', 'affinity', 'document', 'anchorContextDigest'])
        || typeof value.nodeId !== 'string' || value.nodeId.length < 1 || value.nodeId.length > 128
        || /[\s/\\?#<>]/u.test(value.nodeId)
        || !exactKeys(value.range, ['start', 'end']) || !isSequence(value.range.start)
        || !isSequence(value.range.end) || value.range.end < value.range.start
        || !['before', 'after'].includes(String(value.affinity)) || !isDigest(value.anchorContextDigest))
    {
        return false;
    }
    return isAnchorDocument(value.document);
}

function isAnchorDocument(document: unknown): document is AuthoringNavigationAnchor['document']
{
    return exactKeys(document, ['articleId', 'draftId', 'documentId', 'documentEpoch', 'sourceRevision',
        'draftRevision', 'siteScope', 'userScope', 'sourceIdentityDigest', 'contentDigest', 'contextDigest'])
        && isIdentity({ articleId: document.articleId, draftId: document.draftId, documentId: document.documentId })
        && isSequence(document.documentEpoch) && document.documentEpoch > 0
        && isSequence(document.sourceRevision) && isNullableRef(document.draftRevision)
        && isRef(document.siteScope) && isRef(document.userScope)
        && isDigest(document.sourceIdentityDigest) && isDigest(document.contentDigest) && isDigest(document.contextDigest);
}

function isVisit(value: unknown, scope: AuthoringNavigationScope, sealed = false): value is AuthoringNavigationVisit
{
    if (!exactKeys(value, [...visitKeys, ...(sealed ? ['contentDigest'] : [])])
        || !isRef(value.entryId) || !isIdentity(value.identity) || !isDocumentContext(value.documentContext)
        || !isRef(value.owningGroupId) || !isRef(value.targetGroupId)
        || !authoringNavigationVisitCauses.includes(value.cause as AuthoringNavigationVisitCause)
        || !isRef(value.userActionId) || !isSequence(value.userSequence) || value.userSequence === 0
        || !isSequence(value.userInitiatedAt) || !isSequence(value.recordedAt)
        || value.recordedAt < value.userInitiatedAt || !isValidity(value.validity)
        || !(value.anchor === null || isAnchor(value.anchor)))
    {
        return false;
    }
    if (value.anchor !== null)
    {
        const document = value.anchor.document;
        if (document.articleId !== value.identity.articleId || document.draftId !== value.identity.draftId
            || document.documentId !== value.identity.documentId
            || document.documentEpoch !== value.documentContext.documentEpoch
            || document.draftRevision !== value.documentContext.draftRevision
            || document.siteScope !== scope.siteScope || document.userScope !== scope.userScope)
        {
            return false;
        }
    }
    const recent = value.recentRestore;
    return (value.cause === 'recent-closed-restore'
        ? exactKeys(recent, ['entryRef', 'restoreReceiptRef', 'restoreReceiptDigest'])
            && isRef(recent.entryRef) && isRef(recent.restoreReceiptRef) && isDigest(recent.restoreReceiptDigest)
        : recent === null) && (!sealed || validSeal(value));
}

/** Canonical JSON digest over closed semantic data; it does not authenticate its producer. */
export function calculateAuthoringNavigationDigest(value: unknown): string
{
    function canonical(item: unknown): string
    {
        if (item === null || typeof item === 'string' || typeof item === 'boolean')
        {
            return JSON.stringify(item);
        }
        if (typeof item === 'number' && Number.isSafeInteger(item))
        {
            return JSON.stringify(item);
        }
        if (Array.isArray(item))
        {
            if (Reflect.ownKeys(item).length !== item.length + 1
                || !Array.from({ length: item.length }, (_, index) => Object.hasOwn(item, index)).every(Boolean))
            {
                throw new Error('authoring-navigation-sparse-or-extended-array');
            }
            return `[${item.map(canonical).join(',')}]`;
        }
        if (item !== null && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype)
        {
            const record = item as Record<string, unknown>;
            if (Reflect.ownKeys(record).length !== Object.keys(record).length
                || Object.keys(record).some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(record, key) ?? {}, 'value')))
            {
                throw new Error('authoring-navigation-hidden-or-accessor-field');
            }
            return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
        }
        throw new Error('authoring-navigation-non-semantic-data');
    }
    return bytesToHex(sha256(utf8ToBytes(canonical(value))));
}

function seal<T extends object>(body: T): T & { contentDigest: string; }
{
    return { ...body, contentDigest: calculateAuthoringNavigationDigest(body) };
}

function withoutDigest<T extends { contentDigest: string; }>(value: T): Omit<T, 'contentDigest'>
{
    const { contentDigest: ignoredDigest, ...body } = value;
    void ignoredDigest;
    return body;
}

function validSeal(value: Record<string, unknown>): boolean
{
    const { contentDigest, ...body } = value;
    return isDigest(contentDigest) && contentDigest === calculateAuthoringNavigationDigest(body);
}

function same(left: unknown, right: unknown): boolean
{
    return calculateAuthoringNavigationDigest(left) === calculateAuthoringNavigationDigest(right);
}

function isCommand(value: unknown): value is AuthoringNavigationCommand
{
    if (value === null || typeof value !== 'object')
    {
        return false;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.hasOwn(commandKeys, String(record.kind))
        ? commandKeys[record.kind as AuthoringNavigationCommand['kind']] : null;
    if (!keys || !exactKeys(value, [...commonCommandKeys, ...keys])
        || value.schema !== authoringNavigationCommandSchema || !isScope(value.scope)
        || !isRef(value.commandId) || !isRef(value.idempotencyKey)
        || !isSequence(value.commandSequence) || value.commandSequence === 0 || !isSequence(value.expectedRevision))
    {
        return false;
    }
    switch (value.kind)
    {
        case 'append':
        case 'coalesce': return isVisit(value.visit, value.scope);
        case 'back':
        case 'forward':
        case 'replace-invalid': return isRef(value.entryId) && isDigest(value.expectedEntryDigest) && isValidity(value.validity);
        case 'settle-navigation': return isRef(value.intentRef) && ['completed', 'cancelled', 'failed'].includes(String(value.outcome));
        case 'clear-current-session': return true;
        default: return false;
    }
}

/** Validates bounds, nested closed records, seals and cursor/intent consistency without owner calls. */
export function verifyAuthoringNavigationHistoryState(value: unknown): value is AuthoringNavigationHistoryState
{
    try
    {
        if (!exactKeys(value, stateKeys) || value.schema !== authoringNavigationHistorySchema || !isScope(value.scope)
            || !isSequence(value.capacity) || value.capacity < 1 || value.capacity > authoringNavigationPolicy.maxEntries
            || !isSequence(value.revision) || !isSequence(value.lastCommandSequence)
            || value.lastCommandSequence < value.revision
            || !isSequence(value.lastUserSequence) || !isSequence(value.lastUserInitiatedAt)
            || !Array.isArray(value.entries) || value.entries.length > value.capacity
            || !Number.isSafeInteger(value.cursor) || Number(value.cursor) < -1 || Number(value.cursor) >= value.entries.length
            || (value.entries.length === 0) !== (value.cursor === -1)
            || !Array.isArray(value.processed)
            || value.processed.length !== Math.min(value.revision, authoringNavigationPolicy.commandWindow)
            || value.revision === 0 && (value.lastCommandSequence !== 0 || value.lastUserSequence !== 0
                || value.lastUserInitiatedAt !== 0 || value.entries.length !== 0))
        {
            return false;
        }
        const entries: AuthoringNavigationEntry[] = [];
        for (const entry of value.entries)
        {
            if (!isVisit(entry, value.scope, true))
            {
                return false;
            }
            entries.push(entry as AuthoringNavigationEntry);
        }
        if (new Set(entries.map(entry => entry.entryId)).size !== entries.length
            || entries.some((entry, index) => entry.userSequence > Number(value.lastUserSequence)
                || entry.userInitiatedAt > Number(value.lastUserInitiatedAt)
                || index > 0 && (entry.userSequence <= entries[index - 1].userSequence
                    || entry.userInitiatedAt < entries[index - 1].userInitiatedAt)))
        {
            return false;
        }
        const commandIds = new Set<string>();
        const keys = new Set<string>();
        let previousRevision = value.revision - value.processed.length;
        let lastCommandId: string | null = null;
        for (const processed of value.processed)
        {
            if (!exactKeys(processed, ['commandId', 'idempotencyKey', 'commandDigest', 'revisionAfter'])
                || !isRef(processed.commandId) || !isRef(processed.idempotencyKey) || !isDigest(processed.commandDigest)
                || !isSequence(processed.revisionAfter) || processed.revisionAfter !== previousRevision + 1
                || processed.revisionAfter > Number(value.revision)
                || commandIds.has(processed.commandId) || keys.has(processed.idempotencyKey))
            {
                return false;
            }
            commandIds.add(processed.commandId);
            keys.add(processed.idempotencyKey);
            previousRevision = processed.revisionAfter;
            lastCommandId = processed.commandId;
        }
        if (value.revision === 0 ? value.processed.length !== 0 : previousRevision !== value.revision)
        {
            return false;
        }
        if (value.pending !== null)
        {
            const pending = value.pending;
            if (!exactKeys(pending, ['intentRef', 'entryId', 'entryDigest', 'fromCursor', 'toCursor'])
                || !isRef(pending.intentRef) || !isRef(pending.entryId) || !isDigest(pending.entryDigest)
                || lastCommandId !== pending.intentRef
                || pending.fromCursor !== value.cursor || !isSequence(pending.toCursor)
                || Math.abs(pending.toCursor - Number(value.cursor)) !== 1)
            {
                return false;
            }
            const target = entries[pending.toCursor];
            if (target?.entryId !== pending.entryId || target.contentDigest !== pending.entryDigest
                || target.validity.status !== 'current')
            {
                return false;
            }
        }
        return validSeal(value);
    }
    catch
    {
        return false;
    }
}

/** No state hydration: a reload, logout or workspace replacement must create a fresh scope. */
export function createAuthoringNavigationHistoryState(scope: AuthoringNavigationScope, capacity = 64): AuthoringNavigationHistoryState
{
    if (!isScope(scope) || !isSequence(capacity) || capacity < 1 || capacity > authoringNavigationPolicy.maxEntries)
    {
        throw new Error('authoring-navigation-scope-or-capacity-invalid');
    }
    return seal({ schema: authoringNavigationHistorySchema, scope: structuredClone(scope), capacity,
        revision: 0, entries: [], cursor: -1, lastCommandSequence: 0, lastUserSequence: 0,
        lastUserInitiatedAt: 0, pending: null, processed: [] });
}

function sameVisitBase(left: AuthoringNavigationVisit, right: AuthoringNavigationVisit): boolean
{
    return same(left.identity, right.identity) && same(left.documentContext, right.documentContext)
        && left.owningGroupId === right.owningGroupId && left.targetGroupId === right.targetGroupId
        && left.cause === right.cause && same(left.recentRestore, right.recentRestore);
}

function canCoalesce(entry: AuthoringNavigationEntry | undefined, visit: AuthoringNavigationVisit): boolean
{
    if (!entry || !sameVisitBase(entry, visit) || visit.userInitiatedAt < entry.userInitiatedAt
        || visit.userInitiatedAt - entry.userInitiatedAt > authoringNavigationPolicy.coalesceWindowMs)
    {
        return false;
    }
    if (entry.userActionId === visit.userActionId)
    {
        return entry.userSequence === visit.userSequence && entry.userInitiatedAt === visit.userInitiatedAt
            && visit.recordedAt >= entry.recordedAt
            && visit.recordedAt - entry.userInitiatedAt <= authoringNavigationPolicy.coalesceWindowMs
            && (entry.anchor === null || same(entry.anchor, visit.anchor));
    }
    return visit.userSequence > entry.userSequence && same(entry.anchor, visit.anchor);
}

function validityIsFresh(previous: AuthoringNavigationValidity, next: AuthoringNavigationValidity): boolean
{
    return next.registryRevision >= previous.registryRevision
        && (previous.groupRevision === null || next.groupRevision === null || next.groupRevision >= previous.groupRevision);
}

function targetIntent(state: AuthoringNavigationHistoryState, entry: AuthoringNavigationEntry, intentRef: string): AuthoringNavigationTargetIntent
{
    return seal({ schema: authoringNavigationTargetSchema, intentRef, entryId: entry.entryId,
        entryDigest: entry.contentDigest, historyRevision: state.revision, scope: state.scope,
        identity: entry.identity, documentContext: entry.documentContext, anchor: entry.anchor,
        owningGroupId: entry.owningGroupId, targetGroupId: entry.targetGroupId, cause: entry.cause,
        validity: entry.validity, disposition: entry.validity.status === 'current'
            ? 'resolve-through-existing-owners' as const : 'unavailable' as const });
}

function transition(before: AuthoringNavigationHistoryState, after: AuthoringNavigationHistoryState,
    command: AuthoringNavigationCommand, status: AuthoringNavigationCommandStatus,
    target: AuthoringNavigationTargetIntent | null = null): AuthoringNavigationTransition
{
    const entryId = command.kind === 'append' || command.kind === 'coalesce'
        ? after.entries[after.cursor]?.entryId ?? command.visit.entryId
        : 'entryId' in command ? command.entryId : before.pending?.entryId ?? null;
    const entry = after.entries.find(item => item.entryId === entryId);
    const receipt = seal({ schema: authoringNavigationReceiptSchema, commandId: command.commandId,
        idempotencyKey: command.idempotencyKey, commandKind: command.kind,
        commandDigest: calculateAuthoringNavigationDigest(command), status,
        revisionBefore: before.revision, revisionAfter: after.revision,
        cursorBefore: before.cursor, cursorAfter: after.cursor, beforeDigest: before.contentDigest,
        afterDigest: after.contentDigest, entryId, cause: entry?.cause ?? null, validity: entry?.validity ?? null,
        targetDigest: target?.contentDigest ?? null, invalidatedIntentRef: before.pending !== null
            && before.pending.intentRef !== after.pending?.intentRef ? before.pending.intentRef : null });
    return structuredClone({ state: after, receipt, target });
}

/** Pure CAS transition. Targets are data only; successful settlement is reported by a future adapter. */
export function applyAuthoringNavigationCommand(input: AuthoringNavigationHistoryState,
    candidate: AuthoringNavigationCommand): AuthoringNavigationTransition
{
    if (!verifyAuthoringNavigationHistoryState(input))
    {
        throw new Error('authoring-navigation-state-invalid');
    }
    if (!isCommand(candidate))
    {
        throw new Error('authoring-navigation-command-invalid');
    }
    const before = structuredClone(input);
    const command = structuredClone(candidate);
    const reject = (status: AuthoringNavigationCommandStatus): AuthoringNavigationTransition => transition(before, before, command, status);
    if (!same(before.scope, command.scope))
    {
        return reject('rejected-invalid-command');
    }
    const commandDigest = calculateAuthoringNavigationDigest(command);
    const processed = before.processed.find(item => item.idempotencyKey === command.idempotencyKey || item.commandId === command.commandId);
    if (processed)
    {
        return reject(processed.commandDigest === commandDigest ? 'replayed' : 'rejected-idempotency-conflict');
    }
    if (command.expectedRevision !== before.revision)
    {
        return reject('rejected-cas');
    }
    if (command.commandSequence <= before.lastCommandSequence || before.revision === Number.MAX_SAFE_INTEGER)
    {
        return reject('rejected-sequence');
    }
    const entries = before.entries.map(entry => structuredClone(entry));
    let cursor = before.cursor;
    let pending = before.pending;
    let lastUserSequence = before.lastUserSequence;
    let lastUserInitiatedAt = before.lastUserInitiatedAt;
    let status: AuthoringNavigationCommandStatus = 'applied';
    let targetEntry: AuthoringNavigationEntry | null = null;
    switch (command.kind)
    {
        case 'append':
        case 'coalesce': {
            const visit = command.visit;
            const current = entries[cursor];
            const coalesce = canCoalesce(current, visit);
            const settling = coalesce && current.userActionId === visit.userActionId;
            if (visit.userSequence <= lastUserSequence && !(settling && visit.userSequence === lastUserSequence)
                || visit.userInitiatedAt < lastUserInitiatedAt)
            {
                return reject('rejected-sequence');
            }
            if (visit.validity.status !== 'current'
                || (command.kind === 'coalesce' || current?.userActionId === visit.userActionId) && !coalesce
                || current && coalesce && !validityIsFresh(current.validity, visit.validity)
                || entries.some(entry => entry.entryId === visit.entryId && (!coalesce || entry.entryId !== current.entryId)))
            {
                return reject('rejected-state');
            }
            entries.splice(cursor + 1);
            if (coalesce)
            {
                entries[cursor] = seal({ ...visit, entryId: current.entryId });
                status = 'coalesced';
            }
            else
            {
                entries.push(seal(visit));
            }
            if (entries.length > before.capacity)
            {
                entries.splice(0, entries.length - before.capacity);
            }
            cursor = entries.length - 1;
            pending = null;
            lastUserSequence = visit.userSequence;
            lastUserInitiatedAt = visit.userInitiatedAt;
            break;
        }
        case 'back':
        case 'forward': {
            if (pending !== null)
            {
                return reject('rejected-pending');
            }
            const toCursor = cursor + (command.kind === 'back' ? -1 : 1);
            const entry = entries[toCursor];
            if (entry?.entryId !== command.entryId || entry.contentDigest !== command.expectedEntryDigest
                || !validityIsFresh(entry.validity, command.validity))
            {
                return reject('rejected-state');
            }
            targetEntry = seal({ ...withoutDigest(entry), validity: command.validity });
            entries[toCursor] = targetEntry;
            if (command.validity.status === 'current')
            {
                pending = { intentRef: command.commandId, entryId: entry.entryId,
                    entryDigest: targetEntry.contentDigest, fromCursor: cursor, toCursor };
            }
            else
            {
                status = 'unavailable';
            }
            break;
        }
        case 'replace-invalid': {
            const index = entries.findIndex(entry => entry.entryId === command.entryId);
            const entry = entries[index];
            if (entry?.contentDigest !== command.expectedEntryDigest
                || entry.validity.status === 'current' && command.validity.status === 'current'
                || !validityIsFresh(entry.validity, command.validity))
            {
                return reject('rejected-state');
            }
            entries[index] = seal({ ...withoutDigest(entry), validity: command.validity });
            pending = null;
            break;
        }
        case 'settle-navigation': {
            if (pending?.intentRef !== command.intentRef)
            {
                return reject('rejected-state');
            }
            if (command.outcome === 'completed')
            {
                cursor = pending.toCursor;
            }
            pending = null;
            break;
        }
        case 'clear-current-session': {
            entries.splice(0);
            cursor = -1;
            pending = null;
            break;
        }
    }
    const revision = before.revision + 1;
    const after = seal({ ...withoutDigest(before), entries, cursor, pending, revision,
        lastCommandSequence: command.commandSequence, lastUserSequence, lastUserInitiatedAt,
        processed: [...before.processed, { commandId: command.commandId, idempotencyKey: command.idempotencyKey,
            commandDigest, revisionAfter: revision }].slice(-authoringNavigationPolicy.commandWindow) });
    if (!verifyAuthoringNavigationHistoryState(after))
    {
        throw new Error('authoring-navigation-transition-invariant');
    }
    return transition(before, after, command, status, targetEntry ? targetIntent(after, targetEntry, command.commandId) : null);
}

/** Derives conservative validity from actual owner projections, without calling or activating owners. */
export function observeAuthoringNavigationTarget(entry: AuthoringNavigationEntry, facts: {
    current: Pick<OpenArticleDocumentEntry, 'identity' | 'documentContext' | 'owningGroupId' | 'status'> | null;
    absence: 'missing' | 'unknown';
    group: Pick<AuthoringTabGroup, 'groupId' | 'revision'> | null;
    anchorStatus: 'current' | 'missing' | 'partial' | 'unknown';
    anchorDocument: AuthoringNavigationAnchor['document'] | null;
    registryRevision: number;
    observationRef: string;
}): AuthoringNavigationValidity
{
    if (!exactKeys(facts, ['current', 'absence', 'group', 'anchorStatus', 'anchorDocument', 'registryRevision', 'observationRef'])
        || !['missing', 'unknown'].includes(facts.absence)
        || !['current', 'missing', 'partial', 'unknown'].includes(facts.anchorStatus)
        || !(facts.anchorDocument === null || isAnchorDocument(facts.anchorDocument))
        || !(facts.group === null || exactKeys(facts.group, ['groupId', 'revision'])
            && isRef(facts.group.groupId) && isSequence(facts.group.revision))
        || !(facts.current === null || exactKeys(facts.current, ['identity', 'documentContext', 'owningGroupId', 'status'])
            && isIdentity(facts.current.identity) && isDocumentContext(facts.current.documentContext)
            && isRef(facts.current.owningGroupId)
            && exactKeys(facts.current.status, ['dirty', 'saving', 'conflict', 'recovery', 'pendingAttachments', 'permission', 'lifecycle', 'statusRef'])
            && ['dirty', 'saving', 'conflict', 'recovery', 'pendingAttachments'].every(key => typeof facts.current?.status[key as 'dirty'] === 'boolean')
            && ['allowed', 'read-only', 'denied', 'revoked'].includes(facts.current.status.permission)
            && ['current', 'deleted', 'archived', 'draft-replaced', 'blocked'].includes(facts.current.status.lifecycle)
            && isRef(facts.current.status.statusRef)))
    {
        throw new Error('authoring-navigation-observation-invalid');
    }
    const current = facts.current;
    let status: AuthoringNavigationValidityStatus = 'unknown';
    if (current === null)
    {
        status = facts.absence;
    }
    else if (same(current.identity, entry.identity))
    {
        if (current.status.permission === 'revoked' || current.status.permission === 'denied')
        {
            status = 'permission-revoked';
        }
        else if (current.status.lifecycle === 'deleted' || current.status.lifecycle === 'archived')
        {
            status = current.status.lifecycle;
        }
        else if (current.status.lifecycle === 'current' && ['allowed', 'read-only'].includes(current.status.permission))
        {
            if (!same(current.documentContext, entry.documentContext))
            {
                status = 'stale-revision';
            }
            else if (facts.group?.groupId !== entry.owningGroupId)
            {
                status = 'group-missing';
            }
            else if (current.owningGroupId === entry.owningGroupId)
            {
                status = entry.anchor === null ? 'current'
                    : facts.anchorDocument === null ? 'unknown'
                        : !same(entry.anchor.document, facts.anchorDocument) ? 'stale-revision'
                            : facts.anchorStatus === 'current' ? 'current'
                        : facts.anchorStatus === 'missing' ? 'anchor-missing'
                            : facts.anchorStatus === 'partial' ? 'anchor-partial' : 'unknown';
            }
        }
    }
    const validity = { status, statusRef: current && same(current.identity, entry.identity) ? current.status.statusRef : null,
        registryRevision: facts.registryRevision, groupRevision: facts.group?.revision ?? null,
        observationRef: facts.observationRef };
    if (!isValidity(validity))
    {
        throw new Error('authoring-navigation-observation-invalid');
    }
    return validity;
}

const owners = new WeakMap<OpenArticleDocumentRegistry, AuthoringNavigationHistory>();

/** One process-local history per canonical Registry. No editor, route, storage or owner methods run here. */
export class AuthoringNavigationHistory
{
    #state: AuthoringNavigationHistoryState;
    #executing = false;

    public constructor(registry: OpenArticleDocumentRegistry, scope: AuthoringNavigationScope, capacity = 64)
    {
        if (owners.has(registry))
        {
            throw new Error('authoring-navigation-owner-already-exists');
        }
        this.#state = createAuthoringNavigationHistoryState(scope, capacity);
        owners.set(registry, this);
    }

    public exportState(): AuthoringNavigationHistoryState
    {
        return structuredClone(this.#state);
    }

    public execute(command: AuthoringNavigationCommand): AuthoringNavigationTransition
    {
        if (this.#executing)
        {
            throw new Error('authoring-navigation-command-reentry');
        }
        this.#executing = true;
        try
        {
            const result = applyAuthoringNavigationCommand(this.#state, command);
            this.#state = structuredClone(result.state);
            return result;
        }
        finally
        {
            this.#executing = false;
        }
    }
}

/** Reconstructs transitions independently of apply/execute; caller supplies external observation facts. */
export function verifyAuthoringNavigationTransition(before: AuthoringNavigationHistoryState,
    command: AuthoringNavigationCommand, observed: AuthoringNavigationTransition): boolean
{
    try
    {
        if (!verifyAuthoringNavigationHistoryState(before) || !isCommand(command)
            || !exactKeys(observed, ['state', 'receipt', 'target'])
            || !verifyAuthoringNavigationHistoryState(observed.state))
        {
            return false;
        }
        const commandDigest = calculateAuthoringNavigationDigest(command);
        const prior = before.processed.find(item => item.commandId === command.commandId || item.idempotencyKey === command.idempotencyKey);
        let status: AuthoringNavigationCommandStatus = 'applied';
        let rejected = false;
        let entries = [...before.entries];
        let cursor = before.cursor;
        let pending = before.pending;
        let lastUserSequence = before.lastUserSequence;
        let lastUserInitiatedAt = before.lastUserInitiatedAt;
        let targetEntry: AuthoringNavigationEntry | null = null;
        if (!same(before.scope, command.scope))
        {
            status = 'rejected-invalid-command';
        }
        else if (prior)
        {
            status = prior.commandDigest === commandDigest ? 'replayed' : 'rejected-idempotency-conflict';
        }
        else if (command.expectedRevision !== before.revision)
        {
            status = 'rejected-cas';
        }
        else if (command.commandSequence <= before.lastCommandSequence || before.revision === Number.MAX_SAFE_INTEGER)
        {
            status = 'rejected-sequence';
        }
        else
        {
            switch (command.kind)
            {
                case 'append':
                case 'coalesce': {
                    const visit = command.visit;
                    const current = before.entries[before.cursor];
                    const coalesces = canCoalesce(current, visit);
                    const settling = coalesces && current.userActionId === visit.userActionId;
                    if (visit.userInitiatedAt < before.lastUserInitiatedAt
                        || visit.userSequence <= before.lastUserSequence && !(settling && visit.userSequence === before.lastUserSequence))
                    {
                        status = 'rejected-sequence';
                    }
                    else if (visit.validity.status !== 'current'
                        || (command.kind === 'coalesce' || current?.userActionId === visit.userActionId) && !coalesces
                        || current && coalesces && !validityIsFresh(current.validity, visit.validity)
                        || before.entries.some(entry => entry.entryId === visit.entryId && (!coalesces || entry.entryId !== current.entryId)))
                    {
                        status = 'rejected-state';
                    }
                    else
                    {
                        const prefix = before.entries.slice(0, before.cursor + (coalesces ? 0 : 1));
                        const nextEntry = seal({ ...visit, entryId: coalesces ? current.entryId : visit.entryId });
                        entries = [...prefix, nextEntry].slice(-before.capacity);
                        cursor = entries.length - 1;
                        pending = null;
                        lastUserSequence = visit.userSequence;
                        lastUserInitiatedAt = visit.userInitiatedAt;
                        status = coalesces ? 'coalesced' : 'applied';
                    }
                    break;
                }
                case 'back':
                case 'forward': {
                    const destination = before.cursor + (command.kind === 'back' ? -1 : 1);
                    const entry = before.entries[destination];
                    if (before.pending)
                    {
                        status = 'rejected-pending';
                    }
                    else if (entry?.entryId !== command.entryId || entry.contentDigest !== command.expectedEntryDigest
                        || !validityIsFresh(entry.validity, command.validity))
                    {
                        status = 'rejected-state';
                    }
                    else
                    {
                        targetEntry = seal({ ...withoutDigest(entry), validity: command.validity });
                        entries = before.entries.map((item, index) => index === destination ? targetEntry! : item);
                        status = command.validity.status === 'current' ? 'applied' : 'unavailable';
                        pending = status === 'applied' ? { intentRef: command.commandId, entryId: entry.entryId,
                            entryDigest: targetEntry.contentDigest, fromCursor: before.cursor, toCursor: destination } : null;
                    }
                    break;
                }
                case 'replace-invalid': {
                    const entry = before.entries.find(item => item.entryId === command.entryId);
                    if (entry?.contentDigest !== command.expectedEntryDigest
                        || entry.validity.status === 'current' && command.validity.status === 'current'
                        || !validityIsFresh(entry.validity, command.validity))
                    {
                        status = 'rejected-state';
                    }
                    else
                    {
                        entries = before.entries.map(item => item.entryId === command.entryId
                            ? seal({ ...withoutDigest(item), validity: command.validity }) : item);
                        pending = null;
                    }
                    break;
                }
                case 'settle-navigation': {
                    if (before.pending?.intentRef !== command.intentRef)
                    {
                        status = 'rejected-state';
                    }
                    else
                    {
                        cursor = command.outcome === 'completed' ? before.pending.toCursor : before.cursor;
                        pending = null;
                    }
                    break;
                }
                case 'clear-current-session': {
                    entries = [];
                    cursor = -1;
                    pending = null;
                    break;
                }
            }
        }
        rejected = status.startsWith('rejected-') || status === 'replayed';
        const expected = rejected ? before : seal({ ...withoutDigest(before), entries, cursor, pending,
            revision: before.revision + 1, lastCommandSequence: command.commandSequence,
            lastUserSequence, lastUserInitiatedAt, processed: [...before.processed,
                { commandId: command.commandId, idempotencyKey: command.idempotencyKey, commandDigest,
                    revisionAfter: before.revision + 1 }].slice(-authoringNavigationPolicy.commandWindow) });
        const target = rejected || targetEntry === null ? null : targetIntent(expected, targetEntry, command.commandId);
        // The receipt's complete closed projection is recomputed, including cancellation and content seals.
        const receipt = transition(before, expected, command, status, target).receipt;
        return same(observed.state, expected) && same(observed.target, target) && same(observed.receipt, receipt);
    }
    catch
    {
        return false;
    }
}

/** Replay must start at the explicit genesis; checkpoints alone cannot certify session history. */
export function verifyAuthoringNavigationReplay(scope: AuthoringNavigationScope, capacity: number,
    commands: readonly AuthoringNavigationCommand[], transitions: readonly AuthoringNavigationTransition[],
    expectedFinalDigest: string): boolean
{
    if (!isBoundedDenseArray(commands, 1024) || !isBoundedDenseArray(transitions, 1024)
        || commands.length !== transitions.length || !isDigest(expectedFinalDigest))
    {
        return false;
    }
    try
    {
        let state = createAuthoringNavigationHistoryState(scope, capacity);
        for (let index = 0; index < commands.length; index += 1)
        {
            if (!Object.hasOwn(commands, index) || !Object.hasOwn(transitions, index)
                || !verifyAuthoringNavigationTransition(state, commands[index], transitions[index]))
            {
                return false;
            }
            state = transitions[index].state;
        }
        return state.contentDigest === expectedFinalDigest;
    }
    catch
    {
        return false;
    }
}
