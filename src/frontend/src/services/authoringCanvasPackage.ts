/**
 * Portable Authoring Canvas Package Service (#2491)
 *
 * Implements deterministic package export, safe package import validation,
 * reference re-resolution planning, and unresolved reference handling strategies.
 */

import {
    AUTHORING_CANVAS_BUDGETS,
    computeCanvasDocumentDigest,
    validateAuthoringCanvasDocument,
    type AuthoringCanvasArticleReferenceNode,
    type AuthoringCanvasBlockReferenceNode,
    type AuthoringCanvasDocument,
    type AuthoringCanvasHeadingReferenceNode,
    type AuthoringCanvasNode,
    type AuthoringCanvasReferenceProjection
} from '@/contracts/authoringCanvas';
import {
    defaultTargetArticleProvider,
    type TargetArticleProvider
} from '@/services/authoringCanvasResolver';
import {
    authoringCanvasStorage
} from '@/services/authoringCanvasStorage';

export interface AuthoringCanvasPackageManifest {
    manifestVersion: '1.0';
    kind: 'authoring-canvas';
    schemaVersion: 1;
    exportedAt: string;
    canvasId: string;
    title: string;
    checksum: string;
    counts: {
        nodes: number;
        edges: number;
        notes: number;
    };
}

export interface PortableReferenceMapping {
    nodeId: string;
    nodeType: 'article-reference' | 'heading-reference' | 'block-reference';
    sourceArticleId: number | string;
    titleHint?: string;
    headingId?: string;
    blockId?: string;
    pinnedRevision?: number | string;
}

export interface AuthoringCanvasPackage {
    manifest: AuthoringCanvasPackageManifest;
    document: AuthoringCanvasDocument;
    portableReferences: PortableReferenceMapping[];
    contentDigest: string;
}

export type UnresolvedRefStatus =
    | 'resolved'
    | 'unresolved_missing'
    | 'unresolved_ambiguous'
    | 'unresolved_permission_denied';

export interface ReferenceReResolutionItem {
    nodeId: string;
    nodeType: string;
    targetArticleId: number | string;
    titleHint?: string;
    status: UnresolvedRefStatus;
    matchedTargetTitle?: string;
}

export interface AuthoringCanvasImportPlan {
    package: AuthoringCanvasPackage;
    isNewCanvas: boolean;
    targetCanvasId?: string;
    expectedRevision?: number;
    reResolutionItems: ReferenceReResolutionItem[];
    resolvedCount: number;
    unresolvedCount: number;
    canDirectlyExecute: boolean;
}

export type UnresolvedDecisionAction = 'leave-broken' | 'remove-node' | 'remap';

export interface UnresolvedDecision {
    action: UnresolvedDecisionAction;
    remappedArticleId?: number | string;
}

export function exportAuthoringCanvasPackage(
    doc: AuthoringCanvasDocument,
    projections?: Map<string, AuthoringCanvasReferenceProjection>
): AuthoringCanvasPackage {
    const portableRefs: PortableReferenceMapping[] = [];
    let noteCount = 0;

    for (const nodeId of doc.nodeIds) {
        const node = doc.nodes[nodeId];
        if (!node) continue;

        if (node.type === 'plain-text-note') {
            noteCount++;
        } else if (node.type === 'article-reference') {
            const artNode = node as AuthoringCanvasArticleReferenceNode;
            const proj = projections?.get(nodeId);
            portableRefs.push({
                nodeId,
                nodeType: 'article-reference',
                sourceArticleId: artNode.targetArticleId,
                titleHint: proj?.title,
                pinnedRevision: artNode.pinnedTargetRevision
            });
        } else if (node.type === 'heading-reference') {
            const headNode = node as AuthoringCanvasHeadingReferenceNode;
            const proj = projections?.get(nodeId);
            portableRefs.push({
                nodeId,
                nodeType: 'heading-reference',
                sourceArticleId: headNode.targetArticleId,
                headingId: headNode.targetHeadingId,
                titleHint: proj?.title,
                pinnedRevision: headNode.pinnedTargetRevision
            });
        } else if (node.type === 'block-reference') {
            const blkNode = node as AuthoringCanvasBlockReferenceNode;
            const proj = projections?.get(nodeId);
            portableRefs.push({
                nodeId,
                nodeType: 'block-reference',
                sourceArticleId: blkNode.targetArticleId,
                blockId: blkNode.targetBlockId,
                titleHint: proj?.title,
                pinnedRevision: blkNode.pinnedTargetRevision
            });
        }
    }

    const exportedAt = new Date().toISOString();
    const digest = computeCanvasDocumentDigest(doc);

    const manifest: AuthoringCanvasPackageManifest = {
        manifestVersion: '1.0',
        kind: 'authoring-canvas',
        schemaVersion: 1,
        exportedAt,
        canvasId: doc.id,
        title: doc.title,
        checksum: digest,
        counts: {
            nodes: doc.nodeIds.length,
            edges: doc.edgeIds.length,
            notes: noteCount
        }
    };

    return {
        manifest,
        document: JSON.parse(JSON.stringify(doc)),
        portableReferences: portableRefs,
        contentDigest: digest
    };
}

