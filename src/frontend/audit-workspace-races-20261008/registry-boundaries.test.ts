import { describe, expect, it } from 'vitest';
import {
    OpenArticleDocumentRegistry,
    openArticleDocumentCommandSchema,
    verifyOpenArticleDocumentRegistryState,
    type OpenOrActivateArticleCommand
} from '../src/services/authoring/openArticleDocumentRegistry';
import {
    ArticleWorkspaceTabRouter,
    type ArticleWorkspaceOpenInput
} from '../src/services/authoring/articleWorkspaceTabRouter';

// These are actual production Registry/router commands. No SDK session factory,
// server snapshot, cache, restore receipt, or two-group transaction is simulated.
// The router's own default immediateSessionPort is exercised only as a pure
// memory protocol; it does not establish real editor readiness.
const status = {
    dirty: false, saving: false, conflict: false, recovery: false,
    pendingAttachments: false, permission: 'allowed' as const,
    lifecycle: 'current' as const, statusRef: 'audit-status:allowed'
};

function open(articleId: number, revision: number, label: string): OpenOrActivateArticleCommand {
    return {
        schema: openArticleDocumentCommandSchema,
        kind: 'open-or-activate', commandId: `audit-command:${label}`,
        idempotencyKey: `audit-idempotency:${label}`, expectedRevision: revision,
        intent: 'workspace', entrypoint: 'recent-restore',
        identity: { articleId, draftId: `audit-draft:${articleId}`, documentId: `audit-document:${articleId}` },
        documentContext: { documentEpoch: 1, sourceRevision: `audit-source:${articleId}`, draftRevision: `audit-draft-revision:${articleId}` },
        editorSessionRef: `audit-session:${articleId}`, tabId: `audit-tab:${articleId}`,
        targetGroupId: 'audit-group:primary', tabKind: 'pinned', status,
        lastActiveAnchorRef: null
    };
}

function base(kind: string, revision: number, label: string) {
    return { schema: openArticleDocumentCommandSchema, kind, expectedRevision: revision,
        commandId: `audit-command:${label}`, idempotencyKey: `audit-idempotency:${label}` };
}

function input(articleId: number): ArticleWorkspaceOpenInput {
    const command = open(articleId, 0, `input-${articleId}`);
    return { identity: command.identity, documentContext: command.documentContext,
        title: '', status, targetGroupId: command.targetGroupId,
        tabKind: command.tabKind, entrypoint: 'recent-restore' };
}

describe('independent published-interface boundaries; no #2302–#2306 candidate supplied', () => {
    it('rejects writer B carrying the same revision after writer A commits', () => {
        const registry = new OpenArticleDocumentRegistry();
        const writerA = open(1, 0, 'writer-a');
        const writerB = open(2, 0, 'writer-b');
        expect(registry.execute(writerA).status).toBe('applied');
        const accepted = registry.exportState();
        expect(registry.execute(writerB).status).toBe('rejected-cas');
        expect(registry.exportState()).toEqual(accepted);
        expect(verifyOpenArticleDocumentRegistryState(accepted)).toBe(true);
    });

    it('coalesces same article in a different group/draft without allocating a second session', () => {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(open(1, 0, 'first-owner'));
        const alternate = open(1, 1, 'second-owner');
        alternate.targetGroupId = 'audit-group:secondary';
        alternate.editorSessionRef = 'audit-session:duplicate';
        alternate.tabId = 'audit-tab:duplicate';
        alternate.identity.draftId = 'audit-draft:replaced';
        expect(registry.execute(alternate).status).toBe('activated-existing');
        expect(registry.listEntries()).toHaveLength(1);
        expect(registry.listEntries()[0]).toMatchObject({
            editorSessionRef: 'audit-session:1', owningGroupId: 'audit-group:primary'
        });
        expect(verifyOpenArticleDocumentRegistryState(registry.exportState())).toBe(true);
    });

    it('rejects one editor session ref being owned by a different article', () => {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(open(1, 0, 'original-session'));
        const before = registry.exportState();
        const duplicate = open(2, 1, 'duplicate-session');
        duplicate.editorSessionRef = 'audit-session:1';
        expect(registry.execute(duplicate).status).toBe('rejected-duplicate-session');
        expect(registry.exportState()).toEqual(before);
    });

    it('preserves live authority when a consumer mutates an exported entry/state', () => {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(open(1, 0, 'projection'));
        const before = registry.exportState();
        const exported = registry.exportState();
        exported.entries[0]!.status.permission = 'revoked';
        exported.entries[0]!.owningGroupId = 'audit-group:tampered';
        expect(verifyOpenArticleDocumentRegistryState(exported)).toBe(false);
        expect(registry.exportState()).toEqual(before);
    });

    it('rejects late session readiness if permission changes during the router await', async () => {
        const coordinator = new ArticleWorkspaceTabRouter();
        const pending = coordinator.openOrActivate(input(1));
        const registry = coordinator.getRegistry();
        const entry = registry.listEntries()[0]!;
        expect(registry.execute({ ...base('invalidate-permission', registry.getRevision(), 'revoke-pending'),
            tabId: entry.tabId, permission: 'revoked', statusRef: 'audit-status:revoked' }).status).toBe('applied');
        const result = await pending;
        expect(result.sessionState).toBe('blocked');
        expect(result.reason).toBe('session-result-stale');
    });

    it('MUST_FIX dependency: open-or-activate must not reactivate a permission-revoked existing tab', () => {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(open(1, 0, 'first'));
        registry.execute(open(2, 1, 'other-active'));
        expect(registry.execute({ ...base('invalidate-permission', 2, 'revoke'),
            tabId: 'audit-tab:1', permission: 'revoked', statusRef: 'audit-status:revoked' }).status).toBe('applied');
        const before = registry.exportState();
        const result = registry.execute(open(1, 3, 'restore-reopen'));
        console.log('AUDIT_PERMISSION_REOPEN', JSON.stringify({ result, before, after: registry.exportState() }));
        expect(result.status).toBe('rejected-state');
        expect(registry.exportState()).toEqual(before);
    });

    it('MUST_FIX dependency: resetting projections during pending readiness must invalidate the late result', async () => {
        const coordinator = new ArticleWorkspaceTabRouter();
        const pending = coordinator.openOrActivate(input(1));
        coordinator.reset();
        const result = await pending;
        console.log('AUDIT_RESET_LATE', JSON.stringify({ result, tabs: coordinator.listTabs() }));
        expect(result.sessionState).toBe('blocked');
    });

    it('MUST_FIX dependency: older navigation completion must not return an applied current result', async () => {
        const coordinator = new ArticleWorkspaceTabRouter();
        let finishA!: () => void;
        let reachedA!: () => void;
        const startedA = new Promise<void>(resolve => { reachedA = resolve; });
        const navigationA = new Promise<void>(resolve => { finishA = resolve; });
        const first = coordinator.openOrActivateAndNavigate(input(1), {
            currentFullPath: '', push: async () => { reachedA(); await navigationA; }
        });
        await startedA;
        const second = await coordinator.openOrActivateAndNavigate(input(2), {
            currentFullPath: '', push: async () => undefined
        });
        finishA();
        const late = await first;
        console.log('AUDIT_OUT_OF_ORDER', JSON.stringify({ second, late, activeTab: coordinator.getActiveTab() }));
        expect(late.resultStatus).toBe('stale');
        expect(coordinator.getActiveTab()?.articleId).toBe(2);
    });
});
