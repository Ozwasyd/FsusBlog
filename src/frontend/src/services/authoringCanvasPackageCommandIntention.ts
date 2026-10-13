import { authoringCanvasLimits, CanvasWireWriter } from '@/codecs/binary/authoringCanvasWire.generated';
import {
    validateAuthoringCanvasEdge,
    validateAuthoringCanvasNode,
    type AuthoringCanvasDocument,
    type AuthoringCanvasEdge,
    type AuthoringCanvasNode,
    type AuthoringCanvasPlainTextNoteNode
} from '@/contracts/authoringCanvas';
import type { AuthoringCanvasCommand } from '@/services/authoringCanvasOperations';

export interface AuthoringCanvasPackageCommandIntention
{
    readonly canvasId: string;
    readonly expectedRevision: number;
    readonly expectedContentDigest: string;
    readonly command: Extract<AuthoringCanvasCommand, { type: 'batch'; }>;
}

function requireUuid(value: string, writer: CanvasWireWriter): void
{
    if (typeof value !== 'string' || value !== value.toLowerCase()
        || value === '00000000-0000-0000-0000-000000000000')
    {
        throw new Error('canvas_package_intention_identity_invalid');
    }
    writer.guid(value);
}

function bindFreshIds(sourceIds: readonly string[], bindings: Readonly<Record<string, string>>,
    reservedIds: Set<string>, writer: CanvasWireWriter): Map<string, string>
{
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings))
    {
        throw new Error('canvas_package_intention_bindings_invalid');
    }
    const sourceSet = new Set(sourceIds);
    const keys = Object.keys(bindings);
    if (keys.length !== sourceIds.length || keys.some(key => !sourceSet.has(key)))
    {
        throw new Error('canvas_package_intention_bindings_invalid');
    }
    const result = new Map<string, string>();
    for (const sourceId of sourceIds)
    {
        if (!Object.hasOwn(bindings, sourceId))
        {
            throw new Error('canvas_package_intention_bindings_invalid');
        }
        const id = bindings[sourceId];
        requireUuid(id, writer);
        if (reservedIds.has(id))
        {
            throw new Error('canvas_package_intention_identity_reused');
        }
        reservedIds.add(id);
        result.set(sourceId, id);
    }
    return result;
}

/**
 * Compiles only note/visual-edge facts into the original command language for an
 * explicitly selected existing target. Coordinates are copied caller expectations,
 * not an observation of existence, permissions, CAS or package admission.
 * The native command compiler and server preparation remain required before any write.
 */
