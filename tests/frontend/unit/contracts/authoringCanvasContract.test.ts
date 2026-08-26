import { describe, expect, it } from 'vitest';
import {
    AUTHORING_CANVAS_BUDGETS,
    CLOSED_EDGE_TYPES,
    CLOSED_NODE_TYPES,
    CLOSED_REFERENCE_STATUSES,
    canonicalizeCanvasDocument,
    computeCanvasDocumentDigest,
    isAuthoringCanvasEdgeType,
    isAuthoringCanvasNodeType,
    isAuthoringCanvasReferenceStatus,
    validateAuthoringCanvasDocument,
    validateAuthoringCanvasEdge,
    validateAuthoringCanvasNode,
    type AuthoringCanvasDocument,
    type AuthoringCanvasNode
} from '@/contracts/authoringCanvas';

describe('Authoring Canvas Contract (#2482, #2484)', () => {
    it('defines exact closed node, edge, and reference status types', () => {
        expect(CLOSED_NODE_TYPES).toEqual([
            'article-reference',
            'heading-reference',
            'block-reference',
            'plain-text-note',
            'group-frame'
        ]);

        expect(CLOSED_EDGE_TYPES).toEqual([
            'visual-only',
            'explicit-reference-note'
        ]);

        expect(CLOSED_REFERENCE_STATUSES).toContain('current');
        expect(CLOSED_REFERENCE_STATUSES).toContain('pinned-current');
        expect(CLOSED_REFERENCE_STATUSES).toContain('pinned-stale');
        expect(CLOSED_REFERENCE_STATUSES).toContain('target-updated');
        expect(CLOSED_REFERENCE_STATUSES).toContain('missing');
        expect(CLOSED_REFERENCE_STATUSES).toContain('deleted');
        expect(CLOSED_REFERENCE_STATUSES).toContain('permission-denied');

        expect(isAuthoringCanvasNodeType('article-reference')).toBe(true);
        expect(isAuthoringCanvasNodeType('custom-vue-component')).toBe(false);
        expect(isAuthoringCanvasNodeType('iframe-embed')).toBe(false);

        expect(isAuthoringCanvasEdgeType('visual-only')).toBe(true);
        expect(isAuthoringCanvasEdgeType('relation-auto-link')).toBe(false);

        expect(isAuthoringCanvasReferenceStatus('pinned-stale')).toBe(true);
        expect(isAuthoringCanvasReferenceStatus('random-status')).toBe(false);
    });

    describe('validateAuthoringCanvasNode', () => {
        it('validates a valid article-reference node', () => {
            const node: AuthoringCanvasNode = {
                id: 'node-1',
                type: 'article-reference',
                x: 100,
                y: 150,
                width: 280,
                height: 140,
                targetArticleId: 42,
                pinnedTargetRevision: 3
            };
            const result = validateAuthoringCanvasNode(node);
            expect(result.valid).toBe(true);
        });

        it('rejects an article reference node that tries to store markdown or HTML copy', () => {
            const dirtyNode = {
                id: 'node-1',
                type: 'article-reference',
                x: 100,
                y: 150,
                width: 280,
                height: 140,
                targetArticleId: 42,
                markdown: '# Leaked Article Full Markdown Body',
                html: '<p>Leaked HTML</p>'
            };
            const result = validateAuthoringCanvasNode(dirtyNode);
            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/cannot persist article body/i);
        });

        it('validates a valid plain-text note within budget', () => {
            const noteNode: AuthoringCanvasNode = {
                id: 'node-note-1',
                type: 'plain-text-note',
                x: 200,
                y: 300,
                width: 240,
                height: 120,
                text: 'This is a clean research note without execution.'
            };
            const result = validateAuthoringCanvasNode(noteNode);
            expect(result.valid).toBe(true);
        });

        it('rejects plain-text note exceeding size budget', () => {
            const oversizedNode = {
                id: 'node-note-2',
                type: 'plain-text-note',
                x: 0,
                y: 0,
                width: 200,
                height: 100,
                text: 'A'.repeat(AUTHORING_CANVAS_BUDGETS.MAX_NOTE_TEXT_LENGTH + 1)
            };
            const result = validateAuthoringCanvasNode(oversizedNode);
            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/exceeds maximum length budget/i);
        });

        it('rejects plain-text note containing forbidden script injection', () => {
            const scriptNode = {
                id: 'node-note-3',
                type: 'plain-text-note',
                x: 0,
                y: 0,
                width: 200,
                height: 100,
                text: '<script>alert("xss")</script>'
            };
            const result = validateAuthoringCanvasNode(scriptNode);
            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/forbidden script or html/i);
        });

        it('validates a valid group frame node', () => {
            const frameNode: AuthoringCanvasNode = {
                id: 'frame-1',
                type: 'group-frame',
                x: 50,
                y: 50,
                width: 600,
                height: 400,
                label: 'Research Topic Group',
                memberNodeIds: ['node-1', 'node-note-1']
            };
            const result = validateAuthoringCanvasNode(frameNode);
            expect(result.valid).toBe(true);
        });
    });

    describe('validateAuthoringCanvasEdge', () => {
        it('validates a valid edge', () => {
            const result = validateAuthoringCanvasEdge({
                id: 'edge-1',
                type: 'visual-only',
                sourceNodeId: 'node-1',
                targetNodeId: 'node-2',
                label: 'relates to'
            });
            expect(result.valid).toBe(true);
        });

        it('rejects self-referencing edge', () => {
            const result = validateAuthoringCanvasEdge({
                id: 'edge-self',
                type: 'visual-only',
                sourceNodeId: 'node-1',
                targetNodeId: 'node-1'
            });
            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/self-referencing/i);
        });
    });

    describe('validateAuthoringCanvasDocument', () => {
        const createSampleDoc = (): AuthoringCanvasDocument => ({
            id: 'canvas-101',
            userId: 'user-author-1',
            siteId: 'site-default',
            title: 'Q3 Research Graph',
            revision: 1,
            viewport: { x: 0, y: 0, zoom: 1 },
            nodeIds: ['node-1', 'node-2'],
            nodes: {
                'node-1': {
                    id: 'node-1',
                    type: 'article-reference',
                    x: 100,
                    y: 100,
                    width: 250,
                    height: 120,
                    targetArticleId: 10
                },
                'node-2': {
                    id: 'node-2',
                    type: 'plain-text-note',
                    x: 400,
                    y: 100,
                    width: 200,
                    height: 100,
                    text: 'Key insights'
                }
            },
            edgeIds: ['edge-1'],
            edges: {
                'edge-1': {
                    id: 'edge-1',
                    type: 'visual-only',
                    sourceNodeId: 'node-1',
                    targetNodeId: 'node-2',
                    label: 'notes on article'
                }
            },
            createdAt: '2026-08-25T10:00:00.000Z',
            updatedAt: '2026-08-25T10:00:00.000Z',
            contentDigest: 'cad_sample'
        });

        it('validates a complete valid canvas document', () => {
            const doc = createSampleDoc();
            const result = validateAuthoringCanvasDocument(doc);
            expect(result.valid).toBe(true);
        });

        it('rejects document with missing edge target node', () => {
            const doc = createSampleDoc();
            doc.edges['edge-1'].targetNodeId = 'non-existent-node';
            const result = validateAuthoringCanvasDocument(doc);
            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/references non-existent targetNodeId/i);
        });

        it('rejects document with invalid revision (< 1)', () => {
            const doc = createSampleDoc();
            doc.revision = 0;
            const result = validateAuthoringCanvasDocument(doc);
            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/positive integer/i);
        });

        it('computes deterministic digest for identical content regardless of key ordering', () => {
            const doc1 = createSampleDoc();
            const doc2 = createSampleDoc();

            const digest1 = computeCanvasDocumentDigest(doc1);
            const digest2 = computeCanvasDocumentDigest(doc2);
            expect(digest1).toBe(digest2);
            expect(digest1).toMatch(/^cad_[0-9a-f]{16}$/);

            // Change title -> digest changes
            doc2.title = 'Updated Title';
            const digest3 = computeCanvasDocumentDigest(doc2);
            expect(digest3).not.toBe(digest1);
        });
    });
});
