import {
    calculateOpenArticleDocumentDigest,
    openArticleDocumentCommandSchema,
    verifyOpenArticleDocumentRegistryState
} from './openArticleDocumentRegistry';

import type {
    OpenArticleDocumentEntry,
    OpenArticleDocumentRegistryState,
    ArticleGroupOwnershipCell,
    UpdateArticleGroupOwnershipTransactionCommand,
    OpenArticleDocumentRegistry
} from './openArticleDocumentRegistry';

export const authoringTabGroupRegistrySchema = 'fsusblog.authoring-tab-group-registry.v1' as const;
export const authoringTabGroupCommandSchema = 'fsusblog.authoring-tab-group-command.v1' as const;
export const authoringTabGroupResultSchema = 'fsusblog.authoring-tab-group-result.v1' as const;

const stableRef = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/u;
const owners = new WeakMap<OpenArticleDocumentRegistry, AuthoringTabGroupRegistry>();

export interface AuthoringGroupTabRef {
    tabId: string;
    editorSessionRef: string;
    documentEpoch: number;
    lifecycleRevision: number;
}

export interface AuthoringTabGroup {
    groupId: string;
    revision: number;
    tabs: AuthoringGroupTabRef[];
    activeTabId: string | null;
}

export interface AuthoringGroupActivationRef {
    groupId: string;
    tabId: string;
    editorSessionRef: string;
}

export interface AuthoringTabGroupRegistryState {
    schema: typeof authoringTabGroupRegistrySchema;
    revision: number;
    articleRegistryRevision: number;
    layoutState: 'single-group' | 'horizontal-two-group';
    effectiveLayoutState: 'single-group' | 'horizontal-two-group';
    groups: AuthoringTabGroup[];
    activeGroupId: string;
    focusedGroupId: string;
    effectiveFocusedGroupId: string;
    focusHistory: string[];
    activationHistory: AuthoringGroupActivationRef[];
    historyCapacity: number;
    splitRatioRef: string;
    collapsedByViewportRef: string | null;
    contentDigest: string;
}

export interface AuthoringTabGroupOptions {
    initialGroupId: string;
    splitRatioRef: string;
    historyCapacity: number;
}

/** Opaque reference supplied by the actual split-layout owner. */
export type AuthoringSplitRatioRef = string;

export interface AuthoringGroupReferenceProposal {
    groupId: string;
    expectedRevision: number | null;
    tabs: AuthoringGroupTabRef[];
    activeTabId: string | null;
}

interface GroupCommandBase {
    schema: typeof authoringTabGroupCommandSchema;
    commandId: string;
    idempotencyKey: string;
    expectedRevision: number;
    expectedArticleRegistryRevision: number;
}

export type AuthoringTabGroupCommand = GroupCommandBase & (
  | { kind: 'create-second-group'; groupId: string; }
  | { kind: 'focus-group'; groupId: string; }
  | { kind: 'move-tab'; sourceGroupId: string; targetGroupId: string;
      expectedSourceGroupRevision: number; expectedTargetGroupRevision: number;
      tab: AuthoringGroupTabRef; insertBeforeTabId: string | null; }
  | { kind: 'activate-tab-in-group'; groupId: string; tab: AuthoringGroupTabRef; }
  | { kind: 'merge-groups'; sourceGroupId: string; targetGroupId: string;
      expectedSourceGroupRevision: number; expectedTargetGroupRevision: number; }
  | { kind: 'close-empty-group'; groupId: string; }
  | { kind: 'set-effective-single'; enabled: boolean; viewportStateRef: string; }
  | { kind: 'set-split-ratio-ref'; splitRatioRef: string; }
  | { kind: 'apply-group-references'; groups: AuthoringGroupReferenceProposal[];
      activeGroupId: string; splitRatioRef: AuthoringSplitRatioRef; }
);

export type AuthoringTabGroupResultStatus = 'applied' | 'replayed' | 'rejected-invalid-command'
  | 'rejected-cas' | 'rejected-state' | 'rejected-idempotency-conflict' | 'recovery-required';

export interface AuthoringTabGroupCommandResult {
    schema: typeof authoringTabGroupResultSchema;
    commandId: string;
    idempotencyKey: string;
    status: AuthoringTabGroupResultStatus;
    reason: string | null;
    commandDigest: string;
    revisionBefore: number;
    revisionAfter: number;
    articleRevisionBefore: number;
    articleRevisionAfter: number;
    ownershipTransactionRef: string | null;
    before: AuthoringTabGroupRegistryState;
    after: AuthoringTabGroupRegistryState;
    contentDigest: string;
}

