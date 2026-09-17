import type { EChartsType } from 'echarts/core';

type EchartsRuntimeModule = typeof import('@/utils/echartsRuntime.bundle');

let runtimePromise: Promise<EchartsRuntimeModule['echarts']> | null = null;

export type { EChartsType };

export function loadEchartsRuntime(): Promise<EchartsRuntimeModule['echarts']>
{
    if (runtimePromise)
    {
        return runtimePromise;
    }

    runtimePromise = import('@/utils/echartsRuntime.bundle').then((module) => module.echarts);
    return runtimePromise;
}
