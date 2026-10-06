import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as wire from '@/codecs/binary/authoringCanvasWire.generated';
const api = vi.hoisted(() => ({ list: vi.fn(), header: vi.fn(), nodes: vi.fn(), edges: vi.fn(),
    history: vi.fn(), prepare: vi.fn(), apply: vi.fn(), undoRedo: vi.fn(), create: vi.fn(), delete: vi.fn(), resolve: vi.fn() }));
vi.mock('@/api/authoringCanvas', () => ({ authoringCanvasApi: api }));
import { canvasSafeInteger, canvasWireCommands, createAuthoringCanvasSession } from '@/services/authoringCanvasSession';
const id = '11111111-1111-1111-1111-111111111111';
const noteId = '22222222-2222-2222-2222-222222222222';
const frameId = '33333333-3333-3333-3333-333333333333';
const edgeId = '44444444-4444-4444-4444-444444444444';
const requestId = '55555555-5555-5555-5555-555555555555';
const journalId = '66666666-6666-6666-6666-666666666666';
const digest = 'a'.repeat(64);
const owner = { adminPrincipalId: '9223372036854775807', siteScope: 'primary-site' };
function header(revision = '1', nodeCount = 0, edgeCount = 0): wire.AuthoringCanvasDocumentHeader {
    return { id, owner, schemaVersion: 1, revision, title: 'Private canvas', viewport: { x: 0, y: 0, zoom: 1 },
        nodeCount, edgeCount, createdAtUtc: '0', updatedAtUtc: '0', contentDigest: digest };
}
function note(): wire.AuthoringCanvasNode {
    return { id: noteId, type: 3, order: 40, geometry: { x: 10, y: 20, width: 240, height: 140 },
        targetArticleId: null, targetHeadingIdentity: null, targetBlockIdentity: null, pinnedTargetRevision: null,
        displayProjectionReference: null, referenceState: null, noteSource: 'Retained note', frameLabel: null, members: [] };
}
function window(revision = '1') {
    return { canvasId: id, revision, canvasContentDigest: digest, historyDigest: 'b'.repeat(64), undoEntries: [], redoEntries: [] };
}
function bind(value = header(), nodes: wire.AuthoringCanvasNode[] = [], edges: wire.AuthoringCanvasEdge[] = []) {
    api.list.mockResolvedValue({ owner, items: [], nextCursor: null });
    api.header.mockResolvedValue(value);
    api.nodes.mockResolvedValue({ canvasId: id, revision: value.revision, contentDigest: digest, items: nodes, nextCursor: null });
    api.edges.mockResolvedValue({ canvasId: id, revision: value.revision, contentDigest: digest, items: edges, nextCursor: null });
    api.history.mockResolvedValue(window(value.revision));
}
beforeEach(() => { vi.resetAllMocks(); bind(); });
describe('server Canvas session authority', () => {
    it('retains the actual isolated principal int64 even with an empty owner list', async () => {
        const session = await createAuthoringCanvasSession();
        expect(session.ownerContext).toEqual({ userId: owner.adminPrincipalId, siteId: owner.siteScope });
    });
    it.each(['9007199254740993', '9223372036854775807', '01', '1e3'])('refuses presentation integer loss: %s', value => {
        expect(() => canvasSafeInteger(value)).toThrow();
    });
    it('requires node counts to agree with the complete read instead of accepting truncation', async () => {
        bind(header('1', 1));
        const session = await createAuthoringCanvasSession();
        await expect(session.storage.getCanvas(id, session.ownerContext)).rejects.toThrow('count_mismatch');
    });
    it('refuses a changed coordinate on the final header', async () => {
        api.header.mockResolvedValueOnce(header()).mockResolvedValueOnce(header('2'));
        const session = await createAuthoringCanvasSession();
        await expect(session.storage.getCanvas(id, session.ownerContext)).rejects.toThrow('coordinate_changed');
    });
    it('refuses an empty page carrying another cursor', async () => {
        api.nodes.mockResolvedValue({ canvasId: id, revision: '1', contentDigest: digest, items: [],
            nextCursor: { order: '1', id: noteId } });
        const session = await createAuthoringCanvasSession();
        await expect(session.storage.getCanvas(id, session.ownerContext)).rejects.toThrow('empty_cursor');
    });
    it('refuses a foreign owner read before exposing document content', async () => {
        api.header.mockResolvedValue({ ...header(), owner: { ...owner, adminPrincipalId: '2' } });
        const session = await createAuthoringCanvasSession();
        await expect(session.storage.getCanvas(id, session.ownerContext)).rejects.toThrow('owner_context_mismatch');
    });
    it('refuses whole-document updates at the production boundary', async () => {
        const session = await createAuthoringCanvasSession();
        await expect(session.storage.updateCanvas(id, 1, { title: 'Forged write' }, session.ownerContext, requestId))
            .rejects.toThrow('whole_document_mutation_unsupported');
        expect(api.apply).not.toHaveBeenCalled();
    });
    it('includes incident edge removal and frame membership cleanup in one legal delete intention', () => {
        const value = note();
        const frame = { ...value, id: frameId, type: 4 as const, order: 41, noteSource: null, frameLabel: 'Frame', members: [noteId] };
        const edge = { id: edgeId, type: 0 as const, order: 9, sourceNodeId: noteId, targetNodeId: frameId, label: null };
        const commands = canvasWireCommands({ header: header('1', 2, 1), nodes: [value, frame], edges: [edge] },
            { type: 'delete-node', nodeId: noteId });
        expect(commands).toHaveLength(1); expect(commands[0].kind).toBe(11);
        expect(commands[0].before.map(f => [f.kind, f.id])).toEqual([[0, noteId], [1, edgeId], [0, frameId]]);
        expect(commands[0].after.find(f => f.id === edgeId)?.exists).toBe(false);
        expect(commands[0].after.find(f => f.id === frameId)?.node?.members).toEqual([]);
    });
    it('preserves hidden server reference metadata during a geometry change', () => {
        const reference = { ...note(), type: 0 as const, targetArticleId: 1, referenceState: 3 as const,
            noteSource: null, pinnedTargetRevision: '9223372036854775807', displayProjectionReference: digest };
        const commands = canvasWireCommands({ header: header('1', 1), nodes: [reference], edges: [] },
            { type: 'move-node', nodeId: noteId, x: 400, y: 500 });
        expect(commands[0].after[0].node).toEqual({ ...reference, geometry: { ...reference.geometry, x: 400, y: 500 } });
        expect(commands[0].before[0]).not.toHaveProperty('contentDigest');
    });
    it('builds dependent batch intentions without changing the server snapshot or granting local success', () => {
        const snapshot = { header: header('1', 1), nodes: [note()], edges: [] };
        const original = structuredClone(snapshot);
        const commands = canvasWireCommands(snapshot, { type: 'batch', commands: [
            { type: 'move-node', nodeId: noteId, x: 40, y: 50 },
            { type: 'resize-node', nodeId: noteId, width: 300, height: 200 }
        ] });
        expect(snapshot).toEqual(original);
        expect(commands).toHaveLength(2);
        expect(commands[1].before[0].node?.geometry).toEqual({ x: 40, y: 50, width: 240, height: 140 });
        expect(commands[1].after[0].node?.geometry).toEqual({ x: 40, y: 50, width: 300, height: 200 });
        expect(commands.every(command => !('contentDigest' in command))).toBe(true);
        expect(api.apply).not.toHaveBeenCalled();
    });
    it('converts edge type changes into closed disconnect/connect commands without changing its order', () => {
        const edge = { id: edgeId, type: 0 as const, order: 9, sourceNodeId: noteId, targetNodeId: frameId, label: null };
        const commands = canvasWireCommands({ header: header('1', 0, 1), nodes: [], edges: [edge] },
            { type: 'edit-edge', edgeId, edgeType: 'explicit-reference-note' });
        expect(commands.map(command => command.kind)).toEqual([8, 7]);
        expect(commands[1].after[0].edge?.order).toBe(9);
    });
    it('rejects frame-label changes for which the sole domain engine has no transition', () => {
        const frame = { ...note(), id: frameId, type: 4 as const, noteSource: null, frameLabel: 'Original', members: [noteId] };
        expect(() => canvasWireCommands({ header: header('1', 1), nodes: [frame], edges: [] },
            { type: 'group-nodes', frameId, memberNodeIds: [], label: 'Unsupported rename' })).toThrow('label_change_unsupported');
    });
    it('uses the server-selected first history journal and verifies its actual readback', async () => {
        const first = { journalId, revision: '1', mode: 0 as const, requestId, targetJournalId: null };
        const second = { ...first, journalId: edgeId };
        api.history.mockResolvedValueOnce({ ...window(), undoEntries: [first, second] }).mockResolvedValueOnce(window('2'));
        api.undoRedo.mockResolvedValue({ canvasId: id, requestId, mode: 1, revision: '2', status: 0,
            undoDepth: 0, redoDepth: 0, receiptDigest: digest, canvasContentDigest: digest, journalId, targetJournalId: journalId });
        api.header.mockResolvedValueOnce(header()).mockResolvedValueOnce(header())
            .mockResolvedValueOnce(header('2')).mockResolvedValueOnce(header('2'));
        api.nodes.mockResolvedValueOnce({ canvasId: id, revision: '1', contentDigest: digest, items: [], nextCursor: null })
            .mockResolvedValueOnce({ canvasId: id, revision: '2', contentDigest: digest, items: [], nextCursor: null });
        api.edges.mockResolvedValueOnce({ canvasId: id, revision: '1', contentDigest: digest, items: [], nextCursor: null })
            .mockResolvedValueOnce({ canvasId: id, revision: '2', contentDigest: digest, items: [], nextCursor: null });
        const session = await createAuthoringCanvasSession();
        const result = await session.undo(id, 1, requestId);
        expect(api.undoRedo.mock.calls[0][1].targetJournalId).toBe(journalId);
        expect(result.document.revision).toBe(2);
        expect(result.receipt.canvasContentDigest).toBe(result.document.contentDigest);
    });
    it('checks document/history coordinates before exposing loaded undo depths', async () => {
        api.history.mockResolvedValue({ ...window(), canvasContentDigest: 'c'.repeat(64) });
        const session = await createAuthoringCanvasSession();
        await expect(session.history(id, 1, digest)).rejects.toThrow('history_coordinate_mismatch');
    });
    it('refuses a stale history before sending operation intentions', async () => {
        bind(header('2', 1), [note()]);
        const session = await createAuthoringCanvasSession();
        await expect(session.apply(id, 1, requestId, { type: 'move-node', nodeId: noteId, x: 20, y: 30 }))
            .rejects.toThrow('revision_conflict');
        expect(api.apply).not.toHaveBeenCalled();
    });
    it('refuses an operation receipt belonging to another request', async () => {
        bind(header('1', 1), [note()]);
        api.apply.mockResolvedValue({ canvasId: id, requestId: edgeId, mode: 0, revision: '2', status: 0,
            undoDepth: 1, redoDepth: 0, receiptDigest: digest, canvasContentDigest: digest, journalId });
        const session = await createAuthoringCanvasSession();
        await expect(session.apply(id, 1, requestId, { type: 'move-node', nodeId: noteId, x: 20, y: 30 }))
            .rejects.toThrow('operation_receipt_mismatch');
    });
    it.each(['identity', 'permission-leak', 'receipt-substitution'])('refuses server resolution %s', async defect => {
        const session = await createAuthoringCanvasSession();
        api.resolve.mockImplementation(async (_canvasId, request) => {
            const projection = { nodeId: noteId, nodeType: 0, targetArticleId: 7,
                targetHeadingIdentity: null, targetBlockIdentity: null, status: 7, title: null, contextSnippet: null,
                targetRevision: null, currentTargetRevision: null, openIntent: null, updateAvailable: false,
                displayProjectionReference: null, contentDigest: digest };
            if (defect === 'identity') projection.nodeId = edgeId;
            if (defect === 'permission-leak') projection.title = 'Private title' as never;
            const receiptItem = { ...projection };
            if (defect === 'receipt-substitution') receiptItem.targetArticleId = 8;
            return { canvasId: id, canvasRevision: '1', canvasContentDigest: digest, projections: [projection], contentDigest: digest,
                authorityCoordinate: { generation: '1', contentDigest: digest, permissionFingerprint: 'actual-read-scope' },
                receipt: { requestId: request.requestId, canvasId: id, canvasRevision: '1', canvasContentDigest: digest,
                    authorityGeneration: '1', authorityContentDigest: digest, permissionFingerprint: 'actual-read-scope',
                    targetCount: 1, items: [receiptItem] } };
        });
        await expect(session.projections.resolveReferences([{ id: noteId, type: 'article-reference', targetArticleId: 7,
            x: 0, y: 0, width: 240, height: 140 }], { ...session.ownerContext, canvasId: id,
            canvasRevision: 1, documentDigest: digest })).rejects.toThrow();
        const sent = api.resolve.mock.calls[0][1];
        expect(sent.nodeIds).toEqual([noteId]);
        expect(sent).not.toHaveProperty('owner');
        expect(sent).not.toHaveProperty('nodes');
    });

    it('binds the receipt command-kind roster to the actual sent intentions', async () => {
        bind(header('1', 1), [note()]);
        api.apply.mockResolvedValue({ canvasId: id, requestId, mode: 0, revision: '2', status: 0,
            undoDepth: 1, redoDepth: 0, receiptDigest: digest, canvasContentDigest: digest, journalId,
            targetJournalId: null, commandCount: 1, commandKinds: [10] });
        const session = await createAuthoringCanvasSession();
        await expect(session.apply(id, 1, requestId, { type: 'move-node', nodeId: noteId, x: 20, y: 30 }))
            .rejects.toThrow('operation_receipt_mismatch');
        expect(api.apply.mock.calls[0][1].commands[0].kind).toBe(3);
    });

    it('prepares reference metadata once and retains exact payload and request IDs across failed submission retries', async () => {
        api.prepare.mockImplementation(async (_canvasId, raw) => ({ ...raw, commands: raw.commands.map((command: wire.AuthoringCanvasWireCommand) => ({
            ...command, after: command.after.map(fact => ({ ...fact, node: fact.node ? { ...fact.node,
                referenceState: 1, displayProjectionReference: digest } : null })) })) }));
        api.apply.mockRejectedValue(new Error('transport_lost_after_submission'));
        const session = await createAuthoringCanvasSession();
        const command = { type: 'create-node' as const, node: { id: noteId, type: 'article-reference' as const,
            targetArticleId: 7, x: 10, y: 20, width: 240, height: 140 } };
        await expect(session.apply(id, 1, requestId, command)).rejects.toThrow('transport_lost');
        const sent = structuredClone(api.apply.mock.calls[0][1]);
        expect(sent.commands[0].after[0].node.displayProjectionReference).toBe(digest);
        expect(session.pendingWrite()).toEqual({ canvasId: id, expectedRevision: 1, requestId, mode: 'apply' });
        api.header.mockRejectedValue(new Error('retry_must_not_read_fresh_snapshot'));
        await expect(session.retryPending()).rejects.toThrow('transport_lost');
        expect(api.prepare).toHaveBeenCalledTimes(1);
        expect(api.apply.mock.calls[1][1]).toEqual(sent);
        await expect(session.apply(id, 1, edgeId, command)).rejects.toThrow('pending_request_mismatch');
        expect(api.apply).toHaveBeenCalledTimes(2);
    });
    it.each(['target', 'geometry', 'request'])('rejects a prepared response that changes %s intention', async defect => {
        api.prepare.mockImplementation(async (_canvasId, raw) => {
            const prepared = structuredClone(raw);
            const node = prepared.commands[0].after[0].node;
            node.referenceState = 1; node.displayProjectionReference = digest;
            if (defect === 'target') node.targetArticleId = 8;
            if (defect === 'geometry') node.geometry.x = 999;
            if (defect === 'request') prepared.requestId = edgeId;
            return prepared;
        });
        const session = await createAuthoringCanvasSession();
        await expect(session.apply(id, 1, requestId, { type: 'create-node', node: { id: noteId, type: 'article-reference',
            targetArticleId: 7, x: 10, y: 20, width: 240, height: 140 } })).rejects.toThrow('preparation_intent_mismatch');
        expect(api.apply).not.toHaveBeenCalled();
        expect(session.pendingWrite()).toBeNull();
    });

    it.each([['undo', 1], ['redo', 2]] as const)('retains exact %s payload for an unknown-response retry', async (method, mode) => {
        const entry = { journalId, revision: '1', mode: 0 as const, requestId, targetJournalId: null };
        api.history.mockResolvedValue({ ...window(), undoEntries: mode === 1 ? [entry] : [], redoEntries: mode === 2 ? [entry] : [] });
        api.undoRedo.mockRejectedValue(new Error('transport_lost_after_submission'));
        const session = await createAuthoringCanvasSession();
        await expect(session[method](id, 1, requestId)).rejects.toThrow('transport_lost');
        const sent = structuredClone(api.undoRedo.mock.calls[0][1]);
        expect(session.pendingWrite()).toEqual({ canvasId: id, expectedRevision: 1, requestId, mode: method });
        api.header.mockRejectedValue(new Error('retry_must_not_read_fresh_snapshot'));
        await expect(session.retryPending()).rejects.toThrow('transport_lost');
        expect(api.undoRedo.mock.calls[1][1]).toEqual(sent);
        await expect(session[method](id, 1, edgeId)).rejects.toThrow('pending_request_mismatch');
        expect(api.undoRedo).toHaveBeenCalledTimes(2);
    });

    it('releases a refused read-only preparation so a later legal note intention can be sent', async () => {
        api.prepare.mockRejectedValue(new Error('canvas_operation_reference_unavailable'));
        api.apply.mockRejectedValue(new Error('transport_lost_after_submission'));
        const session = await createAuthoringCanvasSession();
        await expect(session.apply(id, 1, requestId, { type: 'create-node', node: { id: noteId, type: 'article-reference',
            targetArticleId: 7, x: 10, y: 20, width: 240, height: 140 } })).rejects.toThrow('reference_unavailable');
        expect(session.pendingWrite()).toBeNull();
        expect(api.apply).not.toHaveBeenCalled();
        await expect(session.apply(id, 1, edgeId, { type: 'create-node', node: { id: noteId, type: 'plain-text-note',
            text: 'Legal private note', x: 10, y: 20, width: 240, height: 140 } })).rejects.toThrow('transport_lost');
        expect(api.apply).toHaveBeenCalledTimes(1);
        expect(api.apply.mock.calls[0][1].requestId).toBe(edgeId);
        expect(session.pendingWrite()?.requestId).toBe(edgeId);
    });

});
