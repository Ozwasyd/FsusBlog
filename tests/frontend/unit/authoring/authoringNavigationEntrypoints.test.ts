// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ElMarkdownEditor } from '@ozwasyd/element-plus';
import { createMarkdownAnchorMap } from '@ozwasyd/element-plus/markdown-runtime';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import {
    AuthoringNavigationEntrypoints,
    createAuthoringNavigationIntent,
    projectAuthoringNavigationAnchor,
    verifyAuthoringNavigationEntrypointReceipt,
    verifyAuthoringNavigationIntent
} from '@/services/authoring/authoringNavigationEntrypoints';
import { authoringNavigationVisitCauses, calculateAuthoringNavigationDigest } from '@/services/authoring/authoringNavigationHistory';
import { AuthoringTabGroupRegistry, authoringTabGroupCommandSchema } from '@/services/authoring/authoringTabGroupRegistry';
import { authoringWorkspaceRatioOwner } from '@/services/authoring/authoringWorkspaceRatioOwner';
import { OpenArticleDocumentRegistry, calculateOpenArticleDocumentDigest, openArticleDocumentCommandSchema } from '@/services/authoring/openArticleDocumentRegistry';

import type { MarkdownEditorDispatchResult, MarkdownEditorTransaction } from '@ozwasyd/element-plus';
import type { ArticleAnchorContext } from '@/services/authoring/articleAnchorContext';
import type { ArticleEditorMountedSessionPort } from '@/services/authoring/articleEditorContinuity';
import type {
    AuthoringNavigationIntent,
    AuthoringNavigationMountedEditor,
    AuthoringNavigationRouteOrigin,
    AuthoringNavigationSelectionPort
} from '@/services/authoring/authoringNavigationEntrypoints';
import type { OpenArticleDocumentEntry, OpenOrActivateArticleCommand } from '@/services/authoring/openArticleDocumentRegistry';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()));

async function mounted(articleId: number)
{
    let source = '# Heading\n\nabcdef\n';
    const documentOwner = createArticleDocumentContextAdapter({ articleId, draftId: `draft:${articleId}`,
        editorSessionId: `session:${articleId}`, siteScope: 'site:test', userScope: 'user:test', content: source });
    const anchors = new ArticleAnchorContextAdapter(documentOwner);
    const wrapper = mount(ElMarkdownEditor, { attachTo: document.body, props: {
        modelValue: source, mode: 'source', documentIdentity: documentOwner.documentIdentity
    } });
    cleanup.push(() => { wrapper.unmount(); documentOwner.dispose(); });
    await nextTick();
    const editor = wrapper.vm as unknown as ArticleEditorMountedSessionPort & {
        revealSourceRange(range: { start: number; end: number; }): string;
    };
    const native = editor.getSession(`session:${articleId}`);
    const captures: ArticleAnchorContext[] = [];
    const capture = anchors.capture.bind(anchors);
    vi.spyOn(anchors, 'capture').mockImplementation((...args) =>
    {
        const saved = capture(...args);
        captures.push(saved);
        return saved;
    });
    const transactions: MarkdownEditorDispatchResult[] = [];
    let focusFails = false;
    const port: AuthoringNavigationMountedEditor = {
        document: documentOwner, anchors, editor,
        binding: () => ({ document: documentOwner.context,
            map: createMarkdownAnchorMap({ identity: documentOwner.documentIdentity, source }) }),
        selection: () => native.captureSnapshot(calculateOpenArticleDocumentDigest).selection,
        captureOptions: () => ({ affinity: 'after', viewportOffset: 0, percentage: 0, surface: 'source', tool: 'none' }),
        resolveAnchor: anchor => captures.find(saved => saved.contentDigest === anchor.anchorContextDigest) ?? null,
        transactions: saved => transactions.filter(transaction => transaction.beforeRevision >= saved.document.sourceRevision),
        viewport: () => ({ height: 500, reducedMotion: true }),
        reveal: async (command, signal, admit) =>
        {
            signal.throwIfAborted();
            admit();
            const revealed = command?.range ? editor.revealSourceRange(command.range) === 'success' : true;
            await nextTick();
            admit();
            const textarea = wrapper.find('textarea');
            if (!focusFails && textarea.exists()) (textarea.element as HTMLTextAreaElement).focus();
            return { focusAcknowledged: !focusFails && wrapper.element.contains(document.activeElement), viewportAcknowledged: revealed };
        }
    };
    const identity = { articleId, draftId: documentOwner.context.draftId, documentId: documentOwner.context.documentId };
    const command = (revision: number): OpenOrActivateArticleCommand => ({ schema: openArticleDocumentCommandSchema,
        kind: 'open-or-activate', commandId: `seed:${articleId}`, idempotencyKey: `seed:${articleId}`, expectedRevision: revision,
        intent: 'workspace', entrypoint: 'direct-route', identity,
        documentContext: { documentEpoch: documentOwner.context.documentEpoch, sourceRevision: `source:${articleId}`, draftRevision: null },
        editorSessionRef: `session:${articleId}`, tabId: `tab:${articleId}`, targetGroupId: 'group:main', tabKind: 'pinned',
        status: { dirty: false, saving: false, conflict: false, recovery: false, pendingAttachments: false,
            permission: 'allowed', lifecycle: 'current', statusRef: `status:${articleId}` }, lastActiveAnchorRef: null });
    return { identity, command, port, captures, wrapper, focusFail: () => { focusFails = true; },
        capture: (start = 11, end = 15) => anchors.capture(port.binding(), { start, end, direction: 'forward' }, port.captureOptions()),
        dispatch: (changes: MarkdownEditorTransaction['changes']) =>
        {
            const result = editor.dispatchTransaction({ changes, documentIdentity: documentOwner.documentIdentity,
                expectedRevision: documentOwner.context.sourceRevision, history: 'separate', origin: 'programmatic' });
            expect(result.accepted).toBe(true);
            source = result.value;
            documentOwner.updateSource(source, result.revision);
            transactions.push(result);
            return result;
        }
    };
}

