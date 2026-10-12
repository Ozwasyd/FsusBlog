import { describe, expect, it } from 'vitest';

import {
    OpenArticleDocumentRegistry,
    sealRetainedArticleDocumentMembership,
    hasSealedRetainedArticleDocumentMembershipCustody,
    cancelRetainedArticleDocumentMembershipSeal,
    inspectRetainedArticleDocumentHandle,
    openArticleDocumentCommandSchema,
    retainedArticleDocumentHandleBelongsTo,
    revokeRetainedArticleDocumentScope,
    subscribeRetainedArticleDocumentHandle,
    type OpenOrActivateArticleCommand,
    type RetainedArticleDocumentHandle
} from '@/services/authoring/openArticleDocumentRegistry';

const open = (registry: OpenArticleDocumentRegistry, articleId = 1): OpenOrActivateArticleCommand => ({
    schema: openArticleDocumentCommandSchema,
    kind: 'open-or-activate',
    commandId: `open:${registry.getRevision()}:${articleId}`,
    idempotencyKey: `open:${registry.getRevision()}:${articleId}`,
    expectedRevision: registry.getRevision(),
    intent: 'workspace',
    entrypoint: 'direct-route',
    identity: { articleId, draftId: `article:${articleId}`, documentId: `document:${articleId}` },
    documentContext: { documentEpoch: 1, sourceRevision: 'source-revision:0', draftRevision: null },
    editorSessionRef: `session:${articleId}`,
    tabId: `tab:${articleId}`,
    targetGroupId: 'group:primary',
    tabKind: 'pinned',
    status: { dirty: false, saving: false, conflict: false, recovery: false, pendingAttachments: false,
        permission: 'allowed', lifecycle: 'current', statusRef: 'status:clean' },
    lastActiveAnchorRef: null
});

