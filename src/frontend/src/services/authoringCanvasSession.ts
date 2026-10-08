import { authoringCanvasApi } from '@/api/authoringCanvas';
import * as wire from '@/codecs/binary/authoringCanvasWire.generated';
import { authoringCanvasLimits } from '@/codecs/binary/authoringCanvasWire.generated';
import type { AuthoringCanvasSession, CanvasOperationReceipt } from '@/composables/useAuthoringCanvas';
import { validateAuthoringCanvasDocument, type AuthoringCanvasDocument, type AuthoringCanvasNode, type AuthoringCanvasEdge, type AuthoringCanvasReferenceProjection } from '@/contracts/authoringCanvas';
import type { AuthoringCanvasCommand } from '@/services/authoringCanvasOperations';
import type { CanvasOwnerContext, AuthoringCanvasStorage } from '@/services/authoringCanvasStorage';
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';
const NODE_TYPES = ['article-reference', 'heading-reference', 'block-reference', 'plain-text-note', 'group-frame'] as const;
const STATUSES = ['current', 'pinned-current', 'pinned-stale', 'target-updated', 'missing', 'deleted', 'archived',
    'permission-denied', 'heading-missing', 'duplicate', 'invalid', 'block-missing', 'duplicate', 'invalid', 'source-stale'] as const;
