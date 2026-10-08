/**
 * Authoring Canvas Pure Operation Preview (#2485)
 *
 * Implements closed atomic commands, deterministic inverse command synthesis,
 * preview inverse synthesis and bounded presentation validation. Server receipts alone authorize writes.
 */
import { cloneCanvasDocumentJson, cloneCanvasEdgeJson, cloneCanvasNodeJson, computeCanvasDocumentDigest, validateAuthoringCanvasDocument, type AuthoringCanvasDocument, type AuthoringCanvasEdge, type AuthoringCanvasEdgeType, type AuthoringCanvasGroupFrameNode, type AuthoringCanvasNode, type AuthoringCanvasViewport } from '@/contracts/authoringCanvas';
import { AuthoringCanvasCasMismatchError } from '@/services/authoringCanvasStorage';
export const MAX_JOURNAL_ENTRIES = 100;
export type AuthoringCanvasCommand = {
    type: 'create-node';
    node: AuthoringCanvasNode;
} | {
    type: 'delete-node';
    nodeId: string;
} | {
    type: 'move-node';
    nodeId: string;
    x: number;
    y: number;
} | {
    type: 'batch-move-nodes';
    moves: {
        nodeId: string;
        x: number;
        y: number;
    }[];
} | {
    type: 'resize-node';
    nodeId: string;
    width: number;
    height: number;
} | {
    type: 'create-edge';
    edge: AuthoringCanvasEdge;
} | {
    type: 'delete-edge';
    edgeId: string;
} | {
    type: 'edit-edge';
    edgeId: string;
    label?: string;
    edgeType?: AuthoringCanvasEdgeType;
} | {
    type: 'edit-note';
    nodeId: string;
    text: string;
} | {
    type: 'group-nodes';
    frameId: string;
    memberNodeIds: string[];
    label?: string;
} | {
    type: 'ungroup-nodes';
    frameId: string;
} | {
    type: 'set-viewport';
    viewport: AuthoringCanvasViewport;
} | {
    type: 'pin-reference';
    nodeId: string;
    pinnedRevision: number | string;
} | {
    type: 'unpin-reference';
    nodeId: string;
} | {
    type: 'batch';
    commands: AuthoringCanvasCommand[];
};
export interface AuthoringCanvasJournalEntry
{
    journalId: string;
    canvasId: string;
    baseRevision: number;
    resultingRevision: number;
    command: AuthoringCanvasCommand;
    inverseCommand: AuthoringCanvasCommand;
    affectedNodeIds: string[];
    affectedEdgeIds: string[];
    timestamp: string;
    idempotencyKey?: string;
    contentDigest: string;
}
function frameLabelOrDefault(value: string | undefined): string
{
    if (value)
    {
        return value;
    }
    return 'Group';
}
export class AuthoringCanvasOperationEngine
{
    /**
     * Applies a command to a document and returns the updated document alongside its journal entry.
     */
    applyCommand(doc: AuthoringCanvasDocument, command: AuthoringCanvasCommand, options?: {
        expectedRevision?: number;
        idempotencyKey?: string;
    }): {
        updatedDoc: AuthoringCanvasDocument;
        journalEntry: AuthoringCanvasJournalEntry;
    }
    {
        if (options?.expectedRevision !== undefined && options.expectedRevision !== doc.revision)
        {
            throw new AuthoringCanvasCasMismatchError(doc.id, options.expectedRevision, doc.revision);
        }
        // Deep clone working state
        const workingDoc: AuthoringCanvasDocument = cloneCanvasDocumentJson(doc);
        const affectedNodeIds: string[] = [];
        const affectedEdgeIds: string[] = [];
        const inverseCommand = this.executeCommandOnWorkingDoc(workingDoc, command, affectedNodeIds, affectedEdgeIds);
        const nextRevision = doc.revision + 1;
        const now = new Date().toISOString();
        const rawUpdated: Omit<AuthoringCanvasDocument, 'contentDigest'> = {
            id: workingDoc.id,
            userId: workingDoc.userId,
            siteId: workingDoc.siteId,
            title: workingDoc.title,
            revision: nextRevision,
            viewport: { ...workingDoc.viewport },
            nodeIds: [...workingDoc.nodeIds],
            nodes: { ...workingDoc.nodes },
            edgeIds: [...workingDoc.edgeIds],
            edges: { ...workingDoc.edges },
            createdAt: workingDoc.createdAt,
            updatedAt: now
        };
        const validation = validateAuthoringCanvasDocument(rawUpdated);
        if (!validation.valid)
        {
            throw new Error(`Command execution produced invalid canvas document: ${validation.error}`);
        }
        const digest = computeCanvasDocumentDigest(rawUpdated);
        const finalDoc: AuthoringCanvasDocument = {
            ...rawUpdated,
            contentDigest: digest
        };
        const journalEntry: AuthoringCanvasJournalEntry = {
            journalId: `jnl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            canvasId: doc.id,
            baseRevision: doc.revision,
            resultingRevision: nextRevision,
            command,
            inverseCommand,
            affectedNodeIds: Array.from(new Set(affectedNodeIds)),
            affectedEdgeIds: Array.from(new Set(affectedEdgeIds)),
            timestamp: now,
            idempotencyKey: options?.idempotencyKey,
            contentDigest: digest
        };
        return { updatedDoc: finalDoc, journalEntry };
    }
    private executeCommandOnWorkingDoc(doc: AuthoringCanvasDocument, command: AuthoringCanvasCommand, affectedNodes: string[], affectedEdges: string[]): AuthoringCanvasCommand
    {
        switch (command.type)
        {
            case 'create-node':
            {
                const node = command.node;
                if (doc.nodes[node.id])
                {
                    throw new Error(`Cannot create node: node "${node.id}" already exists`);
                }
                doc.nodes[node.id] = cloneCanvasNodeJson(node);
                if (!doc.nodeIds.includes(node.id))
                {
                    doc.nodeIds.push(node.id);
                }
                affectedNodes.push(node.id);
                return { type: 'delete-node', nodeId: node.id };
            }
            case 'delete-node':
            {
                const nodeId = command.nodeId;
                const existingNode = doc.nodes[nodeId];
                if (!existingNode)
                {
                    throw new Error(`Cannot delete node: node "${nodeId}" not found`);
                }
                // Collect incident edges
                const incidentEdges: AuthoringCanvasEdge[] = [];
                const restoreFrames: AuthoringCanvasCommand[] = [];
                for (const edgeId of [...doc.edgeIds])
                {
                    const edge = doc.edges[edgeId];
                    if (edge && (edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId))
                    {
                        incidentEdges.push(cloneCanvasEdgeJson(edge));
                        delete doc.edges[edgeId];
                        doc.edgeIds = doc.edgeIds.filter((id) => id !== edgeId);
                        affectedEdges.push(edgeId);
                    }
                }
                // Remove node from any frame memberships
                for (const n of Object.values(doc.nodes))
                {
                    if (n.type === 'group-frame')
                    {
                        const frame = n;
                        if (frame.memberNodeIds.includes(nodeId))
                        {
                            restoreFrames.push({ type: 'group-nodes', frameId: frame.id,
                                memberNodeIds: [...frame.memberNodeIds], label: frame.label });
                            frame.memberNodeIds = frame.memberNodeIds.filter((id) => id !== nodeId);
                            affectedNodes.push(frame.id);
                        }
                    }
                }
                delete doc.nodes[nodeId];
                doc.nodeIds = doc.nodeIds.filter((id) => id !== nodeId);
                affectedNodes.push(nodeId);
                // Inverse restores the node and all its incident edges
                const restoreCommands: AuthoringCanvasCommand[] = [
                    { type: 'create-node', node: cloneCanvasNodeJson(existingNode) }
                ];
                restoreCommands.push(...restoreFrames);
                for (const edge of incidentEdges)
                {
                    restoreCommands.push({ type: 'create-edge', edge });
                }
                return restoreCommands.length === 1 ? restoreCommands[0] : { type: 'batch', commands: restoreCommands };
            }
            case 'move-node':
            {
                const node = doc.nodes[command.nodeId];
                if (!node)
                {
                    throw new Error(`Node "${command.nodeId}" not found for move`);
                }
                const oldX = node.x;
                const oldY = node.y;
                node.x = command.x;
                node.y = command.y;
                affectedNodes.push(node.id);
                return { type: 'move-node', nodeId: command.nodeId, x: oldX, y: oldY };
            }
            case 'batch-move-nodes':
            {
                const inverseMoves: {
                    nodeId: string;
                    x: number;
                    y: number;
                }[] = [];
                for (const m of command.moves)
                {
                    const node = doc.nodes[m.nodeId];
                    if (node)
                    {
                        inverseMoves.push({ nodeId: m.nodeId, x: node.x, y: node.y });
                        node.x = m.x;
                        node.y = m.y;
                        affectedNodes.push(m.nodeId);
                    }
                }
                return { type: 'batch-move-nodes', moves: inverseMoves };
            }
            case 'resize-node':
            {
                const node = doc.nodes[command.nodeId];
                if (!node)
                {
                    throw new Error(`Node "${command.nodeId}" not found for resize`);
                }
                const oldW = node.width;
                const oldH = node.height;
                node.width = command.width;
                node.height = command.height;
                affectedNodes.push(node.id);
                return { type: 'resize-node', nodeId: command.nodeId, width: oldW, height: oldH };
            }
            case 'create-edge':
            {
                const edge = command.edge;
                if (doc.edges[edge.id])
                {
                    throw new Error(`Cannot create edge: edge "${edge.id}" already exists`);
                }
                doc.edges[edge.id] = cloneCanvasEdgeJson(edge);
                if (!doc.edgeIds.includes(edge.id))
                {
                    doc.edgeIds.push(edge.id);
                }
                affectedEdges.push(edge.id);
                return { type: 'delete-edge', edgeId: edge.id };
            }
            case 'delete-edge':
            {
                const edge = doc.edges[command.edgeId];
                if (!edge)
                {
                    throw new Error(`Edge "${command.edgeId}" not found for deletion`);
                }
                const oldEdge = cloneCanvasEdgeJson(edge);
                delete doc.edges[command.edgeId];
                doc.edgeIds = doc.edgeIds.filter((id) => id !== command.edgeId);
                affectedEdges.push(command.edgeId);
                return { type: 'create-edge', edge: oldEdge };
            }
            case 'edit-edge':
            {
                const edge = doc.edges[command.edgeId];
                if (!edge)
                {
                    throw new Error(`Edge "${command.edgeId}" not found for edit`);
                }
                const oldLabel = edge.label;
                const oldType = edge.type;
                if (command.label !== undefined)
                {
                    edge.label = command.label;
                }
                if (command.edgeType !== undefined)
                {
                    edge.type = command.edgeType;
                }
                affectedEdges.push(edge.id);
                return { type: 'edit-edge', edgeId: command.edgeId, label: oldLabel, edgeType: oldType };
            }
            case 'edit-note':
            {
                const node = doc.nodes[command.nodeId];
                if (node?.type !== 'plain-text-note')
                {
                    throw new Error(`Note node "${command.nodeId}" not found for edit`);
                }
                const noteNode = node;
                const oldText = noteNode.text;
                noteNode.text = command.text;
                affectedNodes.push(node.id);
                return { type: 'edit-note', nodeId: command.nodeId, text: oldText };
            }
            case 'group-nodes':
            {
                let frameNode = doc.nodes[command.frameId] as AuthoringCanvasGroupFrameNode | undefined;
                if (frameNode && frameNode.type !== 'group-frame')
                {
                    throw new Error('canvas_frame_type_mismatch');
                }
                if (!frameNode)
                {
                    // Create new group frame
                    frameNode = {
                        id: command.frameId,
                        type: 'group-frame',
                        x: 0,
                        y: 0,
                        width: 400,
                        height: 300,
                        label: frameLabelOrDefault(command.label),
                        memberNodeIds: [...command.memberNodeIds]
                    };
                    doc.nodes[command.frameId] = frameNode;
                    doc.nodeIds.push(command.frameId);
                    affectedNodes.push(command.frameId);
                    return { type: 'ungroup-nodes', frameId: command.frameId };
                }
                else
                {
                    const oldMembers = [...frameNode.memberNodeIds];
                    const oldLabel = frameNode.label;
                    frameNode.memberNodeIds = [...command.memberNodeIds];
                    if (command.label !== undefined)
                    {
                        frameNode.label = command.label;
                    }
                    affectedNodes.push(command.frameId);
                    return { type: 'group-nodes', frameId: command.frameId, memberNodeIds: oldMembers, label: oldLabel };
                }
            }
            case 'ungroup-nodes':
            {
                const frameNode = doc.nodes[command.frameId] as AuthoringCanvasGroupFrameNode | undefined;
                if (frameNode?.type !== 'group-frame')
                {
                    throw new Error(`Group frame "${command.frameId}" not found for ungroup`);
                }
                const oldNode = cloneCanvasNodeJson(frameNode);
                delete doc.nodes[command.frameId];
                doc.nodeIds = doc.nodeIds.filter((id) => id !== command.frameId);
                affectedNodes.push(command.frameId);
                return { type: 'create-node', node: oldNode };
            }
            case 'set-viewport':
            {
                const oldViewport = { ...doc.viewport };
                doc.viewport = { ...command.viewport };
                return { type: 'set-viewport', viewport: oldViewport };
            }
            case 'pin-reference':
            {
                const node = doc.nodes[command.nodeId];
                if (!node || (node.type !== 'article-reference' && node.type !== 'heading-reference' && node.type !== 'block-reference'))
                {
                    throw new Error(`Reference node "${command.nodeId}" not found for pin`);
                }
                const oldPin = node.pinnedTargetRevision;
                node.pinnedTargetRevision = command.pinnedRevision;
                affectedNodes.push(node.id);
                return oldPin !== undefined
                    ? { type: 'pin-reference', nodeId: command.nodeId, pinnedRevision: oldPin }
                    : { type: 'unpin-reference', nodeId: command.nodeId };
            }
            case 'unpin-reference':
            {
                const node = doc.nodes[command.nodeId];
                if (!node || (node.type !== 'article-reference' && node.type !== 'heading-reference' && node.type !== 'block-reference'))
                {
                    throw new Error(`Reference node "${command.nodeId}" not found for unpin`);
                }
                const oldPin = node.pinnedTargetRevision;
                delete node.pinnedTargetRevision;
                affectedNodes.push(node.id);
                return oldPin !== undefined
                    ? { type: 'pin-reference', nodeId: command.nodeId, pinnedRevision: oldPin }
                    : { type: 'unpin-reference', nodeId: command.nodeId };
            }
            case 'batch':
            {
                const inverseList: AuthoringCanvasCommand[] = [];
                // Execute forward batch commands in order
                for (const subCmd of command.commands)
                {
                    const inv = this.executeCommandOnWorkingDoc(doc, subCmd, affectedNodes, affectedEdges);
                    const validation = validateAuthoringCanvasDocument(doc);
                    if (!validation.valid)
                    {
                        throw new Error(`canvas_batch_command_invalid: ${validation.error}`);
                    }
                    inverseList.unshift(inv); // Reverse order for inverse execution
                }
                return { type: 'batch', commands: inverseList };
            }
            default:
                throw new Error(`Unknown canvas command type: "${(command as {
                    type: string;
                }).type}"`);
        }
    }
}
export const authoringCanvasOperationEngine = new AuthoringCanvasOperationEngine();
