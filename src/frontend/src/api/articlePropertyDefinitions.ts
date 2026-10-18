import { encodeAedsFrame } from '@/api/binaryFrame';
import * as wire from '@/codecs/binary/articlePropertyValueReadWire.generated';
import { requestBinaryOnly } from '@/composition/binaryTransport';

import { FrameType } from '@wasm/protocol/frame';

type DefinitionRequest = wire.ArticlePropertyDefinitionCreateRequest | wire.ArticlePropertyDefinitionUpdateRequest
    | wire.ArticlePropertyDefinitionRenameRequest | wire.ArticlePropertyDefinitionDeprecateRequest
    | wire.ArticlePropertyDefinitionDeleteRequest;

async function mutate(request: DefinitionRequest, method: string, path: string, frame: FrameType,
    payload: Uint8Array, commandKind: string, signal?: AbortSignal): Promise<wire.ArticlePropertyDefinitionMutationReceipt>
{
    if (request.siteScope !== 'primary-site')
    {
        throw new RangeError('article_property_definition_site_invalid');
    }
    const result = await requestBinaryOnly<wire.ArticlePropertyDefinitionMutationReceipt>({
        binaryUrl: '/api/binary/author/property-definitions' + path, privateScope: 'admin',
        frameType: FrameType.ArticlePropertyDefinitionMutationReceipt, signal,
        requestOptions: { method, cache: 'no-store', requiresPow: true, body: encodeAedsFrame(frame, payload) }
    });
    if (result.requestId !== request.requestId || result.definitionId !== request.definitionId
        || result.definitionOwnerUserId !== request.definitionOwnerUserId || result.siteScope !== request.siteScope
        || result.commandKind !== commandKind || result.previousOwnerRevision !== request.expectedOwnerRevision
        || BigInt(result.ownerRevision) !== BigInt(request.expectedOwnerRevision) + 1n
        || ('expectedSchemaRevision' in request && result.previousSchemaRevision !== request.expectedSchemaRevision)
        || BigInt(result.schemaRevision) !== ('expectedSchemaRevision' in request ? BigInt(request.expectedSchemaRevision) + 1n : 1n))
    {
        throw new Error('article_property_definition_receipt_binding_invalid');
    }
    return result;
}

export const articlePropertyDefinitionsApi = {
    create(request: wire.ArticlePropertyDefinitionCreateRequest, signal?: AbortSignal): Promise<wire.ArticlePropertyDefinitionMutationReceipt>
    {
        return mutate(request, 'POST', '', FrameType.ArticlePropertyDefinitionCreateRequest,
            wire.encodeArticlePropertyDefinitionCreateRequest(request), 'create', signal);
    },
    update(request: wire.ArticlePropertyDefinitionUpdateRequest, signal?: AbortSignal): Promise<wire.ArticlePropertyDefinitionMutationReceipt>
    {
        return mutate(request, 'PUT', '/' + request.definitionId, FrameType.ArticlePropertyDefinitionUpdateRequest,
            wire.encodeArticlePropertyDefinitionUpdateRequest(request), 'change-settings', signal);
    },
    rename(request: wire.ArticlePropertyDefinitionRenameRequest, signal?: AbortSignal): Promise<wire.ArticlePropertyDefinitionMutationReceipt>
    {
        return mutate(request, 'POST', '/' + request.definitionId + '/rename', FrameType.ArticlePropertyDefinitionRenameRequest,
            wire.encodeArticlePropertyDefinitionRenameRequest(request), 'rename', signal);
    },
    deprecate(request: wire.ArticlePropertyDefinitionDeprecateRequest, signal?: AbortSignal): Promise<wire.ArticlePropertyDefinitionMutationReceipt>
    {
        return mutate(request, 'POST', '/' + request.definitionId + '/deprecate', FrameType.ArticlePropertyDefinitionDeprecateRequest,
            wire.encodeArticlePropertyDefinitionDeprecateRequest(request), 'deprecate', signal);
    },
    delete(request: wire.ArticlePropertyDefinitionDeleteRequest, signal?: AbortSignal): Promise<wire.ArticlePropertyDefinitionMutationReceipt>
    {
        return mutate(request, 'DELETE', '/' + request.definitionId, FrameType.ArticlePropertyDefinitionDeleteRequest,
            wire.encodeArticlePropertyDefinitionDeleteRequest(request), 'delete', signal);
    }
};
