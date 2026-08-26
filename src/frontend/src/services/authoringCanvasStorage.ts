/**
 * Authoring Canvas Server Storage Authority & CAS (#2482, #2484)
 *
 * Implements authoritative canvas document lifecycle, CAS concurrency control,
 * privacy-safe permission scoping, and deletion isolation.
 */

import {
    AUTHORING_CANVAS_BUDGETS,
    computeCanvasDocumentDigest,
    validateAuthoringCanvasDocument,
    type AuthoringCanvasDocument,
    type AuthoringCanvasDocumentSummary,
    type AuthoringCanvasEdge,
    type AuthoringCanvasNode,
    type AuthoringCanvasViewport
} from '@/contracts/authoringCanvas';

export class AuthoringCanvasCasMismatchError extends Error {
    constructor(
        public readonly canvasId: string,
        public readonly expectedRevision: number,
        public readonly actualRevision: number
    ) {
        super(`Canvas CAS revision mismatch on "${canvasId}": expected revision ${expectedRevision}, but found revision ${actualRevision}`);
        this.name = 'AuthoringCanvasCasMismatchError';
    }
}

export class AuthoringCanvasBudgetExceededError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AuthoringCanvasBudgetExceededError';
    }
}

export class AuthoringCanvasAccessDeniedError extends Error {
    constructor() {
        super('Access to authoring canvas denied');
        this.name = 'AuthoringCanvasAccessDeniedError';
    }
}

export class AuthoringCanvasNotFoundError extends Error {
    constructor(public readonly canvasId: string) {
        super(`Authoring canvas "${canvasId}" not found`);
        this.name = 'AuthoringCanvasNotFoundError';
    }
}

export interface CreateCanvasParams {
    userId: string;
    siteId: string;
    title: string;
    viewport?: AuthoringCanvasViewport;
    nodeIds?: string[];
    nodes?: Record<string, AuthoringCanvasNode>;
    edgeIds?: string[];
    edges?: Record<string, AuthoringCanvasEdge>;
}

export interface CanvasStorageReceipt {
    receiptId: string;
    action: 'create' | 'update' | 'delete';
    canvasId: string;
    revision: number;
    nodeCount: number;
    edgeCount: number;
    timestamp: string;
    contentDigest: string;
}

export interface AuthoringCanvasStorage {
    createCanvas(params: CreateCanvasParams): Promise<AuthoringCanvasDocument>;
    getCanvas(canvasId: string, context?: { userId: string; siteId: string }): Promise<AuthoringCanvasDocument | null>;
    updateCanvas(
        canvasId: string,
        expectedRevision: number,
        update: Partial<Omit<AuthoringCanvasDocument, 'id' | 'userId' | 'siteId' | 'revision' | 'createdAt'>>,
        context?: { userId: string; siteId: string }
    ): Promise<AuthoringCanvasDocument>;
    deleteCanvas(
        canvasId: string,
        expectedRevision?: number,
        context?: { userId: string; siteId: string }
    ): Promise<{ success: boolean; deletedCanvasId: string }>;
    listCanvases(context: { userId: string; siteId: string }): Promise<AuthoringCanvasDocumentSummary[]>;
    getReceipts(canvasId?: string): CanvasStorageReceipt[];
    clear(): void;
}

/**
 * In-memory Authoritative Storage Engine with strict CAS, validation, and audit receipts.
 */
class InMemoryAuthoringCanvasStorage implements AuthoringCanvasStorage {
    private readonly documents = new Map<string, AuthoringCanvasDocument>();
    private readonly receipts: CanvasStorageReceipt[] = [];

