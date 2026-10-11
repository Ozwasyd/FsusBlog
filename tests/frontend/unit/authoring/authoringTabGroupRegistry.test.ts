import { describe, expect, it, vi } from 'vitest';

import {
    AuthoringTabGroupRegistry,
    authoringTabGroupCommandSchema,
    authoringTabGroupResultSchema,
    replayAuthoringTabGroupCommands,
    verifyAuthoringTabGroupRegistryState,
    verifyAuthoringTabGroupResult
} from '@/services/authoring/authoringTabGroupRegistry';
import {
    OpenArticleDocumentRegistry,
    calculateOpenArticleDocumentDigest,
    openArticleDocumentCommandSchema,
    verifyOpenArticleDocumentResult
} from '@/services/authoring/openArticleDocumentRegistry';

import type { AuthoringTabGroupCommand, AuthoringTabGroupRegistryState } from '@/services/authoring/authoringTabGroupRegistry';
import type { OpenOrActivateArticleCommand } from '@/services/authoring/openArticleDocumentRegistry';

function open(articleId: number, revision: number): OpenOrActivateArticleCommand
{
    return { schema: openArticleDocumentCommandSchema, kind: 'open-or-activate',
        commandId: `group-open-${articleId}`, idempotencyKey: `group-open-${articleId}`, expectedRevision: revision,
        intent: 'workspace', entrypoint: 'direct-route', identity: { articleId, draftId: `draft-${articleId}`, documentId: `document-${articleId}` },
        documentContext: { documentEpoch: 3, sourceRevision: `source-${articleId}`, draftRevision: `draft-${articleId}` },
        editorSessionRef: `session-${articleId}`, tabId: `tab-${articleId}`, targetGroupId: 'group-primary', tabKind: 'pinned',
        status: { dirty: false, saving: false, conflict: false, recovery: false, pendingAttachments: false,
            permission: 'allowed', lifecycle: 'current', statusRef: `status-${articleId}` }, lastActiveAnchorRef: `anchor-${articleId}` };
}

function fixture()
{
    const articles = new OpenArticleDocumentRegistry();
    articles.execute(open(1, 0));
    articles.execute(open(2, 1));
    const groups = new AuthoringTabGroupRegistry(articles, {
        initialGroupId: 'group-primary', splitRatioRef: 'ratio-explicit-input', historyCapacity: 4
    });
    return { articles, groups };
}

function commandBase(state: AuthoringTabGroupRegistryState)
{
    return { schema: authoringTabGroupCommandSchema, commandId: `group-command-${state.revision}`,
        idempotencyKey: `group-command-${state.revision}`, expectedRevision: state.revision,
        expectedArticleRegistryRevision: state.articleRegistryRevision };
}

function addSecond(groups: AuthoringTabGroupRegistry)
{
    return groups.execute({ ...commandBase(groups.exportState()), kind: 'create-second-group', groupId: 'group-secondary' });
}

function move(groups: AuthoringTabGroupRegistry): AuthoringTabGroupCommand
{
    const state = groups.exportState();
    return { ...commandBase(state), kind: 'move-tab', sourceGroupId: 'group-primary', targetGroupId: 'group-secondary',
        expectedSourceGroupRevision: state.groups[0].revision, expectedTargetGroupRevision: state.groups[1].revision,
        tab: state.groups[0].tabs[0], insertBeforeTabId: null };
}

