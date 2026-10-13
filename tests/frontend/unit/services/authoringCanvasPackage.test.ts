import { InMemoryTargetArticleProvider } from '../../fixtures/authoringCanvasTransportFixture';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
    AuthoringCanvasArticleReferenceNode,
    AuthoringCanvasDocument,
    AuthoringCanvasPlainTextNoteNode
} from '@/contracts/authoringCanvas';
import {
    executeCanvasPackageImport,
    exportAuthoringCanvasPackage,
    planCanvasPackageImport,
    validateAndParseCanvasPackage
} from '@/services/authoringCanvasPackage';
import { authoringCanvasStorage } from '../../fixtures/authoringCanvasTransportFixture';

describe('Authoring Canvas Portable Package & Safe Import (#2491)', () => {
    let sampleDoc: AuthoringCanvasDocument;
    let articleProvider: InMemoryTargetArticleProvider;

    beforeEach(() => {
        authoringCanvasStorage.clear();
        articleProvider = new InMemoryTargetArticleProvider();

        articleProvider.setArticle({
            id: 200,
            title: 'Kernel Architecture Guide',
            revision: 1
        });

        sampleDoc = {
            id: 'canvas-pkg-1',
            userId: 'user-alice',
            siteId: 'site-default',
            title: 'OS Concepts Map',
            revision: 1,
            viewport: { x: 0, y: 0, zoom: 1 },
            nodeIds: ['node-art-1', 'node-note-1'],
            nodes: {
                'node-art-1': {
                    id: 'node-art-1',
                    type: 'article-reference',
                    x: 100,
                    y: 100,
                    width: 250,
                    height: 120,
                    targetArticleId: 200
                },
                'node-note-1': {
                    id: 'node-note-1',
                    type: 'plain-text-note',
                    x: 450,
                    y: 100,
                    width: 200,
                    height: 100,
                    text: 'Key architectural insights'
                }
            },
            edgeIds: ['edge-1'],
            edges: {
                'edge-1': {
                    id: 'edge-1',
                    type: 'visual-only',
                    sourceNodeId: 'node-art-1',
                    targetNodeId: 'node-note-1',
                    label: 'explains'
                }
            },
            createdAt: '2026-08-25T10:00:00.000Z',
            updatedAt: '2026-08-25T10:00:00.000Z',
            contentDigest: 'cad_pkg_test'
        };
    });

    it('exports a deterministic portable package with manifest kind="authoring-canvas"', () => {
        const pkg = exportAuthoringCanvasPackage(sampleDoc);

        expect(pkg.manifest.kind).toBe('authoring-canvas');
        expect(pkg.manifest.manifestVersion).toBe('1.0');
        expect(pkg.manifest.counts.nodes).toBe(2);
        expect(pkg.manifest.counts.edges).toBe(1);
        expect(pkg.manifest.counts.notes).toBe(1);
        expect(pkg.portableReferences.length).toBe(1);
        expect(pkg.portableReferences[0].sourceArticleId).toBe(200);

        const exportedJson = JSON.stringify(pkg);
        const parsedResult = validateAndParseCanvasPackage(exportedJson);
        expect(parsedResult.valid).toBe(true);
        expect(parsedResult.package?.manifest.kind).toBe('authoring-canvas');
    });

    it('rejects invalid package kind such as article package #1865', () => {
        const fakeArticlePackage = {
            manifest: {
                manifestVersion: '1.0',
                kind: 'article-package-v1', // Non-canvas kind!
                schemaVersion: 1
            },
            document: sampleDoc,
            portableReferences: []
        };

        const result = validateAndParseCanvasPackage(JSON.stringify(fakeArticlePackage));
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/Invalid package kind/i);
    });

    it('plans import and identifies resolved vs unresolved references', async () => {
        const pkg = exportAuthoringCanvasPackage(sampleDoc);

        // Target site has article 200 -> resolved!
        const plan = await planCanvasPackageImport(pkg, articleProvider, { context: { userId: 'user-alice', siteId: 'site-default', canvasId: '', canvasRevision: 1 } });
        expect(plan.resolvedCount).toBe(1);
        expect(plan.unresolvedCount).toBe(0);
        expect(plan.canDirectlyExecute).toBe(true);

        // If target site is missing article 200
        articleProvider.clear();
        const planMissing = await planCanvasPackageImport(pkg, articleProvider, { context: { userId: 'user-alice', siteId: 'site-default', canvasId: '', canvasRevision: 1 } });
        expect(planMissing.resolvedCount).toBe(0);
        expect(planMissing.unresolvedCount).toBe(1);
        expect(planMissing.canDirectlyExecute).toBe(false);
        expect(planMissing.reResolutionItems[0].status).toBe('unresolved_missing');
    });

    it('executes safe import as a new canvas with explicit decision handling', async () => {
        const pkg = exportAuthoringCanvasPackage(sampleDoc);
        const plan = await planCanvasPackageImport(pkg, articleProvider, { context: { userId: 'user-alice', siteId: 'site-default', canvasId: '', canvasRevision: 1 } });

        const importedDoc = await executeCanvasPackageImport(plan, {}, {
            userId: 'user-bob',
            siteId: 'site-default'
        }, authoringCanvasStorage);

        expect(importedDoc.id).toMatch(/^canvas-/);
        expect(importedDoc.userId).toBe('user-bob');
        expect(importedDoc.nodeIds.length).toBe(2);
        expect(importedDoc.revision).toBe(1);
    });

    it('handles unresolved references with remove-node strategy during import', async () => {
        articleProvider.clear(); // Simulate target site missing references
        const pkg = exportAuthoringCanvasPackage(sampleDoc);
        const plan = await planCanvasPackageImport(pkg, articleProvider, { context: { userId: 'user-alice', siteId: 'site-default', canvasId: '', canvasRevision: 1 } });

        // User decides to remove missing reference node
        const importedDoc = await executeCanvasPackageImport(
            plan,
            { 'node-art-1': { action: 'remove-node' } },
            { userId: 'user-bob', siteId: 'site-default' },
            authoringCanvasStorage
        );

        // Reference node and connected edge should be cleanly removed
        expect(importedDoc.nodes['node-art-1']).toBeUndefined();
        expect(importedDoc.edges['edge-1']).toBeUndefined();
        // Plain note is preserved
        expect(importedDoc.nodes['node-note-1']).toBeDefined();
    });
});