export function compileAuthoringCanvasPackageCommandIntention(
    facts: Readonly<{ nodes: readonly AuthoringCanvasNode[]; edges: readonly AuthoringCanvasEdge[]; }>,
    target: Readonly<Pick<AuthoringCanvasDocument, 'id' | 'revision' | 'contentDigest' | 'nodeIds' | 'edgeIds'>>,
    bindings: Readonly<{ nodes: Readonly<Record<string, string>>; edges: Readonly<Record<string, string>>; }>
): AuthoringCanvasPackageCommandIntention
{
    if (!facts || !Array.isArray(facts.nodes) || !Array.isArray(facts.edges)
        || !target || !Array.isArray(target.nodeIds) || !Array.isArray(target.edgeIds) || !bindings)
    {
        throw new Error('canvas_package_intention_input_invalid');
    }
    const sourceNodes = [...(facts.nodes as readonly AuthoringCanvasNode[])];
    const sourceEdges = [...(facts.edges as readonly AuthoringCanvasEdge[])];
    const targetNodeIds: readonly string[] = [...target.nodeIds];
    const targetEdgeIds: readonly string[] = [...target.edgeIds];
    const nodeCount = sourceNodes.length;
    const edgeCount = sourceEdges.length;
    if (nodeCount + edgeCount < 1 || nodeCount + edgeCount > authoringCanvasLimits.maxCommandsPerTransaction
        || targetNodeIds.length + nodeCount > authoringCanvasLimits.maxNodesPerCanvas
        || targetEdgeIds.length + edgeCount > authoringCanvasLimits.maxEdgesPerCanvas)
    {
        throw new Error('canvas_package_intention_budget_exceeded');
    }
    const coordinate = { canvasId: target.id, expectedRevision: target.revision, expectedContentDigest: target.contentDigest };
    if (!Number.isSafeInteger(coordinate.expectedRevision) || coordinate.expectedRevision < 1)
    {
        throw new Error('canvas_package_intention_coordinate_invalid');
    }
    const identities = new CanvasWireWriter();
    requireUuid(coordinate.canvasId, identities);
    identities.text(coordinate.expectedContentDigest, 64, true);
    if (new Set(targetNodeIds).size !== targetNodeIds.length || new Set(targetEdgeIds).size !== targetEdgeIds.length)
    {
        throw new Error('canvas_package_intention_target_roster_invalid');
    }
    const reservedIds = new Set([coordinate.canvasId, ...targetNodeIds, ...targetEdgeIds]);
    for (const id of reservedIds)
    {
        requireUuid(id, identities);
    }
    const nodes = sourceNodes.map(node =>
    {
        if (!validateAuthoringCanvasNode(node).valid || node.type !== 'plain-text-note')
        {
            throw new Error('canvas_package_intention_node_invalid');
        }
        const owned: AuthoringCanvasPlainTextNoteNode = { id: node.id, type: 'plain-text-note',
            x: node.x, y: node.y, width: node.width, height: node.height, text: node.text };
        if (!validateAuthoringCanvasNode(owned).valid || !owned.text.trim())
        {
            throw new Error('canvas_package_intention_node_invalid');
        }
        new CanvasWireWriter().text(owned.text, authoringCanvasLimits.maxNoteSourceLength, false);
        return owned;
    });
    const edges = sourceEdges.map(edge =>
    {
        if (!validateAuthoringCanvasEdge(edge).valid || edge.type !== 'visual-only')
        {
            throw new Error('canvas_package_intention_edge_invalid');
        }
        const owned: AuthoringCanvasEdge = { id: edge.id, type: 'visual-only', sourceNodeId: edge.sourceNodeId,
            targetNodeId: edge.targetNodeId, ...(edge.label === undefined ? {} : { label: edge.label }) };
        if (!validateAuthoringCanvasEdge(owned).valid)
        {
            throw new Error('canvas_package_intention_edge_invalid');
        }
        if (owned.label !== undefined)
        {
            new CanvasWireWriter().text(owned.label, authoringCanvasLimits.maxEdgeLabelLength, false);
        }
        return owned;
    });
    const nodeIds = nodes.map(node => node.id);
    const edgeIds = edges.map(edge => edge.id);
    if (new Set(nodeIds).size !== nodeIds.length || new Set(edgeIds).size !== edgeIds.length)
    {
        throw new Error('canvas_package_intention_source_roster_invalid');
    }
    for (const id of [...nodeIds, ...edgeIds])
    {
        requireUuid(id, identities);
        reservedIds.add(id);
    }
    const nodeBindings = bindFreshIds(nodeIds, bindings.nodes, reservedIds, identities);
    const edgeBindings = bindFreshIds(edgeIds, bindings.edges, reservedIds, identities);
    const commands: AuthoringCanvasCommand[] = [];
    for (const node of nodes)
    {
        const id = nodeBindings.get(node.id);
        if (!id)
        {
            throw new Error('canvas_package_intention_bindings_invalid');
        }
        commands.push(Object.freeze({ type: 'create-node', node: Object.freeze({ ...node, id }) }));
    }
    for (const edge of edges)
    {
        const id = edgeBindings.get(edge.id);
        const sourceNodeId = nodeBindings.get(edge.sourceNodeId);
        const targetNodeId = nodeBindings.get(edge.targetNodeId);
        if (!id || !sourceNodeId || !targetNodeId)
        {
            throw new Error('canvas_package_intention_bindings_invalid');
        }
        commands.push(Object.freeze({ type: 'create-edge', edge: Object.freeze({ ...edge, id, sourceNodeId, targetNodeId }) }));
    }
    Object.freeze(commands);
    return Object.freeze({ ...coordinate, command: Object.freeze({ type: 'batch', commands }) });
}