describe('AuthoringTabGroupRegistry ordinary source controls (#2298)', () => {
    it('independently replays exact commands and receipts against a separate canonical owner', () => {
        const { groups } = fixture();
        const create: AuthoringTabGroupCommand = { ...commandBase(groups.exportState()), kind: 'create-second-group', groupId: 'group-secondary' };
        const first = groups.execute(create);
        const command = move(groups);
        const second = groups.execute(command);
        const replay = groups.execute(command);
        const articles = new OpenArticleDocumentRegistry();
        articles.execute(open(1, 0));
        articles.execute(open(2, 1));
        expect(replayAuthoringTabGroupCommands(articles, { initialGroupId: 'group-primary', splitRatioRef: 'ratio-explicit-input', historyCapacity: 4 },
            [create, command, command], [first, second, replay]).accepted).toBe(true);
    });
    it('has one owner per canonical registry and refuses third groups and recursive command shapes', () => {
        const { articles, groups } = fixture();
        expect(() => new AuthoringTabGroupRegistry(articles, { initialGroupId: 'group-primary', splitRatioRef: 'ratio-other', historyCapacity: 4 })).toThrow('owner-already-exists');
        expect(addSecond(groups).status).toBe('applied');
        const before = groups.exportState();
        expect(groups.execute({ ...commandBase(before), kind: 'create-second-group', groupId: 'group-third' }).status).toBe('rejected-state');
        expect(groups.execute({ ...commandBase(before), kind: 'create-second-group', groupId: 'group-third', children: [] }).status).toBe('rejected-invalid-command');
        expect(groups.exportState()).toEqual(before);
    });

    it('moves the same tab/session/epoch with one canonical ownership commit and exact replay', () => {
        const { articles, groups } = fixture();
        addSecond(groups);
        const before = articles.exportState();
        const command = move(groups);
        const result = groups.execute(command);
        expect(result.status).toBe('applied');
        expect(articles.getRevision()).toBe(before.revision + 1);
        const moved = articles.getEntry('tab-1')!;
        expect(moved.owningGroupId).toBe('group-secondary');
        expect(moved.editorSessionRef).toBe(before.entries[0].editorSessionRef);
        expect(moved.documentContext).toEqual(before.entries[0].documentContext);
        expect(moved.identity).toEqual(before.entries[0].identity);
        expect(moved.lastActiveAnchorRef).toBe(before.entries[0].lastActiveAnchorRef);
        expect(verifyAuthoringTabGroupResult(result, before, articles.exportState(), command)).toBe(true);
        const accepted = groups.exportState();
        const articleAccepted = articles.exportState();
        expect(groups.execute(command).status).toBe('replayed');
        expect(groups.exportState()).toEqual(accepted);
        expect(articles.exportState()).toEqual(articleAccepted);
    });

    it.each(['expectedRevision', 'expectedArticleRegistryRevision', 'expectedSourceGroupRevision', 'expectedTargetGroupRevision'])(
        'refuses stale %s without changes on either side', field => {
            const { articles, groups } = fixture();
            addSecond(groups);
            const before = groups.exportState();
            const articleBefore = articles.exportState();
            const command = move(groups) as unknown as Record<string, unknown>;
            command[field] = Number(command[field]) + 1;
            expect(groups.execute(command).status).not.toBe('applied');
            expect(groups.exportState()).toEqual(before);
            expect(articles.exportState()).toEqual(articleBefore);
        }
    );

    it('refuses foreign exact refs and nonexistent insertion or target refs with no mutation', () => {
        const { articles, groups } = fixture();
        addSecond(groups);
        const command = move(groups);
        const before = groups.exportState();
        const articleBefore = articles.exportState();
        if (command.kind !== 'move-tab') throw new Error('source command mismatch');
        for (const candidate of [
            { ...command, tab: { ...command.tab, editorSessionRef: 'session-foreign' } },
            { ...command, tab: { ...command.tab, documentEpoch: command.tab.documentEpoch + 1 } },
            { ...command, insertBeforeTabId: 'tab-missing' }, { ...command, targetGroupId: 'group-missing' }
        ]) expect(groups.execute(candidate).status).toBe('rejected-state');
        expect(groups.exportState()).toEqual(before);
        expect(articles.exportState()).toEqual(articleBefore);
    });

    it('merges all unique refs and active history into one group without replacing sessions', () => {
        const { articles, groups } = fixture();
        addSecond(groups);
        groups.execute(move(groups));
        let state = groups.exportState();
        groups.execute({ ...commandBase(state), kind: 'activate-tab-in-group', groupId: 'group-secondary', tab: state.groups[1].tabs[0] });
        state = groups.exportState();
        const before = articles.exportState();
        const result = groups.execute({ ...commandBase(state), kind: 'merge-groups', sourceGroupId: 'group-secondary', targetGroupId: 'group-primary',
            expectedSourceGroupRevision: state.groups[1].revision, expectedTargetGroupRevision: state.groups[0].revision });
        expect(result.status).toBe('applied');
        expect(result.after.layoutState).toBe('single-group');
        expect(result.after.groups[0].tabs.map(tab => tab.tabId).sort()).toEqual(['tab-1', 'tab-2']);
        expect(result.after.groups[0].activeTabId).toBe('tab-1');
        expect(result.after.activationHistory).toEqual([{ groupId: 'group-primary', tabId: 'tab-1', editorSessionRef: 'session-1' }]);
        expect(articles.listEntries().map(entry => entry.editorSessionRef)).toEqual(before.entries.map(entry => entry.editorSessionRef));
        expect(verifyAuthoringTabGroupRegistryState(result.after, articles.exportState())).toBe(true);
    });

    it('closes only an empty second group and never closes a nonempty or last group', () => {
        const { articles, groups } = fixture();
        addSecond(groups);
        let state = groups.exportState();
        const before = articles.exportState();
        expect(groups.execute({ ...commandBase(state), kind: 'close-empty-group', groupId: 'group-primary' }).status).toBe('rejected-state');
        expect(groups.execute({ ...commandBase(state), kind: 'close-empty-group', groupId: 'group-secondary' }).status).toBe('applied');
        state = groups.exportState();
        expect(groups.execute({ ...commandBase(state), kind: 'close-empty-group', groupId: 'group-primary' }).status).toBe('rejected-state');
        expect(articles.exportState().entries).toEqual(before.entries);
        expect(articles.getRevision()).toBe(before.revision + 1);
    });

    it('collapses only the effective projection and restores hidden refs and the same ratio', () => {
        const { articles, groups } = fixture();
        addSecond(groups);
        groups.execute(move(groups));
        const before = groups.exportState();
        const articleBefore = articles.exportState();
        const result = groups.execute({ ...commandBase(before), kind: 'set-effective-single', enabled: true, viewportStateRef: 'viewport-narrow' });
        expect(result.after.layoutState).toBe('horizontal-two-group');
        expect(result.after.effectiveLayoutState).toBe('single-group');
        expect(result.after.groups).toEqual(before.groups);
        expect(result.after.splitRatioRef).toBe(before.splitRatioRef);
        const restored = groups.execute({ ...commandBase(groups.exportState()), kind: 'set-effective-single', enabled: false, viewportStateRef: 'viewport-wide' });
        expect(restored.after.effectiveLayoutState).toBe('horizontal-two-group');
        expect(restored.after.groups).toEqual(before.groups);
        expect(articles.exportState().entries).toEqual(articleBefore.entries);
        expect(articles.getRevision()).toBe(articleBefore.revision + 2);
    });

    it('keeps an existing article in its owning group on an other-group open attempt', () => {
        const { articles, groups } = fixture();
        addSecond(groups);
        groups.execute(move(groups));
        const command = { ...open(1, articles.getRevision()), commandId: 'group-repeat-open', idempotencyKey: 'group-repeat-open', targetGroupId: 'group-primary' };
        expect(articles.execute(command).status).toBe('activated-existing');
        const state = groups.exportState();
        expect(state.groups[1].tabs.filter(tab => tab.tabId === 'tab-1')).toHaveLength(1);
        expect(state.groups[0].tabs.some(tab => tab.tabId === 'tab-1')).toBe(false);
        expect(state.activeGroupId).toBe('group-secondary');
    });

    it('refuses an externally mismatched ownership rather than silently moving its group refs', () => {
        const { articles, groups } = fixture();
        addSecond(groups);
        const before = groups.exportState();
        articles.execute({ schema: openArticleDocumentCommandSchema, kind: 'update-group-ownership', commandId: 'foreign-owner-command',
            idempotencyKey: 'foreign-owner-command', expectedRevision: articles.getRevision(), tabId: 'tab-1',
            targetGroupId: 'group-secondary', ownershipTransactionRef: 'foreign-owner-transaction' });
        expect(() => groups.exportState()).toThrow('ownership-recovery-required');
        expect(verifyAuthoringTabGroupRegistryState(before, articles.exportState())).toBe(false);
    });

    it('prepares the outward receipt before ownership mutation and leaves a failed key retryable', () => {
        const { articles, groups } = fixture();
        addSecond(groups);
        const command = move(groups);
        const before = groups.exportState();
        const articleBefore = articles.exportState();
        const original = globalThis.structuredClone;
        let failed = false;
        const spy = vi.spyOn(globalThis, 'structuredClone').mockImplementation(value => {
            const result = value as { schema?: string; status?: string; };
            if (!failed && result.schema === authoringTabGroupResultSchema && result.status === 'applied')
            {
                failed = true;
                throw new Error('injected group receipt preparation failure');
            }
            return original(value);
        });
        try { expect(groups.execute(command).status).toBe('rejected-state'); }
        finally { spy.mockRestore(); }
        expect(groups.exportState()).toEqual(before);
        expect(articles.exportState()).toEqual(articleBefore);
        expect(groups.execute(command).status).toBe('applied');
    });

    it('rejects canonical idempotency conflicts without publishing a half group commit', () => {
        const { articles, groups } = fixture();
        addSecond(groups);
        const command = { ...move(groups), idempotencyKey: 'group-open-1' };
        const before = groups.exportState();
        const articleBefore = articles.exportState();
        expect(groups.execute(command).status).toBe('rejected-state');
        expect(groups.exportState()).toEqual(before);
        expect(articles.exportState()).toEqual(articleBefore);
    });

    it('bounds focus history, stores only opaque ratio refs and rejects resealed session tamper', () => {
        const { articles, groups } = fixture();
        addSecond(groups);
        for (const groupId of ['group-secondary', 'group-primary', 'group-secondary'])
        {
            groups.execute({ ...commandBase(groups.exportState()), kind: 'focus-group', groupId });
        }
        const result = groups.execute({ ...commandBase(groups.exportState()), kind: 'set-split-ratio-ref', splitRatioRef: 'ratio-explicit-new' });
        expect(result.after.focusHistory).toEqual(['group-primary', 'group-secondary']);
        expect(result.after.splitRatioRef).toBe('ratio-explicit-new');
        const tampered = structuredClone(result.after);
        tampered.groups[0].tabs[0].editorSessionRef = 'session-foreign';
        const { contentDigest: _digest, ...body } = tampered;
        tampered.contentDigest = calculateOpenArticleDocumentDigest(body);
        expect(verifyAuthoringTabGroupRegistryState(tampered, articles.exportState())).toBe(false);
    });

    it('publishes two targets, ordered complete refs and activation in one canonical transaction', () => {
        const { articles, groups } = fixture();
        const before = groups.exportState();
        const articleBefore = articles.exportState();
        const command: AuthoringTabGroupCommand = { ...commandBase(before), kind: 'apply-group-references',
            groups: [
                { groupId: 'group-secondary', expectedRevision: null, tabs: [before.groups[0].tabs[0]], activeTabId: 'tab-1' },
                { groupId: 'group-primary', expectedRevision: before.groups[0].revision, tabs: [before.groups[0].tabs[1]], activeTabId: 'tab-2' }
            ], activeGroupId: 'group-secondary', splitRatioRef: 'ratio-layout-owner-value' };
        const port = vi.spyOn(articles, 'executeGroupOwnershipTransaction');
        try
        {
            const result = groups.execute(command);
            expect(result.status).toBe('applied');
            expect(port).toHaveBeenCalledTimes(1);
            const [request] = port.mock.calls[0];
            const receipt = port.mock.results[0].value;
            expect(verifyOpenArticleDocumentResult(receipt, request)).toBe(true);
            expect(verifyAuthoringTabGroupResult(result, articleBefore, articles.exportState(), command)).toBe(true);
            expect(result.after.groups.map(group => group.groupId)).toEqual(['group-secondary', 'group-primary']);
            expect(result.after.groups.map(group => group.tabs.map(tab => tab.tabId))).toEqual([['tab-1'], ['tab-2']]);
            expect(articles.listEntries().filter(entry => entry.isActive).map(entry => entry.tabId)).toEqual(['tab-1']);
            expect(articles.listEntries().map(entry => entry.editorSessionRef)).toEqual(articleBefore.entries.map(entry => entry.editorSessionRef));
            expect(articles.getRevision()).toBe(articleBefore.revision + 1);
            const published = articles.exportState();
            expect(groups.execute(command).status).toBe('replayed');
            expect(articles.exportState()).toEqual(published);
            expect(port).toHaveBeenCalledTimes(1);
            for (const field of ['groupStateAfterDigest', 'groupCommandDigest', 'groupRevisionAfter'])
            {
                const tampered = structuredClone(receipt) as Record<string, unknown>;
                tampered[field] = field === 'groupRevisionAfter' ? 999 : 'a'.repeat(64);
                const { contentDigest: _digest, ...body } = tampered;
                tampered.contentDigest = calculateOpenArticleDocumentDigest(body);
                expect(verifyOpenArticleDocumentResult(tampered as typeof receipt, request)).toBe(false);
            }
        }
        finally { port.mockRestore(); }
    });

    it('preserves explicit tab order when the complete reference transaction keeps one target', () => {
        const { articles, groups } = fixture();
        const before = groups.exportState();
        const result = groups.execute({ ...commandBase(before), kind: 'apply-group-references',
            groups: [{ groupId: 'group-primary', expectedRevision: before.groups[0].revision,
                tabs: [...before.groups[0].tabs].reverse(), activeTabId: 'tab-2' }],
            activeGroupId: 'group-primary', splitRatioRef: before.splitRatioRef });
        expect(result.status).toBe('applied');
        expect(groups.exportState().groups[0].tabs.map(tab => tab.tabId)).toEqual(['tab-2', 'tab-1']);
        expect(verifyAuthoringTabGroupRegistryState(result.after, articles.exportState())).toBe(true);
    });

    it.each(['omitted', 'duplicate', 'stale', 'unknown-active', 'wrong-group-revision', 'sparse', 'null-member'])(
        'rejects %s complete refs without changing either registry or consuming the key', scenario => {
            const { articles, groups } = fixture();
            const before = groups.exportState();
            const articleBefore = articles.exportState();
            const command: AuthoringTabGroupCommand = { ...commandBase(before), kind: 'apply-group-references',
                groups: [{ groupId: 'group-primary', expectedRevision: before.groups[0].revision,
                    tabs: structuredClone(before.groups[0].tabs), activeTabId: 'tab-2' }],
                activeGroupId: 'group-primary', splitRatioRef: before.splitRatioRef };
            const candidate = structuredClone(command);
            const proposal = candidate.groups[0];
            if (scenario === 'omitted') proposal.tabs.pop();
            if (scenario === 'duplicate') proposal.tabs[1] = proposal.tabs[0];
            if (scenario === 'stale') proposal.tabs[0].documentEpoch += 1;
            if (scenario === 'unknown-active') proposal.activeTabId = 'tab-missing';
            if (scenario === 'wrong-group-revision') proposal.expectedRevision = 99;
            if (scenario === 'sparse') delete proposal.tabs[0];
            if (scenario === 'null-member') (proposal.tabs as unknown[])[0] = null;
            expect(groups.execute(candidate).status).not.toBe('applied');
            expect(groups.exportState()).toEqual(before);
            expect(articles.exportState()).toEqual(articleBefore);
            expect(groups.execute(command).status).toBe('applied');
        }
    );

    it('rejects a nonwritable registered publication cell before any canonical mutation', () => {
        const articles = new OpenArticleDocumentRegistry();
        articles.execute(open(1, 0));
        const registration = vi.spyOn(articles, 'createGroupOwnershipCell');
        let groups: AuthoringTabGroupRegistry;
        try
        {
            groups = new AuthoringTabGroupRegistry(articles, { initialGroupId: 'group-primary', splitRatioRef: 'ratio-explicit-input', historyCapacity: 4 });
            Object.freeze(registration.mock.results[0].value);
        }
        finally { registration.mockRestore(); }
        const before = groups.exportState();
        const articleBefore = articles.exportState();
        expect(addSecond(groups).status).toBe('rejected-state');
        expect(groups.exportState()).toEqual(before);
        expect(articles.exportState()).toEqual(articleBefore);
    });
});
