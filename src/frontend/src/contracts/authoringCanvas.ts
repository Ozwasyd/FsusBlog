/**
 * Closed Authoring Canvas Contracts (#2482, #2483, #2484)
 *
 * Defines closed schemas, node/edge types, budgets, projection states,
 * presentation validation and non-authoritative package fingerprints.
 * Server document/transition digests are never recomputed or attested by these helpers.
 */
// <generated-canvas-client-budgets>
// Generated from the canonical Shared domain constants; do not hand-edit.
export const AUTHORING_CANVAS_BUDGETS = Object.freeze({
    MAX_NODES: 10000,
    MAX_EDGES: 10000,
    MAX_TITLE_LENGTH: 128,
    MAX_NOTE_TEXT_LENGTH: 8192,
    MAX_FRAME_LABEL_LENGTH: 128,
    MAX_EDGE_LABEL_LENGTH: 128,
    MAX_COORDINATE_MAGNITUDE: 10000000,
    MIN_NODE_EXTENT: 24,
    MAX_NODE_EXTENT: 4096,
    MIN_ZOOM: 0.1,
    MAX_ZOOM: 4,
    MAX_CANVASES_PER_USER: 100
} as const);
// </generated-canvas-client-budgets>
export const CLOSED_NODE_TYPES = Object.freeze([
    'article-reference',
    'heading-reference',
    'block-reference',
    'plain-text-note',
    'group-frame'
] as const);
export type AuthoringCanvasNodeType = typeof CLOSED_NODE_TYPES[number];
export const CLOSED_EDGE_TYPES = Object.freeze([
    'visual-only',
    'explicit-reference-note'
] as const);
export type AuthoringCanvasEdgeType = typeof CLOSED_EDGE_TYPES[number];
export const CLOSED_REFERENCE_STATUSES = Object.freeze([
    'current',
    'pinned-current',
    'pinned-stale',
    'target-updated',
    'missing',
    'deleted',
    'archived',
    'permission-denied',
    'heading-missing',
    'block-missing',
    'duplicate',
    'invalid',
    'source-stale'
] as const);
export type AuthoringCanvasReferenceStatus = typeof CLOSED_REFERENCE_STATUSES[number];
export interface AuthoringCanvasViewport
{
    x: number;
    y: number;
    zoom: number;
}
export interface AuthoringCanvasBaseNode
{
    id: string;
    type: AuthoringCanvasNodeType;
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex?: number;
    createdAt?: string;
    updatedAt?: string;
}
export interface AuthoringCanvasArticleReferenceNode extends AuthoringCanvasBaseNode
{
    type: 'article-reference';
    targetArticleId: number | string;
    pinnedTargetRevision?: number | string;
}
export interface AuthoringCanvasHeadingReferenceNode extends AuthoringCanvasBaseNode
{
    type: 'heading-reference';
    targetArticleId: number | string;
    targetHeadingId: string;
    pinnedTargetRevision?: number | string;
}
export interface AuthoringCanvasBlockReferenceNode extends AuthoringCanvasBaseNode
{
    type: 'block-reference';
    targetArticleId: number | string;
    targetBlockId: string;
    pinnedTargetRevision?: number | string;
}
export interface AuthoringCanvasPlainTextNoteNode extends AuthoringCanvasBaseNode
{
    type: 'plain-text-note';
    text: string;
}
export interface AuthoringCanvasGroupFrameNode extends AuthoringCanvasBaseNode
{
    type: 'group-frame';
    label: string;
    memberNodeIds: string[];
}
export type AuthoringCanvasNode = AuthoringCanvasArticleReferenceNode | AuthoringCanvasHeadingReferenceNode | AuthoringCanvasBlockReferenceNode | AuthoringCanvasPlainTextNoteNode | AuthoringCanvasGroupFrameNode;
export interface AuthoringCanvasEdge
{
    id: string;
    type: AuthoringCanvasEdgeType;
    sourceNodeId: string;
    targetNodeId: string;
    label?: string;
    createdAt?: string;
    updatedAt?: string;
}
export interface AuthoringCanvasDocument
{
    id: string;
    userId: string;
    siteId: string;
    title: string;
    revision: number;
    viewport: AuthoringCanvasViewport;
    nodeIds: string[];
    nodes: Record<string, AuthoringCanvasNode>;
    edgeIds: string[];
    edges: Record<string, AuthoringCanvasEdge>;
    createdAt: string;
    updatedAt: string;
    contentDigest: string;
}
/**
 * Internal typed-input JSON roundtrips preserve the existing lossy clone behavior.
 * The concrete return assertions retain the caller's static model assumption;
 * these helpers do not parse unknown payloads or prove runtime model validity.
 * Extra properties, toJSON, undefined omission and native JSON errors are preserved.
 */
