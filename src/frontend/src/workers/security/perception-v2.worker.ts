import {
    handlePerceptionV2WorkerRequest,
    type PerceptionV2WorkerRequest
} from './perception-v2.renderer';

// Dedicated workers share MessagePort's message and transferable APIs.
const ctx = self as Pick<MessagePort, 'onmessage' | 'postMessage'>;

ctx.onmessage = async (event: MessageEvent<PerceptionV2WorkerRequest>) =>
{
    const result = await handlePerceptionV2WorkerRequest(event.data);
    if (!result)
    {
        return;
    }

    ctx.postMessage(result.response, result.transfer);
};