    async createCanvas(params: CreateCanvasParams): Promise<AuthoringCanvasDocument> {
        if (!params.userId || !params.siteId) {
            throw new AuthoringCanvasAccessDeniedError();
        }

        const userDocs = Array.from(this.documents.values()).filter(
            (d) => d.userId === params.userId && d.siteId === params.siteId
        );
        if (userDocs.length >= AUTHORING_CANVAS_BUDGETS.MAX_CANVASES_PER_USER) {
            throw new AuthoringCanvasBudgetExceededError(
                `Maximum canvas count per user (${AUTHORING_CANVAS_BUDGETS.MAX_CANVASES_PER_USER}) exceeded`
            );
        }

        const title = (params.title || 'Untitled Canvas').trim().slice(0, AUTHORING_CANVAS_BUDGETS.MAX_TITLE_LENGTH);
        const canvasId = `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const now = new Date().toISOString();

        const rawDoc: Omit<AuthoringCanvasDocument, 'contentDigest'> = {
            id: canvasId,
            userId: params.userId,
            siteId: params.siteId,
            title: title || 'Untitled Canvas',
            revision: 1,
            viewport: params.viewport || { x: 0, y: 0, zoom: 1 },
            nodeIds: params.nodeIds || [],
            nodes: params.nodes || {},
            edgeIds: params.edgeIds || [],
            edges: params.edges || {},
            createdAt: now,
            updatedAt: now
        };

        const digest = computeCanvasDocumentDigest(rawDoc);
        const completeDoc: AuthoringCanvasDocument = {
            ...rawDoc,
            contentDigest: digest
        };

        const validation = validateAuthoringCanvasDocument(completeDoc);
        if (!validation.valid) {
            throw new Error(`Invalid canvas document creation: ${validation.error}`);
        }

        this.documents.set(canvasId, JSON.parse(JSON.stringify(completeDoc)));

        this.receipts.push({
            receiptId: `rcpt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            action: 'create',
            canvasId,
            revision: 1,
            nodeCount: completeDoc.nodeIds.length,
            edgeCount: completeDoc.edgeIds.length,
            timestamp: now,
            contentDigest: digest
        });

        return JSON.parse(JSON.stringify(completeDoc));
    }

    async getCanvas(canvasId: string, context?: { userId: string; siteId: string }): Promise<AuthoringCanvasDocument | null> {
        const doc = this.documents.get(canvasId);
        if (!doc) {
            return null;
        }

        if (context) {
            if (doc.userId !== context.userId || doc.siteId !== context.siteId) {
                // Privacy-safe: fail closed and return null to prevent leaking document existence
                return null;
            }
        }

        return JSON.parse(JSON.stringify(doc));
    }

    async updateCanvas(
        canvasId: string,
        expectedRevision: number,
        update: Partial<Omit<AuthoringCanvasDocument, 'id' | 'userId' | 'siteId' | 'revision' | 'createdAt'>>,
        context?: { userId: string; siteId: string }
    ): Promise<AuthoringCanvasDocument> {
        const existing = this.documents.get(canvasId);
        if (!existing) {
            throw new AuthoringCanvasNotFoundError(canvasId);
        }

        if (context && (existing.userId !== context.userId || existing.siteId !== context.siteId)) {
            throw new AuthoringCanvasAccessDeniedError();
        }

        if (existing.revision !== expectedRevision) {
            throw new AuthoringCanvasCasMismatchError(canvasId, expectedRevision, existing.revision);
        }

        const nextRevision = existing.revision + 1;
        const now = new Date().toISOString();

        const updatedRaw: Omit<AuthoringCanvasDocument, 'contentDigest'> = {
            id: existing.id,
            userId: existing.userId,
            siteId: existing.siteId,
            title: update.title !== undefined ? update.title.trim().slice(0, AUTHORING_CANVAS_BUDGETS.MAX_TITLE_LENGTH) : existing.title,
            revision: nextRevision,
            viewport: update.viewport ? { ...update.viewport } : { ...existing.viewport },
            nodeIds: update.nodeIds ? [...update.nodeIds] : [...existing.nodeIds],
            nodes: update.nodes ? { ...update.nodes } : { ...existing.nodes },
            edgeIds: update.edgeIds ? [...update.edgeIds] : [...existing.edgeIds],
            edges: update.edges ? { ...update.edges } : { ...existing.edges },
            createdAt: existing.createdAt,
            updatedAt: now
        };

        const digest = computeCanvasDocumentDigest(updatedRaw);
        const completeDoc: AuthoringCanvasDocument = {
            ...updatedRaw,
            contentDigest: digest
        };

        const validation = validateAuthoringCanvasDocument(completeDoc);
        if (!validation.valid) {
            throw new Error(`Invalid canvas update: ${validation.error}`);
        }

        this.documents.set(canvasId, JSON.parse(JSON.stringify(completeDoc)));

        this.receipts.push({
            receiptId: `rcpt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            action: 'update',
            canvasId,
            revision: nextRevision,
            nodeCount: completeDoc.nodeIds.length,
            edgeCount: completeDoc.edgeIds.length,
            timestamp: now,
            contentDigest: digest
        });

        return JSON.parse(JSON.stringify(completeDoc));
    }

    async deleteCanvas(
        canvasId: string,
        expectedRevision?: number,
        context?: { userId: string; siteId: string }
    ): Promise<{ success: boolean; deletedCanvasId: string }> {
        const existing = this.documents.get(canvasId);
        if (!existing) {
            throw new AuthoringCanvasNotFoundError(canvasId);
        }

        if (context && (existing.userId !== context.userId || existing.siteId !== context.siteId)) {
            throw new AuthoringCanvasAccessDeniedError();
        }

        if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
            throw new AuthoringCanvasCasMismatchError(canvasId, expectedRevision, existing.revision);
        }

        const now = new Date().toISOString();
        this.documents.delete(canvasId);

        this.receipts.push({
            receiptId: `rcpt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            action: 'delete',
            canvasId,
            revision: existing.revision,
            nodeCount: 0,
            edgeCount: 0,
            timestamp: now,
            contentDigest: existing.contentDigest
        });

        return { success: true, deletedCanvasId: canvasId };
    }

    async listCanvases(context: { userId: string; siteId: string }): Promise<AuthoringCanvasDocumentSummary[]> {
        if (!context?.userId || !context?.siteId) {
            return [];
        }

        const summaries: AuthoringCanvasDocumentSummary[] = [];
        for (const doc of this.documents.values()) {
            if (doc.userId === context.userId && doc.siteId === context.siteId) {
                summaries.push({
                    id: doc.id,
                    userId: doc.userId,
                    siteId: doc.siteId,
                    title: doc.title,
                    revision: doc.revision,
                    nodeCount: doc.nodeIds.length,
                    edgeCount: doc.edgeIds.length,
                    createdAt: doc.createdAt,
                    updatedAt: doc.updatedAt,
                    contentDigest: doc.contentDigest
                });
            }
        }

        return summaries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }

    getReceipts(canvasId?: string): CanvasStorageReceipt[] {
        if (canvasId) {
            return this.receipts.filter((r) => r.canvasId === canvasId);
        }
        return [...this.receipts];
    }

    clear(): void {
        this.documents.clear();
        this.receipts.length = 0;
    }
}

export const authoringCanvasStorage: AuthoringCanvasStorage = new InMemoryAuthoringCanvasStorage();
