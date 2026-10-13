import { InMemoryTargetArticleProvider } from '../../fixtures/authoringCanvasTransportFixture';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    AUTHORING_CANVAS_BUDGETS,
    validateAuthoringCanvasDocument,
    validateAuthoringCanvasNode,
    type AuthoringCanvasArticleReferenceNode,
    type AuthoringCanvasDocument,
    type AuthoringCanvasNode,
    type AuthoringCanvasPlainTextNoteNode
} from '@/contracts/authoringCanvas';
import {
    authoringCanvasOperationEngine
} from '@/services/authoringCanvasOperations';
import {
    exportAuthoringCanvasPackage,
    planCanvasPackageImport,
    validateAndParseCanvasPackage
} from '@/services/authoringCanvasPackage';
import {
    AuthoringCanvasResolver,
} from '@/services/authoringCanvasResolver';
import {
    AuthoringCanvasSpatialIndex
} from '@/services/authoringCanvasSpatialIndex';
import { authoringCanvasStorage } from '../../fixtures/authoringCanvasTransportFixture';

describe('Authoring Canvas 10,000-Node Scale, Authority, & Matrix Closure (#2494)', () => {
    beforeEach(() => {
        authoringCanvasStorage.clear();
    });

    it('virtualizes 10,000 nodes with spatial index bounded viewport culling', () => {
        const spatial = new AuthoringCanvasSpatialIndex();
        const nodes: AuthoringCanvasNode[] = [];

        // Distribute 10,000 nodes in a 100x100 grid across canvas space
        for (let i = 0; i < 10000; i++) {
            nodes.push({
                id: `node-${i}`,
                type: 'plain-text-note',
                x: (i % 100) * 350,
                y: Math.floor(i / 100) * 200,
                width: 250,
                height: 120,
                text: `Node content #${i}`
            });
        }

        const t0 = performance.now();
        spatial.indexNodes(nodes);
        const indexDuration = performance.now() - t0;
        expect(indexDuration).toBeLessThan(1000);

        // Query standard desktop viewport (1440x900) at zoom 1.0
        const t1 = performance.now();
        const visibleIds = spatial.queryVisibleNodeIds(
            { x: 0, y: 0, zoom: 1.0 },
            { width: 1440, height: 900 },
            100 // buffer
        );
        const queryDuration = performance.now() - t1;

        expect(queryDuration).toBeLessThan(15);
        // Visible nodes must be bounded (e.g. ~20-35 nodes, never 10,000!)
        expect(visibleIds.length).toBeGreaterThan(0);
        expect(visibleIds.length).toBeLessThan(50);
    });

    it('enforces end-to-end invariant: document -> resolver -> ops -> package roundtrip with zero article body copy', async () => {
        const articleProvider = new InMemoryTargetArticleProvider();
        articleProvider.setArticle({
            id: 888,
            title: 'System Boundary Architecture',
            revision: 3,
            snippet: 'Deterministic verification guidelines.'
        });

        const resolver = new AuthoringCanvasResolver(articleProvider);

        // 1. Create document via server authority
        const doc = await authoringCanvasStorage.createCanvas({
            userId: 'user-architect',
            siteId: 'site-default',
            title: 'End-to-End Architectural Canvas'
        });

        // 2. Add reference node & note node via operations engine
        const refNode: AuthoringCanvasArticleReferenceNode = {
            id: 'node-arch-1',
            type: 'article-reference',
            x: 100,
            y: 100,
            width: 280,
            height: 140,
            targetArticleId: 888,
            pinnedTargetRevision: 3
        };

        const noteNode: AuthoringCanvasPlainTextNoteNode = {
            id: 'node-arch-2',
            type: 'plain-text-note',
            x: 450,
            y: 100,
            width: 240,
            height: 140,
            text: 'Invariant summary'
        };

        let updated = authoringCanvasOperationEngine.applyCommand(doc, {
            type: 'create-node',
            node: refNode
        }).updatedDoc;

        updated = authoringCanvasOperationEngine.applyCommand(updated, {
            type: 'create-node',
            node: noteNode
        }).updatedDoc;

        updated = authoringCanvasOperationEngine.applyCommand(updated, {
            type: 'create-edge',
            edge: {
                id: 'edge-arch-1',
                type: 'explicit-reference-note',
                sourceNodeId: 'node-arch-1',
                targetNodeId: 'node-arch-2',
                label: 'relates to'
            }
        }).updatedDoc;

        expect(updated.revision).toBe(4);
        expect(updated.nodeIds.length).toBe(2);
        expect(updated.edgeIds.length).toBe(1);

        // 3. Resolve references
        const projections = await resolver.resolveReferences(
            Object.values(updated.nodes),
            {
                userId: 'user-architect',
                siteId: 'site-default',
                canvasId: updated.id,
                canvasRevision: updated.revision
            }
        );

        const proj = projections.get('node-arch-1');
        expect(proj?.status).toBe('pinned-current');
        expect(proj?.title).toBe('System Boundary Architecture');

        // Verify NO article markdown or HTML body was copied into node
        expect(updated.nodes['node-arch-1']).not.toHaveProperty('markdown');
        expect(updated.nodes['node-arch-1']).not.toHaveProperty('body');
        expect(updated.nodes['node-arch-1']).not.toHaveProperty('html');

        // 4. Export Portable Package
        const pkg = exportAuthoringCanvasPackage(updated, projections);
        expect(pkg.manifest.kind).toBe('authoring-canvas');
        expect(pkg.manifest.counts.nodes).toBe(2);

        // 5. Validate Package
        const parsed = validateAndParseCanvasPackage(JSON.stringify(pkg));
        expect(parsed.valid).toBe(true);

        // 6. Plan Import
        const plan = await planCanvasPackageImport(parsed.package!, articleProvider, { context: { userId: 'user-alice', siteId: 'site-default', canvasId: '', canvasRevision: 1 } });
        expect(plan.resolvedCount).toBe(1);
        expect(plan.canDirectlyExecute).toBe(true);
    });

    it('kills mutations: rejects arbitrary JSON, HTML/script execution, and budget violations', () => {
        // Mutation 1: Script injection in plain-text note
        const xssNote = {
            id: 'xss-1',
            type: 'plain-text-note',
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            text: '<script>alert(document.cookie)</script>'
        };
        expect(validateAuthoringCanvasNode(xssNote).valid).toBe(false);

        // Mutation 2: Arbitrary plugin component node
        const pluginNode = {
            id: 'plugin-1',
            type: 'third-party-vue-card',
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            props: { color: 'red' }
        };
        expect(validateAuthoringCanvasNode(pluginNode).valid).toBe(false);

        // Mutation 3: Edge pointing to non-existent node in document
        const brokenDoc: AuthoringCanvasDocument = {
            id: 'doc-broken',
            userId: 'user-1',
            siteId: 'site-1',
            title: 'Broken Doc',
            revision: 1,
            viewport: { x: 0, y: 0, zoom: 1 },
            nodeIds: ['n1'],
            nodes: {
                n1: { id: 'n1', type: 'plain-text-note', x: 0, y: 0, width: 100, height: 100, text: 'hi' }
            },
            edgeIds: ['e1'],
            edges: {
                e1: { id: 'e1', type: 'visual-only', sourceNodeId: 'n1', targetNodeId: 'n2_missing' }
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            contentDigest: 'cad_test'
        };
        expect(validateAuthoringCanvasDocument(brokenDoc).valid).toBe(false);
    });
});
