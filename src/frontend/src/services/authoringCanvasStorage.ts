/**
 * Authoring Canvas Server Storage Authority & CAS (#2482, #2484)
 *
 * Implements authoritative canvas document lifecycle, CAS concurrency control,
 * privacy-safe permission scoping, and deletion isolation.
 */
import { AUTHORING_CANVAS_BUDGETS, validateAuthoringCanvasDocument, type AuthoringCanvasDocument, type AuthoringCanvasDocumentSummary, type AuthoringCanvasEdge, type AuthoringCanvasNode, type AuthoringCanvasViewport } from '@/contracts/authoringCanvas';
export class AuthoringCanvasCasMismatchError extends Error
{
    readonly canvasId: string;
    readonly expectedRevision: number;
    readonly actualRevision: number;
    constructor(canvasId: string, expectedRevision: number, actualRevision: number)
    {
        super(`Canvas CAS revision mismatch on "${canvasId}": expected revision ${expectedRevision}, but found revision ${actualRevision}`);
        this.name = 'AuthoringCanvasCasMismatchError';
        this.canvasId = canvasId;
        this.expectedRevision = expectedRevision;
        this.actualRevision = actualRevision;
    }
}
export class AuthoringCanvasBudgetExceededError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = 'AuthoringCanvasBudgetExceededError';
    }
}
export class AuthoringCanvasAccessDeniedError extends Error
{
    constructor()
    {
        super('Access to authoring canvas denied');
        this.name = 'AuthoringCanvasAccessDeniedError';
    }
}
export class AuthoringCanvasNotFoundError extends Error
{
    readonly canvasId: string;
    constructor(canvasId: string)
    {
        super(`Authoring canvas "${canvasId}" not found`);
        this.name = 'AuthoringCanvasNotFoundError';
        this.canvasId = canvasId;
    }
}
export interface CreateCanvasParams
{
    userId: string;
    siteId: string;
    title: string;
    viewport?: AuthoringCanvasViewport;
    nodeIds?: string[];
    nodes?: Record<string, AuthoringCanvasNode>;
    edgeIds?: string[];
    edges?: Record<string, AuthoringCanvasEdge>;
}
export interface CanvasStorageReceipt
{
    receiptId: string;
    action: 'create' | 'update' | 'delete';
    canvasId: string;
    revision: number;
    nodeCount: number;
    edgeCount: number;
    timestamp: string;
    contentDigest: string;
}
/** Authenticated server transport; implementations must use the existing AEDS v2 boundary. */
export interface AuthoringCanvasStorage
{
    createCanvas(params: CreateCanvasParams): Promise<AuthoringCanvasDocument>;
    getCanvas(canvasId: string, context: CanvasOwnerContext): Promise<AuthoringCanvasDocument | null>;
    updateCanvas(canvasId: string, expectedRevision: number, update: Partial<Omit<AuthoringCanvasDocument, 'id' | 'userId' | 'siteId' | 'revision' | 'createdAt'>>, context: CanvasOwnerContext, requestId: string): Promise<AuthoringCanvasDocument>;
    deleteCanvas(canvasId: string, expectedRevision: number, context: CanvasOwnerContext, requestId: string): Promise<{
        success: boolean;
        deletedCanvasId: string;
    }>;
    listCanvases(context: CanvasOwnerContext): Promise<AuthoringCanvasDocumentSummary[]>;
}
export interface CanvasOwnerContext
{
    userId: string;
    siteId: string;
}
/** Presentation adapter. It has no document table, receipt issuer, or persistence fallback. */
export class AuthoringCanvasStorageClient implements AuthoringCanvasStorage
{
    private readonly transport: AuthoringCanvasStorage;
    constructor(transport: AuthoringCanvasStorage)
    {
        this.transport = transport;
    }
    private requireContext(context: CanvasOwnerContext): void
    {
        if (!context.userId || !context.siteId)
        {
            throw new AuthoringCanvasAccessDeniedError();
        }
    }
    private requireRevision(revision: number): void
    {
        if (!Number.isSafeInteger(revision) || revision < 1)
        {
            throw new Error('canvas_revision_invalid');
        }
    }
    private requireDocument(doc: AuthoringCanvasDocument, context: CanvasOwnerContext): AuthoringCanvasDocument
    {
        if (doc.userId !== context.userId || doc.siteId !== context.siteId)
        {
            throw new AuthoringCanvasAccessDeniedError();
        }
        const result = validateAuthoringCanvasDocument(doc);
        if (!result.valid)
        {
            throw new Error(`canvas_projection_invalid: ${result.error}`);
        }
        return structuredClone(doc);
    }
    async createCanvas(params: CreateCanvasParams): Promise<AuthoringCanvasDocument>
    {
        this.requireContext(params);
        if (!params.title.trim() || params.title.length > AUTHORING_CANVAS_BUDGETS.MAX_TITLE_LENGTH)
        {
            throw new AuthoringCanvasBudgetExceededError('canvas_title_invalid');
        }
        return this.requireDocument(await this.transport.createCanvas(structuredClone(params)), params);
    }
    async getCanvas(canvasId: string, context: CanvasOwnerContext): Promise<AuthoringCanvasDocument | null>
    {
        this.requireContext(context);
        const doc = await this.transport.getCanvas(canvasId, context);
        if (doc && doc.id !== canvasId)
        {
            throw new Error('canvas_projection_identity_mismatch');
        }
        return doc ? this.requireDocument(doc, context) : null;
    }
    async updateCanvas(canvasId: string, expectedRevision: number, update: Partial<Omit<AuthoringCanvasDocument, 'id' | 'userId' | 'siteId' | 'revision' | 'createdAt'>>, context: CanvasOwnerContext, requestId: string): Promise<AuthoringCanvasDocument>
    {
        this.requireContext(context);
        this.requireRevision(expectedRevision);
        if (!requestId)
        {
            throw new Error('canvas_request_id_required');
        }
        const doc = this.requireDocument(await this.transport.updateCanvas(canvasId, expectedRevision, structuredClone(update), context, requestId), context);
        if (doc.id !== canvasId || doc.revision !== expectedRevision + 1)
        {
            throw new Error('canvas_transition_receipt_mismatch');
        }
        return doc;
    }
    async deleteCanvas(canvasId: string, expectedRevision: number, context: CanvasOwnerContext, requestId: string): Promise<{
        success: boolean;
        deletedCanvasId: string;
    }>
    {
        this.requireContext(context);
        this.requireRevision(expectedRevision);
        if (!requestId)
        {
            throw new Error('canvas_request_id_required');
        }
        const result = await this.transport.deleteCanvas(canvasId, expectedRevision, context, requestId);
        if (result.deletedCanvasId !== canvasId)
        {
            throw new Error('canvas_deletion_receipt_mismatch');
        }
        return result;
    }
    async listCanvases(context: CanvasOwnerContext): Promise<AuthoringCanvasDocumentSummary[]>
    {
        this.requireContext(context);
        const docs = await this.transport.listCanvases(context);
        if (docs.length > AUTHORING_CANVAS_BUDGETS.MAX_CANVASES_PER_USER)
        {
            throw new AuthoringCanvasBudgetExceededError('canvas_owner_budget_exceeded');
        }
        if (docs.some(doc => doc.userId !== context.userId || doc.siteId !== context.siteId))
        {
            throw new AuthoringCanvasAccessDeniedError();
        }
        return structuredClone(docs);
    }
}
