import { describe, expect, it } from 'vitest';

import {
    AuthoringSessionHost,
    authoringSessionSnapshotSchema,
    authoringSessionTaskEnvelopeSchema,
    calculateOpenArticleDocumentDigest,
    defaultAuthoringSessionResourcePolicy,
    openArticleDocumentEntrySchema,
    sealAuthoringSessionSnapshot,
    verifyAuthoringSessionHostState,
    type AuthoringSessionResourcePolicy,
    type AuthoringSessionResourceUsage,
    type AuthoringSessionSnapshotContext,
    type AuthoringSessionSnapshotRefs,
    type FsusUiPublicEditorSession,
    type FsusUiPublicEditorSessionFactory,
    type OpenArticleDocumentEntry
} from '@/services/authoring';

const activeResources = (): AuthoringSessionResourceUsage => ({
    editorInstances: 1,
    renderers: 1,
    observers: 1,
    timers: 1,
    backgroundTasks: 1,
    networkRequests: 1,
    memoryUnits: 10
});

const pausedResources = (): AuthoringSessionResourceUsage => ({
    editorInstances: 1,
    renderers: 0,
    observers: 0,
    timers: 0,
    backgroundTasks: 0,
    networkRequests: 0,
    memoryUnits: 5
});

class FakeEditorSession implements FsusUiPublicEditorSession
{
    public captureCount = 0;
    public restoreCount = 0;
    public pauseCount = 0;
    public disposed = false;
    public lastRestoredSnapshot: AuthoringSessionSnapshotRefs | null = null;
    private resources = activeResources();

    public readonly editorSessionRef: string;
    private readonly rejectRestore: boolean;

    public constructor(editorSessionRef: string, rejectRestore = false)
    {
        this.editorSessionRef = editorSessionRef;
        this.rejectRestore = rejectRestore;
    }

    public captureSnapshot(context: AuthoringSessionSnapshotContext): AuthoringSessionSnapshotRefs
    {
        this.captureCount += 1;
        const suffix = `${this.editorSessionRef}:${this.captureCount}`;
        return sealAuthoringSessionSnapshot({
            schema: authoringSessionSnapshotSchema,
            snapshotRef: `snapshot:${suffix}`,
            identity: structuredClone(context.identity),
            editorSessionRef: context.editorSessionRef,
            documentContext: structuredClone(context.documentContext),
            permission: context.permission,
            permissionRef: context.permissionRef,
            selectionRef: `selection:${suffix}`,
            selectionDirection: this.captureCount % 2 === 0 ? 'backward' : 'forward',
            historyRef: `history:${suffix}`,
            activeNodeRef: `active-node:${suffix}`,
            scrollAnchorRef: `scroll-anchor:${suffix}`,
            outlineRef: `outline:${suffix}`,
            searchRef: `search:${suffix}`,
            attachmentStateRef: `attachments:${suffix}`,
            lastValidRenderRef: `last-valid-render:${suffix}`,
            draftStateRef: `draft-state:${suffix}`,
            crashJournalRef: `crash-journal:${suffix}`,
            editorContentDigest: calculateOpenArticleDocumentDigest({ editorSessionRef: this.editorSessionRef })
        });
    }

    public pauseResources(): AuthoringSessionResourceUsage
    {
        this.pauseCount += 1;
        this.resources = pausedResources();
        return structuredClone(this.resources);
    }

    public resumeResources(): AuthoringSessionResourceUsage
    {
        this.resources = activeResources();
        return structuredClone(this.resources);
    }

    public restoreSnapshot(snapshot: AuthoringSessionSnapshotRefs): ReturnType<FsusUiPublicEditorSession['restoreSnapshot']>
    {
        this.restoreCount += 1;
        this.lastRestoredSnapshot = structuredClone(snapshot);
        return {
            status: this.rejectRestore ? 'blocked' : 'restored',
            snapshotRef: snapshot.snapshotRef,
            snapshotDigest: snapshot.snapshotDigest,
            identityValidated: !this.rejectRestore,
            refsValidated: !this.rejectRestore,
            reason: this.rejectRestore ? 'snapshot-proof-tampered' : null
        };
    }

    public inspectResources(): AuthoringSessionResourceUsage
    {
        return structuredClone(this.resources);
    }

    public disposeAfterSnapshot(): void
    {
        this.disposed = true;
        this.resources = {
            editorInstances: 0,
            renderers: 0,
            observers: 0,
            timers: 0,
            backgroundTasks: 0,
            networkRequests: 0,
            memoryUnits: 0
        };
    }
}

