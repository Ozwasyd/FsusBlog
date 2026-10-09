import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthoringCanvas } from '@/composables/useAuthoringCanvas';
import { authoringCanvasStorage, createCanvasTestSession, settleCanvasTestOperations } from '../../fixtures/authoringCanvasTransportFixture';

describe('useAuthoringCanvas Composable (#2489)', () => {
    beforeEach(() => {
        authoringCanvasStorage.clear();
    });

    it('creates a canvas, adds notes and references, and manages undo/redo stack', async () => {
        const canvas = useAuthoringCanvas(createCanvasTestSession());

        const doc = await canvas.createCanvas('Test Canvas');
        expect(doc).not.toBeNull();
        expect(canvas.document.value?.title).toBe('Test Canvas');

        // Add a note
        canvas.addPlainTextNote('A note about distributed systems', 100, 100);
        await settleCanvasTestOperations();
        expect(canvas.document.value?.nodeIds.length).toBe(1);
        expect(canvas.canUndo.value).toBe(true);
        expect(canvas.canRedo.value).toBe(false);

        // Add an article reference
        canvas.addArticleReference(101, 400, 100);
        await settleCanvasTestOperations();
        expect(canvas.document.value?.nodeIds.length).toBe(2);

        // Undo article reference addition
        canvas.undo();
        await settleCanvasTestOperations();
        expect(canvas.document.value?.nodeIds.length).toBe(1);
        expect(canvas.canRedo.value).toBe(true);

        // Redo
        canvas.redo();
        await settleCanvasTestOperations();
        expect(canvas.document.value?.nodeIds.length).toBe(2);
    });

    it('manages structured outline projection with full parity', async () => {
        const canvas = useAuthoringCanvas(createCanvasTestSession());

        await canvas.createCanvas('Outline Test');

        canvas.addPlainTextNote('Research note', 100, 100);
        await settleCanvasTestOperations();
        canvas.addArticleReference(42, 400, 100);
        await settleCanvasTestOperations();

        const outline = canvas.outlineItems.value;
        expect(outline.length).toBe(2);
        expect(outline[0].kind).toBe('node');
        expect(outline[1].kind).toBe('node');
    });

    it('handles pan, zoom, and viewport reset bounds', async () => {
        const canvas = useAuthoringCanvas(createCanvasTestSession());
        await canvas.createCanvas('Zoom Test');

        canvas.setZoom(2.5);
        await settleCanvasTestOperations();
        expect(canvas.viewport.value.zoom).toBe(2.5);

        // Clamp at max
        canvas.setZoom(10.0);
        await settleCanvasTestOperations();
        expect(canvas.viewport.value.zoom).toBe(4.0);

        canvas.panBy(100, -50);
        await settleCanvasTestOperations();
        expect(canvas.viewport.value.x).toBe(100);
        expect(canvas.viewport.value.y).toBe(-50);

        canvas.resetViewport();
        await settleCanvasTestOperations();
        expect(canvas.viewport.value).toEqual({ x: 0, y: 0, zoom: 1 });
    });
});