export function cloneCanvasDocumentJson(source: AuthoringCanvasDocument): AuthoringCanvasDocument
{
    const parsed: unknown = JSON.parse(JSON.stringify(source));
    return parsed as AuthoringCanvasDocument;
}
export function cloneCanvasNodeJson(source: AuthoringCanvasNode): AuthoringCanvasNode
{
    const parsed: unknown = JSON.parse(JSON.stringify(source));
    return parsed as AuthoringCanvasNode;
}
export function cloneCanvasEdgeJson(source: AuthoringCanvasEdge): AuthoringCanvasEdge
{
    const parsed: unknown = JSON.parse(JSON.stringify(source));
    return parsed as AuthoringCanvasEdge;
}
export interface AuthoringCanvasDocumentSummary
{
    id: string;
    userId: string;
    siteId: string;
    title: string;
    revision: number;
    nodeCount: number;
    edgeCount: number;
    createdAt: string;
    updatedAt: string;
    contentDigest: string;
}
export interface AuthoringCanvasReferenceProjection
{
    nodeId: string;
    nodeType: 'article-reference' | 'heading-reference' | 'block-reference';
    targetArticleId: number | string;
    status: AuthoringCanvasReferenceStatus;
    title?: string;
    snippet?: string;
    targetRevision?: number | string;
    openIntent?: AuthoringCanvasOpenIntent;
    contentDigest: string;
    resolvedAt: string;
}
export interface AuthoringCanvasOpenIntent
{
    articleId: number | string;
    revision?: string;
    mode?: 0;
    targetGroupId?: string | null;
    headingId?: string;
    blockId?: string;
    route: string;
}
export interface AuthoringCanvasValidationResult
{
    valid: boolean;
    error?: string;
}
/**
 * Type guards
 */
export function isAuthoringCanvasNodeType(value: unknown): value is AuthoringCanvasNodeType
{
    return typeof value === 'string' && (CLOSED_NODE_TYPES as readonly string[]).includes(value);
}
export function isAuthoringCanvasEdgeType(value: unknown): value is AuthoringCanvasEdgeType
{
    return typeof value === 'string' && (CLOSED_EDGE_TYPES as readonly string[]).includes(value);
}
export function isAuthoringCanvasReferenceStatus(value: unknown): value is AuthoringCanvasReferenceStatus
{
    return typeof value === 'string' && (CLOSED_REFERENCE_STATUSES as readonly string[]).includes(value);
}
/**
 * Fails closed on any arbitrary script/HTML/SVG/Vue component injection or unsupported properties.
 */