async function fixture(options: { selection?: AuthoringNavigationSelectionPort; seed?: boolean; } = {})
{
    const first = await mounted(1);
    const second = await mounted(2);
    const registry = new OpenArticleDocumentRegistry();
    const ratioScope = authoringWorkspaceRatioOwner.openWorkspace();
    const groups = new AuthoringTabGroupRegistry(registry, { initialGroupId: 'group:main', ratioScope,
        splitRatioRef: authoringWorkspaceRatioOwner.read(ratioScope).ratioRef, historyCapacity: 16 });
    if (options.seed !== false)
    {
        expect(registry.openOrActivate(first.command(registry.getRevision())).status).toBe('applied');
        expect(registry.openOrActivate(second.command(registry.getRevision())).status).toBe('applied');
    }
    const hosts = [first, second];
    const current = (entry: OpenArticleDocumentEntry) => hosts.find(host => host.identity.documentId === entry.identity.documentId)?.port ?? null;
    const echoes: string[] = [];
    const tokens: AuthoringNavigationRouteOrigin[] = [];
    let wait = async (entry: OpenArticleDocumentEntry) => current(entry);
    let route = async () => {};
    const adapter = new AuthoringNavigationEntrypoints({ registry, groups,
        scope: { sessionRef: 'session:test', workspaceRef: 'workspace:test', siteScope: 'site:test', userScope: 'user:test' },
        mounted: { current, wait: (entry, _signal) => wait(entry) }, selection: options.selection,
        route: { update: async (_entry, _policy, token, signal, admit) =>
        {
            signal.throwIfAborted();
            admit();
            tokens.push(token);
            echoes.push(adapter.observeRoute(token).status);
            await route();
            admit();
        } }
    });
    const intent = (sequence: number, target = first, overrides: Partial<AuthoringNavigationIntent> = {}) =>
    {
        const { contentDigest: _digest, schema: _schema, ...input } = {
            schema: 'fsusblog.authoring-navigation-entrypoint.v1' as const, contentDigest: '',
            requestId: `request:${sequence}`, sequence, initiatedAt: sequence * 1000, entrypoint: 'rail' as const,
            identity: target.identity, anchor: null, targetGroupId: null, routePolicy: 'push' as const, recentRestore: null,
            ...overrides
        };
        return createAuthoringNavigationIntent(input);
    };
    return { adapter, registry, groups, first, second, hosts, current, intent, echoes, tokens,
        setWait: (value: typeof wait) => { wait = value; }, setRoute: (value: typeof route) => { route = value; } };
}

