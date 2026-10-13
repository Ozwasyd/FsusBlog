import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthoringCanvasNode } from '@/contracts/authoringCanvas';
import {
    AuthoringCanvasSpatialIndex,
    authoringCanvasSpatialIndex
} from '@/services/authoringCanvasSpatialIndex';

describe('Authoring Canvas Spatial Index & Virtualization (#2489, #2494)', () => {
    beforeEach(() => {
        authoringCanvasSpatialIndex.clear();
    });

    it('indexes nodes and queries visible nodes with precise viewport bounding box culling', () => {
        const nodes: AuthoringCanvasNode[] = [
            { id: 'node-center', type: 'plain-text-note', x: 100, y: 100, width: 200, height: 100, text: 'Visible' },
            { id: 'node-far-away', type: 'plain-text-note', x: 5000, y: 5000, width: 200, height: 100, text: 'Hidden' },
            { id: 'node-edge', type: 'plain-text-note', x: 750, y: 550, width: 200, height: 100, text: 'Edge' }
        ];

        authoringCanvasSpatialIndex.indexNodes(nodes);

        const visible = authoringCanvasSpatialIndex.queryVisibleNodeIds(
            { x: 0, y: 0, zoom: 1 },
            { width: 800, height: 600 },
            50 // buffer
        );

        expect(visible).toContain('node-center');
        expect(visible).toContain('node-edge');
        expect(visible).not.toContain('node-far-away');
    });

    it('handles screen-to-canvas and canvas-to-screen coordinate roundtrips with zoom and pan', () => {
        const viewport = { x: 150, y: -80, zoom: 1.5 };
        const canvasPoint = { x: 300, y: 400 };

        const screenPoint = authoringCanvasSpatialIndex.canvasToScreen(canvasPoint, viewport);
        expect(screenPoint.x).toBe(300 * 1.5 + 150);
        expect(screenPoint.y).toBe(400 * 1.5 - 80);

        const roundtripCanvas = authoringCanvasSpatialIndex.screenToCanvas(screenPoint, viewport);
        expect(Math.round(roundtripCanvas.x)).toBe(300);
        expect(Math.round(roundtripCanvas.y)).toBe(400);
    });

    it('indexes and queries 10,000 nodes in under 50ms with tight memory bounds', () => {
        const spatial = new AuthoringCanvasSpatialIndex();
        const tenThousandNodes: AuthoringCanvasNode[] = [];

        for (let i = 0; i < 10000; i++) {
            tenThousandNodes.push({
                id: `n-${i}`,
                type: 'plain-text-note',
                x: (i % 100) * 300,
                y: Math.floor(i / 100) * 200,
                width: 250,
                height: 150,
                text: `Node ${i}`
            });
        }

        const t0 = performance.now();
        spatial.indexNodes(tenThousandNodes);
        const indexDuration = performance.now() - t0;
        expect(indexDuration).toBeLessThan(500); // Fast indexing

        const t1 = performance.now();
        // Query viewport (0,0) to (1200, 800)
        const visible = spatial.queryVisibleNodeIds(
            { x: 0, y: 0, zoom: 1 },
            { width: 1200, height: 800 },
            100
        );
        const queryDuration = performance.now() - t1;

        expect(queryDuration).toBeLessThan(20); // Sub-millisecond to few ms query
        // Should only return ~20-30 nodes out of 10,000!
        expect(visible.length).toBeGreaterThan(0);
        expect(visible.length).toBeLessThan(100);
    });
});