describe('original Registry retained document handle source controls', () =>
{
    it('issues exact-one original opaque handle and rejects copied and forged handle objects', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(open(registry));
        const handle = registry.issueRetainedDocumentHandle('tab:1');
        expect(registry.issueRetainedDocumentHandle('tab:1')).toBe(handle);
        expect(inspectRetainedArticleDocumentHandle(handle).state).toBe('live');
        expect(() => inspectRetainedArticleDocumentHandle({ ...handle })).toThrow('handle-invalid');
        expect(() => inspectRetainedArticleDocumentHandle(registry.getEntry('tab:1') as unknown as RetainedArticleDocumentHandle))
            .toThrow('handle-invalid');
        expect(retainedArticleDocumentHandleBelongsTo(handle, new OpenArticleDocumentRegistry())).toBe(false);
    });

    it('retains original lifetime across activate, pin and group ownership commands', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(open(registry));
        const handle = registry.issueRetainedDocumentHandle('tab:1');
        for (const mutation of [
            { kind: 'activate', tabId: 'tab:1', lastActiveAnchorRef: null },
            { kind: 'set-pin-state', tabId: 'tab:1', pinned: true },
            { kind: 'update-group-ownership', tabId: 'tab:1', targetGroupId: 'group:secondary', ownershipTransactionRef: 'ownership:test' }
        ])
        {
            const revision = registry.getRevision();
            const result = registry.execute({ schema: openArticleDocumentCommandSchema,
                commandId: `mutation:${revision}`, idempotencyKey: `mutation:${revision}`, expectedRevision: revision, ...mutation });
            expect(result.status).toBe('applied');
            expect(registry.issueRetainedDocumentHandle('tab:1')).toBe(handle);
            expect(inspectRetainedArticleDocumentHandle(handle).state).toBe('live');
        }
        expect(inspectRetainedArticleDocumentHandle(handle).entry?.owningGroupId).toBe('group:secondary');
    });

    it('does not resurrect a detached handle when every public identity is reused', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(open(registry));
        const handle = registry.issueRetainedDocumentHandle('tab:1');
        for (const mutation of [
            { kind: 'request-close', tabId: 'tab:1' },
            { kind: 'detach-on-final-close', tabId: 'tab:1', closeDecisionRef: 'close:formal' }
        ])
        {
            const revision = registry.getRevision();
            registry.execute({ schema: openArticleDocumentCommandSchema, commandId: `close:${revision}`,
                idempotencyKey: `close:${revision}`, expectedRevision: revision, ...mutation });
        }
        registry.execute(open(registry));
        expect(inspectRetainedArticleDocumentHandle(handle).state).toBe('revoked');
        expect(inspectRetainedArticleDocumentHandle(handle).reason).toBe('final-close');
        expect(registry.issueRetainedDocumentHandle('tab:1')).not.toBe(handle);
    });

    it('revokes preview replacement while preserving the new canonical session', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute({ ...open(registry), tabKind: 'preview' });
        const first = registry.issueRetainedDocumentHandle('tab:1');
        registry.execute({ ...open(registry, 2), tabKind: 'preview' });
        expect(inspectRetainedArticleDocumentHandle(first).reason).toBe('final-close');
        expect(inspectRetainedArticleDocumentHandle(registry.issueRetainedDocumentHandle('tab:2')).state).toBe('live');
    });

    it('blocks revoked permission and deleted lifecycle without discarding risk facts', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        const command = open(registry);
        registry.execute({ ...command, status: { ...command.status, dirty: true, recovery: true } });
        const handle = registry.issueRetainedDocumentHandle('tab:1');
        const revision = registry.getRevision();
        registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'invalidate-permission',
            commandId: 'permission:revoke', idempotencyKey: 'permission:revoke', expectedRevision: revision,
            tabId: 'tab:1', permission: 'revoked', statusRef: 'status:revoked' });
        const blocked = inspectRetainedArticleDocumentHandle(handle);
        expect(blocked.state).toBe('blocked');
        expect(blocked.entry?.status.dirty).toBe(true);
        expect(blocked.entry?.status.recovery).toBe(true);
        expect(registry.issueRetainedDocumentHandle('tab:1')).toBe(handle);
        registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'invalidate-lifecycle',
            commandId: 'lifecycle:delete', idempotencyKey: 'lifecycle:delete', expectedRevision: registry.getRevision(),
            tabId: 'tab:1', lifecycle: 'deleted', statusRef: 'status:deleted' });
        expect(inspectRetainedArticleDocumentHandle(handle).entry?.status.lifecycle).toBe('deleted');
    });

    it('revokes changed draft identity and refuses scope-retired reissuance', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(open(registry));
        const handle = registry.issueRetainedDocumentHandle('tab:1');
        registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'replace-draft-identity',
            commandId: 'draft:replace', idempotencyKey: 'draft:replace', expectedRevision: registry.getRevision(),
            tabId: 'tab:1', draftId: 'draft:replacement', draftRevision: 'revision:replacement', replacementRef: 'replace:test' });
        expect(inspectRetainedArticleDocumentHandle(handle).reason).toBe('identity-replaced');
        const replacement = registry.issueRetainedDocumentHandle('tab:1');
        revokeRetainedArticleDocumentScope(replacement);
        expect(inspectRetainedArticleDocumentHandle(replacement).reason).toBe('scope-revoked');
        expect(inspectRetainedArticleDocumentHandle(replacement).entry).not.toBeNull();
        expect(() => registry.issueRetainedDocumentHandle('tab:1')).toThrow('scope-revoked');
    });

    it('preserves committed command/history and records failed or reentrant notification', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(open(registry));
        const handle = registry.issueRetainedDocumentHandle('tab:1');
        let nestedStatus: string | null = null;
        subscribeRetainedArticleDocumentHandle(handle, () =>
        {
            nestedStatus = registry.execute(open(registry, 3)).status;
            throw new Error('actual-consumer-cleanup-failure');
        });
        const second = open(registry, 2);
        expect(registry.execute(second).status).toBe('applied');
        expect(nestedStatus).toBe('rejected-state');
        expect(registry.execute(second).status).toBe('replayed');
        expect(registry.listEntries()).toHaveLength(2);
        expect(inspectRetainedArticleDocumentHandle(handle).notificationFailed).toBe(true);
    });

    it('keeps actual runtime custody hidden when shadow properties are injected', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(open(registry));
        const handle = registry.issueRetainedDocumentHandle('tab:1');
        expect(Object.getOwnPropertyNames(registry)).not.toContain('retainedDocumentCells');
        Object.defineProperty(registry, 'retainedDocumentCells', { value: new Set([{ handle, reason: null, registry: new OpenArticleDocumentRegistry() }]) });
        revokeRetainedArticleDocumentScope(handle);
        expect(inspectRetainedArticleDocumentHandle(handle).reason).toBe('scope-revoked');
        expect(retainedArticleDocumentHandleBelongsTo(handle, registry)).toBe(true);
        expect(retainedArticleDocumentHandleBelongsTo(handle, new OpenArticleDocumentRegistry())).toBe(false);
    });

    it('permits a new incarnation after scope retirement and formal detach with equal public IDs', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(open(registry));
        const original = registry.issueRetainedDocumentHandle('tab:1');
        revokeRetainedArticleDocumentScope(original);
        for (const mutation of [
            { kind: 'request-close', tabId: 'tab:1' },
            { kind: 'detach-on-final-close', tabId: 'tab:1', closeDecisionRef: 'close:formal' }
        ])
        {
            const revision = registry.getRevision();
            registry.execute({ schema: openArticleDocumentCommandSchema, commandId: `close:${revision}`,
                idempotencyKey: `close:${revision}`, expectedRevision: revision, ...mutation });
        }
        registry.execute(open(registry));
        const current = registry.issueRetainedDocumentHandle('tab:1');
        expect(current).not.toBe(original);
        expect(inspectRetainedArticleDocumentHandle(current).state).toBe('live');
        expect(inspectRetainedArticleDocumentHandle(original).state).toBe('revoked');
        expect(inspectRetainedArticleDocumentHandle(original).entry).toBeNull();
    });

    it('drains terminal scope notification requested from inside a live notification', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(open(registry));
        const handle = registry.issueRetainedDocumentHandle('tab:1');
        const observed: string[] = [];
        subscribeRetainedArticleDocumentHandle(handle, () =>
        {
            const state = inspectRetainedArticleDocumentHandle(handle).state;
            observed.push(state);
            if (state === 'live')
            {
                revokeRetainedArticleDocumentScope(handle);
            }
        });
        registry.execute(open(registry, 2));
        expect(observed).toEqual(['live', 'revoked']);
    });
    it('binds membership seals to original private publication and rejects copied or canceled tokens', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(open(registry));
        const handle = registry.issueRetainedDocumentHandle('tab:1');
        const seal = sealRetainedArticleDocumentMembership(handle)!;
        expect(hasSealedRetainedArticleDocumentMembershipCustody(seal)).toBe(true);
        expect(hasSealedRetainedArticleDocumentMembershipCustody({ ...seal })).toBe(false);
        expect(cancelRetainedArticleDocumentMembershipSeal({ ...seal })).toBe(false);
        expect(cancelRetainedArticleDocumentMembershipSeal(seal)).toBe(true);
        expect(hasSealedRetainedArticleDocumentMembershipCustody(seal)).toBe(false);
        expect(cancelRetainedArticleDocumentMembershipSeal(seal)).toBe(false);
    });

    it('retires original membership seals before command getters and notification readers run', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(open(registry));
        const handle = registry.issueRetainedDocumentHandle('tab:1');
        const seal = sealRetainedArticleDocumentMembership(handle)!;
        let commandRead = false;
        const command = open(registry, 2);
        Object.defineProperty(command, 'schema', { enumerable: true, get: () =>
        {
            commandRead = true;
            expect(hasSealedRetainedArticleDocumentMembershipCustody(seal)).toBe(false);
            expect(sealRetainedArticleDocumentMembership(handle)).toBeNull();
            return openArticleDocumentCommandSchema;
        } });
        let notified = false;
        subscribeRetainedArticleDocumentHandle(handle, () =>
        {
            notified = true;
            expect(hasSealedRetainedArticleDocumentMembershipCustody(seal)).toBe(false);
            expect(sealRetainedArticleDocumentMembership(handle)).toBeNull();
        });
        registry.execute(command);
        expect(commandRead).toBe(true);
        expect(notified).toBe(true);
        expect(hasSealedRetainedArticleDocumentMembershipCustody(seal)).toBe(false);
        expect(hasSealedRetainedArticleDocumentMembershipCustody(sealRetainedArticleDocumentMembership(handle)!)).toBe(true);
    });

    it('revokes original membership seals synchronously before scope listeners and retains notification failure', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(open(registry));
        const handle = registry.issueRetainedDocumentHandle('tab:1');
        const seal = sealRetainedArticleDocumentMembership(handle)!;
        subscribeRetainedArticleDocumentHandle(handle, () =>
        {
            expect(hasSealedRetainedArticleDocumentMembershipCustody(seal)).toBe(false);
            throw new Error('actual-original-listener-failure');
        });
        revokeRetainedArticleDocumentScope(handle);
        expect(hasSealedRetainedArticleDocumentMembershipCustody(seal)).toBe(false);
        expect(sealRetainedArticleDocumentMembership(handle)).toBeNull();
        expect(inspectRetainedArticleDocumentHandle(handle).notificationFailed).toBe(true);
    });
});