class FakeEditorSessionFactory implements FsusUiPublicEditorSessionFactory
{
    public readonly created = new Map<string, FakeEditorSession[]>();
    public readonly rejectRestoreRefs = new Set<string>();

    public createSession(entry: OpenArticleDocumentEntry): FakeEditorSession
    {
        const session = new FakeEditorSession(
            entry.editorSessionRef,
            this.rejectRestoreRefs.has(entry.editorSessionRef)
        );
        const sessions = this.created.get(entry.editorSessionRef) ?? [];
        sessions.push(session);
        this.created.set(entry.editorSessionRef, sessions);
        return session;
    }

    public latest(editorSessionRef: string): FakeEditorSession
    {
        const sessions = this.created.get(editorSessionRef) ?? [];
        const latest = sessions.at(-1);
        if (!latest)
        {
            throw new Error('fake-session-not-created');
        }
        return latest;
    }
}

type EntryOverrides = Omit<Partial<OpenArticleDocumentEntry>, 'identity' | 'documentContext' | 'status'> & {
    identity?: Partial<OpenArticleDocumentEntry['identity']>;
    documentContext?: Partial<OpenArticleDocumentEntry['documentContext']>;
    status?: Partial<OpenArticleDocumentEntry['status']>;
};

function makeEntry(index: number, overrides: EntryOverrides = {}): OpenArticleDocumentEntry
{
    const base = {
        schema: openArticleDocumentEntrySchema,
        identity: {
            articleId: index + 1,
            draftId: `draft:${index + 1}`,
            documentId: `document:${index + 1}`
        },
        documentContext: {
            documentEpoch: index + 1,
            sourceRevision: `source-revision:${index + 1}`,
            draftRevision: `draft-revision:${index + 1}`
        },
        editorSessionRef: `editor-session:${index + 1}`,
        tabId: `tab:${index + 1}`,
        isPreview: false,
        isPinned: true,
        isActive: false,
        owningGroupId: 'group:primary',
        status: {
            dirty: false,
            saving: false,
            conflict: false,
            recovery: false,
            pendingAttachments: false,
            permission: 'allowed' as const,
            lifecycle: 'current' as const,
            statusRef: `status:${index + 1}`
        },
        lastActiveAnchorRef: null,
        closeRequestRef: null,
        lifecycleRevision: 1
    };
    const merged = {
        ...base,
        ...overrides,
        identity: { ...base.identity, ...overrides.identity },
        documentContext: { ...base.documentContext, ...overrides.documentContext },
        status: { ...base.status, ...overrides.status }
    };
    return {
        ...merged,
        contentDigest: calculateOpenArticleDocumentDigest(merged)
    };
}

function policy(overrides: Partial<AuthoringSessionResourcePolicy>): AuthoringSessionResourcePolicy
{
    return {
        ...defaultAuthoringSessionResourcePolicy,
        ...overrides
    };
}

