/** Test-only transport double. No PostgreSQL, HTTP, identity, or runtime acceptance is implied. */
import { computeCanvasDocumentDigest, type AuthoringCanvasDocument } from '@/contracts/authoringCanvas';
import { authoringCanvasOperationEngine } from '@/services/authoringCanvasOperations';
import { AuthoringCanvasStorageClient, AuthoringCanvasAccessDeniedError, AuthoringCanvasBudgetExceededError, AuthoringCanvasCasMismatchError, type AuthoringCanvasStorage, type CanvasOwnerContext } from '@/services/authoringCanvasStorage';
import type { TargetArticleProvider, TargetArticleProviderItem, ResolutionContext } from '@/services/authoringCanvasResolver';
import type { AuthoringCanvasSession } from '@/composables/useAuthoringCanvas';

export class InMemoryTargetArticleProvider implements TargetArticleProvider {
    private readonly articles = new Map<number | string, TargetArticleProviderItem>();
    setArticle(article: TargetArticleProviderItem): void { this.articles.set(article.id, structuredClone(article)); }
    clear(): void { this.articles.clear(); }
    async getArticle(id: number | string, _context: ResolutionContext): Promise<TargetArticleProviderItem | null> { return structuredClone(this.articles.get(id) ?? null); }
    async getArticlesBatch(ids: (number | string)[], context: ResolutionContext): Promise<Map<number | string, TargetArticleProviderItem>> {
        const result = new Map<number | string, TargetArticleProviderItem>();
        for (const id of ids) { const article = await this.getArticle(id, context); if (article) result.set(id, article); }
        return result;
    }
}
const documents = new Map<string, AuthoringCanvasDocument>();
const receipts = new Map<string, { action: string; canvasId: string; contentDigest: string }[]>();
const transport: AuthoringCanvasStorage = {
    async createCanvas(params) {
        if ([...documents.values()].filter(doc => doc.userId === params.userId && doc.siteId === params.siteId).length >= 100) throw new AuthoringCanvasBudgetExceededError('canvas_owner_budget_exceeded');
        const now = new Date().toISOString();
        const doc: AuthoringCanvasDocument = { id: `canvas-${crypto.randomUUID()}`, userId: params.userId, siteId: params.siteId, title: params.title, revision: 1, viewport: params.viewport ?? { x: 0, y: 0, zoom: 1 }, nodeIds: params.nodeIds ?? [], nodes: params.nodes ?? {}, edgeIds: params.edgeIds ?? [], edges: params.edges ?? {}, createdAt: now, updatedAt: now, contentDigest: '' };
        doc.contentDigest = computeCanvasDocumentDigest(doc); documents.set(doc.id, structuredClone(doc));
        receipts.set(doc.id, [{ action: 'create', canvasId: doc.id, contentDigest: doc.contentDigest }]);
        return structuredClone(doc);
    },
    async getCanvas(id, context) { const doc = documents.get(id); return doc && doc.userId === context.userId && doc.siteId === context.siteId ? structuredClone(doc) : null; },
    async updateCanvas(id, expectedRevision, update, context) {
        const doc = documents.get(id);
        if (!doc || doc.userId !== context.userId || doc.siteId !== context.siteId) throw new AuthoringCanvasAccessDeniedError();
        if (doc.revision !== expectedRevision) throw new AuthoringCanvasCasMismatchError(id, expectedRevision, doc.revision);
        const next = { ...doc, ...update, revision: doc.revision + 1, updatedAt: new Date().toISOString() };
        next.contentDigest = computeCanvasDocumentDigest(next); documents.set(id, structuredClone(next)); return next;
    },
    async deleteCanvas(id, expectedRevision, context) {
        const doc = documents.get(id);
        if (!doc || doc.userId !== context.userId || doc.siteId !== context.siteId) throw new AuthoringCanvasAccessDeniedError();
        if (doc.revision !== expectedRevision) throw new AuthoringCanvasCasMismatchError(id, expectedRevision, doc.revision);
        documents.delete(id); return { success: true, deletedCanvasId: id };
    },
    async listCanvases(context) { return [...documents.values()].filter(doc => doc.userId === context.userId && doc.siteId === context.siteId).map(doc => ({ ...doc, nodeCount: doc.nodeIds.length, edgeCount: doc.edgeIds.length })); }
};
const client = new AuthoringCanvasStorageClient(transport);
export const authoringCanvasStorage = {
    createCanvas: client.createCanvas.bind(client), getCanvas: client.getCanvas.bind(client),
    updateCanvas: client.updateCanvas.bind(client), deleteCanvas: client.deleteCanvas.bind(client), listCanvases: client.listCanvases.bind(client),
    clear(): void { documents.clear(); receipts.clear(); },
    getReceipts(id: string) { return structuredClone(receipts.get(id) ?? []); }
};
export function createCanvasTestSession(ownerContext: CanvasOwnerContext = { userId: 'user-alice', siteId: 'site-default' }): AuthoringCanvasSession {
    const undo: AuthoringCanvasDocument[] = []; const redo: AuthoringCanvasDocument[] = [];
    async function commit(id: string, expectedRevision: number, requestId: string, next: AuthoringCanvasDocument) {
        const document = await authoringCanvasStorage.updateCanvas(id, expectedRevision, { ...next }, ownerContext, requestId);
        return { document, receipt: { canvasId: id, revision: document.revision, requestId, journalId: crypto.randomUUID(), undoDepth: undo.length, redoDepth: redo.length, receiptDigest: 'a'.repeat(64), canvasContentDigest: document.contentDigest } };
    }
    return { ownerContext, storage: authoringCanvasStorage, projections: { async resolveReferences() { return new Map(); } },
        async history(canvasId, revision, canvasContentDigest) { return { canvasId, revision, canvasContentDigest, historyDigest: 'b'.repeat(64), undoDepth: undo.length, redoDepth: redo.length }; },
        async apply(id, revision, requestId, command) { const before = (await authoringCanvasStorage.getCanvas(id, ownerContext))!; const next = authoringCanvasOperationEngine.applyCommand(before, command, { expectedRevision: revision }).updatedDoc; undo.push(before); redo.length = 0; return commit(id, revision, requestId, next); },
        async undo(id, revision, requestId) { const before = (await authoringCanvasStorage.getCanvas(id, ownerContext))!; const next = undo.pop(); if (!next) throw new Error('empty-history'); redo.push(before); return commit(id, revision, requestId, next); },
        async redo(id, revision, requestId) { const before = (await authoringCanvasStorage.getCanvas(id, ownerContext))!; const next = redo.pop(); if (!next) throw new Error('empty-history'); undo.push(before); return commit(id, revision, requestId, next); }
    };
}
export async function settleCanvasTestOperations(): Promise<void> { for (let index = 0; index < 20; index++) await new Promise<void>(resolve => setTimeout(resolve, 0)); }
