import type { RenderPipelineConfigContract } from '@ozwasyd/element-plus/render-pipeline';

export const FSUSBLOG_RENDER_PIPELINE_CONFIG = Object.freeze({
    mode: 'auto',
    worker: 'auto',
    thresholds: {
        htmlBytes: 128_000,
        estimatedNodes: 1500,
        itemCount: 500
    },
    budget: {
        frameMs: 8,
        overscanPx: 800,
        measureBatch: 32
    },
    acceleration: {
        mode: 'auto',
        compositor: 'auto',
        contentVisibility: 'auto',
        layerBudget: 80
    }
} as const satisfies RenderPipelineConfigContract);