interface WireSnapshot
{
    header: wire.AuthoringCanvasDocumentHeader;
    nodes: wire.AuthoringCanvasNode[];
    edges: wire.AuthoringCanvasEdge[];
}
/** Presentation numbers may never round a server int64 coordinate. */
export function canvasSafeInteger(value: string): number
{
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(value))
    {
        throw new Error('canvas_integer_invalid');
    }
    const result = Number(value);
    if (!Number.isSafeInteger(result) || BigInt(result) !== BigInt(value))
    {
        throw new Error('canvas_integer_range');
    }
    return result;
}
function revision(value: number): string
{
    if (!Number.isSafeInteger(value) || value < 1)
    {
        throw new Error('canvas_revision_invalid');
    }
    return String(value);
}
function timestamp(value: string): string
{
    const date = new Date(canvasSafeInteger(value));
    if (!Number.isFinite(date.getTime()))
    {
        throw new Error('canvas_timestamp_invalid');
    }
    return date.toISOString();
}
function ownerOf(header: wire.AuthoringCanvasDocumentHeader): CanvasOwnerContext
{
    return { userId: header.owner.adminPrincipalId, siteId: header.owner.siteScope };
}
function requireOwner(owner: CanvasOwnerContext, context: CanvasOwnerContext): void
{
    if (context.userId !== owner.userId || context.siteId !== owner.siteId)
    {
        throw new Error('canvas_owner_context_mismatch');
    }
}
function requireHeader(header: wire.AuthoringCanvasDocumentHeader, canvasId: string, owner: CanvasOwnerContext): void
{
    requireOwner(owner, ownerOf(header));
    if (header.id !== canvasId || header.schemaVersion !== 1 || canvasSafeInteger(header.revision) < 1
        || header.nodeCount < 0 || header.nodeCount > authoringCanvasLimits.maxNodesPerCanvas || header.edgeCount < 0 || header.edgeCount > authoringCanvasLimits.maxEdgesPerCanvas
        || !/^[0-9a-f]{64}$/.test(header.contentDigest))
    {
        throw new Error('canvas_header_invalid');
    }
}
function coordinate(left: wire.AuthoringCanvasDocumentHeader, right: {
    revision: string;
    contentDigest: string;
}): void
{
    if (left.revision !== right.revision || left.contentDigest !== right.contentDigest)
    {
        throw new Error('canvas_read_coordinate_changed');
    }
}
function cursorKey(cursor: wire.AuthoringCanvasPageCursor): string
{
    return `${cursor.order}:${cursor.id}`;
}
async function readSnapshot(canvasId: string, owner: CanvasOwnerContext, signal?: AbortSignal): Promise<WireSnapshot>
{
    const header = await authoringCanvasApi.header(canvasId, signal);
    requireHeader(header, canvasId, owner);
    async function collect<T extends {
        id: string;
        order: number;
    }>(count: number, reader: (cursor: wire.AuthoringCanvasPageCursor | null) => Promise<{
        canvasId: string;
        revision: string;
        contentDigest: string;
        items: readonly T[];
        nextCursor: wire.AuthoringCanvasPageCursor | null;
    }>): Promise<T[]>
    {
        const items: T[] = [];
        const identities = new Set<string>();
        const cursors = new Set<string>();
        let cursor: wire.AuthoringCanvasPageCursor | null = null;
        let previous: T | undefined;
        do
        {
            const page = await reader(cursor);
            if (page.canvasId !== canvasId || page.items.length > authoringCanvasLimits.maxPageSize)
            {
                throw new Error('canvas_page_invalid');
            }
            coordinate(header, page);
            if (page.nextCursor && page.items.length === 0)
            {
                throw new Error('canvas_page_empty_cursor');
            }
            for (const item of page.items)
            {
                if (identities.has(item.id) || (previous && (item.order < previous.order
                    || (item.order === previous.order && item.id <= previous.id))))
                {
                    throw new Error('canvas_page_order_invalid');
                }
                identities.add(item.id);
                items.push(item);
                previous = item;
                if (items.length > count)
                {
                    throw new Error('canvas_page_count_mismatch');
                }
            }
            cursor = page.nextCursor;
            if (cursor)
            {
                const key = cursorKey(cursor);
                if (cursors.has(key) || !previous || cursor.order !== String(previous.order) || cursor.id !== previous.id)
                {
                    throw new Error('canvas_page_cursor_invalid');
                }
                cursors.add(key);
            }
        } while (cursor);
        if (items.length !== count)
        {
            throw new Error('canvas_page_count_mismatch');
        }
        return items;
    }
    const nodes = await collect(header.nodeCount, cursor => authoringCanvasApi.nodes(canvasId, cursor, signal));
    const edges = await collect(header.edgeCount, cursor => authoringCanvasApi.edges(canvasId, cursor, signal));
    const final = await authoringCanvasApi.header(canvasId, signal);
    requireHeader(final, canvasId, owner);
    coordinate(header, final);
    if (final.nodeCount !== header.nodeCount || final.edgeCount !== header.edgeCount)
    {
        throw new Error('canvas_page_count_mismatch');
    }
    return { header, nodes, edges };
}
function presentNode(node: wire.AuthoringCanvasNode): AuthoringCanvasNode
{
    const common = { id: node.id, ...node.geometry, zIndex: node.order };
    switch (node.type)
    {
        case 0: return { ...common, type: 'article-reference', targetArticleId: node.targetArticleId!,
            ...(node.pinnedTargetRevision === null ? {} : { pinnedTargetRevision: node.pinnedTargetRevision }) };
        case 1: return { ...common, type: 'heading-reference', targetArticleId: node.targetArticleId!,
            targetHeadingId: node.targetHeadingIdentity!,
            ...(node.pinnedTargetRevision === null ? {} : { pinnedTargetRevision: node.pinnedTargetRevision }) };
        case 2: return { ...common, type: 'block-reference', targetArticleId: node.targetArticleId!,
            targetBlockId: node.targetBlockIdentity!,
            ...(node.pinnedTargetRevision === null ? {} : { pinnedTargetRevision: node.pinnedTargetRevision }) };
        case 3: return { ...common, type: 'plain-text-note', text: node.noteSource! };
        case 4: return { ...common, type: 'group-frame', label: node.frameLabel!, memberNodeIds: [...(node.members ?? [])] };
        default: throw new Error('canvas_node_type_invalid');
    }
}
function presentation(snapshot: WireSnapshot): AuthoringCanvasDocument
{
    const { header } = snapshot;
    const nodes = Object.fromEntries(snapshot.nodes.map(node => [node.id, presentNode(node)]));
    const edges = Object.fromEntries(snapshot.edges.map(edge => [edge.id, { id: edge.id,
        type: edge.type === 0 ? 'visual-only' as const : 'explicit-reference-note' as const,
        sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId,
        ...(edge.label === null ? {} : { label: edge.label }) }]));
    const document: AuthoringCanvasDocument = {
        id: header.id, ...ownerOf(header), title: header.title, revision: canvasSafeInteger(header.revision),
        viewport: { ...header.viewport }, nodeIds: snapshot.nodes.map(node => node.id), nodes,
        edgeIds: snapshot.edges.map(edge => edge.id), edges, createdAt: timestamp(header.createdAtUtc),
        updatedAt: timestamp(header.updatedAtUtc), contentDigest: header.contentDigest
    };
    const check = validateAuthoringCanvasDocument(document);
    if (!check.valid)
    {
        throw new Error(`canvas_presentation_invalid: ${check.error}`);
    }
    return document;
}
function nextOrder(items: {
    order: number;
}[]): number
{
    const order = items.reduce((max, item) => Math.max(max, item.order), -1) + 1;
    if (!Number.isInteger(order) || order < 0 || order > 2147483647)
    {
        throw new Error('canvas_order_exhausted');
    }
    return order;
}
function positiveInt32(value: number | string): number
{
    const number = typeof value === 'string' ? canvasSafeInteger(value) : value;
    if (!Number.isInteger(number) || number < 1 || number > 2147483647)
    {
        throw new Error('canvas_article_id_invalid');
    }
    return number;
}
function pin(value: number | string): string
{
    const text = String(value);
    if (!/^[1-9][0-9]*$/.test(text) || BigInt(text) > 9223372036854775807n)
    {
        throw new Error('canvas_pin_invalid');
    }
    return text;
}
function newNode(node: AuthoringCanvasNode, order: number): wire.AuthoringCanvasNode
{
    const type = NODE_TYPES.indexOf(node.type);
    if (type < 0)
    {
        throw new Error('canvas_node_type_invalid');
    }
    const reference = node.type === 'article-reference' || node.type === 'heading-reference' || node.type === 'block-reference';
    return { id: node.id, type: type as wire.AuthoringCanvasNode['type'], order,
        geometry: { x: node.x, y: node.y, width: node.width, height: node.height },
        targetArticleId: reference ? positiveInt32(node.targetArticleId) : null,
        targetHeadingIdentity: node.type === 'heading-reference' ? node.targetHeadingId : null,
        targetBlockIdentity: node.type === 'block-reference' ? node.targetBlockId : null,
        pinnedTargetRevision: reference && node.pinnedTargetRevision !== undefined ? pin(node.pinnedTargetRevision) : null,
        displayProjectionReference: null, referenceState: reference ? (node.pinnedTargetRevision === undefined ? 0 : 2) : null,
        noteSource: node.type === 'plain-text-note' ? node.text : null,
        frameLabel: node.type === 'group-frame' ? node.label : null,
        members: node.type === 'group-frame' ? [...node.memberNodeIds] : [] };
}
function newEdge(edge: AuthoringCanvasEdge, order: number): wire.AuthoringCanvasEdge
{
    return { id: edge.id, type: edge.type === 'visual-only' ? 0 : 1, order,
        sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId, label: edge.label ?? null };
}
function fact(kind: 0 | 1 | 2, id: string, value?: wire.AuthoringCanvasNode | wire.AuthoringCanvasEdge | wire.AuthoringCanvasViewport): wire.AuthoringCanvasOperationFact
{
    return { kind, id, exists: value !== undefined, node: kind === 0 && value ? value as wire.AuthoringCanvasNode : null,
        edge: kind === 1 && value ? value as wire.AuthoringCanvasEdge : null,
        viewport: kind === 2 && value ? value as wire.AuthoringCanvasViewport : null };
}
/** Derives unsealed intentions from fresh server facts; never issues a document or transition digest. */
export function canvasWireCommands(snapshot: WireSnapshot, input: AuthoringCanvasCommand): wire.AuthoringCanvasWireCommand[]
{
    let nodes = snapshot.nodes;
    let edges = snapshot.edges;
    let viewport = { ...snapshot.header.viewport };
    let commands: wire.AuthoringCanvasWireCommand[] = [];
    let totalFacts = 0;
    function emit(kind: wire.AuthoringCanvasWireCommand['kind'], before: wire.AuthoringCanvasOperationFact[], after: wire.AuthoringCanvasOperationFact[]): void
    {
        totalFacts += before.length + after.length;
        if (totalFacts > authoringCanvasLimits.maxFactsPerTransaction * 2 || commands.length >= authoringCanvasLimits.maxCommandsPerTransaction)
        {
            throw new Error('canvas_operation_budget_exceeded');
        }
        commands = [...commands, { commandId: crypto.randomUUID(), kind, before, after }];
        for (const value of after)
        {
            if (value.kind === 0)
            {
                nodes = [...nodes.filter(node => node.id !== value.id), ...(value.exists ? [value.node!] : [])];
            }
            else if (value.kind === 1)
            {
                edges = [...edges.filter(edge => edge.id !== value.id), ...(value.exists ? [value.edge!] : [])];
            }
            else
            {
                viewport = { ...value.viewport! };
            }
        }
    }
    function node(id: string): wire.AuthoringCanvasNode
    {
        const value = nodes.find(item => item.id === id);
        if (!value)
        {
            throw new Error('canvas_node_unavailable');
        }
        return value;
    }
    function edge(id: string): wire.AuthoringCanvasEdge
    {
        const value = edges.find(item => item.id === id);
        if (!value)
        {
            throw new Error('canvas_edge_unavailable');
        }
        return value;
    }
    function changeNode(kind: wire.AuthoringCanvasWireCommand['kind'], before: wire.AuthoringCanvasNode, after: wire.AuthoringCanvasNode): void
    {
        emit(kind, [fact(0, before.id, before)], [fact(0, after.id, after)]);
    }
    function removeNode(id: string): void
    {
        const target = node(id);
        const before = [fact(0, id, target)];
        const after = [fact(0, id)];
        for (const item of edges)
        {
            if (item.sourceNodeId === id || item.targetNodeId === id)
            {
                before.push(fact(1, item.id, item));
                after.push(fact(1, item.id));
            }
        }
        for (const item of nodes)
        {
            if (item.id !== id && item.type === 4 && item.members?.includes(id))
            {
                before.push(fact(0, item.id, item));
                after.push(fact(0, item.id, { ...item, members: item.members.filter(member => member !== id) }));
            }
        }
        emit(11, before, after);
    }
    function execute(command: AuthoringCanvasCommand, depth: number): void
    {
        if (depth > 64)
        {
            throw new Error('canvas_batch_depth_exceeded');
        }
        switch (command.type)
        {
            case 'batch':
                if (command.commands.length > authoringCanvasLimits.maxCommandsPerTransaction)
                {
                    throw new Error('canvas_operation_budget_exceeded');
                }
                for (const item of command.commands)
                {
                    execute(item, depth + 1);
                }
                return;
            case 'create-node':
            {
                if (nodes.some(item => item.id === command.node.id))
                {
                    throw new Error('canvas_node_duplicate');
                }
                const value = newNode(command.node, nextOrder(nodes));
                emit(value.type === 3 ? 1 : value.type === 4 ? 2 : 0, [fact(0, value.id)], [fact(0, value.id, value)]);
                return;
            }
            case 'delete-node':
                removeNode(command.nodeId);
                return;
            case 'move-node':
            {
                const before = node(command.nodeId);
                changeNode(3, before, { ...before, geometry: { ...before.geometry, x: command.x, y: command.y } });
                return;
            }
            case 'batch-move-nodes':
            {
                if (command.moves.length > authoringCanvasLimits.maxNodesPerCanvas || new Set(command.moves.map(item => item.nodeId)).size !== command.moves.length)
                {
                    throw new Error('canvas_move_roster_invalid');
                }
                const before = command.moves.map(item => fact(0, item.nodeId, node(item.nodeId)));
                const after = command.moves.map(item =>
                {
                    const value = node(item.nodeId);
                    return fact(0, value.id, { ...value, geometry: { ...value.geometry, x: item.x, y: item.y } });
                });
                emit(3, before, after);
                return;
            }
            case 'resize-node':
            {
                const before = node(command.nodeId);
                changeNode(4, before, { ...before, geometry: { ...before.geometry, width: command.width, height: command.height } });
                return;
            }
            case 'create-edge':
            {
                if (edges.some(item => item.id === command.edge.id))
                {
                    throw new Error('canvas_edge_duplicate');
                }
                const value = newEdge(command.edge, nextOrder(edges));
                emit(7, [fact(1, value.id)], [fact(1, value.id, value)]);
                return;
            }
            case 'delete-edge':
            {
                const before = edge(command.edgeId);
                emit(8, [fact(1, before.id, before)], [fact(1, before.id)]);
                return;
            }
            case 'edit-edge':
            {
                const before = edge(command.edgeId);
                const after = { ...before, label: command.label ?? before.label,
                    type: command.edgeType === undefined ? before.type : command.edgeType === 'visual-only' ? 0 as const : 1 as const };
                if (before.type !== after.type)
                {
                    emit(8, [fact(1, before.id, before)], [fact(1, before.id)]);
                    emit(7, [fact(1, after.id)], [fact(1, after.id, after)]);
                }
                else
                {
                    emit(9, [fact(1, before.id, before)], [fact(1, after.id, after)]);
                }
                return;
            }
            case 'edit-note':
            {
                const before = node(command.nodeId);
                if (before.type !== 3)
                {
                    throw new Error('canvas_note_required');
                }
                changeNode(10, before, { ...before, noteSource: command.text });
                return;
            }
            case 'group-nodes':
            {
                const before = nodes.find(item => item.id === command.frameId);
                if (!before)
                {
                    execute({ type: 'create-node', node: { id: command.frameId, type: 'group-frame',
                        x: 0, y: 0, width: 400, height: 300, label: command.label ?? 'Group',
                        memberNodeIds: [...command.memberNodeIds] } }, depth + 1);
                    return;
                }
                if (before.type !== 4 || (command.label !== undefined && command.label !== before.frameLabel))
                {
                    throw new Error('canvas_frame_label_change_unsupported');
                }
                if (new Set(command.memberNodeIds).size !== command.memberNodeIds.length)
                {
                    throw new Error('canvas_members_duplicate');
                }
                const retained = (before.members ?? []).filter(id => command.memberNodeIds.includes(id));
                if (retained.length !== (before.members ?? []).length)
                {
                    changeNode(6, before, { ...before, members: retained });
                }
                const current = node(before.id);
                if (command.memberNodeIds.some(id => !retained.includes(id)))
                {
                    changeNode(5, current, { ...current, members: [...command.memberNodeIds] });
                }
                else if (retained.length === (before.members ?? []).length)
                {
                    throw new Error('canvas_members_unchanged');
                }
                return;
            }
            case 'ungroup-nodes':
            {
                if (node(command.frameId).type !== 4)
                {
                    throw new Error('canvas_frame_required');
                }
                removeNode(command.frameId);
                return;
            }
            case 'set-viewport':
                emit(12, [fact(2, EMPTY_GUID, viewport)], [fact(2, EMPTY_GUID, command.viewport)]);
                return;
            case 'pin-reference':
            case 'unpin-reference':
            {
                const before = node(command.nodeId);
                if (before.type > 2)
                {
                    throw new Error('canvas_reference_required');
                }
                const pinning = command.type === 'pin-reference';
                changeNode(pinning ? 13 : 14, before, { ...before,
                    pinnedTargetRevision: pinning ? pin(command.pinnedRevision) : null, referenceState: pinning ? 2 : 1,
                    displayProjectionReference: null });
                return;
            }
            default: throw new Error('canvas_command_unsupported');
        }
    }
    execute(input, 0);
    if (commands.length === 0)
    {
        throw new Error('canvas_command_empty');
    }
    return commands;
}
async function headers(owner: CanvasOwnerContext | null, signal?: AbortSignal): Promise<{
    owner: CanvasOwnerContext;
    items: wire.AuthoringCanvasDocumentHeader[];
}>
{
    const items: wire.AuthoringCanvasDocumentHeader[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: wire.AuthoringCanvasPageCursor | null = null;
    let actual = owner;
    do
    {
        const page = await authoringCanvasApi.list(cursor, signal);
        const observed = { userId: page.owner.adminPrincipalId, siteId: page.owner.siteScope };
        if (!/^[1-9][0-9]*$/.test(observed.userId) || !observed.siteId)
        {
            throw new Error('canvas_authenticated_owner_invalid');
        }
        if (actual)
        {
            requireOwner(actual, observed);
        }
        else
        {
            actual = observed;
        }
        if (page.items.length > authoringCanvasLimits.maxCanvasesPerOwner || (page.nextCursor && page.items.length === 0))
        {
            throw new Error('canvas_list_invalid');
        }
        for (const item of page.items)
        {
            requireHeader(item, item.id, actual);
            if (ids.has(item.id) || items.length >= authoringCanvasLimits.maxCanvasesPerOwner)
            {
                throw new Error('canvas_list_budget_or_duplicate');
            }
            ids.add(item.id);
            items.push(item);
        }
        cursor = page.nextCursor;
        if (cursor)
        {
            const last = items.at(-1);
            const key = cursorKey(cursor);
            if (!last || cursors.has(key) || cursor.order !== last.revision || cursor.id !== last.id)
            {
                throw new Error('canvas_list_cursor_invalid');
            }
            cursors.add(key);
        }
    } while (cursor);
    return { owner: actual, items };
}
async function history(snapshot: WireSnapshot, signal?: AbortSignal): Promise<wire.AuthoringCanvasHistoryResponse>
{
    const value = await authoringCanvasApi.history(snapshot.header.id, signal);
    if (value.canvasId !== snapshot.header.id || value.revision !== snapshot.header.revision
        || value.canvasContentDigest !== snapshot.header.contentDigest || !/^[0-9a-f]{64}$/.test(value.historyDigest)
        || value.undoEntries.length > authoringCanvasLimits.maxUndoDepth || value.redoEntries.length > authoringCanvasLimits.maxUndoDepth)
    {
        throw new Error('canvas_history_coordinate_mismatch');
    }
    const ids = [...value.undoEntries, ...value.redoEntries].map(entry => entry.journalId);
    if (new Set(ids).size !== ids.length)
    {
        throw new Error('canvas_history_duplicate');
    }
    return value;
}
function sameOpenIntent(left: wire.AuthoringCanvasOpenIntent | null, right: wire.AuthoringCanvasOpenIntent | null): boolean
{
    if (!left || !right)
    {
        return left === right;
    }
    return left.articleId === right.articleId && left.revision === right.revision
        && left.headingIdentity === right.headingIdentity && left.blockIdentity === right.blockIdentity
        && left.stableRoute === right.stableRoute && left.mode === right.mode && left.targetGroupId === right.targetGroupId;
}
function receiptProjection(value: wire.AuthoringCanvasOperationReceipt): CanvasOperationReceipt
{
    return { canvasId: value.canvasId, revision: canvasSafeInteger(value.revision), requestId: value.requestId,
        journalId: value.journalId, undoDepth: value.undoDepth, redoDepth: value.redoDepth,
        receiptDigest: value.receiptDigest, canvasContentDigest: value.canvasContentDigest };
}
function requirePreparedIntent(raw: wire.AuthoringCanvasApplyRequest, prepared: wire.AuthoringCanvasApplyRequest): void
{
    if (prepared.commands.length !== raw.commands.length)
    {
        throw new Error('canvas_preparation_intent_mismatch');
    }
    const versions = new Set<string>();
    const normalized = { ...prepared, commands: prepared.commands.map((command, index) =>
    {
        const original = raw.commands[index];
        const controlsReference = original.kind === 0 || original.kind === 13 || original.kind === 14;
        function normalize(facts: readonly wire.AuthoringCanvasOperationFact[], source: readonly wire.AuthoringCanvasOperationFact[], after: boolean)
        {
            if (facts.length !== source.length)
            {
                throw new Error('canvas_preparation_intent_mismatch');
            }
            return facts.map((fact, factIndex) =>
            {
                const input = source[factIndex];
                if (input.kind === 0 && input.exists && input.node && input.node.type <= 2
                        && fact.node && (versions.has(input.id) || (after && controlsReference)))
                {
                    return { ...fact, node: { ...fact.node, displayProjectionReference: input.node.displayProjectionReference,
                        referenceState: input.node.referenceState } };
                }
                return fact;
            });
        }
        const before = normalize(command.before, original.before, false);
        const after = normalize(command.after, original.after, true);
        for (const fact of original.after)
        {
            if (fact.kind === 0 && controlsReference && fact.exists && fact.node && fact.node.type <= 2)
            {
                versions.add(fact.id);
            }
            else if (fact.kind === 0 && !fact.exists)
            {
                versions.delete(fact.id);
            }
        }
        return { ...command, before, after };
    }) };
    const expected = wire.encodeAuthoringCanvasApplyRequest(raw);
    const actual = wire.encodeAuthoringCanvasApplyRequest(normalized);
    if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index]))
    {
        throw new Error('canvas_preparation_intent_mismatch');
    }
}
export interface AuthoringCanvasServerSession extends AuthoringCanvasSession
{
    pendingWrite(): {
        canvasId: string;
        expectedRevision: number;
        requestId: string;
        mode: 'apply' | 'undo' | 'redo';
    } | null;
    retryPending(): Promise<{
        document: AuthoringCanvasDocument;
        receipt: CanvasOperationReceipt;
    }>;
    history(canvasId: string, expectedRevision: number, documentDigest: string): Promise<{
        canvasId: string;
        revision: number;
        canvasContentDigest: string;
        historyDigest: string;
        undoDepth: number;
        redoDepth: number;
    }>;
}
/** Builds an authenticated session only after obtaining the actual server owner, including an empty list. */
export async function createAuthoringCanvasSession(signal?: AbortSignal): Promise<AuthoringCanvasServerSession>
{
    const initial = await headers(null, signal);
    const ownerContext = Object.freeze({ ...initial.owner });
    let pending: {
        canvasId: string;
        expectedRevision: number;
        requestId: string;
        intention: string;
        raw: wire.AuthoringCanvasApplyRequest;
        prepared: wire.AuthoringCanvasApplyRequest | null;
    } | null = null;
    let pendingHistory: {
        canvasId: string;
        expectedRevision: number;
        requestId: string;
        request: wire.AuthoringCanvasUndoRedoRequest;
    } | null = null;
    async function completeTransition(canvasId: string, requestId: string, mode: 0 | 1 | 2, baseRevision: string, targetJournalId: string | null, expectedKinds: readonly wire.AuthoringCanvasOperationKind[] | null, value: wire.AuthoringCanvasOperationReceipt): Promise<{
        document: AuthoringCanvasDocument;
        receipt: CanvasOperationReceipt;
    }>
    {
        if (value.canvasId !== canvasId || value.requestId !== requestId || value.mode !== mode
            || value.targetJournalId !== targetJournalId
            || (expectedKinds && (value.commandCount !== expectedKinds.length
                || value.commandKinds.length !== expectedKinds.length
                || value.commandKinds.some((kind, index) => kind !== expectedKinds[index])))
            || value.revision !== String(BigInt(baseRevision) + 1n)
            || value.status === 3 || value.undoDepth < 0 || value.undoDepth > authoringCanvasLimits.maxUndoDepth
            || value.redoDepth < 0 || value.redoDepth > authoringCanvasLimits.maxUndoDepth || !/^[0-9a-f]{64}$/.test(value.receiptDigest))
        {
            throw new Error('canvas_operation_receipt_mismatch');
        }
        const next = await readSnapshot(canvasId, ownerContext, signal);
        if (next.header.revision !== value.revision || next.header.contentDigest !== value.canvasContentDigest)
        {
            throw new Error('canvas_operation_readback_mismatch');
        }
        const nextHistory = await history(next, signal);
        if (nextHistory.undoEntries.length !== value.undoDepth || nextHistory.redoEntries.length !== value.redoDepth)
        {
            throw new Error('canvas_operation_history_readback_mismatch');
        }
        return { document: presentation(next), receipt: receiptProjection(value) };
    }
    async function executeTransition(canvasId: string, expectedRevision: number, requestId: string, command?: AuthoringCanvasCommand, mode: 0 | 1 | 2 = 0): Promise<{
        document: AuthoringCanvasDocument;
        receipt: CanvasOperationReceipt;
    }>
    {
        if (mode === 0 && command)
        {
            if (pendingHistory)
            {
                throw new Error('canvas_pending_request_mismatch');
            }
            const intention = JSON.stringify(command);
            if (pending && (pending.canvasId !== canvasId || pending.expectedRevision !== expectedRevision
                || pending.requestId !== requestId || pending.intention !== intention))
            {
                throw new Error('canvas_pending_request_mismatch');
            }
            if (!pending)
            {
                const snapshot = await readSnapshot(canvasId, ownerContext, signal);
                if (snapshot.header.revision !== revision(expectedRevision))
                {
                    throw new Error('canvas_revision_conflict');
                }
                const window = await history(snapshot, signal);
                const raw = { requestId, expectedRevision: snapshot.header.revision,
                    expectedContentDigest: snapshot.header.contentDigest, expectedHistoryDigest: window.historyDigest,
                    commands: canvasWireCommands(snapshot, command) };
                pending = { canvasId, expectedRevision, requestId, intention, raw, prepared: null };
            }
            const current = pending;
            if (!current.prepared)
            {
                if (current.raw.commands.some(item => item.kind === 0 || item.kind === 13 || item.kind === 14))
                {
                    try
                    {
                        const prepared = await authoringCanvasApi.prepare(canvasId, current.raw, signal);
                        requirePreparedIntent(current.raw, prepared);
                        current.prepared = prepared;
                    }
                    catch (error)
                    {
                        // Preparation is read-only; no mutation has been submitted and no receipt can exist.
                        pending = null;
                        throw error;
                    }
                }
                else
                {
                    current.prepared = current.raw;
                }
            }
            const value = await authoringCanvasApi.apply(canvasId, current.prepared, signal);
            const result = await completeTransition(canvasId, requestId, mode, current.prepared.expectedRevision, null, current.prepared.commands.map(item => item.kind), value);
            pending = null;
            return result;
        }
        if (pending)
        {
            throw new Error('canvas_pending_request_mismatch');
        }
        if (pendingHistory && (pendingHistory.canvasId !== canvasId || pendingHistory.expectedRevision !== expectedRevision
            || pendingHistory.requestId !== requestId || pendingHistory.request.mode !== mode))
        {
            throw new Error('canvas_pending_request_mismatch');
        }
        if (!pendingHistory)
        {
            const snapshot = await readSnapshot(canvasId, ownerContext, signal);
            if (snapshot.header.revision !== revision(expectedRevision))
            {
                throw new Error('canvas_revision_conflict');
            }
            const window = await history(snapshot, signal);
            const target = (mode === 1 ? window.undoEntries : window.redoEntries)[0];
            if (!target)
            {
                throw new Error('canvas_history_empty');
            }
            pendingHistory = { canvasId, expectedRevision, requestId, request: { requestId,
                expectedRevision: snapshot.header.revision, expectedContentDigest: snapshot.header.contentDigest,
                expectedHistoryDigest: window.historyDigest, mode, targetJournalId: target.journalId } };
        }
        const current = pendingHistory;
        const value = await authoringCanvasApi.undoRedo(canvasId, current.request, signal);
        const result = await completeTransition(canvasId, requestId, mode, current.request.expectedRevision, current.request.targetJournalId, null, value);
        pendingHistory = null;
        return result;
    }
    let transitionBusy = false;
    async function transition(canvasId: string, expectedRevision: number, requestId: string, command?: AuthoringCanvasCommand, mode: 0 | 1 | 2 = 0)
    {
        if (transitionBusy)
        {
            throw new Error('canvas_operation_in_progress');
        }
        transitionBusy = true;
        try
        {
            return await executeTransition(canvasId, expectedRevision, requestId, command, mode);
        }
        finally
        {
            transitionBusy = false;
        }
    }
    const storage: AuthoringCanvasStorage = {
        async createCanvas(params)
        {
            requireOwner(ownerContext, params);
            if ((params.nodeIds?.length ?? 0) || Object.keys(params.nodes ?? {}).length
                || (params.edgeIds?.length ?? 0) || Object.keys(params.edges ?? {}).length)
            {
                throw new Error('canvas_create_graph_requires_operations');
            }
            const canvasId = crypto.randomUUID();
            const created = await authoringCanvasApi.create({ canvasId, requestId: crypto.randomUUID(),
                title: params.title, viewport: params.viewport ?? { x: 0, y: 0, zoom: 1 } }, signal);
            requireHeader(created, canvasId, ownerContext);
            const snapshot = await readSnapshot(canvasId, ownerContext, signal);
            coordinate(created, snapshot.header);
            return presentation(snapshot);
        },
        async getCanvas(canvasId, context)
        {
            requireOwner(ownerContext, context);
            return presentation(await readSnapshot(canvasId, ownerContext, signal));
        },
        updateCanvas()
        {
            return Promise.reject(new Error('canvas_whole_document_mutation_unsupported'));
        },
        async deleteCanvas(canvasId, expectedRevision, context, requestId)
        {
            requireOwner(ownerContext, context);
            const value = await authoringCanvasApi.delete(canvasId, { requestId, expectedRevision: revision(expectedRevision) }, signal);
            if (value.canvasId !== canvasId || value.commandKind !== 'delete-document'
                || value.revision !== String(BigInt(expectedRevision) + 1n))
            {
                throw new Error('canvas_delete_receipt_mismatch');
            }
            return { success: true, deletedCanvasId: canvasId };
        },
        async listCanvases(context)
        {
            requireOwner(ownerContext, context);
            const result = await headers(ownerContext, signal);
            return result.items.map(item => ({ id: item.id, ...ownerOf(item), title: item.title,
                revision: canvasSafeInteger(item.revision), nodeCount: item.nodeCount, edgeCount: item.edgeCount,
                createdAt: timestamp(item.createdAtUtc), updatedAt: timestamp(item.updatedAtUtc), contentDigest: item.contentDigest }));
        }
    };
    return {
        ownerContext, storage,
        pendingWrite: () => pending ? { canvasId: pending.canvasId, expectedRevision: pending.expectedRevision,
            requestId: pending.requestId, mode: 'apply' } : pendingHistory ? { canvasId: pendingHistory.canvasId,
            expectedRevision: pendingHistory.expectedRevision, requestId: pendingHistory.requestId,
            mode: pendingHistory.request.mode === 1 ? 'undo' : 'redo' } : null,
        async retryPending()
        {
            if (pendingHistory)
            {
                return transition(pendingHistory.canvasId, pendingHistory.expectedRevision, pendingHistory.requestId, undefined, pendingHistory.request.mode);
            }
            if (!pending)
            {
                throw new Error('canvas_pending_request_missing');
            }
            return transition(pending.canvasId, pending.expectedRevision, pending.requestId, JSON.parse(pending.intention) as AuthoringCanvasCommand);
        },
        apply: (canvasId, expectedRevision, requestId, command) => transition(canvasId, expectedRevision, requestId, command),
        undo: (canvasId, expectedRevision, requestId) => transition(canvasId, expectedRevision, requestId, undefined, 1),
        redo: (canvasId, expectedRevision, requestId) => transition(canvasId, expectedRevision, requestId, undefined, 2),
        async history(canvasId, expectedRevision, documentDigest)
        {
            const snapshot = await readSnapshot(canvasId, ownerContext, signal);
            if (snapshot.header.revision !== revision(expectedRevision) || snapshot.header.contentDigest !== documentDigest)
            {
                throw new Error('canvas_revision_conflict');
            }
            const value = await history(snapshot, signal);
            return { canvasId, revision: expectedRevision, canvasContentDigest: value.canvasContentDigest, historyDigest: value.historyDigest,
                undoDepth: value.undoEntries.length, redoDepth: value.redoEntries.length };
        },
        projections: {
            async resolveReferences(nodes, context, resolveSignal)
            {
                requireOwner(ownerContext, context);
                const output = new Map<string, AuthoringCanvasReferenceProjection>();
                const references = nodes.filter(node => node.type === 'article-reference'
                    || node.type === 'heading-reference' || node.type === 'block-reference');
                if (new Set(references.map(node => node.id)).size !== references.length || references.length > authoringCanvasLimits.maxNodesPerCanvas)
                {
                    throw new Error('canvas_resolution_roster_invalid');
                }
                for (let offset = 0; offset < references.length; offset += authoringCanvasLimits.maxPageSize)
                {
                    const requested = references.slice(offset, offset + authoringCanvasLimits.maxPageSize);
                    const requestId = crypto.randomUUID();
                    const value = await authoringCanvasApi.resolve(context.canvasId, { requestId,
                        canvasRevision: revision(context.canvasRevision), canvasContentDigest: context.documentDigest,
                        nodeIds: requested.map(node => node.id), targetWorkspaceGroupId: null }, resolveSignal ?? signal);
                    if (value.canvasId !== context.canvasId || value.canvasRevision !== revision(context.canvasRevision)
                        || value.canvasContentDigest !== context.documentDigest || value.projections.length !== requested.length
                        || value.receipt.requestId !== requestId || value.receipt.canvasId !== value.canvasId
                        || value.receipt.canvasRevision !== value.canvasRevision
                        || value.receipt.canvasContentDigest !== value.canvasContentDigest
                        || value.receipt.targetCount !== requested.length || value.receipt.items.length !== requested.length
                        || value.receipt.authorityGeneration !== value.authorityCoordinate.generation
                        || value.receipt.authorityContentDigest !== value.authorityCoordinate.contentDigest
                        || value.receipt.permissionFingerprint !== value.authorityCoordinate.permissionFingerprint)
                    {
                        throw new Error('canvas_resolution_receipt_mismatch');
                    }
                    const received = new Set<string>();
                    for (const item of value.projections)
                    {
                        const original = requested.find(node => node.id === item.nodeId);
                        const receiptItem = value.receipt.items.find(entry => entry.nodeId === item.nodeId);
                        if (!original || received.has(item.nodeId) || !receiptItem || item.nodeType > 2
                            || NODE_TYPES[item.nodeType] !== original.type || String(item.targetArticleId) !== String(original.targetArticleId)
                            || receiptItem.contentDigest !== item.contentDigest || receiptItem.status !== item.status
                            || receiptItem.targetArticleId !== item.targetArticleId
                            || receiptItem.targetHeadingIdentity !== item.targetHeadingIdentity
                            || receiptItem.targetBlockIdentity !== item.targetBlockIdentity
                            || receiptItem.targetRevision !== item.targetRevision
                            || receiptItem.title !== item.title || receiptItem.contextSnippet !== item.contextSnippet
                            || !sameOpenIntent(receiptItem.openIntent, item.openIntent))
                        {
                            throw new Error('canvas_resolution_identity_mismatch');
                        }
                        received.add(item.nodeId);
                        const denied = item.status === 7;
                        if (denied && (item.title !== null || item.contextSnippet !== null || item.openIntent !== null
                            || item.targetRevision !== null || item.currentTargetRevision !== null || item.displayProjectionReference !== null
                            || receiptItem.title !== null || receiptItem.contextSnippet !== null || receiptItem.openIntent !== null))
                        {
                            throw new Error('canvas_resolution_permission_leak');
                        }
                        const projection: AuthoringCanvasReferenceProjection = {
                            nodeId: item.nodeId, nodeType: NODE_TYPES[item.nodeType] as AuthoringCanvasReferenceProjection['nodeType'],
                            targetArticleId: item.targetArticleId, status: STATUSES[item.status],
                            contentDigest: item.contentDigest, resolvedAt: new Date().toISOString(),
                            ...(item.title === null ? {} : { title: item.title }),
                            ...(item.contextSnippet === null ? {} : { snippet: item.contextSnippet }),
                            ...(item.targetRevision === null ? {} : { targetRevision: item.targetRevision }),
                            ...(item.openIntent === null ? {} : { openIntent: { articleId: item.openIntent.articleId,
                                    revision: item.openIntent.revision, mode: item.openIntent.mode,
                                    targetGroupId: item.openIntent.targetGroupId,
                                    route: item.openIntent.stableRoute,
                                    ...(item.openIntent.headingIdentity === null ? {} : { headingId: item.openIntent.headingIdentity }),
                                    ...(item.openIntent.blockIdentity === null ? {} : { blockId: item.openIntent.blockIdentity }) } })
                        };
                        output.set(item.nodeId, projection);
                    }
                }
                return output;
            }
        }
    };
}
