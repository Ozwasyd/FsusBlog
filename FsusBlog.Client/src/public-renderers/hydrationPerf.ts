import { markStartup, measureStartup } from '@/bootstrap/startupProfiler';
import type { PublicHydrationPayload } from './types';

export type HydrationPerfMetrics = Readonly<{
  pageKind: PublicHydrationPayload['pageKind'];
  routeKey: string;
  startAt: number;
  longTaskCountBeforeHydration: number;
  scriptResourceCountBeforeHydration: number;
}>;

type PerfWindow = Window & {
  __FSUS_PUBLIC_HYDRATION_METRICS__?: Array<Record<string, unknown>>;
};

const LONG_TASK_OBSERVER_SUPPORTED =
  typeof window !== 'undefined' &&
  typeof PerformanceObserver !== 'undefined' &&
  typeof PerformanceObserver.supportedEntryTypes !== 'undefined' &&
  PerformanceObserver.supportedEntryTypes.includes('longtask');

let longTaskObserverStarted = false;
let longTaskCount = 0;

function ensureLongTaskObserver(): void {
  if (!LONG_TASK_OBSERVER_SUPPORTED || longTaskObserverStarted) {
    return;
  }

  try {
    const observer = new PerformanceObserver((list) => {
      longTaskCount += list.getEntries().length;
    });
    observer.observe({ entryTypes: ['longtask'] });
    longTaskObserverStarted = true;
  } catch {
    longTaskObserverStarted = false;
  }
}

function countLongTasksSoFar(): number {
  if (!LONG_TASK_OBSERVER_SUPPORTED) {
    return 0;
  }

  ensureLongTaskObserver();
  return longTaskCount;
}

function countScriptResourcesSoFar(): number {
  return performance
    .getEntriesByType('resource')
    .filter((entry) => entry.initiatorType === 'script')
    .length;
}

export function beginHydrationMetrics(payload: PublicHydrationPayload): HydrationPerfMetrics {
  markStartup('public-hydrate:start');
  return {
    pageKind: payload.pageKind,
    routeKey: payload.routeKey,
    startAt: performance.now(),
    longTaskCountBeforeHydration: countLongTasksSoFar(),
    scriptResourceCountBeforeHydration: countScriptResourcesSoFar()
  };
}

export function markHydrationStep(step: string): void {
  markStartup(`public-hydrate:${step}`);
}

export function finishHydrationMetrics(metrics: HydrationPerfMetrics): void {
  markStartup('public-hydrate:end');
  const duration = Number((performance.now() - metrics.startAt).toFixed(2));
  measureStartup('public-hydrate-total', 'public-hydrate:start', 'public-hydrate:end');
  measureStartup('public-hydrate-mount', 'public-hydrate:hydrate:start', 'public-hydrate:hydrate:mounted');

  const snapshot = {
    pageKind: metrics.pageKind,
    routeKey: metrics.routeKey,
    durationMs: duration,
    longTaskDelta: countLongTasksSoFar() - metrics.longTaskCountBeforeHydration,
    scriptResourcesBeforeHydration: metrics.scriptResourceCountBeforeHydration,
    scriptResourcesDelta: countScriptResourcesSoFar() - metrics.scriptResourceCountBeforeHydration
  };

  const perfWindow = window as PerfWindow;
  const current = perfWindow.__FSUS_PUBLIC_HYDRATION_METRICS__ ?? [];
  current.push(snapshot);
  perfWindow.__FSUS_PUBLIC_HYDRATION_METRICS__ = current;
}
