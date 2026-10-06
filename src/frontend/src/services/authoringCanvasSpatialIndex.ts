/**
 * Authoring Canvas Spatial Index & Virtualization Engine (#2489, #2494)
 *
 * Provides high-performance spatial bucket indexing for up to 10,000 nodes,
 * sub-millisecond viewport bounding box queries, and bidirectional coordinate transforms.
 */
import { AUTHORING_CANVAS_BUDGETS, type AuthoringCanvasEdge, type AuthoringCanvasNode, type AuthoringCanvasViewport } from '@/contracts/authoringCanvas';
export interface BoundingBox
{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}
export interface ContainerDimensions
{
    width: number;
    height: number;
}
export interface Point
{
    x: number;
    y: number;
}
const CELL_SIZE = 500; // Spatial bucket grid cell size in canvas units
export class AuthoringCanvasSpatialIndex
{
    private readonly grid = new Map<string, Set<string>>();
    private readonly nodeBounds = new Map<string, BoundingBox>();
    private getCellKey(cellX: number, cellY: number): string
    {
        return `${cellX}:${cellY}`;
    }
    clear(): void
    {
        this.grid.clear();
        this.nodeBounds.clear();
    }
    /**
     * Indexes a collection of nodes into spatial grid buckets.
     */
    indexNodes(nodes: AuthoringCanvasNode[]): void
    {
        this.clear();
        for (const node of nodes)
        {
            this.insertNode(node);
        }
    }
    insertNode(node: AuthoringCanvasNode): void
    {
        if (!Number.isFinite(node.x) || !Number.isFinite(node.y)
            || !Number.isFinite(node.width) || !Number.isFinite(node.height)
            || node.width <= 0 || node.height <= 0
            || node.width > AUTHORING_CANVAS_BUDGETS.MAX_NODE_EXTENT
            || node.height > AUTHORING_CANVAS_BUDGETS.MAX_NODE_EXTENT)
        {
            throw new Error('canvas_spatial_geometry_invalid');
        }
        this.removeNode(node.id);
        const bbox: BoundingBox = {
            minX: node.x,
            minY: node.y,
            maxX: node.x + node.width,
            maxY: node.y + node.height
        };
        this.nodeBounds.set(node.id, bbox);
        const startCellX = Math.floor(bbox.minX / CELL_SIZE);
        const endCellX = Math.floor(bbox.maxX / CELL_SIZE);
        const startCellY = Math.floor(bbox.minY / CELL_SIZE);
        const endCellY = Math.floor(bbox.maxY / CELL_SIZE);
        for (let cx = startCellX; cx <= endCellX; cx++)
        {
            for (let cy = startCellY; cy <= endCellY; cy++)
            {
                const key = this.getCellKey(cx, cy);
                let cell = this.grid.get(key);
                if (!cell)
                {
                    cell = new Set<string>();
                    this.grid.set(key, cell);
                }
                cell.add(node.id);
            }
        }
    }
    removeNode(nodeId: string): void
    {
        const bbox = this.nodeBounds.get(nodeId);
        if (!bbox)
        {
            return;
        }
        const startCellX = Math.floor(bbox.minX / CELL_SIZE);
        const endCellX = Math.floor(bbox.maxX / CELL_SIZE);
        const startCellY = Math.floor(bbox.minY / CELL_SIZE);
        const endCellY = Math.floor(bbox.maxY / CELL_SIZE);
        for (let cx = startCellX; cx <= endCellX; cx++)
        {
            for (let cy = startCellY; cy <= endCellY; cy++)
            {
                const key = this.getCellKey(cx, cy);
                const cell = this.grid.get(key);
                if (cell)
                {
                    cell.delete(nodeId);
                    if (cell.size === 0)
                    {
                        this.grid.delete(key);
                    }
                }
            }
        }
        this.nodeBounds.delete(nodeId);
    }
    /**
     * Calculates the canvas coordinate bounding box currently visible in the container viewport.
     */
    getViewportCanvasBounds(viewport: AuthoringCanvasViewport, container: ContainerDimensions, bufferPx = 200): BoundingBox
    {
        // Screen (0, 0) in canvas coords
        const topLeft = this.screenToCanvas({ x: -bufferPx, y: -bufferPx }, viewport);
        // Screen (width, height) in canvas coords
        const bottomRight = this.screenToCanvas({ x: container.width + bufferPx, y: container.height + bufferPx }, viewport);
        return {
            minX: Math.min(topLeft.x, bottomRight.x),
            minY: Math.min(topLeft.y, bottomRight.y),
            maxX: Math.max(topLeft.x, bottomRight.x),
            maxY: Math.max(topLeft.y, bottomRight.y)
        };
    }
    /**
     * Queries all node IDs that intersect the given viewport bounds.
     */
    queryVisibleNodeIds(viewport: AuthoringCanvasViewport, container: ContainerDimensions, bufferPx = 200): string[]
    {
        const visibleBounds = this.getViewportCanvasBounds(viewport, container, bufferPx);
        const startCellX = Math.floor(visibleBounds.minX / CELL_SIZE);
        const endCellX = Math.floor(visibleBounds.maxX / CELL_SIZE);
        const startCellY = Math.floor(visibleBounds.minY / CELL_SIZE);
        const endCellY = Math.floor(visibleBounds.maxY / CELL_SIZE);
        const candidateIds = new Set<string>();
        for (let cx = startCellX; cx <= endCellX; cx++)
        {
            for (let cy = startCellY; cy <= endCellY; cy++)
            {
                const key = this.getCellKey(cx, cy);
                const cell = this.grid.get(key);
                if (cell)
                {
                    for (const id of cell)
                    {
                        candidateIds.add(id);
                    }
                }
            }
        }
        // Precise AABB intersection test
        const visibleIds: string[] = [];
        for (const id of candidateIds)
        {
            const bbox = this.nodeBounds.get(id);
            if (bbox)
            {
                if (bbox.maxX >= visibleBounds.minX &&
                    bbox.minX <= visibleBounds.maxX &&
                    bbox.maxY >= visibleBounds.minY &&
                    bbox.minY <= visibleBounds.maxY)
                {
                    visibleIds.push(id);
                }
            }
        }
        return visibleIds;
    }
    /**
     * Filters edges that have at least one or both endpoints visible in the viewport.
     */
    queryVisibleEdgeIds(edges: AuthoringCanvasEdge[], visibleNodeIdSet: Set<string>): string[]
    {
        const visibleEdgeIds: string[] = [];
        for (const edge of edges)
        {
            if (visibleNodeIdSet.has(edge.sourceNodeId) || visibleNodeIdSet.has(edge.targetNodeId))
            {
                visibleEdgeIds.push(edge.id);
            }
        }
        return visibleEdgeIds;
    }
    /**
     * Screen px -> Canvas coordinate
     */
    screenToCanvas(screenPoint: Point, viewport: AuthoringCanvasViewport): Point
    {
        const zoom = Math.max(AUTHORING_CANVAS_BUDGETS.MIN_ZOOM, Math.min(AUTHORING_CANVAS_BUDGETS.MAX_ZOOM, viewport.zoom || 1));
        return {
            x: (screenPoint.x - viewport.x) / zoom,
            y: (screenPoint.y - viewport.y) / zoom
        };
    }
    /**
     * Canvas coordinate -> Screen px
     */
    canvasToScreen(canvasPoint: Point, viewport: AuthoringCanvasViewport): Point
    {
        const zoom = Math.max(AUTHORING_CANVAS_BUDGETS.MIN_ZOOM, Math.min(AUTHORING_CANVAS_BUDGETS.MAX_ZOOM, viewport.zoom || 1));
        return {
            x: canvasPoint.x * zoom + viewport.x,
            y: canvasPoint.y * zoom + viewport.y
        };
    }
}
export const authoringCanvasSpatialIndex = new AuthoringCanvasSpatialIndex();
