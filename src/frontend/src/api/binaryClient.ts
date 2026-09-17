import { runPrivateRequest } from '@/services/privateRequestRuntime';

import { binaryRequest } from './binaryApiClient';

export async function getBinary<T = unknown>(url: string, signal?: AbortSignal): Promise<T>
{
    return await runPrivateRequest('admin', signal, async (leaseSignal) =>
    {
        const buffer = await binaryRequest(url, { signal: leaseSignal });
        leaseSignal.throwIfAborted();
        const decoder = new TextDecoder();
        const json = decoder.decode(buffer);
        return JSON.parse(json) as T;
    });
}