export function validateAndParseCanvasPackage(jsonStr: string): {
    valid: boolean;
    package?: AuthoringCanvasPackage;
    error?: string;
} {
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonStr);
    } catch {
        return { valid: false, error: 'Invalid JSON payload in package' };
    }

    if (!parsed || typeof parsed !== 'object') {
        return { valid: false, error: 'Package must be a valid JSON object' };
    }

    const p = parsed as Record<string, unknown>;

    // Strict manifest validation
    if (!p.manifest || typeof p.manifest !== 'object') {
        return { valid: false, error: 'Package missing manifest' };
    }

    const manifest = p.manifest as Record<string, unknown>;
    if (manifest.kind !== 'authoring-canvas') {
        return {
            valid: false,
            error: `Invalid package kind "${manifest.kind}". Only "authoring-canvas" packages are accepted (article packages #1865 are rejected).`
        };
    }

    if (manifest.manifestVersion !== '1.0' || manifest.schemaVersion !== 1) {
        return { valid: false, error: 'Unsupported package schema or manifest version' };
    }

    // Document validation
    const docValidation = validateAuthoringCanvasDocument(p.document);
    if (!docValidation.valid) {
        return { valid: false, error: `Document validation inside package failed: ${docValidation.error}` };
    }

    if (!Array.isArray(p.portableReferences)) {
        return { valid: false, error: 'Package portableReferences must be an array' };
    }

    return {
        valid: true,
        package: parsed as AuthoringCanvasPackage
    };
}

export async function planCanvasPackageImport(
    pkg: AuthoringCanvasPackage,
    articleProvider: TargetArticleProvider = defaultTargetArticleProvider,
    options: { targetCanvasId?: string; expectedRevision?: number } = {}
): Promise<AuthoringCanvasImportPlan> {
    const isNewCanvas = !options.targetCanvasId;
    const reResolutionItems: ReferenceReResolutionItem[] = [];
    let resolvedCount = 0;
    let unresolvedCount = 0;

    for (const ref of pkg.portableReferences) {
        const article = await articleProvider.getArticle(ref.sourceArticleId);
        let status: UnresolvedRefStatus = 'unresolved_missing';
        let matchedTitle: string | undefined;

        if (article && !article.isDeleted) {
            if (article.isArchived) {
                status = 'unresolved_missing';
            } else {
                status = 'resolved';
                matchedTitle = article.title;
            }
        }

        if (status === 'resolved') {
            resolvedCount++;
        } else {
            unresolvedCount++;
        }

        reResolutionItems.push({
            nodeId: ref.nodeId,
            nodeType: ref.nodeType,
            targetArticleId: ref.sourceArticleId,
            titleHint: ref.titleHint,
            status,
            matchedTargetTitle: matchedTitle
        });
    }

    return {
        package: pkg,
        isNewCanvas,
        targetCanvasId: options.targetCanvasId,
        expectedRevision: options.expectedRevision,
        reResolutionItems,
        resolvedCount,
        unresolvedCount,
        canDirectlyExecute: unresolvedCount === 0
    };
}

export async function executeCanvasPackageImport(
    plan: AuthoringCanvasImportPlan,
    decisions: Record<string, UnresolvedDecision> = {},
    context: { userId: string; siteId: string }
): Promise<AuthoringCanvasDocument> {
    const pkg = plan.package;
    const workingDoc: AuthoringCanvasDocument = JSON.parse(JSON.stringify(pkg.document));

    // Handle unresolved reference decisions
    for (const item of plan.reResolutionItems) {
        if (item.status !== 'resolved') {
            const decision = decisions[item.nodeId] || { action: 'leave-broken' };

            if (decision.action === 'remove-node') {
                delete workingDoc.nodes[item.nodeId];
                workingDoc.nodeIds = workingDoc.nodeIds.filter((id) => id !== item.nodeId);
                // Remove incident edges
                for (const edgeId of [...workingDoc.edgeIds]) {
                    const edge = workingDoc.edges[edgeId];
                    if (edge && (edge.sourceNodeId === item.nodeId || edge.targetNodeId === item.nodeId)) {
                        delete workingDoc.edges[edgeId];
                        workingDoc.edgeIds = workingDoc.edgeIds.filter((id) => id !== edgeId);
                    }
                }
            } else if (decision.action === 'remap' && decision.remappedArticleId) {
                const node = workingDoc.nodes[item.nodeId];
                if (node && (node.type === 'article-reference' || node.type === 'heading-reference' || node.type === 'block-reference')) {
                    node.targetArticleId = decision.remappedArticleId;
                }
            }
            // If 'leave-broken', node remains intact in document for future resolution
        }
    }

    if (plan.isNewCanvas) {
        return await authoringCanvasStorage.createCanvas({
            userId: context.userId,
            siteId: context.siteId,
            title: workingDoc.title,
            viewport: workingDoc.viewport,
            nodeIds: workingDoc.nodeIds,
            nodes: workingDoc.nodes,
            edgeIds: workingDoc.edgeIds,
            edges: workingDoc.edges
        });
    } else {
        if (!plan.targetCanvasId || plan.expectedRevision === undefined) {
            throw new Error('Target canvas ID and expected revision are required for update import');
        }
        return await authoringCanvasStorage.updateCanvas(
            plan.targetCanvasId,
            plan.expectedRevision,
            {
                title: workingDoc.title,
                viewport: workingDoc.viewport,
                nodeIds: workingDoc.nodeIds,
                nodes: workingDoc.nodes,
                edgeIds: workingDoc.edgeIds,
                edges: workingDoc.edges
            },
            context
        );
    }
}
