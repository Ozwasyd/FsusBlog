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

import { authoringWorkspaceRatioOwner } from '@/services/authoring/authoringWorkspaceRatioOwner';

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

function ratioOptions()
{
    const ratioScope = authoringWorkspaceRatioOwner.openWorkspace();
    return { initialGroupId: 'group-primary', ratioScope,
        splitRatioRef: authoringWorkspaceRatioOwner.read(ratioScope).ratioRef, historyCapacity: 4 };
}

function executeWithRatio(groups: AuthoringTabGroupRegistry, command: AuthoringTabGroupCommand)
{
    const projection = groups.exportProjection();
    if (command.kind !== 'apply-group-references' && command.kind !== 'set-split-ratio-ref') throw new Error('ratio command required');
    const change = authoringWorkspaceRatioOwner.prepare(projection.ratioScope, projection.splitRatioRef, command.splitRatioPermille);
    const result = groups.execute(command, change);
    if (result.status !== 'applied') authoringWorkspaceRatioOwner.discard(projection.ratioScope, change);
    return result;
}

function fixture()
{
    const articles = new OpenArticleDocumentRegistry();
    articles.execute(open(1, 0));
    articles.execute(open(2, 1));
    const groups = new AuthoringTabGroupRegistry(articles, ratioOptions());
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
    it('binds only its actual canonical Registry instance despite identical exported state', () => {
        const owned = fixture();
        const foreign = fixture();
        expect(owned.articles.exportState()).toEqual(foreign.articles.exportState());
        expect(owned.groups.verifyBinding(owned.articles)).toBe(true);
        expect(owned.groups.verifyBinding(foreign.articles)).toBe(false);
        expect(foreign.groups.verifyBinding(owned.articles)).toBe(false);
        expect(owned.groups.verifyBinding(new Proxy(owned.articles, {}))).toBe(false);
    });

    it('refuses a foreign empty Registry binding even when both owners genuinely commit exact +1', () => {
        const firstRegistry = new OpenArticleDocumentRegistry();
        const secondRegistry = new OpenArticleDocumentRegistry();
        const firstOwner = new AuthoringTabGroupRegistry(firstRegistry, ratioOptions());
        const secondOwner = new AuthoringTabGroupRegistry(secondRegistry, ratioOptions());
        const proposal = (groups: AuthoringTabGroupRegistry, splitRatioPermille: number): AuthoringTabGroupCommand => {
            const state = groups.exportState();
            return { ...commandBase(state), kind: 'apply-group-references',
                groups: [{ groupId: 'group-primary', expectedRevision: state.groups[0].revision, tabs: [], activeTabId: null }],
                activeGroupId: 'group-primary', expectedRatioRevision: state.splitRatio.revision, splitRatioPermille };
        };
        const firstCommand = proposal(firstOwner, 600);
        const secondCommand = proposal(secondOwner, 700);
        const firstReceipt = executeWithRatio(firstOwner, firstCommand);
        const secondReceipt = executeWithRatio(secondOwner, secondCommand);
        expect(firstReceipt.status).toBe('applied');
        expect(secondReceipt.status).toBe('applied');
        expect(firstRegistry.getRevision()).toBe(1);
        expect(secondRegistry.getRevision()).toBe(1);
        expect(firstOwner.exportState().splitRatio.splitRatioPermille).toBe(600);
        expect(secondOwner.exportState().splitRatio.splitRatioPermille).toBe(700);
        expect(secondOwner.verifyCommittedTransition({ schema: 'fsusblog.authoring-snapshot-group-transition.v1',
            command: secondCommand, receipt: secondReceipt })).toBe(true);
        expect(secondOwner.verifyBinding(secondRegistry)).toBe(true);
        expect(secondOwner.verifyBinding(firstRegistry)).toBe(false);
        expect(firstOwner.verifyBinding(secondRegistry)).toBe(false);
    });

    it.each(['create-second-group', 'focus-group', 'move-tab', 'activate-tab-in-group', 'merge-groups',
        'close-empty-group', 'set-effective-single', 'set-split-ratio-ref', 'apply-group-references'] as const)(
        'rejects a resealed but semantically different %s receipt', kind => {
            const { articles, groups } = fixture();
            if (['focus-group', 'move-tab', 'merge-groups', 'close-empty-group', 'set-effective-single'].includes(kind))
                expect(addSecond(groups).status).toBe('applied');
            const state = groups.exportState();
            const base = commandBase(state);
            let command: AuthoringTabGroupCommand;
            switch (kind)
            {
                case 'create-second-group': command = { ...base, kind, groupId: 'group-secondary' }; break;
                case 'focus-group': command = { ...base, kind, groupId: 'group-secondary' }; break;
                case 'move-tab': command = move(groups); break;
                case 'activate-tab-in-group': command = { ...base, kind, groupId: 'group-primary', tab: state.groups[0].tabs[0] }; break;
                case 'merge-groups': command = { ...base, kind, sourceGroupId: 'group-secondary', targetGroupId: 'group-primary',
                    expectedSourceGroupRevision: state.groups[1].revision, expectedTargetGroupRevision: state.groups[0].revision }; break;
                case 'close-empty-group': command = { ...base, kind, groupId: 'group-secondary' }; break;
                case 'set-effective-single': command = { ...base, kind, enabled: true, viewportStateRef: 'viewport-original' }; break;
                case 'set-split-ratio-ref': command = { ...base, kind, expectedRatioRevision: state.splitRatio.revision, splitRatioPermille: 600 }; break;
                case 'apply-group-references': command = { ...base, kind,
                    groups: [{ groupId: 'group-primary', expectedRevision: state.groups[0].revision,
                        tabs: state.groups[0].tabs, activeTabId: 'tab-2' }], activeGroupId: 'group-primary',
                    expectedRatioRevision: state.splitRatio.revision, splitRatioPermille: 600 }; break;
            }
            const before = articles.exportState();
            const receipt = command.kind === 'set-split-ratio-ref' || command.kind === 'apply-group-references'
                ? executeWithRatio(groups, command) : groups.execute(command);
            const after = articles.exportState();
            expect(receipt.status).toBe('applied');
            expect(verifyAuthoringTabGroupResult(receipt, before, after, command)).toBe(true);
            const tampered = structuredClone(receipt);
            switch (kind)
            {
                case 'create-second-group': tampered.after.groups[1].groupId = 'group-unrequested'; break;
                case 'focus-group': tampered.after.focusedGroupId = 'group-primary'; tampered.after.effectiveFocusedGroupId = 'group-primary'; break;
                case 'move-tab':
                case 'merge-groups':
                case 'close-empty-group': tampered.after.groups[0].revision += 1; break;
                case 'activate-tab-in-group': tampered.after.activationHistory = []; break;
                case 'set-effective-single': tampered.after.collapsedByViewportRef = 'viewport-unrequested'; break;
                case 'set-split-ratio-ref': tampered.after.splitRatio.splitRatioPermille = 601; break;
                case 'apply-group-references': tampered.after.groups[0].tabs.reverse(); break;
            }
            const { contentDigest: _stateDigest, ...stateBody } = tampered.after;
            tampered.after.contentDigest = calculateOpenArticleDocumentDigest(stateBody);
            const { contentDigest: _resultDigest, ...resultBody } = tampered;
            tampered.contentDigest = calculateOpenArticleDocumentDigest(resultBody);
            expect(verifyAuthoringTabGroupRegistryState(tampered.after, after)).toBe(true);
            expect(verifyAuthoringTabGroupResult(tampered, before, after, command)).toBe(false);
            const metadataTampered = structuredClone(receipt);
            metadataTampered.after.historyCapacity += 1;
            const { contentDigest: _metadataStateDigest, ...metadataStateBody } = metadataTampered.after;
            metadataTampered.after.contentDigest = calculateOpenArticleDocumentDigest(metadataStateBody);
            const { contentDigest: _metadataResultDigest, ...metadataResultBody } = metadataTampered;
            metadataTampered.contentDigest = calculateOpenArticleDocumentDigest(metadataResultBody);
            expect(verifyAuthoringTabGroupRegistryState(metadataTampered.after, after)).toBe(true);
            expect(verifyAuthoringTabGroupResult(metadataTampered, before, after, command)).toBe(false);
        }
    );

    it.each(['allowed', 'denied'] as const)(
        'preserves no canonical active tab during collapse after legal close with %s survivor', permission => {
            const { articles, groups } = fixture();
            expect(addSecond(groups).status).toBe('applied');
            const articleBase = (id: string) => ({ schema: openArticleDocumentCommandSchema,
                commandId: id, idempotencyKey: id, expectedRevision: articles.getRevision() });
            expect(articles.execute({ ...articleBase('collapse-close-request'), kind: 'request-close', tabId: 'tab-2' }).status).toBe('applied');
            expect(articles.execute({ ...articleBase('collapse-final-close'), kind: 'detach-on-final-close',
                tabId: 'tab-2', closeDecisionRef: 'collapse-close-decision' }).status).toBe('applied');
            if (permission === 'denied') expect(articles.execute({ ...articleBase('collapse-deny-survivor'),
                kind: 'invalidate-permission', tabId: 'tab-1', permission, statusRef: 'collapse-denied-status' }).status).toBe('applied');
            const survivor = articles.getEntry('tab-1');
            for (const enabled of [true, false, true])
            {
                const before = articles.exportState();
                const command: AuthoringTabGroupCommand = { ...commandBase(groups.exportState()), kind: 'set-effective-single',
                    enabled, viewportStateRef: 'viewport-closed-tab' };
                const result = groups.execute(command);
                expect(result.status).toBe('applied');
                expect(articles.getEntry('tab-1')).toEqual(survivor);
                expect(articles.listEntries().some(entry => entry.isActive)).toBe(false);
                expect(verifyAuthoringTabGroupResult(result, before, articles.exportState(), command)).toBe(true);
                const published = articles.exportState();
                expect(groups.execute(command).status).toBe('replayed');
                expect(articles.exportState()).toEqual(published);
            }
        }
    );

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
        expect(replayAuthoringTabGroupCommands(articles, ratioOptions(),
            [create, command, command], [first, second, replay]).accepted).toBe(true);
    });
    it('has one owner per canonical registry and refuses third groups and recursive command shapes', () => {
        const { articles, groups } = fixture();
        expect(() => new AuthoringTabGroupRegistry(articles, ratioOptions())).toThrow('owner-already-exists');
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
        const ratioBefore = groups.exportProjection();
        const articleBefore = articles.exportState();
        const result = groups.execute({ ...commandBase(before), kind: 'set-effective-single', enabled: true, viewportStateRef: 'viewport-narrow' });
        expect(result.after.layoutState).toBe('horizontal-two-group');
        expect(result.after.effectiveLayoutState).toBe('single-group');
        expect(result.after.groups).toEqual(before.groups);
        expect(result.after.splitRatio).toEqual(before.splitRatio);
        const restored = groups.execute({ ...commandBase(groups.exportState()), kind: 'set-effective-single', enabled: false, viewportStateRef: 'viewport-wide' });
        expect(restored.after.effectiveLayoutState).toBe('horizontal-two-group');
        expect(restored.after.groups).toEqual(before.groups);
        expect(groups.exportProjection().splitRatioRef).toBe(ratioBefore.splitRatioRef);
        expect(groups.exportProjection().ratioScope).toBe(ratioBefore.ratioScope);
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

    it('bounds focus history, uses the actual ratio owner and rejects resealed session tamper', () => {
        const { articles, groups } = fixture();
        addSecond(groups);
        for (const groupId of ['group-secondary', 'group-primary', 'group-secondary'])
        {
            groups.execute({ ...commandBase(groups.exportState()), kind: 'focus-group', groupId });
        }
        const state = groups.exportState();
        const result = executeWithRatio(groups, { ...commandBase(state), kind: 'set-split-ratio-ref', expectedRatioRevision: state.splitRatio.revision, splitRatioPermille: 600 });
        expect(result.after.focusHistory).toEqual(['group-primary', 'group-secondary']);
        expect(result.after.splitRatio.splitRatioPermille).toBe(600);
        const projection = groups.exportProjection();
        expect(authoringWorkspaceRatioOwner.resolve(projection.ratioScope, projection.splitRatioRef).splitRatioPermille).toBe(600);
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
            ], activeGroupId: 'group-secondary', expectedRatioRevision: before.splitRatio.revision, splitRatioPermille: 600 };
        const port = vi.spyOn(articles, 'executeGroupOwnershipTransaction');
        try
        {
            const result = executeWithRatio(groups, command);
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
        const result = executeWithRatio(groups, { ...commandBase(before), kind: 'apply-group-references',
            groups: [{ groupId: 'group-primary', expectedRevision: before.groups[0].revision,
                tabs: [...before.groups[0].tabs].reverse(), activeTabId: 'tab-2' }],
            activeGroupId: 'group-primary', expectedRatioRevision: before.splitRatio.revision, splitRatioPermille: before.splitRatio.splitRatioPermille });
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
                activeGroupId: 'group-primary', expectedRatioRevision: before.splitRatio.revision, splitRatioPermille: before.splitRatio.splitRatioPermille };
            const candidate = structuredClone(command);
            const proposal = candidate.groups[0];
            if (scenario === 'omitted') proposal.tabs.pop();
            if (scenario === 'duplicate') proposal.tabs[1] = proposal.tabs[0];
            if (scenario === 'stale') proposal.tabs[0].documentEpoch += 1;
            if (scenario === 'unknown-active') proposal.activeTabId = 'tab-missing';
            if (scenario === 'wrong-group-revision') proposal.expectedRevision = 99;
            if (scenario === 'sparse') delete proposal.tabs[0];
            if (scenario === 'null-member') (proposal.tabs as unknown[])[0] = null;
            expect(executeWithRatio(groups, candidate).status).not.toBe('applied');
            expect(groups.exportState()).toEqual(before);
            expect(articles.exportState()).toEqual(articleBefore);
            expect(executeWithRatio(groups, command).status).toBe('applied');
        }
    );

    it('rejects a nonwritable registered publication cell before any canonical mutation', () => {
        const articles = new OpenArticleDocumentRegistry();
        articles.execute(open(1, 0));
        const registration = vi.spyOn(articles, 'createGroupOwnershipCell');
        let groups: AuthoringTabGroupRegistry;
        try
        {
            groups = new AuthoringTabGroupRegistry(articles, ratioOptions());
            Object.freeze(registration.mock.results[0].value);
        }
        finally { registration.mockRestore(); }
        const before = groups.exportState();
        const articleBefore = articles.exportState();
        expect(addSecond(groups).status).toBe('rejected-state');
        const ratioBefore = groups.exportProjection();
        expect(executeWithRatio(groups, { ...commandBase(before), kind: 'set-split-ratio-ref',
            expectedRatioRevision: before.splitRatio.revision, splitRatioPermille: 600 }).status).toBe('rejected-state');
        expect(authoringWorkspaceRatioOwner.read(ratioBefore.ratioScope).ratioRef).toBe(ratioBefore.splitRatioRef);
        expect(groups.exportState()).toEqual(before);
        expect(articles.exportState()).toEqual(articleBefore);
    });

    it('requires a real prepared ratio capability and rejects numeric disagreement with zero publication', () => {
        const { articles, groups } = fixture();
        const projection = groups.exportProjection();
        const before = projection.state;
        const articleBefore = articles.exportState();
        const command: AuthoringTabGroupCommand = { ...commandBase(before), kind: 'set-split-ratio-ref',
            expectedRatioRevision: before.splitRatio.revision, splitRatioPermille: 600 };
        expect(groups.execute(command).status).toBe('rejected-state');
        const change = authoringWorkspaceRatioOwner.prepare(projection.ratioScope, projection.splitRatioRef, 650);
        try
        {
            expect(groups.execute(command, change).status).toBe('rejected-cas');
            expect(groups.exportState()).toEqual(before);
            expect(articles.exportState()).toEqual(articleBefore);
            expect(authoringWorkspaceRatioOwner.read(projection.ratioScope).ratioRef).toBe(projection.splitRatioRef);
        }
        finally { authoringWorkspaceRatioOwner.discard(projection.ratioScope, change); }
        expect(executeWithRatio(groups, command).status).toBe('applied');
    });

    it('rejects a foreign prepared ratio without changing either group or the current ratio', () => {
        const { articles, groups } = fixture();
        const before = groups.exportState();
        const articleBefore = articles.exportState();
        const foreign = ratioOptions();
        const change = authoringWorkspaceRatioOwner.prepare(foreign.ratioScope, foreign.splitRatioRef, 600);
        try
        {
            expect(groups.execute({ ...commandBase(before), kind: 'set-split-ratio-ref',
                expectedRatioRevision: before.splitRatio.revision, splitRatioPermille: 600 }, change).status).toBe('rejected-state');
            expect(groups.exportState()).toEqual(before);
            expect(articles.exportState()).toEqual(articleBefore);
            expect(authoringWorkspaceRatioOwner.read(foreign.ratioScope).ratioRef).toBe(foreign.splitRatioRef);
        }
        finally
        {
            authoringWorkspaceRatioOwner.discard(foreign.ratioScope, change);
            authoringWorkspaceRatioOwner.releaseWorkspace(foreign.ratioScope);
        }
    });

    it('prepares the canonical receipt before committing the actual ratio', () => {
        const { articles, groups } = fixture();
        const projection = groups.exportProjection();
        const before = projection.state;
        const articleBefore = articles.exportState();
        const command: AuthoringTabGroupCommand = { ...commandBase(before), kind: 'set-split-ratio-ref',
            expectedRatioRevision: before.splitRatio.revision, splitRatioPermille: 600 };
        const change = authoringWorkspaceRatioOwner.prepare(projection.ratioScope, projection.splitRatioRef, 600);
        const clone = globalThis.structuredClone;
        let failed = false;
        const spy = vi.spyOn(globalThis, 'structuredClone').mockImplementation(value => {
            const result = value as { schema?: string; status?: string; };
            if (!failed && result.schema === 'fsusblog.open-article-document-result.v1' && result.status === 'applied')
            {
                failed = true;
                throw new Error('injected canonical receipt clone failure');
            }
            return clone(value);
        });
        try { expect(groups.execute(command, change).status).toBe('rejected-state'); }
        finally { spy.mockRestore(); }
        expect(groups.exportState()).toEqual(before);
        expect(articles.exportState()).toEqual(articleBefore);
        expect(authoringWorkspaceRatioOwner.read(projection.ratioScope).ratioRef).toBe(projection.splitRatioRef);
        expect(groups.execute(command, change).status).toBe('applied');
        expect(groups.exportProjection().splitRatioRef).toBe(change.ratioRef);
        expect(() => authoringWorkspaceRatioOwner.resolve(projection.ratioScope, projection.splitRatioRef)).toThrow('stale-ratio');
    });

    it('keeps capabilities outside receipts and refuses projection after real workspace disposal', () => {
        const { articles, groups } = fixture();
        const projection = groups.exportProjection();
        expect(Object.keys(projection.state.splitRatio).sort()).toEqual(['policySchema', 'revision', 'splitRatioPermille']);
        expect(verifyAuthoringTabGroupRegistryState(structuredClone(projection.state), articles.exportState())).toBe(true);
        authoringWorkspaceRatioOwner.releaseWorkspace(projection.ratioScope);
        expect(() => groups.exportProjection()).toThrow('invalid-scope');
    });

    it('bootstraps only explicitly declared groups around existing canonical restore refs', () => {
        const articles = new OpenArticleDocumentRegistry();
        articles.execute(open(1, 0));
        articles.execute({ ...open(2, 1), targetGroupId: 'group-secondary' });
        const before = articles.exportState();
        const groups = new AuthoringTabGroupRegistry(articles, { ...ratioOptions(), initialGroupIds: ['group-primary', 'group-secondary'] });
        expect(groups.exportState().groups.map(group => group.tabs.map(tab => tab.tabId))).toEqual([['tab-1'], ['tab-2']]);
        expect(groups.exportState().activeGroupId).toBe('group-secondary');
        expect(articles.exportState()).toEqual(before);
        expect(verifyAuthoringTabGroupRegistryState(groups.exportState(), before)).toBe(true);
    });

    it.each(['unknown-existing', 'third', 'duplicate', 'sparse'])(
        'refuses %s bootstrap groups without inferring hidden ownership', scenario => {
            const articles = new OpenArticleDocumentRegistry();
            articles.execute({ ...open(1, 0), targetGroupId: 'group-secondary' });
            const options = { ...ratioOptions(), initialGroupIds: ['group-primary'] };
            if (scenario === 'third') options.initialGroupIds = ['group-primary', 'group-secondary', 'group-third'];
            if (scenario === 'duplicate') options.initialGroupIds = ['group-primary', 'group-primary'];
            if (scenario === 'sparse') options.initialGroupIds = new Array<string>(2);
            const before = articles.exportState();
            expect(() => new AuthoringTabGroupRegistry(articles, options)).toThrow();
            expect(articles.exportState()).toEqual(before);
        }
    );

    it('adapts the original snapshot group callback through one real joint transaction', async () => {
        const { articles, groups } = fixture();
        addSecond(groups);
        const before = articles.exportState();
        const port = vi.spyOn(articles, 'executeGroupOwnershipTransaction');
        const adapter = groups.createSnapshotAdapter(() => ({ commandId: 'snapshot-group-operation', idempotencyKey: 'snapshot-group-operation' }));
        try
        {
            const transition = await adapter.applyGroupsWithReceipt([
                { groupId: 'group-secondary', tabIds: ['tab-1'], activeTabId: 'tab-1' },
                { groupId: 'group-primary', tabIds: ['tab-2'], activeTabId: 'tab-2' }
            ], 'group-secondary', 600, new AbortController().signal);
            expect(transition.receipt.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
            expect(groups.verifyCommittedTransition(transition)).toBe(true);
            expect(verifyAuthoringTabGroupResult(transition.receipt, before, articles.exportState(), transition.command)).toBe(true);
            expect(transition.receipt.articleRevisionBefore).toBe(before.revision);
            expect(transition.receipt.articleRevisionAfter).toBe(before.revision + 1);
            const tampered = structuredClone(transition);
            tampered.receipt.articleRevisionAfter += 1;
            const { contentDigest: _digest, ...body } = tampered.receipt;
            tampered.receipt.contentDigest = calculateOpenArticleDocumentDigest(body);
            expect(groups.verifyCommittedTransition(tampered)).toBe(false);
            expect(port).toHaveBeenCalledTimes(1);
            expect(articles.getRevision()).toBe(before.revision + 1);
            const projection = groups.exportProjection();
            expect(projection.state.groups.map(group => group.groupId)).toEqual(['group-secondary', 'group-primary']);
            expect(authoringWorkspaceRatioOwner.resolve(projection.ratioScope, projection.splitRatioRef).splitRatioPermille).toBe(600);
            expect(articles.listEntries().map(entry => entry.editorSessionRef)).toEqual(before.entries.map(entry => entry.editorSessionRef));
        }
        finally { port.mockRestore(); }
    });

    it('refuses an aborted snapshot callback before staging or generating an operation', async () => {
        const { articles, groups } = fixture();
        const before = groups.exportProjection();
        const articleBefore = articles.exportState();
        const identity = vi.fn(() => ({ commandId: 'snapshot-group-operation', idempotencyKey: 'snapshot-group-operation' }));
        const adapter = groups.createSnapshotAdapter(identity);
        const abort = new AbortController();
        abort.abort(new Error('snapshot-cancelled'));
        await expect(adapter.applyGroups([{ groupId: 'group-primary', tabIds: ['tab-1', 'tab-2'], activeTabId: 'tab-2' }],
            'group-primary', 600, abort.signal)).rejects.toThrow('snapshot-cancelled');
        expect(identity).not.toHaveBeenCalled();
        expect(groups.exportState()).toEqual(before.state);
        expect(articles.exportState()).toEqual(articleBefore);
        expect(authoringWorkspaceRatioOwner.read(before.ratioScope).ratioRef).toBe(before.splitRatioRef);
    });

    it.each(['missing', 'incomplete'])(
        'refuses %s snapshot runtime refs without committing the staged ratio', async scenario => {
            const { articles, groups } = fixture();
            const before = groups.exportProjection();
            const articleBefore = articles.exportState();
            const adapter = groups.createSnapshotAdapter(() => ({ commandId: 'snapshot-group-operation', idempotencyKey: 'snapshot-group-operation' }));
            await expect(adapter.applyGroups([{ groupId: 'group-primary',
                tabIds: scenario === 'missing' ? ['tab-missing'] : ['tab-1'],
                activeTabId: scenario === 'missing' ? 'tab-missing' : 'tab-1' }],
            'group-primary', 600, new AbortController().signal)).rejects.toThrow();
            expect(groups.exportState()).toEqual(before.state);
            expect(articles.exportState()).toEqual(articleBefore);
            expect(authoringWorkspaceRatioOwner.read(before.ratioScope).ratioRef).toBe(before.splitRatioRef);
        }
    );

    it('exports state copies and hides internal mutable group publication behind runtime private fields', () => {
        const { articles, groups } = fixture();
        const before = groups.exportState();
        const projection = groups.exportProjection();
        projection.state.groups[0].tabs.pop();
        projection.state.splitRatio.splitRatioPermille = 800;
        expect(groups.exportState()).toEqual(before);
        for (const name of ['state', 'processed', 'publicationCell', 'ratioScope', 'projectState', 'result'])
            expect(Reflect.get(groups, name)).toBeUndefined();
        expect(Reflect.get(articles, 'groupOwnershipCell')).toBeUndefined();
    });
});
