import { createPoSpaceProactiveCallbacks } from './pospace-proactive-callbacks.mjs';
import { createPoSpaceRuntimeFlowCore } from './pospace-runtime-flow-core.mjs';

export function createPoSpaceRuntimeFlow(ts, provenance)
{
    const callbacks = createPoSpaceProactiveCallbacks(ts, provenance);
    return createPoSpaceRuntimeFlowCore(ts, provenance, callbacks);
}
