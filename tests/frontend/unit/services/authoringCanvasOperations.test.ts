import { beforeEach, describe, expect, it } from 'vitest';
import type {
    AuthoringCanvasArticleReferenceNode,
    AuthoringCanvasDocument,
    AuthoringCanvasEdge,
    AuthoringCanvasPlainTextNoteNode
} from '@/contracts/authoringCanvas';
import {
    authoringCanvasOperationEngine,
    type AuthoringCanvasCommand
} from '@/services/authoringCanvasOperations';
import { AuthoringCanvasCasMismatchError } from '@/services/authoringCanvasStorage';

describe('Authoring Canvas Operations & Undo/Redo Engine (#2485)', () => {
    let baseDoc: AuthoringCanvasDocument;

    beforeEach(() => {
        baseDoc = {
            id: 'canvas-ops-1',
            userId: 'user-alice',
            siteId: 'site-default',
            title: 'Ops Testing Canvas',
            revision: 1,
            viewport: { x: 0, y: 0, zoom: 1 },
            nodeIds: ['node-1'],
            nodes: {
                'node-1': {
                    id: 'node-1',
                    type: 'article-reference',
                    x: 100,
                    y: 100,
                    width: 250,
                    height: 120,
                    targetArticleId: 10
                }
            },
            edgeIds: [],
            edges: {},
            createdAt: '2026-08-25T12:00:00.000Z',
            updatedAt: '2026-08-25T12:00:00.000Z',
            contentDigest: 'cad_base'
        };
    });

    it('creates a note node and records an inverse delete-node command in the journal', () => {
        const noteNode: AuthoringCanvasPlainTextNoteNode = {
            id: 'note-2',
            type: 'plain-text-note',
            x: 400,
            y: 100,
            width: 200,
            height: 100,
            text: 'Initial note body'
        };

        const { updatedDoc, journalEntry } = authoringCanvasOperationEngine.applyCommand(
            baseDoc,
            { type: 'create-node', node: noteNode },
            { expectedRevision: 1 }
        );

        expect(updatedDoc.revision).toBe(2);
        expect(updatedDoc.nodeIds).toContain('note-2');
        expect(updatedDoc.nodes['note-2']).toBeDefined();

        expect(journalEntry.baseRevision).toBe(1);
        expect(journalEntry.resultingRevision).toBe(2);
        expect(journalEntry.command.type).toBe('create-node');
        expect(journalEntry.inverseCommand).toEqual({ type: 'delete-node', nodeId: 'note-2' });

        // Undo: apply the inverse command on the updated doc
        const undoResult = authoringCanvasOperationEngine.applyCommand(
            updatedDoc,
            journalEntry.inverseCommand,
            { expectedRevision: 2 }
        );

        expect(undoResult.updatedDoc.revision).toBe(3);
        expect(undoResult.updatedDoc.nodeIds).not.toContain('note-2');
        expect(undoResult.updatedDoc.nodes['note-2']).toBeUndefined();
    });

    it('moves a node and generates an exact coordinate inverse command', () => {
        const { updatedDoc, journalEntry } = authoringCanvasOperationEngine.applyCommand(
            baseDoc,
            { type: 'move-node', nodeId: 'node-1', x: 250, y: 350 },
            { expectedRevision: 1 }
        );

        expect(updatedDoc.nodes['node-1'].x).toBe(250);
        expect(updatedDoc.nodes['node-1'].y).toBe(350);
        expect(journalEntry.inverseCommand).toEqual({
            type: 'move-node',
            nodeId: 'node-1',
            x: 100,
            y: 100
        });

        // Undo restores original coordinates
        const undoResult = authoringCanvasOperationEngine.applyCommand(
            updatedDoc,
            journalEntry.inverseCommand,
            { expectedRevision: 2 }
        );
        expect(undoResult.updatedDoc.nodes['node-1'].x).toBe(100);
        expect(undoResult.updatedDoc.nodes['node-1'].y).toBe(100);
    });

    it('deletes a node and cascades incident edge removal without deleting target article', () => {
        // First add second node and edge
        const node2: AuthoringCanvasPlainTextNoteNode = {
            id: 'node-2',
            type: 'plain-text-note',
            x: 400,
            y: 100,
            width: 200,
            height: 100,
            text: 'Note 2'
        };
        const edge1: AuthoringCanvasEdge = {
            id: 'edge-1-2',
            type: 'visual-only',
            sourceNodeId: 'node-1',
            targetNodeId: 'node-2',
            label: 'link'
        };

        let doc = authoringCanvasOperationEngine.applyCommand(baseDoc, { type: 'create-node', node: node2 }).updatedDoc;
        doc = authoringCanvasOperationEngine.applyCommand(doc, { type: 'create-edge', edge: edge1 }).updatedDoc;

        expect(doc.nodeIds.length).toBe(2);
        expect(doc.edgeIds.length).toBe(1);

        // Delete node-1: should automatically delete edge-1-2
        const { updatedDoc: docAfterDelete, journalEntry } = authoringCanvasOperationEngine.applyCommand(
            doc,
            { type: 'delete-node', nodeId: 'node-1' }
        );

        expect(docAfterDelete.nodes['node-1']).toBeUndefined();
        expect(docAfterDelete.edges['edge-1-2']).toBeUndefined();
        expect(docAfterDelete.edgeIds.length).toBe(0);

        // Inverse command restores both node-1 and edge-1-2
        const restored = authoringCanvasOperationEngine.applyCommand(
            docAfterDelete,
            journalEntry.inverseCommand
        ).updatedDoc;

        expect(restored.nodes['node-1']).toBeDefined();
        expect(restored.edges['edge-1-2']).toBeDefined();
        expect(restored.edgeIds).toContain('edge-1-2');
    });

    it('pins and unpins target article revision', () => {
        const pinCmd: AuthoringCanvasCommand = {
            type: 'pin-reference',
            nodeId: 'node-1',
            pinnedRevision: 4
        };

        const { updatedDoc, journalEntry } = authoringCanvasOperationEngine.applyCommand(baseDoc, pinCmd);
        const refNode = updatedDoc.nodes['node-1'] as AuthoringCanvasArticleReferenceNode;
        expect(refNode.pinnedTargetRevision).toBe(4);

        // Inverse is unpin
        expect(journalEntry.inverseCommand).toEqual({
            type: 'unpin-reference',
            nodeId: 'node-1'
        });

        // Apply unpin
        const unpinned = authoringCanvasOperationEngine.applyCommand(
            updatedDoc,
            { type: 'unpin-reference', nodeId: 'node-1' }
        ).updatedDoc;
        const unpinnedRef = unpinned.nodes['node-1'] as AuthoringCanvasArticleReferenceNode;
        expect(unpinnedRef.pinnedTargetRevision).toBeUndefined();
    });

    it('rejects command when expectedRevision does not match current document revision (CAS)', () => {
        expect(() => {
            authoringCanvasOperationEngine.applyCommand(
                baseDoc,
                { type: 'move-node', nodeId: 'node-1', x: 200, y: 200 },
                { expectedRevision: 99 } // Mismatch!
            );
        }).toThrow(AuthoringCanvasCasMismatchError);
    });

    it('applies atomic batch commands and can reverse all of them in reverse order', () => {
        const node2: AuthoringCanvasPlainTextNoteNode = {
            id: 'node-batch-2',
            type: 'plain-text-note',
            x: 300,
            y: 300,
            width: 200,
            height: 100,
            text: 'Batch note'
        };

        const batchCmd: AuthoringCanvasCommand = {
            type: 'batch',
            commands: [
                { type: 'create-node', node: node2 },
                { type: 'move-node', nodeId: 'node-1', x: 50, y: 50 }
            ]
        };

        const { updatedDoc, journalEntry } = authoringCanvasOperationEngine.applyCommand(baseDoc, batchCmd);
        expect(updatedDoc.nodes['node-batch-2']).toBeDefined();
        expect(updatedDoc.nodes['node-1'].x).toBe(50);

        // Inverse batch
        const undone = authoringCanvasOperationEngine.applyCommand(updatedDoc, journalEntry.inverseCommand).updatedDoc;
        expect(undone.nodes['node-batch-2']).toBeUndefined();
        expect(undone.nodes['node-1'].x).toBe(100);
    });
});
