/**
 * Portable Authoring Canvas Package Service (#2491)
 *
 * Implements deterministic package export, safe package import validation,
 * reference re-resolution planning, and unresolved reference handling strategies.
 */
import { cloneCanvasDocumentJson, computeCanvasDocumentDigest, validateAuthoringCanvasDocument, type AuthoringCanvasDocument, type AuthoringCanvasReferenceProjection } from '@/contracts/authoringCanvas';
import { type TargetArticleProvider } from '@/services/authoringCanvasResolver';
import { type AuthoringCanvasStorage } from '@/services/authoringCanvasStorage';
export interface AuthoringCanvasPackageManifest
{
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
export interface PortableReferenceMapping
{
    nodeId: string;
    nodeType: 'article-reference' | 'heading-reference' | 'block-reference';
    sourceArticleId: number | string;
    titleHint?: string;
    headingId?: string;
    blockId?: string;
    pinnedRevision?: number | string;
}
export interface AuthoringCanvasPackage
{
    manifest: AuthoringCanvasPackageManifest;
    document: AuthoringCanvasDocument;
    portableReferences: PortableReferenceMapping[];
    contentDigest: string;
}
export type UnresolvedRefStatus = 'resolved' | 'unresolved_missing' | 'unresolved_ambiguous' | 'unresolved_permission_denied';
export interface ReferenceReResolutionItem
{
    nodeId: string;
    nodeType: string;
    targetArticleId: number | string;
    titleHint?: string;
    status: UnresolvedRefStatus;
    matchedTargetTitle?: string;
}
export interface AuthoringCanvasImportPlan
{
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
export interface UnresolvedDecision
{
    action: UnresolvedDecisionAction;
    remappedArticleId?: number | string;
}
export function exportAuthoringCanvasPackage(doc: AuthoringCanvasDocument, projections?: Map<string, AuthoringCanvasReferenceProjection>): AuthoringCanvasPackage
{
    const portableRefs: PortableReferenceMapping[] = [];
    let noteCount = 0;
    for (const nodeId of doc.nodeIds)
    {
        const node = doc.nodes[nodeId];
        if (!node)
        {
            continue;
        }
        if (node.type === 'plain-text-note')
        {
            noteCount++;
        }
        else if (node.type === 'article-reference')
        {
            const artNode = node;
            const proj = projections?.get(nodeId);
            portableRefs.push({
                nodeId,
                nodeType: 'article-reference',
                sourceArticleId: artNode.targetArticleId,
                titleHint: proj?.title,
                pinnedRevision: artNode.pinnedTargetRevision
            });
        }
        else if (node.type === 'heading-reference')
        {
            const headNode = node;
            const proj = projections?.get(nodeId);
            portableRefs.push({
                nodeId,
                nodeType: 'heading-reference',
                sourceArticleId: headNode.targetArticleId,
                headingId: headNode.targetHeadingId,
                titleHint: proj?.title,
                pinnedRevision: headNode.pinnedTargetRevision
            });
        }
        else if (node.type === 'block-reference')
        {
            const blkNode = node;
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
        document: cloneCanvasDocumentJson(doc),
        portableReferences: portableRefs,
        contentDigest: digest
    };
}
export function validateAndParseCanvasPackage(jsonStr: string): {
    valid: boolean;
    package?: AuthoringCanvasPackage;
    error?: string;
}
{
    if (jsonStr.length > 16 * 1024 * 1024)
    {
        return { valid: false, error: 'Package exceeds bounded interchange size' };
    }
    let parsed: unknown;
    try
    {
        parsed = JSON.parse(jsonStr);
    }
    catch
    {
        return { valid: false, error: 'Invalid JSON payload in package' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    {
        return { valid: false, error: 'Package must be a valid JSON object' };
    }
    const p = parsed as Record<string, unknown>;
    if (Object.keys(p).some(key => !['manifest', 'document', 'portableReferences', 'contentDigest'].includes(key)))
    {
        return { valid: false, error: 'Package contains fields outside its closed interchange record' };
    }
    // Strict manifest validation
    if (!p.manifest || typeof p.manifest !== 'object' || Array.isArray(p.manifest))
    {
        return { valid: false, error: 'Package missing manifest' };
    }
    const manifest = p.manifest as Record<string, unknown>;
    if (Object.keys(manifest).some(key => !['manifestVersion', 'kind', 'schemaVersion', 'exportedAt',
        'canvasId', 'title', 'checksum', 'counts'].includes(key)))
    {
        return { valid: false, error: 'Manifest contains fields outside its closed interchange record' };
    }
    if (manifest.kind !== 'authoring-canvas')
    {
        return {
            valid: false,
            error: `Invalid package kind "${String.raw({ raw: ['', ''] }, manifest.kind)}". Only "authoring-canvas" packages are accepted (article packages #1865 are rejected).`
        };
    }
    if (!manifest.counts || typeof manifest.counts !== 'object' || Array.isArray(manifest.counts))
    {
        return { valid: false, error: 'Package missing bounded count inventory' };
    }
    if (manifest.manifestVersion !== '1.0' || manifest.schemaVersion !== 1)
    {
        return { valid: false, error: 'Unsupported package schema or manifest version' };
    }
    // Document validation
    const docValidation = validateAuthoringCanvasDocument(p.document);
    if (!docValidation.valid)
    {
        return { valid: false, error: `Document validation inside package failed: ${docValidation.error}` };
    }
    if (!Array.isArray(p.portableReferences))
    {
        return { valid: false, error: 'Package portableReferences must be an array' };
    }
    if (p.portableReferences.some((ref: unknown) =>
    {
        if (!ref || typeof ref !== 'object' || Array.isArray(ref))
        {
            return true;
        }
        const record = ref as Record<string, unknown>;
        return Object.keys(record).some(key => !['nodeId', 'nodeType', 'sourceArticleId', 'titleHint',
            'headingId', 'blockId', 'pinnedRevision'].includes(key))
            || (record.titleHint !== undefined && (typeof record.titleHint !== 'string' || record.titleHint.length > 512));
    }))
    {
        return { valid: false, error: 'Portable reference contains an invalid closed record' };
    }
    const pkg = parsed as AuthoringCanvasPackage;
    const expectedFingerprint = computeCanvasDocumentDigest(pkg.document);
    if (pkg.contentDigest !== expectedFingerprint || pkg.manifest.checksum !== expectedFingerprint
        || pkg.manifest.canvasId !== pkg.document.id || pkg.manifest.title !== pkg.document.title
        || pkg.manifest.counts.nodes !== pkg.document.nodeIds.length
        || pkg.manifest.counts.edges !== pkg.document.edgeIds.length
        || pkg.manifest.counts.notes !== Object.values(pkg.document.nodes).filter(node => node.type === 'plain-text-note').length)
    {
        return { valid: false, error: 'Package fingerprint, identity, or count binding mismatch' };
    }
    const referenceIds = pkg.document.nodeIds.filter(id =>
    {
        const node = pkg.document.nodes[id];
        return node.type === 'article-reference' || node.type === 'heading-reference' || node.type === 'block-reference';
    });
    if (pkg.portableReferences.length !== referenceIds.length
        || new Set(pkg.portableReferences.map(ref => ref.nodeId)).size !== referenceIds.length
        || pkg.portableReferences.some(ref =>
        {
            const node = pkg.document.nodes[ref.nodeId];
            return !node || !referenceIds.includes(ref.nodeId) || node.type !== ref.nodeType
                || !('targetArticleId' in node) || node.targetArticleId !== ref.sourceArticleId
                || node.pinnedTargetRevision !== ref.pinnedRevision
                || (node.type === 'heading-reference' && node.targetHeadingId !== ref.headingId)
                || (node.type === 'block-reference' && node.targetBlockId !== ref.blockId);
        }))
    {
        return { valid: false, error: 'Portable reference roster mismatch' };
    }
    return { valid: true, package: pkg };
}
/**
 * Provider-metadata preview only: returned IDs and heading/block anchors must match exactly.
 * These statuses do not attest canonical package admission, permission or pinned coordinates.
 */
export async function planCanvasPackageImport(pkg: AuthoringCanvasPackage, articleProvider: TargetArticleProvider, options: {
    targetCanvasId?: string;
    expectedRevision?: number;
    context: {
        userId: string;
        siteId: string;
        canvasId: string;
        canvasRevision: number;
    };
}): Promise<AuthoringCanvasImportPlan>
{
    const isNewCanvas = !options.targetCanvasId;
    const reResolutionItems: ReferenceReResolutionItem[] = [];
    let resolvedCount = 0;
    let unresolvedCount = 0;
    const reparsed = validateAndParseCanvasPackage(JSON.stringify(pkg));
    if (!reparsed.valid)
    {
        throw new Error(reparsed.error);
    }
    for (const ref of pkg.portableReferences)
    {
        const article = await articleProvider.getArticle(ref.sourceArticleId, options.context);
        let status: UnresolvedRefStatus = 'unresolved_missing';
        let matchedTitle: string | undefined;
        if (article && !article.isDeleted)
        {
            if (article.allowedUserIds && !article.allowedUserIds.includes(options.context.userId))
            {
                status = 'unresolved_permission_denied';
            }
            else if (article.isArchived
                || (typeof article.id !== 'number' && typeof article.id !== 'string')
                || article.id !== ref.sourceArticleId)
            {
                status = 'unresolved_missing';
            }
            else
            {
                const anchorMatches = ref.nodeType === 'heading-reference'
                    ? (article.headings?.filter(heading => heading.id === ref.headingId).length ?? 0)
                    : ref.nodeType === 'block-reference'
                        ? (article.blocks?.filter(block => block.id === ref.blockId).length ?? 0)
                        : 1;
                if (anchorMatches === 0)
                {
                    status = 'unresolved_missing';
                }
                else if (anchorMatches > 1)
                {
                    status = 'unresolved_ambiguous';
                }
                else
                {
                    status = 'resolved';
                    matchedTitle = article.title;
                }
            }
        }
        if (status === 'resolved')
        {
            resolvedCount++;
        }
        else
        {
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
/**
 * Requires explicit closed choices for every unresolved preview row before storage writes.
 * This legacy helper does not make the mutable preview plan an execution authority.
 */
export async function executeCanvasPackageImport(plan: AuthoringCanvasImportPlan, decisions: Record<string, UnresolvedDecision> = {}, context: {
    userId: string;
    siteId: string;
}, storage: AuthoringCanvasStorage): Promise<AuthoringCanvasDocument>
{
    const pkg = plan.package;
    const validated = validateAndParseCanvasPackage(JSON.stringify(pkg));
    if (!validated.valid)
    {
        throw new Error(validated.error);
    }
    if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions))
    {
        throw new Error('canvas_package_unresolved_decision_invalid');
    }
    const workingDoc: AuthoringCanvasDocument = cloneCanvasDocumentJson(pkg.document);
    // Handle unresolved reference decisions
    for (const item of plan.reResolutionItems)
    {
        if (item.status !== 'resolved')
        {
            const decision = Object.hasOwn(decisions, item.nodeId) ? decisions[item.nodeId] : undefined;
            if (!decision || typeof decision !== 'object' || Array.isArray(decision)
                || !Object.hasOwn(decision, 'action')
                || Object.keys(decision).some(key => !['action', 'remappedArticleId'].includes(key)))
            {
                throw new Error('canvas_package_unresolved_decision_required');
            }
            const { action, remappedArticleId } = decision;
            if ((action !== 'leave-broken' && action !== 'remove-node' && action !== 'remap')
                || (action === 'remap' && (!Object.hasOwn(decision, 'remappedArticleId')
                    || (typeof remappedArticleId === 'string'
                        ? !remappedArticleId.trim()
                        : typeof remappedArticleId !== 'number' || !Number.isSafeInteger(remappedArticleId) || remappedArticleId <= 0))))
            {
                throw new Error('canvas_package_unresolved_decision_invalid');
            }
            if (action === 'remove-node')
            {
                for (const node of Object.values(workingDoc.nodes))
                {
                    if (node.type === 'group-frame')
                    {
                        node.memberNodeIds = node.memberNodeIds.filter(id => id !== item.nodeId);
                    }
                }
                delete workingDoc.nodes[item.nodeId];
                workingDoc.nodeIds = workingDoc.nodeIds.filter((id) => id !== item.nodeId);
                // Remove incident edges
                for (const edgeId of [...workingDoc.edgeIds])
                {
                    const edge = workingDoc.edges[edgeId];
                    if (edge && (edge.sourceNodeId === item.nodeId || edge.targetNodeId === item.nodeId))
                    {
                        delete workingDoc.edges[edgeId];
                        workingDoc.edgeIds = workingDoc.edgeIds.filter((id) => id !== edgeId);
                    }
                }
            }
            else if (action === 'remap' && remappedArticleId)
            {
                const node = workingDoc.nodes[item.nodeId];
                if (node && (node.type === 'article-reference' || node.type === 'heading-reference' || node.type === 'block-reference'))
                {
                    node.targetArticleId = remappedArticleId;
                }
            }
        }
    }
    if (plan.isNewCanvas)
    {
        return await storage.createCanvas({
            userId: context.userId,
            siteId: context.siteId,
            title: workingDoc.title,
            viewport: workingDoc.viewport,
            nodeIds: workingDoc.nodeIds,
            nodes: workingDoc.nodes,
            edgeIds: workingDoc.edgeIds,
            edges: workingDoc.edges
        });
    }
    else
    {
        if (!plan.targetCanvasId || plan.expectedRevision === undefined)
        {
            throw new Error('Target canvas ID and expected revision are required for update import');
        }
        return await storage.updateCanvas(plan.targetCanvasId, plan.expectedRevision, {
            title: workingDoc.title,
            viewport: workingDoc.viewport,
            nodeIds: workingDoc.nodeIds,
            nodes: workingDoc.nodes,
            edgeIds: workingDoc.edgeIds,
            edges: workingDoc.edges
        }, context, crypto.randomUUID());
    }
}