function containsForbiddenScriptOrHtml(value: string): boolean
{
    const dangerousPatterns = [
        /<script\b/i,
        /<\/script>/i,
        /<iframe\b/i,
        /<svg\b/i,
        /javascript:/i,
        /on\w+\s*=/i,
        /<object\b/i,
        /<embed\b/i
    ];
    return /<[\s\S]*?>/u.test(value) || hasDisallowedControlCharacters(value) || dangerousPatterns.some((pattern) => pattern.test(value));
}
function hasDisallowedControlCharacters(value: string): boolean
{
    for (let index = 0; index < value.length; index++)
    {
        const code = value.charCodeAt(index);
        if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || (code >= 127 && code <= 159))
        {
            return true;
        }
    }
    return false;
}
export function validateAuthoringCanvasNode(node: unknown): AuthoringCanvasValidationResult
{
    if (!node || typeof node !== 'object')
    {
        return { valid: false, error: 'Node must be a non-null object' };
    }
    const n = node as Record<string, unknown>;
    if (typeof n.id !== 'string' || !n.id.trim())
    {
        return { valid: false, error: 'Node id must be a non-empty string' };
    }
    if (!isAuthoringCanvasNodeType(n.type))
    {
        return { valid: false, error: `Invalid or unknown node type: "${String.raw({ raw: ['', ''] }, n.type)}"` };
    }
    if (typeof n.x !== 'number' || !Number.isFinite(n.x) || typeof n.y !== 'number' || !Number.isFinite(n.y))
    {
        return { valid: false, error: 'Node coordinates (x, y) must be finite numbers' };
    }
    if (typeof n.width !== 'number' || !Number.isFinite(n.width) || n.width <= 0 ||
        typeof n.height !== 'number' || !Number.isFinite(n.height) || n.height <= 0)
    {
        return { valid: false, error: 'Node dimensions (width, height) must be positive finite numbers' };
    }
    if (Math.abs(n.x) > AUTHORING_CANVAS_BUDGETS.MAX_COORDINATE_MAGNITUDE
        || Math.abs(n.y) > AUTHORING_CANVAS_BUDGETS.MAX_COORDINATE_MAGNITUDE
        || (n.width) < AUTHORING_CANVAS_BUDGETS.MIN_NODE_EXTENT
        || (n.height) < AUTHORING_CANVAS_BUDGETS.MIN_NODE_EXTENT
        || (n.width) > AUTHORING_CANVAS_BUDGETS.MAX_NODE_EXTENT
        || (n.height) > AUTHORING_CANVAS_BUDGETS.MAX_NODE_EXTENT)
    {
        return { valid: false, error: 'Node geometry exceeds the server contract bounds' };
    }
    const commonFields = ['id', 'type', 'x', 'y', 'width', 'height', 'zIndex', 'createdAt', 'updatedAt'];
    const fieldsByType: Record<AuthoringCanvasNodeType, string[]> = {
        'article-reference': ['targetArticleId', 'pinnedTargetRevision'],
        'heading-reference': ['targetArticleId', 'targetHeadingId', 'pinnedTargetRevision'],
        'block-reference': ['targetArticleId', 'targetBlockId', 'pinnedTargetRevision'],
        'plain-text-note': ['text'], 'group-frame': ['label', 'memberNodeIds']
    };
    const allowedFields = new Set([...commonFields, ...fieldsByType[n.type]]);
    if ((n.type === 'article-reference' || n.type === 'heading-reference' || n.type === 'block-reference')
        && ['markdown', 'body', 'html', 'renderedDom'].some(key => key in n))
    {
        return { valid: false, error: 'Reference node cannot persist article body, HTML, or DOM copies' };
    }
    if (Object.keys(n).some(key => !allowedFields.has(key)))
    {
        return { valid: false, error: 'Node contains fields outside its closed record type' };
    }
    // Node-type specific validation
    if (n.type === 'article-reference')
    {
        if (n.targetArticleId === undefined || n.targetArticleId === null || n.targetArticleId === '')
        {
            return { valid: false, error: 'Article reference must specify a targetArticleId' };
        }
        // Disallow arbitrary body / markdown / HTML payload copies
        if ('markdown' in n || 'body' in n || 'html' in n || 'renderedDom' in n)
        {
            return { valid: false, error: 'Reference node cannot persist article body, HTML, or DOM copies' };
        }
    }
    else if (n.type === 'heading-reference')
    {
        if (n.targetArticleId === undefined || n.targetArticleId === null || n.targetArticleId === '')
        {
            return { valid: false, error: 'Heading reference must specify a targetArticleId' };
        }
        if (typeof n.targetHeadingId !== 'string' || !n.targetHeadingId.trim())
        {
            return { valid: false, error: 'Heading reference must specify a targetHeadingId' };
        }
        if ('markdown' in n || 'body' in n || 'html' in n)
        {
            return { valid: false, error: 'Reference node cannot persist article body or HTML copies' };
        }
    }
    else if (n.type === 'block-reference')
    {
        if (n.targetArticleId === undefined || n.targetArticleId === null || n.targetArticleId === '')
        {
            return { valid: false, error: 'Block reference must specify a targetArticleId' };
        }
        if (typeof n.targetBlockId !== 'string' || !n.targetBlockId.trim())
        {
            return { valid: false, error: 'Block reference must specify a targetBlockId' };
        }
        if ('markdown' in n || 'body' in n || 'html' in n)
        {
            return { valid: false, error: 'Reference node cannot persist article body or HTML copies' };
        }
    }
    else if (n.type === 'plain-text-note')
    {
        if (typeof n.text !== 'string')
        {
            return { valid: false, error: 'Plain text note must contain string text' };
        }
        if (n.text.length > AUTHORING_CANVAS_BUDGETS.MAX_NOTE_TEXT_LENGTH)
        {
            return { valid: false, error: `Note text exceeds maximum length budget of ${AUTHORING_CANVAS_BUDGETS.MAX_NOTE_TEXT_LENGTH}` };
        }
        if (containsForbiddenScriptOrHtml(n.text))
        {
            return { valid: false, error: 'Note text contains forbidden script or HTML execution patterns' };
        }
    }
    else if (n.type === 'group-frame')
    {
        if (typeof n.label !== 'string')
        {
            return { valid: false, error: 'Group frame must contain a label string' };
        }
        if (n.label.length > AUTHORING_CANVAS_BUDGETS.MAX_FRAME_LABEL_LENGTH)
        {
            return { valid: false, error: 'Group frame label exceeds length budget' };
        }
        if (!Array.isArray(n.memberNodeIds))
        {
            return { valid: false, error: 'Group frame memberNodeIds must be an array' };
        }
        for (const mid of n.memberNodeIds)
        {
            if (typeof mid !== 'string')
            {
                return { valid: false, error: 'Group frame member node ID must be a string' };
            }
        }
    }
    return { valid: true };
}
export function validateAuthoringCanvasEdge(edge: unknown): AuthoringCanvasValidationResult
{
    if (!edge || typeof edge !== 'object' || Array.isArray(edge))
    {
        return { valid: false, error: 'Edge must be a non-null object' };
    }
    const e = edge as Record<string, unknown>;
    if (Object.keys(e).some(key => !['id', 'type', 'sourceNodeId', 'targetNodeId', 'label'].includes(key)))
    {
        return { valid: false, error: 'Edge contains fields outside its closed record type' };
    }
    if (typeof e.id !== 'string' || !e.id.trim())
    {
        return { valid: false, error: 'Edge id must be a non-empty string' };
    }
    if (!isAuthoringCanvasEdgeType(e.type))
    {
        return { valid: false, error: `Invalid or unknown edge type: "${String.raw({ raw: ['', ''] }, e.type)}"` };
    }
    if (typeof e.sourceNodeId !== 'string' || !e.sourceNodeId.trim())
    {
        return { valid: false, error: 'Edge sourceNodeId must be a non-empty string' };
    }
    if (typeof e.targetNodeId !== 'string' || !e.targetNodeId.trim())
    {
        return { valid: false, error: 'Edge targetNodeId must be a non-empty string' };
    }
    if (e.sourceNodeId === e.targetNodeId)
    {
        return { valid: false, error: 'Self-referencing edges are not permitted' };
    }
    if (e.label !== undefined && typeof e.label !== 'string')
    {
        return { valid: false, error: 'Edge label must be a string if defined' };
    }
    if (typeof e.label === 'string')
    {
        if (e.label.length > AUTHORING_CANVAS_BUDGETS.MAX_EDGE_LABEL_LENGTH)
        {
            return { valid: false, error: 'Edge label exceeds maximum length budget' };
        }
        if (containsForbiddenScriptOrHtml(e.label))
        {
            return { valid: false, error: 'Edge label contains forbidden script/HTML' };
        }
    }
    return { valid: true };
}
export function validateAuthoringCanvasDocument(doc: unknown): AuthoringCanvasValidationResult
{
    if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    {
        return { valid: false, error: 'Document must be a non-null object' };
    }
    const d = doc as Record<string, unknown>;
    if (Object.keys(d).some(key => !['id', 'userId', 'siteId', 'title', 'revision', 'viewport',
        'nodeIds', 'nodes', 'edgeIds', 'edges', 'createdAt', 'updatedAt', 'contentDigest'].includes(key)))
    {
        return { valid: false, error: 'Document contains fields outside its presentation record' };
    }
    if (typeof d.id !== 'string' || !d.id.trim())
    {
        return { valid: false, error: 'Document id must be a non-empty string' };
    }
    if (typeof d.userId !== 'string' || !d.userId.trim())
    {
        return { valid: false, error: 'Document userId must be a non-empty string' };
    }
    if (typeof d.siteId !== 'string' || !d.siteId.trim())
    {
        return { valid: false, error: 'Document siteId must be a non-empty string' };
    }
    if (typeof d.title !== 'string')
    {
        return { valid: false, error: 'Document title must be a string' };
    }
    if (d.title.length > AUTHORING_CANVAS_BUDGETS.MAX_TITLE_LENGTH)
    {
        return { valid: false, error: `Document title exceeds budget of ${AUTHORING_CANVAS_BUDGETS.MAX_TITLE_LENGTH}` };
    }
    if (typeof d.revision !== 'number' || !Number.isSafeInteger(d.revision) || d.revision < 1)
    {
        return { valid: false, error: 'Document revision must be a positive integer >= 1' };
    }
    // Viewport validation
    if (!d.viewport || typeof d.viewport !== 'object')
    {
        return { valid: false, error: 'Document must specify a valid viewport' };
    }
    const vp = d.viewport as Record<string, unknown>;
    if (typeof vp.x !== 'number' || !Number.isFinite(vp.x) ||
        typeof vp.y !== 'number' || !Number.isFinite(vp.y) ||
        Math.abs(vp.x) > AUTHORING_CANVAS_BUDGETS.MAX_COORDINATE_MAGNITUDE ||
        Math.abs(vp.y) > AUTHORING_CANVAS_BUDGETS.MAX_COORDINATE_MAGNITUDE ||
        typeof vp.zoom !== 'number' || !Number.isFinite(vp.zoom) ||
        vp.zoom < AUTHORING_CANVAS_BUDGETS.MIN_ZOOM || vp.zoom > AUTHORING_CANVAS_BUDGETS.MAX_ZOOM)
    {
        return { valid: false, error: 'Viewport parameters (x, y, zoom) are out of bounds or invalid' };
    }
    // Node collections
    if (!Array.isArray(d.nodeIds))
    {
        return { valid: false, error: 'Document nodeIds must be an array' };
    }
    if (d.nodeIds.length > AUTHORING_CANVAS_BUDGETS.MAX_NODES)
    {
        return { valid: false, error: `Node count exceeds budget limit of ${AUTHORING_CANVAS_BUDGETS.MAX_NODES}` };
    }
    if (!d.nodes || typeof d.nodes !== 'object' || Array.isArray(d.nodes))
    {
        return { valid: false, error: 'Document nodes map must be an object' };
    }
    const nodesMap = d.nodes as Record<string, unknown>;
    if (new Set(d.nodeIds).size !== d.nodeIds.length || Object.keys(nodesMap).length !== d.nodeIds.length)
    {
        return { valid: false, error: 'Node roster must be unique and exact' };
    }
    for (const nodeId of d.nodeIds)
    {
        if (typeof nodeId !== 'string')
        {
            return { valid: false, error: 'Node ID in nodeIds array must be a string' };
        }
        const node = nodesMap[nodeId];
        if (!Object.hasOwn(nodesMap, nodeId) || !node || (node as {
            id?: unknown;
        }).id !== nodeId)
        {
            return { valid: false, error: `Node "${nodeId}" listed in nodeIds but missing in nodes record` };
        }
        const nodeValidation = validateAuthoringCanvasNode(node);
        if (!nodeValidation.valid)
        {
            return { valid: false, error: `Node "${nodeId}" validation failed: ${nodeValidation.error}` };
        }
    }
    for (const nodeId of d.nodeIds)
    {
        if (typeof nodeId !== 'string')
        {
            return { valid: false, error: 'Node ID in nodeIds array must be a string' };
        }
        const node = nodesMap[nodeId] as AuthoringCanvasNode;
        if (node.type !== 'group-frame')
        {
            continue;
        }
        if (new Set(node.memberNodeIds).size !== node.memberNodeIds.length
            || node.memberNodeIds.some(id => !Object.hasOwn(nodesMap, id)
                || (nodesMap[id] as AuthoringCanvasNode).type === 'group-frame'))
        {
            return { valid: false, error: 'Frames require unique document-local non-frame members' };
        }
    }
    // Edge collections
    if (!Array.isArray(d.edgeIds))
    {
        return { valid: false, error: 'Document edgeIds must be an array' };
    }
    if (d.edgeIds.length > AUTHORING_CANVAS_BUDGETS.MAX_EDGES)
    {
        return { valid: false, error: `Edge count exceeds budget limit of ${AUTHORING_CANVAS_BUDGETS.MAX_EDGES}` };
    }
    if (!d.edges || typeof d.edges !== 'object' || Array.isArray(d.edges))
    {
        return { valid: false, error: 'Document edges map must be an object' };
    }
    const edgesMap = d.edges as Record<string, unknown>;
    if (new Set(d.edgeIds).size !== d.edgeIds.length || Object.keys(edgesMap).length !== d.edgeIds.length)
    {
        return { valid: false, error: 'Edge roster must be unique and exact' };
    }
    for (const edgeId of d.edgeIds)
    {
        if (typeof edgeId !== 'string')
        {
            return { valid: false, error: 'Edge ID in edgeIds array must be a string' };
        }
        const edge = edgesMap[edgeId];
        if (!Object.hasOwn(edgesMap, edgeId) || !edge || (edge as {
            id?: unknown;
        }).id !== edgeId)
        {
            return { valid: false, error: `Edge "${edgeId}" listed in edgeIds but missing in edges record` };
        }
        const edgeValidation = validateAuthoringCanvasEdge(edge);
        if (!edgeValidation.valid)
        {
            return { valid: false, error: `Edge "${edgeId}" validation failed: ${edgeValidation.error}` };
        }
        const e = edge as AuthoringCanvasEdge;
        if (!nodesMap[e.sourceNodeId])
        {
            return { valid: false, error: `Edge "${edgeId}" references non-existent sourceNodeId: "${e.sourceNodeId}"` };
        }
        if (!nodesMap[e.targetNodeId])
        {
            return { valid: false, error: `Edge "${edgeId}" references non-existent targetNodeId: "${e.targetNodeId}"` };
        }
    }
    return { valid: true };
}
/**
 * Deterministic Content Digest computation
 */