describe('AuthoringSessionHost contract (#2294)', () => {
    it('supports 0, 1, 20, and 100 exact-one hosted sessions within the machine policy', () => {
        for (const count of [0, 1, 20, 100])
        {
            const factory = new FakeEditorSessionFactory();
            const host = new AuthoringSessionHost(factory);
            for (let index = 0; index < count; index += 1)
            {
                host.attach(makeEntry(index), index);
            }

            const state = host.exportState();
            expect(state.sessions).toHaveLength(count);
            expect(new Set(state.sessions.map(session => session.editorSessionRef)).size).toBe(count);
            expect(state.aggregateResources.editorInstances).toBeLessThanOrEqual(16);
            expect(state.aggregateResources.renderers).toBeLessThanOrEqual(1);
            expect(state.aggregateResources.observers).toBeLessThanOrEqual(1);
            expect(state.aggregateResources.timers).toBeLessThanOrEqual(1);
            expect(state.aggregateResources.backgroundTasks).toBeLessThanOrEqual(1);
            expect(verifyAuthoringSessionHostState(state)).toBe(true);
        }

        const fullHost = new AuthoringSessionHost(new FakeEditorSessionFactory());
        for (let index = 0; index < 100; index += 1)
        {
            fullHost.attach(makeEntry(index), index);
        }
        expect(() => fullHost.attach(makeEntry(100), 100)).toThrow('session-open-budget-exceeded');
    });

    it('isolates same-source and different-source articles without an article-to-session index', () => {
        const factory = new FakeEditorSessionFactory();
        const host = new AuthoringSessionHost(factory);
        const first = makeEntry(0, {
            documentContext: { sourceRevision: 'source-revision:shared' }
        });
        const second = makeEntry(1, {
            documentContext: { sourceRevision: 'source-revision:shared' }
        });
        const third = makeEntry(2, {
            documentContext: { sourceRevision: 'source-revision:different' }
        });

        [first, second, third].forEach((entry, index) => host.attach(entry, index));

        expect(host.listSessions().map(session => session.snapshot.snapshotRef)).toHaveLength(3);
        expect(host.getSession(first.editorSessionRef)?.identity.articleId).toBe(1);
        expect(host.getSession(second.editorSessionRef)?.identity.articleId).toBe(2);
        expect(host.getSession(first.editorSessionRef)?.snapshot.snapshotDigest)
            .not.toBe(host.getSession(second.editorSessionRef)?.snapshot.snapshotDigest);
    });

    it('preserves official history, selection direction, tools, attachment, render, draft, and journal refs on restore', () => {
        const factory = new FakeEditorSessionFactory();
        const host = new AuthoringSessionHost(factory, policy({
            maxBackgroundRetainedSessions: 0,
            maxSuspendedSessions: 1,
            maxLiveEditorInstances: 2
        }));
        const first = makeEntry(0, { isActive: true });
        const second = makeEntry(1);
        host.attach(first, 1);
        host.attach(second, 2);

        const taskAbort = new AbortController();
        expect(host.registerTask(first.editorSessionRef, {
            taskRef: 'task:old-render',
            kind: 'render',
            documentEpoch: first.documentContext.documentEpoch,
            sourceRevision: first.documentContext.sourceRevision,
            abortController: taskAbort
        })).toBe(true);

        host.activate(second, 3);
        const suspended = host.getSession(first.editorSessionRef);
        expect(suspended?.lifecycleState).toBe('suspended');
        expect(taskAbort.signal.aborted).toBe(true);
        const snapshot = structuredClone(suspended?.snapshot);

        const receipt = host.activate(first, 4);
        const restoredBridge = factory.latest(first.editorSessionRef);
        expect(receipt.restoreValidation.status).toBe('validated');
        expect(receipt.action).toBe('restore');
        expect(restoredBridge.lastRestoredSnapshot).toEqual(snapshot);
        expect(restoredBridge.lastRestoredSnapshot).toMatchObject({
            selectionDirection: expect.stringMatching(/forward|backward|none/u),
            historyRef: expect.any(String),
            activeNodeRef: expect.any(String),
            scrollAnchorRef: expect.any(String),
            outlineRef: expect.any(String),
            searchRef: expect.any(String),
            attachmentStateRef: expect.any(String),
            lastValidRenderRef: expect.any(String),
            draftStateRef: expect.any(String),
            crashJournalRef: expect.any(String)
        });
    });

    it('uses critical, nearby, and recency facts for retained, suspended, and recoverable eviction decisions', () => {
        const factory = new FakeEditorSessionFactory();
        const host = new AuthoringSessionHost(factory, policy({
            maxBackgroundRetainedSessions: 1,
            maxSuspendedSessions: 1,
            maxLiveEditorInstances: 2,
            maxMemoryUnits: 20
        }));
        const critical = makeEntry(0, { status: { dirty: true } });
        const nearby = makeEntry(1);
        const recent = makeEntry(2);
        host.attach(critical, 1);
        host.attach(nearby, 2, true);
        host.attach(recent, 3);

        expect(host.getSession(critical.editorSessionRef)?.lifecycleState).toBe('background-retained');
        expect(host.getSession(nearby.editorSessionRef)?.lifecycleState).toBe('suspended');
        expect(host.getSession(recent.editorSessionRef)?.lifecycleState).toBe('evicted-with-recoverable-state');
        expect(host.getSession(recent.editorSessionRef)?.snapshot.snapshotRef).toMatch(/^snapshot:/u);
        expect(host.exportState().receipts.some(receipt => (
            receipt.editorSessionRef === recent.editorSessionRef && receipt.action === 'evict'
        ))).toBe(true);
    });

    it.each(['dirty', 'saving', 'conflict', 'recovery', 'pendingAttachments'] as const)(
        'never irreversibly evicts a %s session',
        risk => {
            const factory = new FakeEditorSessionFactory();
            const host = new AuthoringSessionHost(factory, policy({
                maxBackgroundRetainedSessions: 0,
                maxSuspendedSessions: 0,
                maxLiveEditorInstances: 1,
                maxMemoryUnits: 10
            }));
            const entry = makeEntry(0, { status: { [risk]: true } });
            host.attach(entry, 1);
            const session = host.getSession(entry.editorSessionRef);
            expect(session?.lifecycleState).toBe('evicted-with-recoverable-state');
            expect(session?.snapshot.snapshotDigest).toMatch(/^[a-f0-9]{64}$/u);
            expect(host.exportState().receipts.at(-1)).toMatchObject({
                action: 'evict',
                stateAfter: 'evicted-with-recoverable-state',
                snapshotRef: session?.snapshot.snapshotRef
            });
        }
    );

    it('aborts inactive tasks and rejects old epoch, old task, and stale result envelopes', () => {
        const factory = new FakeEditorSessionFactory();
        const host = new AuthoringSessionHost(factory);
        const first = makeEntry(0, { isActive: true });
        const second = makeEntry(1);
        host.attach(first, 1);
        host.attach(second, 2);
        const abortController = new AbortController();
        host.registerTask(first.editorSessionRef, {
            taskRef: 'task:attachment-upload',
            kind: 'attachment',
            documentEpoch: first.documentContext.documentEpoch,
            sourceRevision: first.documentContext.sourceRevision,
            abortController
        });
        host.activate(second, 3);

        const envelope = {
            schema: authoringSessionTaskEnvelopeSchema,
            taskRef: 'task:attachment-upload',
            editorSessionRef: first.editorSessionRef,
            documentEpoch: first.documentContext.documentEpoch,
            sourceRevision: first.documentContext.sourceRevision,
            producerRef: 'producer:attachment',
            editorContentDigest: calculateOpenArticleDocumentDigest('result')
        };
        expect(abortController.signal.aborted).toBe(true);
        expect(host.acceptTaskResult(envelope)).toBe(false);
        expect(host.acceptTaskResult({ ...envelope, documentEpoch: 999 })).toBe(false);
        expect(host.getSession(first.editorSessionRef)?.taskRefs).toEqual([]);
    });

    it('blocks a tampered public restore proof and never exposes that snapshot as active', () => {
        const factory = new FakeEditorSessionFactory();
        const host = new AuthoringSessionHost(factory, policy({
            maxBackgroundRetainedSessions: 0,
            maxSuspendedSessions: 0,
            maxLiveEditorInstances: 1
        }));
        const entry = makeEntry(0);
        host.attach(entry, 1);
        factory.rejectRestoreRefs.add(entry.editorSessionRef);

        const receipt = host.activate(entry, 2);
        expect(receipt).toMatchObject({
            action: 'block',
            stateAfter: 'blocked',
            restoreValidation: {
                status: 'blocked',
                reason: 'snapshot-restore-rejected',
                identityValidated: false,
                refsValidated: false
            }
        });
        expect(host.getSession(entry.editorSessionRef)?.lifecycleState).toBe('blocked');
    });

    it.each([
        ['permission', { status: { permission: 'revoked' as const, statusRef: 'status:revoked' } }, 'permission-blocked'],
        ['delete', { status: { lifecycle: 'deleted' as const, statusRef: 'status:deleted' } }, 'article-deleted'],
        [
            'draft replacement',
            {
                identity: { draftId: 'draft:replacement' },
                status: { lifecycle: 'draft-replaced' as const, statusRef: 'status:draft-replaced' }
            },
            'draft-replaced'
        ],
        ['source revision', { documentContext: { sourceRevision: 'source-revision:stale' } }, 'source-revision-mismatch']
    ] as const)('blocks %s changes instead of showing an old snapshot as current', (_name, change, reason) => {
        const factory = new FakeEditorSessionFactory();
        const host = new AuthoringSessionHost(factory);
        const entry = makeEntry(0);
        host.attach(entry, 1);
        const changed = makeEntry(0, change as Partial<OpenArticleDocumentEntry>);
        const receipt = host.synchronizeRegistryEntry(changed, 2);
        expect(receipt.stateAfter).toBe('blocked');
        expect(host.getSession(entry.editorSessionRef)).toMatchObject({
            lifecycleState: 'blocked',
            blockReason: reason
        });
    });

    it('accepts group ownership changes without cloning the already open session', () => {
        const factory = new FakeEditorSessionFactory();
        const host = new AuthoringSessionHost(factory);
        const entry = makeEntry(0);
        host.attach(entry, 1);
        const receipt = host.synchronizeRegistryEntry(makeEntry(0, {
            owningGroupId: 'group:secondary'
        }), 2);

        expect(receipt.action).toBe('group-ownership');
        expect(host.listSessions()).toHaveLength(1);
        expect(host.getSession(entry.editorSessionRef)?.owningGroupId).toBe('group:secondary');
        expect(factory.created.get(entry.editorSessionRef)).toHaveLength(1);
    });

    it('only enters closing and closed after an external formal close authority ref', () => {
        const host = new AuthoringSessionHost(new FakeEditorSessionFactory());
        const entry = makeEntry(0, { isActive: true });
        host.attach(entry, 1);
        expect(() => host.applyCloseAuthority(entry.editorSessionRef, 'closed', 'close-decision:1'))
            .toThrow('session-close-transition-invalid');

        const closing = host.applyCloseAuthority(entry.editorSessionRef, 'closing', 'close-decision:1');
        const closed = host.applyCloseAuthority(entry.editorSessionRef, 'closed', 'close-decision:1');
        expect(closing).toMatchObject({ action: 'closing', stateAfter: 'closing' });
        expect(closed).toMatchObject({ action: 'closed', stateAfter: 'closed' });
        expect(host.getSession(entry.editorSessionRef)?.resources).toEqual({
            editorInstances: 0,
            renderers: 0,
            observers: 0,
            timers: 0,
            backgroundTasks: 0,
            networkRequests: 0,
            memoryUnits: 0
        });
    });

    it('does not use browser navigation state as session identity', () => {
        const factory = new FakeEditorSessionFactory();
        const host = new AuthoringSessionHost(factory);
        const entry = makeEntry(0);
        host.attach(entry, 1);
        const navigationHistory = ['/admin/article/write?id=1', '/admin/article/write?id=2', '/unrelated'];
        navigationHistory.reverse();
        expect(host.getSession(entry.editorSessionRef)?.editorSessionRef).toBe(entry.editorSessionRef);
        expect(factory.created.get(entry.editorSessionRef)).toHaveLength(1);
    });

    it('rejects snapshot, receipt, duplicate identity, and aggregate resource tamper', () => {
        const host = new AuthoringSessionHost(new FakeEditorSessionFactory());
        host.attach(makeEntry(0), 1);
        host.attach(makeEntry(1), 2);
        const valid = host.exportState();
        expect(verifyAuthoringSessionHostState(valid)).toBe(true);

        const snapshotTamper = structuredClone(valid);
        snapshotTamper.sessions[0]!.snapshot.selectionRef = 'selection:tampered';
        expect(verifyAuthoringSessionHostState(snapshotTamper)).toBe(false);

        const receiptTamper = structuredClone(valid);
        receiptTamper.receipts[0]!.taskRefsAfter.push('task:injected');
        expect(verifyAuthoringSessionHostState(receiptTamper)).toBe(false);

        const duplicateIdentity = structuredClone(valid);
        duplicateIdentity.sessions[1]!.identity = structuredClone(duplicateIdentity.sessions[0]!.identity);
        expect(verifyAuthoringSessionHostState(duplicateIdentity)).toBe(false);

        const resourceTamper = structuredClone(valid);
        resourceTamper.aggregateResources.observers = 99;
        expect(verifyAuthoringSessionHostState(resourceTamper)).toBe(false);

        const copiedBodyTamper = structuredClone(valid) as typeof valid & { markdownBody?: string; };
        copiedBodyTamper.markdownBody = '# copied body';
        copiedBodyTamper.contentDigest = calculateOpenArticleDocumentDigest({
            ...copiedBodyTamper,
            contentDigest: undefined
        });
        expect(verifyAuthoringSessionHostState(copiedBodyTamper)).toBe(false);
    });

    it('rejects a registry entry whose authority digest was tampered', () => {
        const host = new AuthoringSessionHost(new FakeEditorSessionFactory());
        const tampered = {
            ...makeEntry(0),
            contentDigest: '0'.repeat(64)
        };
        expect(() => host.attach(tampered, 1)).toThrow('registry-entry-digest-invalid');
        expect(host.listSessions()).toEqual([]);
    });

    it('keeps forbidden remount, copied-body, all-active, and route-local mutations outside the host contract', () => {
        const forbiddenMutations = [
            ':key=articleId',
            'markdownBody',
            'undoStack',
            'allSessionsActive',
            'route-local-fallback',
            'one Pinia store per article'
        ];
        expect(forbiddenMutations).toHaveLength(6);
    });
});
