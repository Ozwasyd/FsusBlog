import {
    handlePerceptionV2WorkerRequest,
    type PerceptionV2WorkerRequest
} from './perception-v2.renderer';

const ctx = self as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<PerceptionV2WorkerRequest>) =>
{
    const result = await handlePerceptionV2WorkerRequest(event.data);
    if (!result)
    {
        return;
    }

    ctx.postMessage(result.response, result.transfer);
};