function canvasLabelOrEmpty(value: string | undefined): string
{
    if (value)
    {
        return value;
    }
    return '';
}
export function canonicalizeCanvasDocument(doc: Omit<AuthoringCanvasDocument, 'contentDigest'>): string
{
    const sortedNodeIds = [...doc.nodeIds];
    const sortedEdgeIds = [...doc.edgeIds];
    const sortedNodes: Record<string, unknown> = {};
    for (const id of sortedNodeIds)
    {
        const n = doc.nodes[id];
        if (n)
        {
            sortedNodes[id] = {
                id: n.id,
                type: n.type,
                x: Math.round(n.x * 100) / 100,
                y: Math.round(n.y * 100) / 100,
                width: Math.round(n.width * 100) / 100,
                height: Math.round(n.height * 100) / 100,
                ...(n.type === 'article-reference' ? { targetArticleId: n.targetArticleId, pinnedTargetRevision: n.pinnedTargetRevision } : {}),
                ...(n.type === 'heading-reference' ? { targetArticleId: n.targetArticleId, targetHeadingId: n.targetHeadingId, pinnedTargetRevision: n.pinnedTargetRevision } : {}),
                ...(n.type === 'block-reference' ? { targetArticleId: n.targetArticleId, targetBlockId: n.targetBlockId, pinnedTargetRevision: n.pinnedTargetRevision } : {}),
                ...(n.type === 'plain-text-note' ? { text: n.text } : {}),
                ...(n.type === 'group-frame' ? { label: n.label, memberNodeIds: [...n.memberNodeIds].sort() } : {})
            };
        }
    }
    const sortedEdges: Record<string, unknown> = {};
    for (const id of sortedEdgeIds)
    {
        const e = doc.edges[id];
        if (e)
        {
            sortedEdges[id] = {
                id: e.id,
                type: e.type,
                sourceNodeId: e.sourceNodeId,
                targetNodeId: e.targetNodeId,
                label: canvasLabelOrEmpty(e.label)
            };
        }
    }
    return JSON.stringify({
        id: doc.id,
        userId: doc.userId,
        siteId: doc.siteId,
        title: doc.title,
        revision: doc.revision,
        viewport: {
            x: Math.round(doc.viewport.x * 100) / 100,
            y: Math.round(doc.viewport.y * 100) / 100,
            zoom: Math.round(doc.viewport.zoom * 1000) / 1000
        },
        nodeIds: sortedNodeIds,
        nodes: sortedNodes,
        edgeIds: sortedEdgeIds,
        edges: sortedEdges
    });
}
/**
 * Fast deterministic 32-bit/64-bit FNV-1a / Murmur-like hex digest for synchronous operations
 */
export function computeCanvasDocumentDigest(doc: Omit<AuthoringCanvasDocument, 'contentDigest'>): string
{
    const canonical = canonicalizeCanvasDocument(doc);
    let h1 = 0xdeadbeef ^ canonical.length;
    let h2 = 0x41c6ce57 ^ canonical.length;
    for (let i = 0; i < canonical.length; i++)
    {
        const ch = canonical.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const part1 = (h1 >>> 0).toString(16).padStart(8, '0');
    const part2 = (h2 >>> 0).toString(16).padStart(8, '0');
    return `cad_${part1}${part2}`;
}