const commonKeys = ['schema', 'commandId', 'idempotencyKey', 'expectedRevision', 'expectedArticleRegistryRevision', 'kind'];
const commandKeys: Record<AuthoringTabGroupCommand['kind'], string[]> = {
    'create-second-group': ['groupId'],
    'focus-group': ['groupId'],
    'move-tab': ['sourceGroupId', 'targetGroupId', 'expectedSourceGroupRevision', 'expectedTargetGroupRevision', 'tab', 'insertBeforeTabId'],
    'activate-tab-in-group': ['groupId', 'tab'],
    'merge-groups': ['sourceGroupId', 'targetGroupId', 'expectedSourceGroupRevision', 'expectedTargetGroupRevision'],
    'close-empty-group': ['groupId'],
    'set-effective-single': ['enabled', 'viewportStateRef'],
    'set-split-ratio-ref': ['splitRatioRef'],
    'apply-group-references': ['groups', 'activeGroupId', 'splitRatioRef']
};

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown>
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRef(value: unknown): value is string
{
    return typeof value === 'string' && stableRef.test(value);
}

function isRevision(value: unknown): value is number
{
    return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isTabRef(value: unknown): value is AuthoringGroupTabRef
{
    return exactKeys(value, ['tabId', 'editorSessionRef', 'documentEpoch', 'lifecycleRevision'])
        && isRef(value.tabId) && isRef(value.editorSessionRef)
        && isRevision(value.documentEpoch) && Number(value.documentEpoch) > 0
        && isRevision(value.lifecycleRevision) && Number(value.lifecycleRevision) > 0;
}

function isCommand(value: unknown): value is AuthoringTabGroupCommand
{
    if (!value || typeof value !== 'object')
    {
        return false;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.prototype.hasOwnProperty.call(commandKeys, String(record.kind))
        ? commandKeys[record.kind as AuthoringTabGroupCommand['kind']] : undefined;
    if (!keys || !exactKeys(value, [...commonKeys, ...keys])
        || record.schema !== authoringTabGroupCommandSchema || !isRef(record.commandId)
        || !isRef(record.idempotencyKey) || !isRevision(record.expectedRevision)
        || !isRevision(record.expectedArticleRegistryRevision))
    {
        return false;
    }
    switch (record.kind)
    {
        case 'move-tab':
        case 'merge-groups':
            return isRef(record.sourceGroupId) && isRef(record.targetGroupId)
                && record.sourceGroupId !== record.targetGroupId
                && isRevision(record.expectedSourceGroupRevision) && isRevision(record.expectedTargetGroupRevision)
                && (record.kind === 'merge-groups' || isTabRef(record.tab)
                    && (record.insertBeforeTabId === null || isRef(record.insertBeforeTabId)));
        case 'activate-tab-in-group': return isRef(record.groupId) && isTabRef(record.tab);
        case 'create-second-group':
        case 'focus-group':
        case 'close-empty-group': return isRef(record.groupId);
        case 'set-effective-single': return typeof record.enabled === 'boolean' && isRef(record.viewportStateRef);
        case 'set-split-ratio-ref': return isRef(record.splitRatioRef);
        case 'apply-group-references': {
            const groups = record.groups;
            if (!Array.isArray(groups) || groups.length < 1 || groups.length > 2
                || !isRef(record.activeGroupId) || !isRef(record.splitRatioRef))
            {
                return false;
            }
            for (let index = 0; index < groups.length; index += 1)
            {
                if (!Object.prototype.hasOwnProperty.call(groups, index))
                {
                    return false;
                }
                const group: unknown = groups[index];
                if (!exactKeys(group, ['groupId', 'expectedRevision', 'tabs', 'activeTabId'])
                    || !isRef(group.groupId) || group.expectedRevision !== null && !isRevision(group.expectedRevision)
                    || !Array.isArray(group.tabs) || group.activeTabId !== null && !isRef(group.activeTabId))
                {
                    return false;
                }
                for (let tabIndex = 0; tabIndex < group.tabs.length; tabIndex += 1)
                {
                    if (!Object.prototype.hasOwnProperty.call(group.tabs, tabIndex) || !isTabRef(group.tabs[tabIndex]))
                    {
                        return false;
                    }
                }
            }
            const validated = groups as AuthoringGroupReferenceProposal[];
            return new Set(validated.map(group => group.groupId)).size === validated.length
                && validated.some(group => group.groupId === record.activeGroupId);
        }
        default: return false;
    }
}

function tabReference(entry: OpenArticleDocumentEntry): AuthoringGroupTabRef
{
    return { tabId: entry.tabId, editorSessionRef: entry.editorSessionRef,
        documentEpoch: entry.documentContext.documentEpoch, lifecycleRevision: entry.lifecycleRevision };
}

function sealState(state: Omit<AuthoringTabGroupRegistryState, 'contentDigest'>): AuthoringTabGroupRegistryState
{
    return { ...state, contentDigest: calculateOpenArticleDocumentDigest(state) };
}

function withoutDigest<T extends { contentDigest: string; }>(value: T): Omit<T, 'contentDigest'>
{
    const body: Partial<T> = { ...value };
    delete body.contentDigest;
    return body as Omit<T, 'contentDigest'>;
}

/** Exactly one group owner per existing article registry; no article identity index. */
export class AuthoringTabGroupRegistry
{
    private readonly articleRegistry: OpenArticleDocumentRegistry;
    private readonly publicationCell: ArticleGroupOwnershipCell;
    private pending = false;
    private recoveryRequired = false;

    public constructor(articleRegistry: OpenArticleDocumentRegistry, options: AuthoringTabGroupOptions)
    {
        if (owners.has(articleRegistry))
        {
            throw new Error('authoring-tab-group-owner-already-exists');
        }
        if (!exactKeys(options, ['initialGroupId', 'splitRatioRef', 'historyCapacity'])
            || !isRef(options.initialGroupId) || !isRef(options.splitRatioRef)
            || !Number.isSafeInteger(options.historyCapacity) || options.historyCapacity < 1)
        {
            throw new Error('authoring-tab-group-options-invalid');
        }
        this.articleRegistry = articleRegistry;
        const initial = sealState({ schema: authoringTabGroupRegistrySchema, revision: 0,
            articleRegistryRevision: articleRegistry.getRevision(), layoutState: 'single-group',
            effectiveLayoutState: 'single-group', groups: [{ groupId: options.initialGroupId,
                revision: 0, tabs: [], activeTabId: null }], activeGroupId: options.initialGroupId,
            focusedGroupId: options.initialGroupId, effectiveFocusedGroupId: options.initialGroupId,
            focusHistory: [], activationHistory: [], historyCapacity: options.historyCapacity,
            splitRatioRef: options.splitRatioRef, collapsedByViewportRef: null });
        const state = this.projectState(initial);
        this.publicationCell = articleRegistry.createGroupOwnershipCell({ state, commandHistory: new Map() });
        owners.set(articleRegistry, this);
    }

    private get state(): AuthoringTabGroupRegistryState
    {
        return this.publicationCell.value.state;
    }

    private get processed(): ArticleGroupOwnershipCell['value']['commandHistory']
    {
        return this.publicationCell.value.commandHistory;
    }

    public exportState(): AuthoringTabGroupRegistryState
    {
        return structuredClone(this.projectState());
    }

    /** Prepare every fallible group operation before calling the synchronous owner port. */
    public execute(input: unknown): AuthoringTabGroupCommandResult
    {
        if (this.pending)
        {
            throw new Error('authoring-group-operation-pending');
        }
        const before = this.projectState();
        const commandDigest = calculateOpenArticleDocumentDigest(input);
        if (!isCommand(input))
        {
            return this.result(input, before, before, 'rejected-invalid-command', 'command-schema-invalid', commandDigest);
        }
        if (this.recoveryRequired)
        {
            return this.result(input, before, before, 'recovery-required', 'group-operation-pending-or-recovery-required', commandDigest);
        }
        const processed = this.processed.get(input.idempotencyKey);
        if (processed)
        {
            if (processed.digest !== commandDigest)
            {
                return this.result(input, before, before, 'rejected-idempotency-conflict', 'idempotency-key-reused', commandDigest);
            }
            const replay = { ...withoutDigest(structuredClone(processed.result)), status: 'replayed' as const };
            return { ...replay, contentDigest: calculateOpenArticleDocumentDigest(replay) };
        }
        if (input.expectedRevision !== before.revision || input.expectedArticleRegistryRevision !== before.articleRegistryRevision)
        {
            return this.result(input, before, before, 'rejected-cas', 'group-or-article-revision-mismatch', commandDigest);
        }
        this.pending = true;
        try
        {
            const command = structuredClone(input);
            const next = structuredClone(before);
            const planned = this.plan(command, next);
            if (typeof planned === 'string')
            {
                return this.result(command, before, before, 'rejected-state', planned, commandDigest);
            }
            if (!Number.isSafeInteger(before.revision + 1)
                || !Number.isSafeInteger(before.articleRegistryRevision + 1)
                || next.groups.some(group => !Number.isSafeInteger(group.revision)))
            {
                return this.result(command, before, before, 'rejected-state', 'revision-exhausted', commandDigest);
            }
            next.revision += 1;
            next.articleRegistryRevision += 1;
            const activeTabId = next.groups.find(group => group.groupId === next.activeGroupId)!.activeTabId;
            const references: UpdateArticleGroupOwnershipTransactionCommand['tabs'] = [];
            for (const group of next.groups)
            {
                group.tabs = group.tabs.map(ref =>
                {
                    const entry = this.articleRegistry.getEntry(ref.tabId)!;
                    references.push({ ...tabReference(entry), expectedOwningGroupId: entry.owningGroupId, targetGroupId: group.groupId });
                    const changed = entry.owningGroupId !== group.groupId || entry.isActive !== (entry.tabId === activeTabId);
                    return { ...tabReference(entry), lifecycleRevision: entry.lifecycleRevision + (changed ? 1 : 0) };
                });
            }
            const after = sealState(withoutDigest(next));
            const result = this.result(command, before, after, 'applied', null, commandDigest,
                command.commandId);
            const outward = structuredClone(result);
            const processedNext = new Map(this.processed);
            processedNext.set(command.idempotencyKey, { digest: commandDigest, result: structuredClone(result) });
            const expected = this.publicationCell.value;
            const ownerCommand: UpdateArticleGroupOwnershipTransactionCommand = {
                schema: openArticleDocumentCommandSchema, kind: 'update-group-ownership-transaction',
                commandId: command.commandId, idempotencyKey: command.idempotencyKey,
                expectedRevision: command.expectedArticleRegistryRevision,
                expectedGroupRevision: expected.state.revision, groupStateBeforeDigest: expected.state.contentDigest,
                groupStateAfterDigest: after.contentDigest, groupCommandDigest: commandDigest,
                ownershipTransactionRef: command.commandId, tabs: references,
                targetGroupIds: after.groups.map(group => group.groupId), activeTabId
            };
            // One canonical commit publishes entries, revisions and the registered
            // group cell. No group assignment follows its successful return.
            const receipt = this.articleRegistry.executeGroupOwnershipTransaction(ownerCommand, expected,
                { state: after, commandHistory: processedNext });
            if (receipt.status !== 'applied')
            {
                return this.result(command, before, before, 'rejected-state', receipt.reason ?? receipt.status, commandDigest);
            }
            return outward;
        }
        catch
        {
            this.recoveryRequired = this.articleRegistry.getRevision() !== before.articleRegistryRevision;
            const observed = this.recoveryRequired ? this.projectState() : before;
            return this.result(input, before, observed, this.recoveryRequired ? 'recovery-required' : 'rejected-state',
                'group-preparation-or-owner-failed', commandDigest);
        }
        finally
        {
            this.pending = false;
        }
    }

    private projectState(base: AuthoringTabGroupRegistryState = this.state): AuthoringTabGroupRegistryState
    {
        const entries = this.articleRegistry.listEntries();
        if (entries.some(entry => !base.groups.some(group => group.groupId === entry.owningGroupId)))
        {
            throw new Error('authoring-tab-group-ownership-recovery-required');
        }
        if (base.groups.some(group => group.tabs.some(ref =>
        {
            const current = entries.find(entry => entry.tabId === ref.tabId);
            return current && (current.owningGroupId !== group.groupId
                || current.editorSessionRef !== ref.editorSessionRef || current.documentContext.documentEpoch !== ref.documentEpoch);
        })))
        {
            throw new Error('authoring-tab-group-ownership-recovery-required');
        }
        const state = structuredClone(base);
        for (const group of state.groups)
        {
            const current = entries.filter(entry => entry.owningGroupId === group.groupId);
            const retained = group.tabs.filter(tab => current.some(entry => entry.tabId === tab.tabId));
            const added = current.filter(entry => !retained.some(tab => tab.tabId === entry.tabId));
            group.tabs = [...retained.map(tab => tabReference(current.find(entry => entry.tabId === tab.tabId)!)), ...added.map(tabReference)];
            const active = current.find(entry => entry.isActive);
            group.activeTabId = active?.tabId ?? (group.tabs.some(tab => tab.tabId === group.activeTabId)
                ? group.activeTabId : group.tabs[0]?.tabId ?? null);
        }
        const active = entries.find(entry => entry.isActive);
        state.activeGroupId = active?.owningGroupId ?? state.activeGroupId;
        state.articleRegistryRevision = this.articleRegistry.getRevision();
        state.effectiveFocusedGroupId = state.collapsedByViewportRef ? state.activeGroupId : state.focusedGroupId;
        state.activationHistory = state.activationHistory.filter(ref => state.groups.some(group =>
            group.groupId === ref.groupId && group.tabs.some(tab => tab.tabId === ref.tabId && tab.editorSessionRef === ref.editorSessionRef)));
        return sealState(withoutDigest(state));
    }

    private plan(command: AuthoringTabGroupCommand, next: AuthoringTabGroupRegistryState): string | null
    {
        const groupFor = (id: string) => next.groups.find(group => group.groupId === id);
        const focus = (id: string) =>
        {
            next.focusedGroupId = id;
            next.focusHistory = [...next.focusHistory.filter(item => item !== id), id].slice(-next.historyCapacity);
        };
        switch (command.kind)
        {
            case 'create-second-group':
                if (next.groups.length !== 1 || groupFor(command.groupId))
                {
                    return 'third-or-duplicate-group-refused';
                }
                next.groups.push({ groupId: command.groupId, revision: 0, tabs: [], activeTabId: null });
                break;
            case 'focus-group':
                if (!groupFor(command.groupId))
                {
                    return 'group-not-found';
                }
                focus(command.groupId);
                break;
            case 'activate-tab-in-group': {
                const group = groupFor(command.groupId);
                const tab = group?.tabs.find(ref => ref.tabId === command.tab.tabId);
                if (!group || !tab || calculateOpenArticleDocumentDigest(tab) !== calculateOpenArticleDocumentDigest(command.tab))
                {
                    return 'tab-session-epoch-mismatch';
                }
                const entry = this.articleRegistry.getEntry(tab.tabId)!;
                if (entry.status.permission === 'denied' || entry.status.permission === 'revoked'
                    || entry.status.lifecycle !== 'current')
                {
                    return 'activation-blocked';
                }
                group.activeTabId = tab.tabId;
                group.revision += 1;
                next.activeGroupId = group.groupId;
                focus(group.groupId);
                next.activationHistory = [...next.activationHistory.filter(ref => ref.tabId !== tab.tabId),
                    { groupId: group.groupId, tabId: tab.tabId, editorSessionRef: tab.editorSessionRef }].slice(-next.historyCapacity);
                break;
            }
            case 'move-tab':
            case 'merge-groups': {
                const source = groupFor(command.sourceGroupId);
                const target = groupFor(command.targetGroupId);
                if (!source || !target)
                {
                    return 'group-not-found';
                }
                if (source.revision !== command.expectedSourceGroupRevision || target.revision !== command.expectedTargetGroupRevision)
                {
                    return 'group-revision-mismatch';
                }
                const tabs = command.kind === 'merge-groups' ? [...source.tabs] : source.tabs.filter(tab => tab.tabId === command.tab.tabId);
                if (command.kind === 'move-tab' && (tabs.length !== 1
                    || calculateOpenArticleDocumentDigest(tabs[0]) !== calculateOpenArticleDocumentDigest(command.tab)))
                {
                    return 'tab-session-epoch-mismatch';
                }
                if (command.kind === 'move-tab' && command.insertBeforeTabId !== null
                    && !target.tabs.some(tab => tab.tabId === command.insertBeforeTabId))
                {
                    return 'insertion-reference-not-found';
                }
                source.tabs = source.tabs.filter(tab => !tabs.some(moved => moved.tabId === tab.tabId));
                const moved = tabs.map(tab => ({ ...tab }));
                const insertion = command.kind === 'move-tab' && command.insertBeforeTabId !== null
                    ? target.tabs.findIndex(tab => tab.tabId === command.insertBeforeTabId) : target.tabs.length;
                target.tabs.splice(insertion, 0, ...moved);
                source.revision += 1;
                target.revision += 1;
                if (tabs.some(tab => tab.tabId === source.activeTabId))
                {
                    if (next.activeGroupId === source.groupId)
                    {
                        target.activeTabId = source.activeTabId;
                        next.activeGroupId = target.groupId;
                    }
                    source.activeTabId = source.tabs[0]?.tabId ?? null;
                }
                target.activeTabId ??= target.tabs[0]?.tabId ?? null;
                next.activationHistory = next.activationHistory.map(ref => tabs.some(tab => tab.tabId === ref.tabId)
                    ? { ...ref, groupId: target.groupId } : ref);
                if (command.kind === 'merge-groups')
                {
                    this.removeEmptyGroup(next, source.groupId, target.groupId);
                }
                break;
            }
            case 'close-empty-group': {
                const group = groupFor(command.groupId);
                if (!group || group.tabs.length || next.groups.length !== 2)
                {
                    return 'nonempty-or-last-group-refused';
                }
                const target = next.groups.find(item => item.groupId !== group.groupId)!;
                this.removeEmptyGroup(next, group.groupId, target.groupId);
                break;
            }
            case 'set-effective-single':
                next.collapsedByViewportRef = command.enabled ? command.viewportStateRef : null;
                break;
            case 'set-split-ratio-ref':
                next.splitRatioRef = command.splitRatioRef;
                break;
            case 'apply-group-references': {
                const current = this.articleRegistry.listEntries();
                const seen = new Set<string>();
                for (const proposal of command.groups)
                {
                    const old = groupFor(proposal.groupId);
                    if (old ? proposal.expectedRevision !== old.revision : proposal.expectedRevision !== null)
                    {
                        return 'group-revision-mismatch';
                    }
                    if (proposal.activeTabId !== null && !proposal.tabs.some(tab => tab.tabId === proposal.activeTabId))
                    {
                        return 'active-tab-reference-not-found';
                    }
                    for (const ref of proposal.tabs)
                    {
                        const entry = current.find(item => item.tabId === ref.tabId);
                        if (!entry || seen.has(ref.tabId) || calculateOpenArticleDocumentDigest(tabReference(entry)) !== calculateOpenArticleDocumentDigest(ref))
                        {
                            return 'duplicate-or-stale-tab-reference';
                        }
                        seen.add(ref.tabId);
                    }
                }
                if (seen.size !== current.length)
                {
                    return 'complete-tab-reference-set-required';
                }
                next.groups = command.groups.map(proposal => ({ groupId: proposal.groupId,
                    revision: (groupFor(proposal.groupId)?.revision ?? -1) + 1,
                    tabs: structuredClone(proposal.tabs), activeTabId: proposal.activeTabId }));
                next.activeGroupId = command.activeGroupId;
                next.focusedGroupId = command.activeGroupId;
                next.splitRatioRef = command.splitRatioRef;
                next.focusHistory = next.focusHistory.filter(id => next.groups.some(group => group.groupId === id));
                next.activationHistory = next.activationHistory.map(ref => ({ ...ref,
                    groupId: next.groups.find(group => group.tabs.some(tab => tab.tabId === ref.tabId))!.groupId }));
                break;
            }
        }
        next.layoutState = next.groups.length === 2 ? 'horizontal-two-group' : 'single-group';
        next.effectiveLayoutState = next.collapsedByViewportRef ? 'single-group' : next.layoutState;
        next.effectiveFocusedGroupId = next.collapsedByViewportRef ? next.activeGroupId : next.focusedGroupId;
        return null;
    }

    private removeEmptyGroup(state: AuthoringTabGroupRegistryState, sourceId: string, targetId: string): void
    {
        state.groups = state.groups.filter(group => group.groupId !== sourceId);
        if (state.activeGroupId === sourceId)
        {
            state.activeGroupId = targetId;
        }
        if (state.focusedGroupId === sourceId)
        {
            state.focusedGroupId = targetId;
        }
        state.focusHistory = [...new Set(state.focusHistory.map(id => id === sourceId ? targetId : id).reverse())].reverse();
    }

    private result(input: unknown, before: AuthoringTabGroupRegistryState, after: AuthoringTabGroupRegistryState,
        status: AuthoringTabGroupResultStatus, reason: string | null, commandDigest: string, ownershipTransactionRef: string | null = null): AuthoringTabGroupCommandResult
    {
        const command = input as Partial<AuthoringTabGroupCommand> | null;
        const base = { schema: authoringTabGroupResultSchema, commandId: isRef(command?.commandId) ? command.commandId : 'invalid-command',
            idempotencyKey: isRef(command?.idempotencyKey) ? command.idempotencyKey : 'invalid-idempotency', status, reason,
            commandDigest, revisionBefore: before.revision, revisionAfter: after.revision,
            articleRevisionBefore: before.articleRegistryRevision, articleRevisionAfter: after.articleRegistryRevision,
            ownershipTransactionRef, before: structuredClone(before), after: structuredClone(after) };
        return { ...base, contentDigest: calculateOpenArticleDocumentDigest(base) };
    }
}

/** Independent closed-state check against the actual canonical article snapshot. */
export function verifyAuthoringTabGroupRegistryState(state: AuthoringTabGroupRegistryState, article: OpenArticleDocumentRegistryState): boolean
{
    try
    {
        return verifyGroupState(state, article);
    }
    catch
    {
        return false;
    }
}

function verifyGroupState(state: AuthoringTabGroupRegistryState, article: OpenArticleDocumentRegistryState): boolean
{
    if (!exactKeys(state, ['schema', 'revision', 'articleRegistryRevision', 'layoutState', 'effectiveLayoutState', 'groups',
        'activeGroupId', 'focusedGroupId', 'effectiveFocusedGroupId', 'focusHistory', 'activationHistory', 'historyCapacity',
        'splitRatioRef', 'collapsedByViewportRef', 'contentDigest']) || state.schema !== authoringTabGroupRegistrySchema
        || !verifyOpenArticleDocumentRegistryState(article) || state.articleRegistryRevision !== article.revision
        || !isRevision(state.revision) || !Array.isArray(state.groups) || state.groups.length < 1 || state.groups.length > 2
        || Object.keys(state.groups).length !== state.groups.length
        || new Set(state.groups.map(group => group.groupId)).size !== state.groups.length
        || !isRef(state.splitRatioRef) || state.collapsedByViewportRef !== null && !isRef(state.collapsedByViewportRef)
        || !Number.isSafeInteger(state.historyCapacity) || state.historyCapacity < 1)
    {
        return false;
    }
    const physical = state.groups.length === 2 ? 'horizontal-two-group' : 'single-group';
    if (state.layoutState !== physical || state.effectiveLayoutState !== (state.collapsedByViewportRef ? 'single-group' : physical)
        || !state.groups.some(group => group.groupId === state.activeGroupId)
        || !state.groups.some(group => group.groupId === state.focusedGroupId)
        || state.effectiveFocusedGroupId !== (state.collapsedByViewportRef ? state.activeGroupId : state.focusedGroupId))
    {
        return false;
    }
    const tabs: string[] = [];
    for (const group of state.groups)
    {
        if (!exactKeys(group, ['groupId', 'revision', 'tabs', 'activeTabId']) || !isRef(group.groupId)
            || !isRevision(group.revision) || !Array.isArray(group.tabs) || Object.keys(group.tabs).length !== group.tabs.length
            || group.activeTabId !== null && !group.tabs.some(tab => tab.tabId === group.activeTabId))
        {
            return false;
        }
        for (const ref of group.tabs)
        {
            const entry = article.entries.find(item => item.tabId === ref.tabId);
            if (!isTabRef(ref) || entry?.owningGroupId !== group.groupId
                || calculateOpenArticleDocumentDigest(ref) !== calculateOpenArticleDocumentDigest(tabReference(entry)))
            {
                return false;
            }
            tabs.push(ref.tabId);
        }
    }
    if (new Set(tabs).size !== tabs.length || tabs.length !== article.entries.length
        || !Array.isArray(state.focusHistory) || Object.keys(state.focusHistory).length !== state.focusHistory.length
        || state.focusHistory.length > state.historyCapacity || new Set(state.focusHistory).size !== state.focusHistory.length
        || state.focusHistory.some(id => !state.groups.some(group => group.groupId === id))
        || !Array.isArray(state.activationHistory) || Object.keys(state.activationHistory).length !== state.activationHistory.length
        || state.activationHistory.length > state.historyCapacity
        || new Set(state.activationHistory.map(ref => ref.tabId)).size !== state.activationHistory.length
        || state.activationHistory.some(ref => !exactKeys(ref, ['groupId', 'tabId', 'editorSessionRef'])
            || !state.groups.some(group => group.groupId === ref.groupId
                && group.tabs.some(tab => tab.tabId === ref.tabId && tab.editorSessionRef === ref.editorSessionRef))))
    {
        return false;
    }
    const active = article.entries.find(entry => entry.isActive);
    if (active && (state.activeGroupId !== active.owningGroupId
        || state.groups.find(group => group.groupId === active.owningGroupId)?.activeTabId !== active.tabId))
    {
        return false;
    }
    return calculateOpenArticleDocumentDigest(withoutDigest(state)) === state.contentDigest;
}

export function verifyAuthoringTabGroupResult(result: AuthoringTabGroupCommandResult,
    articleBefore: OpenArticleDocumentRegistryState, articleAfter: OpenArticleDocumentRegistryState,
    originalCommand: unknown): boolean
{
    try
    {
        if (!exactKeys(result, ['schema', 'commandId', 'idempotencyKey', 'status', 'reason', 'commandDigest',
            'revisionBefore', 'revisionAfter', 'articleRevisionBefore', 'articleRevisionAfter', 'ownershipTransactionRef',
            'before', 'after', 'contentDigest']) || result.schema !== authoringTabGroupResultSchema
            || !isRef(result.commandId) || !isRef(result.idempotencyKey)
            || !/^[a-f0-9]{64}$/u.test(result.commandDigest)
            || result.reason !== null && typeof result.reason !== 'string'
            || result.ownershipTransactionRef !== null && !isRef(result.ownershipTransactionRef)
            || !['applied', 'replayed', 'rejected-invalid-command', 'rejected-cas', 'rejected-state',
                'rejected-idempotency-conflict', 'recovery-required'].includes(result.status)
            || !verifyAuthoringTabGroupRegistryState(result.before, articleBefore)
            || !verifyAuthoringTabGroupRegistryState(result.after, articleAfter)
            || result.revisionBefore !== result.before.revision || result.revisionAfter !== result.after.revision
            || result.articleRevisionBefore !== articleBefore.revision || result.articleRevisionAfter !== articleAfter.revision)
        {
            return false;
        }
        const applied = result.status === 'applied' || result.status === 'replayed';
        if (!isCommand(originalCommand) || result.commandId !== originalCommand.commandId
            || result.idempotencyKey !== originalCommand.idempotencyKey
            || result.commandDigest !== calculateOpenArticleDocumentDigest(originalCommand)
            || applied && (result.revisionBefore !== originalCommand.expectedRevision
                || result.articleRevisionBefore !== originalCommand.expectedArticleRegistryRevision))
        {
            return false;
        }
        if (applied && (result.revisionAfter !== result.revisionBefore + 1
            || result.articleRevisionAfter !== result.articleRevisionBefore + 1
            || result.ownershipTransactionRef !== result.commandId || result.reason !== null)
            || !applied && result.status !== 'recovery-required' && (result.before.contentDigest !== result.after.contentDigest
                || articleBefore.contentDigest !== articleAfter.contentDigest))
        {
            return false;
        }
        if (applied && originalCommand.kind === 'apply-group-references')
        {
            if (result.after.activeGroupId !== originalCommand.activeGroupId
                || result.after.splitRatioRef !== originalCommand.splitRatioRef
                || result.after.groups.length !== originalCommand.groups.length)
            {
                return false;
            }
            for (const [index, proposal] of originalCommand.groups.entries())
            {
                const after = result.after.groups[index];
                const old = result.before.groups.find(group => group.groupId === proposal.groupId);
                if (after.groupId !== proposal.groupId || after.activeTabId !== proposal.activeTabId
                    || after.revision !== (old?.revision ?? -1) + 1
                    || proposal.expectedRevision !== (old?.revision ?? null)
                    || after.tabs.length !== proposal.tabs.length)
                {
                    return false;
                }
                for (const [tabIndex, ref] of proposal.tabs.entries())
                {
                    const entry = articleBefore.entries.find(item => item.tabId === ref.tabId);
                    if (!entry || calculateOpenArticleDocumentDigest(tabReference(entry)) !== calculateOpenArticleDocumentDigest(ref)
                        || after.tabs[tabIndex].tabId !== ref.tabId)
                    {
                        return false;
                    }
                }
            }
        }
        return calculateOpenArticleDocumentDigest(withoutDigest(result)) === result.contentDigest;
    }
    catch
    {
        return false;
    }
}

export interface AuthoringTabGroupReplayResult {
    accepted: boolean;
    failingCommandId: string | null;
    results: AuthoringTabGroupCommandResult[];
    state: AuthoringTabGroupRegistryState;
}

/** The caller supplies an isolated canonical owner; replay never creates an article registry. */
export function replayAuthoringTabGroupCommands(articleRegistry: OpenArticleDocumentRegistry,
    options: AuthoringTabGroupOptions, commands: readonly AuthoringTabGroupCommand[],
    expectedResults: readonly AuthoringTabGroupCommandResult[]): AuthoringTabGroupReplayResult
{
    const groups = new AuthoringTabGroupRegistry(articleRegistry, options);
    const results: AuthoringTabGroupCommandResult[] = [];
    const snapshots = new Map<string, { before: OpenArticleDocumentRegistryState; after: OpenArticleDocumentRegistryState; }>();
    let failingCommandId: string | null = null;
    for (const [ordinal, command] of commands.entries())
    {
        const before = articleRegistry.exportState();
        const result = groups.execute(command);
        results.push(result);
        const expected = expectedResults[ordinal];
        const after = articleRegistry.exportState();
        const replay = result.status === 'replayed' ? snapshots.get(command.idempotencyKey) : null;
        if (expected?.commandId !== command.commandId || expected.idempotencyKey !== command.idempotencyKey
            || expected.contentDigest !== result.contentDigest
            || result.status === 'replayed' && (!replay || before.contentDigest !== after.contentDigest)
            || !verifyAuthoringTabGroupResult(result, replay?.before ?? before, replay?.after ?? after, command)
            || result.status !== 'applied' && result.status !== 'replayed')
        {
            failingCommandId = command.commandId;
            break;
        }
        if (result.status === 'applied')
        {
            snapshots.set(command.idempotencyKey, { before, after });
        }
    }
    const state = groups.exportState();
    return { accepted: failingCommandId === null && results.length === expectedResults.length
        && verifyAuthoringTabGroupRegistryState(state, articleRegistry.exportState()), failingCommandId, results, state };
}