describe('authoring navigation entrypoints (#2308), genuine Registry/Group/Anchor/native sessions', () =>
{
    it('keeps the product disabled without the actual mounted owner port', async () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        const ratioScope = authoringWorkspaceRatioOwner.openWorkspace();
        const groups = new AuthoringTabGroupRegistry(registry, { initialGroupId: 'group:main', ratioScope,
            splitRatioRef: authoringWorkspaceRatioOwner.read(ratioScope).ratioRef, historyCapacity: 16 });
        const adapter = new AuthoringNavigationEntrypoints({ registry, groups,
            scope: { sessionRef: 'session:test', workspaceRef: 'workspace:test', siteScope: 'site:test', userScope: 'user:test' } });
        expect(adapter.inspectAvailability()).toMatchObject({ enabled: false, missing: expect.arrayContaining(['current-public-anchor-map']) });
        expect((await adapter.traverse('back', 'request:back', 1)).status).toBe('disabled');
        expect(registry.getRevision()).toBe(0);
        expect(adapter.history.exportState().cursor).toBe(-1);
    });

    it('independently verifies original history commands and rejects resealed transition/receipt tamper', async () =>
    {
        const f = await fixture();
        const before = f.adapter.history.exportState();
        const receipt = await f.adapter.navigate(f.intent(1));
        expect(verifyAuthoringNavigationEntrypointReceipt(receipt, before)).toBe(true);
        expect(verifyAuthoringNavigationEntrypointReceipt({ ...receipt, status: 'ignored' }, before)).toBe(false);
        const changed = structuredClone(receipt);
        changed.commands[0].expectedRevision += 1;
        const { contentDigest: _digest, ...body } = changed;
        expect(verifyAuthoringNavigationEntrypointReceipt({ ...body, contentDigest: calculateAuthoringNavigationDigest(body) }, before)).toBe(false);
    });

    it.each([...authoringNavigationVisitCauses.filter(cause => cause !== 'recent-closed-restore'), 'direct-route'] as const)(
        'records exactly one explicit %s activation and ignores its route echo', async entrypoint =>
        {
            const f = await fixture();
            const intent = f.intent(1, f.first, { entrypoint });
            const opened = vi.spyOn(f.registry, 'openOrActivate');
            const result = await f.adapter.navigate(intent);
            expect(result, JSON.stringify(result)).toMatchObject({ status: 'completed', observation: { status: 'current' } });
            expect(result.sourceAnchorDigest).toMatch(/^[a-f0-9]{64}$/u);
            expect(opened).toHaveBeenCalledTimes(1);
            expect(f.echoes).toEqual(['ignored']);
            expect(f.adapter.history.exportState().entries).toHaveLength(1);
            expect(await f.adapter.navigate(intent)).toEqual(result);
            expect(opened).toHaveBeenCalledTimes(1);
            expect(f.adapter.observeRoute({ ...f.tokens[0] }).status).toBe('invalid');
        }
    );

    it('authoring back/forward settles only after native reveal, focus acknowledgement and route projection', async () =>
    {
        const f = await fixture();
        expect((await f.adapter.navigate(f.intent(1))).status).toBe('completed');
        expect((await f.adapter.navigate(f.intent(2, f.second))).status).toBe('completed');
        const back = await f.adapter.traverse('back', 'request:back', 3);
        expect(back).toMatchObject({ status: 'completed', anchor: { status: 'ready', kind: 'exact' } });
        expect(back.history.map(value => value.receipt.commandKind)).toEqual(['back', 'settle-navigation']);
        expect(f.adapter.history.exportState()).toMatchObject({ cursor: 0, pending: null });
        expect(f.tokens.at(-1)?.origin).toBe('history-navigation');
        expect((await f.adapter.traverse('forward', 'request:forward', 4)).status).toBe('completed');
        expect(f.adapter.history.exportState()).toMatchObject({ cursor: 1, pending: null });
        expect(f.adapter.history.exportState().entries).toHaveLength(2);
    });

    it('focus failure leaves the history cursor unchanged and releases pending traversal', async () =>
    {
        const f = await fixture();
        await f.adapter.navigate(f.intent(1));
        await f.adapter.navigate(f.intent(2, f.second));
        f.first.focusFail();
        const result = await f.adapter.traverse('back', 'request:failed-back', 3);
        expect(result).toMatchObject({ status: 'invalid', reason: 'authoring-navigation-focus-or-viewport-unacknowledged' });
        expect(f.adapter.history.exportState()).toMatchObject({ cursor: 1, pending: null });
    });

    it('reports the original history target numeric Anchor revision as stale without promoting it to current', async () =>
    {
        const f = await fixture();
        await f.adapter.navigate(f.intent(1));
        await f.adapter.navigate(f.intent(2, f.second));
        f.first.dispatch([{ from: 0, to: 0, insert: 'X' }]);
        const opened = vi.spyOn(f.registry, 'openOrActivate');
        expect(await f.adapter.traverse('back', 'request:stale-anchor', 3)).toMatchObject({ status: 'invalid', reason: 'stale-revision' });
        expect(opened).not.toHaveBeenCalled();
        expect(f.adapter.history.exportState()).toMatchObject({ cursor: 1, pending: null });
    });

    it('cancels delayed traversal without advancing and refuses the old completion after a newer intent', async () =>
    {
        const f = await fixture();
        await f.adapter.navigate(f.intent(1));
        await f.adapter.navigate(f.intent(2, f.second));
        let finish!: (value: AuthoringNavigationMountedEditor | null) => void;
        f.setWait(() => new Promise(resolve => { finish = resolve; }));
        const delayed = f.adapter.traverse('back', 'request:delayed-back', 3);
        await vi.waitFor(() => expect(f.adapter.history.exportState().pending).not.toBeNull());
        f.setWait(async entry => f.current(entry));
        expect((await f.adapter.navigate(f.intent(4, f.second))).status).toBe('completed');
        finish(f.first.port);
        expect((await delayed).status).toBe('cancelled');
        expect(f.registry.listEntries().find(entry => entry.isActive)?.identity).toEqual(f.second.identity);
        expect(f.adapter.history.exportState().pending).toBeNull();
        expect(f.adapter.history.exportState()).toMatchObject({ cursor: 2, lastUserSequence: 4 });
    });

    it('handles synchronous route reentry, old origin, request replay conflicts and out-of-order intents', async () =>
    {
        const f = await fixture();
        const intent = f.intent(1);
        f.setRoute(async () => { expect(f.adapter.navigate(intent)).toBe(f.adapter.navigate(intent)); });
        expect((await f.adapter.navigate(intent)).status).toBe('completed');
        expect((await f.adapter.navigate(f.intent(2, f.second))).status).toBe('completed');
        expect(f.adapter.observeRoute(f.tokens[0]).status).toBe('stale');
        expect((await f.adapter.navigate(f.intent(1, f.second, { requestId: 'request:older' }))).status).toBe('stale');
        expect((await f.adapter.navigate(f.intent(2, f.first))).reason).toBe('request-id-conflict');
    });

    it('keeps cursor fixed on caller cancellation and prevents later target work', async () =>
    {
        const f = await fixture();
        await f.adapter.navigate(f.intent(1));
        await f.adapter.navigate(f.intent(2, f.second));
        let finish!: (value: AuthoringNavigationMountedEditor | null) => void;
        f.setWait(() => new Promise(resolve => { finish = resolve; }));
        const controller = new AbortController();
        const result = f.adapter.traverse('back', 'request:cancel-back', 3, controller.signal);
        await vi.waitFor(() => expect(f.adapter.history.exportState().pending).not.toBeNull());
        controller.abort();
        expect(f.adapter.history.exportState()).toMatchObject({ cursor: 1, pending: null });
        finish(f.first.port);
        expect((await result).status).toBe('cancelled');
        expect(f.adapter.history.exportState()).toMatchObject({ cursor: 1, pending: null });
    });

    it('rejects Group publication changes while mounted work is waiting', async () =>
    {
        const f = await fixture();
        let finish!: (value: AuthoringNavigationMountedEditor | null) => void;
        f.setWait(() => new Promise(resolve => { finish = resolve; }));
        const result = f.adapter.navigate(f.intent(1));
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        const state = f.groups.exportState();
        expect(f.groups.execute({ schema: authoringTabGroupCommandSchema, kind: 'create-second-group', commandId: 'group:late',
            idempotencyKey: 'group:late', expectedRevision: state.revision, expectedArticleRegistryRevision: state.articleRegistryRevision,
            groupId: 'group:recreated' }).status).toBe('applied');
        finish(f.first.port);
        expect(await result).toMatchObject({ status: 'invalid', reason: 'authoring-navigation-group-publication-changed' });
        expect(f.adapter.history.exportState().cursor).toBe(-1);
    });

    it('rejects a same-ID group closed and recreated during mounted work', async () =>
    {
        const f = await fixture();
        const group = (kind: 'create-second-group' | 'close-empty-group', commandId: string) =>
        {
            const state = f.groups.exportState();
            return f.groups.execute({ schema: authoringTabGroupCommandSchema, kind, commandId, idempotencyKey: commandId,
                expectedRevision: state.revision, expectedArticleRegistryRevision: state.articleRegistryRevision, groupId: 'group:reused' });
        };
        expect(group('create-second-group', 'group:create-first').status).toBe('applied');
        let finish!: (value: AuthoringNavigationMountedEditor | null) => void;
        f.setWait(() => new Promise(resolve => { finish = resolve; }));
        const result = f.adapter.navigate(f.intent(1));
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        expect(group('close-empty-group', 'group:close').status).toBe('applied');
        expect(group('create-second-group', 'group:create-second').status).toBe('applied');
        finish(f.first.port);
        expect((await result).reason).toBe('authoring-navigation-group-publication-changed');
        expect(f.adapter.history.exportState().entries).toHaveLength(0);
    });

    it('rejects an actual Registry close/reopen of the same article/tab ID while mounted work waits', async () =>
    {
        const f = await fixture();
        let finish!: (value: AuthoringNavigationMountedEditor | null) => void;
        f.setWait(() => new Promise(resolve => { finish = resolve; }));
        const result = f.adapter.navigate(f.intent(1));
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        expect(f.registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'request-close', commandId: 'close:request',
            idempotencyKey: 'close:request', expectedRevision: f.registry.getRevision(), tabId: 'tab:1' }).status).toBe('applied');
        expect(f.registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'detach-on-final-close', commandId: 'close:final',
            idempotencyKey: 'close:final', expectedRevision: f.registry.getRevision(), tabId: 'tab:1', closeDecisionRef: 'close:decision' }).status).toBe('applied');
        const command = f.first.command(f.registry.getRevision());
        expect(f.registry.openOrActivate({ ...command, commandId: 'reopen:article', idempotencyKey: 'reopen:article',
            documentContext: { ...command.documentContext, documentEpoch: command.documentContext.documentEpoch + 1 } }).status).toBe('applied');
        finish(f.first.port);
        expect((await result).status).toBe('invalid');
        expect(f.adapter.history.exportState().entries).toHaveLength(0);
    });

    it('validates original server selection before opening an absent target and fences cancellation', async () =>
    {
        let resolve!: (value: OpenOrActivateArticleCommand | null) => void;
        const selection = { resolveUnopened: vi.fn(() => new Promise<OpenOrActivateArticleCommand | null>(done => { resolve = done; })),
            verifyRecentRestore: () => false };
        const f = await fixture({ seed: false, selection });
        const opened = vi.spyOn(f.registry, 'openOrActivate');
        const controller = new AbortController();
        const result = f.adapter.navigate(f.intent(1), controller.signal);
        await vi.waitFor(() => expect(selection.resolveUnopened).toHaveBeenCalledTimes(1));
        expect(opened).not.toHaveBeenCalled();
        controller.abort();
        resolve(f.first.command(0));
        expect((await result).status).toBe('cancelled');
        expect(opened).not.toHaveBeenCalled();
        expect(f.registry.getRevision()).toBe(0);
    });

    it('requires a current server selection result and never infers deleted from an absent entry', async () =>
    {
        let selected: OpenOrActivateArticleCommand | null = null;
        const selection = { resolveUnopened: vi.fn(async () => selected), verifyRecentRestore: () => false };
        const f = await fixture({ seed: false, selection });
        expect((await f.adapter.navigate(f.intent(1)))).toMatchObject({ status: 'invalid', reason: 'server-selection-not-current' });
        expect(f.registry.getRevision()).toBe(0);
        selected = f.first.command(0);
        expect((await f.adapter.navigate(f.intent(2)))).toMatchObject({ status: 'completed' });
        expect(selection.resolveUnopened).toHaveBeenCalledTimes(2);
        expect(f.registry.getEntry('tab:1')?.identity).toEqual(f.first.identity);
    });

    it('does not append or settle completed after route failure', async () =>
    {
        const f = await fixture();
        await f.adapter.navigate(f.intent(1));
        await f.adapter.navigate(f.intent(2, f.second));
        f.setRoute(async () => { throw new Error('actual-route-failed'); });
        expect((await f.adapter.traverse('back', 'request:route-failed', 3))).toMatchObject({ status: 'invalid', reason: 'actual-route-failed' });
        expect(f.adapter.history.exportState()).toMatchObject({ cursor: 1, pending: null });
        expect((await f.adapter.navigate(f.intent(4)))).toMatchObject({ status: 'invalid', reason: 'actual-route-failed' });
        expect(f.adapter.history.exportState().entries).toHaveLength(2);
    });

    it.each(['exact', 'rebased', 'partial'] as const)('uses the original Anchor restore result %s', async kind =>
    {
        const f = await fixture();
        const saved = f.first.capture();
        if (kind === 'rebased') f.first.dispatch([{ from: 0, to: 0, insert: 'X' }]);
        if (kind === 'partial') f.first.dispatch([{ from: 12, to: 14, insert: '' }]);
        const result = await f.adapter.navigate(f.intent(1, f.first, { anchor: projectAuthoringNavigationAnchor(saved) }));
        expect(result.anchor, JSON.stringify(result)).toMatchObject({ status: 'ready', kind });
        expect(result.status).toBe(kind === 'partial' ? 'invalid' : 'completed');
        expect(f.adapter.history.exportState().entries).toHaveLength(kind === 'partial' ? 0 : 1);
    });

    it('refuses node-only history data when the original full capture is no longer held', async () =>
    {
        const f = await fixture();
        const saved = f.first.capture();
        const anchor = projectAuthoringNavigationAnchor(saved);
        f.first.captures.splice(0);
        expect((await f.adapter.navigate(f.intent(1, f.first, { anchor }))).reason).toBe('authoring-navigation-original-anchor-unavailable');
        expect(f.adapter.history.exportState().entries).toHaveLength(0);
    });

    it.each(['denied', 'revoked'] as const)('observes actual %s permission before open', async permission =>
    {
        const f = await fixture();
        f.registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'invalidate-permission', commandId: 'permission:revoke',
            idempotencyKey: 'permission:revoke', expectedRevision: f.registry.getRevision(), tabId: 'tab:1', permission, statusRef: 'permission:current' });
        const opened = vi.spyOn(f.registry, 'openOrActivate');
        expect((await f.adapter.navigate(f.intent(1)))).toMatchObject({ status: 'invalid', reason: 'permission-revoked' });
        expect(opened).not.toHaveBeenCalled();
    });

    it('treats Registry absence as unknown and requires the original server selection/revalidation owner', async () =>
    {
        const f = await fixture({ seed: false });
        expect(await f.adapter.navigate(f.intent(1))).toMatchObject({ status: 'disabled', reason: 'server-selection-revalidation-port-unavailable' });
        expect(f.registry.getRevision()).toBe(0);
        expect(f.adapter.history.exportState().entries).toHaveLength(0);
    });

    it('rejects same article ID with a different document lifetime without calling open', async () =>
    {
        const f = await fixture();
        const opened = vi.spyOn(f.registry, 'openOrActivate');
        const result = await f.adapter.navigate(f.intent(1, f.first, { identity: { ...f.first.identity, documentId: 'document:recreated' } }));
        expect(result).toMatchObject({ status: 'invalid', reason: 'same-id-document-recreated' });
        expect(opened).not.toHaveBeenCalled();
    });

    it('uses actual Group publication, falls back for missing group and preserves an existing tab owner', async () =>
    {
        const f = await fixture();
        const state = f.groups.exportState();
        expect(f.groups.execute({ schema: authoringTabGroupCommandSchema, kind: 'create-second-group', commandId: 'group:create',
            idempotencyKey: 'group:create', expectedRevision: state.revision, expectedArticleRegistryRevision: state.articleRegistryRevision,
            groupId: 'group:other' }).status).toBe('applied');
        expect((await f.adapter.navigate(f.intent(1, f.first, { targetGroupId: 'group:absent' })))).toMatchObject({ status: 'completed', groupFallback: true });
        expect(f.registry.getEntry('tab:1')?.owningGroupId).toBe('group:main');
        expect((await f.adapter.navigate(f.intent(2, f.second, { targetGroupId: 'group:other' })))).toMatchObject({ status: 'completed' });
        expect(f.registry.getEntry('tab:2')?.owningGroupId).toBe('group:main');
        expect(f.groups.exportState().groups).toHaveLength(2);
    });

    it('does not fabricate recent restore completion or duplicate a recent stack', async () =>
    {
        const f = await fixture();
        const result = await f.adapter.navigate(f.intent(1, f.first, { entrypoint: 'recent-closed-restore',
            recentRestore: { entryRef: 'recent:entry', restoreReceiptRef: 'recent:receipt', restoreReceiptDigest: 'a'.repeat(64) } }));
        expect(result.reason).toBe('recent-restore-owner-not-completed');
        expect(f.adapter.history.exportState().entries).toHaveLength(0);
    });

    it('records a verified recent-owner handoff once (composition-port control)', async () =>
    {
        const verifyRecentRestore = vi.fn(() => true);
        const f = await fixture({ selection: { resolveUnopened: async () => null, verifyRecentRestore } });
        const ref = { entryRef: 'recent:entry', restoreReceiptRef: 'recent:receipt', restoreReceiptDigest: 'a'.repeat(64) };
        const result = await f.adapter.navigate(f.intent(1, f.first, { entrypoint: 'recent-closed-restore', recentRestore: ref }));
        expect(result.status).toBe('completed');
        expect(verifyRecentRestore).toHaveBeenCalledTimes(1);
        expect(f.adapter.history.exportState().entries[0].recentRestore).toEqual(ref);
    });

    it('keeps the finite routing boundary free of browser-back, storage and additional navigation owners', () =>
    {
        const source = readFileSync(resolve(process.cwd(), 'src/services/authoring/authoringNavigationEntrypoints.ts'), 'utf8');
        const violations = (text: string) => [
            /(?:router|window\.history)\.(?:back|forward|go)\s*\(/u,
            /(?:localStorage|sessionStorage|indexedDB)/u,
            /new\s+(?:OpenArticleDocumentRegistry|AuthoringTabGroupRegistry|ArticleAnchorContextAdapter)\s*\(/u,
            /(?:entries|cursor|recentStack)\s*=\s*(?:\[|new Map|\d)/u
        ].filter(pattern => pattern.test(text));
        expect(violations(source)).toEqual([]);
        for (const mutation of ['router.back()', 'window.history.go(-1)', 'localStorage.setItem("history", "x")',
            'new OpenArticleDocumentRegistry()', 'entries = []', 'recentStack = new Map()'])
            expect(violations(`${source}\n${mutation}`)).not.toEqual([]);
    });

    it('checks exact intent fields/digest and never runs accessor values', async () =>
    {
        const f = await fixture();
        const intent = f.intent(1);
        expect(verifyAuthoringNavigationIntent(intent)).toBe(true);
        expect(verifyAuthoringNavigationIntent({ ...intent, routePolicy: 'replace' })).toBe(false);
        const read = vi.fn(() => 'request:executable');
        const executable = { ...intent };
        Object.defineProperty(executable, 'requestId', { enumerable: true, get: read });
        expect(verifyAuthoringNavigationIntent(executable)).toBe(false);
        expect(read).not.toHaveBeenCalled();
        for (const extra of ['title', 'url', 'heading', 'query', 'hover', 'prefetch', 'workspaceRestore'])
        {
            const { contentDigest: _digest, ...body } = intent;
            const candidate = { ...body, [extra]: 'not-authority' };
            expect(verifyAuthoringNavigationIntent({ ...candidate, contentDigest: calculateAuthoringNavigationDigest(candidate) })).toBe(false);
        }
    });
});

describe('independent review 5561706360 admission controls on exact a18 input', () =>
{
    it('rejects a retired mounted loan before reveal or append (P1)', async () =>
    {
        const f = await fixture();
        f.setWait(async entry =>
        {
            const old = f.current(entry);
            f.hosts.splice(f.hosts.findIndex(host => host.identity.documentId === entry.identity.documentId), 1);
            return old;
        });
        const reveal = vi.spyOn(f.first.port, 'reveal');
        const result = await f.adapter.navigate(f.intent(1));
        expect(f.current(f.registry.getEntry('tab:1')!)).toBeNull();
        expect(result.status).not.toBe('completed');
        expect(reveal).not.toHaveBeenCalled();
        expect(f.adapter.history.exportState().cursor).toBe(-1);
    });

    it('rejects a cross-document public map before anchorless reveal (P2)', async () =>
    {
        const f = await fixture();
        const original = f.first.port.binding;
        f.first.port.binding = () => ({ document: original().document, map: f.second.port.binding().map });
        const reveal = vi.spyOn(f.first.port, 'reveal');
        const result = await f.adapter.navigate(f.intent(1));
        expect(result.status).toBe('invalid');
        expect(reveal).not.toHaveBeenCalled();
    });

    it('rejects a same-document stale public map before anchorless reveal (P2)', async () =>
    {
        const f = await fixture();
        const staleMap = f.first.port.binding().map;
        f.first.dispatch([{ from: 0, to: 0, insert: 'new-source' }]);
        f.first.port.binding = () => ({ document: f.first.port.document.context, map: staleMap });
        const reveal = vi.spyOn(f.first.port, 'reveal');
        const result = await f.adapter.navigate(f.intent(1));
        expect(result.status).toBe('invalid');
        expect(reveal).not.toHaveBeenCalled();
    });

    it('does not settle a traversal whose acknowledged native revision changes during route await (P1)', async () =>
    {
        const f = await fixture();
        await f.adapter.navigate(f.intent(1));
        await f.adapter.navigate(f.intent(2, f.second));
        f.setRoute(async () => { f.first.dispatch([{ from: 0, to: 0, insert: 'route-time-edit' }]); });
        const result = await f.adapter.traverse('back', 'independent:route-edit', 3);
        expect(result.status).not.toBe('completed');
        expect(f.adapter.history.exportState()).toMatchObject({ cursor: 1, pending: null });
    });

    it('rejects an original full Anchor from a different document', async () =>
    {
        const f = await fixture();
        const saved = f.second.capture();
        f.first.port.resolveAnchor = () => saved;
        expect((await f.adapter.navigate(f.intent(1, f.first, { anchor: projectAuthoringNavigationAnchor(saved) }))).status).toBe('invalid');
    });

    it('rejects stale binding context before effects', async () =>
    {
        const f = await fixture();
        const binding = f.first.port.binding();
        f.first.dispatch([{ from: 0, to: 0, insert: 'new-source' }]);
        f.first.port.binding = () => binding;
        const reveal = vi.spyOn(f.first.port, 'reveal');
        expect((await f.adapter.navigate(f.intent(1))).status).toBe('invalid');
        expect(reveal).not.toHaveBeenCalled();
    });

    it.each(['missing', 'reverse', 'cross-document'] as const)('rejects %s public dispatch maps', async kind =>
    {
        const f = await fixture();
        const saved = f.first.capture();
        const first = f.first.dispatch([{ from: 0, to: 0, insert: 'X' }]);
        const second = f.first.dispatch([{ from: 0, to: 0, insert: 'Y' }]);
        const foreign = f.second.dispatch([{ from: 0, to: 0, insert: 'Z' }]);
        f.first.port.transactions = () => kind === 'missing' ? [] : kind === 'reverse' ? [second, first] : [foreign];
        const result = await f.adapter.navigate(f.intent(1, f.first, { anchor: projectAuthoringNavigationAnchor(saved) }));
        expect(result.status).toBe('invalid');
        expect(f.adapter.history.exportState().cursor).toBe(-1);
    });

    it.each(['focusAcknowledged', 'viewportAcknowledged'] as const)('requires actual %s', async field =>
    {
        const f = await fixture();
        const original = f.first.port.reveal;
        f.first.port.reveal = async (...args) => ({ ...await original(...args), [field]: false });
        expect((await f.adapter.navigate(f.intent(1))).status).toBe('invalid');
        expect(f.adapter.history.exportState().cursor).toBe(-1);
    });

    it('rejects cancellation and late reveal completion', async () =>
    {
        const f = await fixture();
        const controller = new AbortController();
        const original = f.first.port.reveal;
        f.first.port.reveal = async (...args) =>
        {
            const ack = await original(...args);
            controller.abort();
            return ack;
        };
        expect((await f.adapter.navigate(f.intent(1), controller.signal)).status).toBe('cancelled');
        expect(f.adapter.history.exportState()).toMatchObject({ cursor: -1, pending: null });
    });

    it('keeps original route tokens distinct from copied and older tokens', async () =>
    {
        const f = await fixture();
        expect((await f.adapter.navigate(f.intent(1))).status).toBe('completed');
        expect(f.adapter.observeRoute(f.tokens[0]).status).toBe('ignored');
        expect(f.adapter.observeRoute({ ...f.tokens[0] }).status).toBe('invalid');
        expect((await f.adapter.navigate(f.intent(2, f.second))).status).toBe('completed');
        expect(f.adapter.observeRoute(f.tokens[0]).status).toBe('stale');
    });
});

describe('mounted admission across all effect boundaries', () =>
{
    it.each(['reveal', 'route'] as const)('fails a traversal when its loan is retired during %s', async phase =>
    {
        const f = await fixture();
        await f.adapter.navigate(f.intent(1));
        await f.adapter.navigate(f.intent(2, f.second));
        const retire = () => f.hosts.splice(f.hosts.indexOf(f.first), 1);
        if (phase === 'reveal')
        {
            const original = f.first.port.reveal;
            f.first.port.reveal = async (...args) => { const ack = await original(...args); retire(); return ack; };
        }
        else f.setRoute(async () => { retire(); });
        expect((await f.adapter.traverse('back', `boundary:${phase}`, 3)).status).not.toBe('completed');
        expect(f.adapter.history.exportState()).toMatchObject({ cursor: 1, pending: null });
    });

    it('checks the map again after the route callback before settlement', async () =>
    {
        const f = await fixture();
        await f.adapter.navigate(f.intent(1));
        await f.adapter.navigate(f.intent(2, f.second));
        const binding = f.first.port.binding;
        f.setRoute(async () => { f.first.port.binding = () => ({ document: binding().document, map: f.second.port.binding().map }); });
        expect((await f.adapter.traverse('back', 'boundary:route-map', 3)).status).not.toBe('completed');
        expect(f.adapter.history.exportState()).toMatchObject({ cursor: 1, pending: null });
    });
});
