import { encodeAedsFrame } from '@/api/binaryFrame';
import * as wire from '@/codecs/binary/articlePropertyValueReadWire.generated';
import { requestBinaryOnly } from '@/composition/binaryTransport';

import { FrameType } from '@wasm/protocol/frame';

type DefinitionRequest = wire.ArticlePropertyDefinitionCreateRequest | wire.ArticlePropertyDefinitionUpdateRequest
    | wire.ArticlePropertyDefinitionRenameRequest | wire.ArticlePropertyDefinitionDeprecateRequest
    | wire.ArticlePropertyDefinitionDeleteRequest;

function captureDefinitionRequest<T extends DefinitionRequest>(request: T,
    encode: (value: T) => Uint8Array, decode: (payload: Uint8Array) => T): { command: T; payload: Uint8Array; }
{
    if (request.siteScope !== 'primary-site')
    {
        throw new RangeError('article_property_definition_site_invalid');
    }
    const payload = encode(request);
    return { command: decode(payload), payload };
}

async function bindDefinitionReceipt(request: DefinitionRequest,
    response: Promise<wire.ArticlePropertyDefinitionMutationReceipt>, commandKind: string): Promise<wire.ArticlePropertyDefinitionMutationReceipt>
{
    const result = await response;
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
        const { command, payload } = captureDefinitionRequest(request,
            wire.encodeArticlePropertyDefinitionCreateRequest, wire.decodeArticlePropertyDefinitionCreateRequest);
        return bindDefinitionReceipt(command, requestBinaryOnly<wire.ArticlePropertyDefinitionMutationReceipt>({
            binaryRoute: { operationId: 'binary_author_article_property_definition_create' },
            privateScope: 'admin', frameType: FrameType.ArticlePropertyDefinitionMutationReceipt, signal,
            requestOptions: { method: 'POST', cache: 'no-store', requiresPow: true,
                body: encodeAedsFrame(FrameType.ArticlePropertyDefinitionCreateRequest, payload) }
        }), 'create');
    },
    update(request: wire.ArticlePropertyDefinitionUpdateRequest, signal?: AbortSignal): Promise<wire.ArticlePropertyDefinitionMutationReceipt>
    {
        const { command, payload } = captureDefinitionRequest(request,
            wire.encodeArticlePropertyDefinitionUpdateRequest, wire.decodeArticlePropertyDefinitionUpdateRequest);
        return bindDefinitionReceipt(command, requestBinaryOnly<wire.ArticlePropertyDefinitionMutationReceipt>({
            binaryRoute: { operationId: 'binary_author_article_property_definition_update', params: { definitionId: command.definitionId } },
            privateScope: 'admin', frameType: FrameType.ArticlePropertyDefinitionMutationReceipt, signal,
            requestOptions: { method: 'PUT', cache: 'no-store', requiresPow: true,
                body: encodeAedsFrame(FrameType.ArticlePropertyDefinitionUpdateRequest, payload) }
        }), 'change-settings');
    },
    rename(request: wire.ArticlePropertyDefinitionRenameRequest, signal?: AbortSignal): Promise<wire.ArticlePropertyDefinitionMutationReceipt>
    {
        const { command, payload } = captureDefinitionRequest(request,
            wire.encodeArticlePropertyDefinitionRenameRequest, wire.decodeArticlePropertyDefinitionRenameRequest);
        return bindDefinitionReceipt(command, requestBinaryOnly<wire.ArticlePropertyDefinitionMutationReceipt>({
            binaryRoute: { operationId: 'binary_author_article_property_definition_rename', params: { definitionId: command.definitionId } },
            privateScope: 'admin', frameType: FrameType.ArticlePropertyDefinitionMutationReceipt, signal,
            requestOptions: { method: 'POST', cache: 'no-store', requiresPow: true,
                body: encodeAedsFrame(FrameType.ArticlePropertyDefinitionRenameRequest, payload) }
        }), 'rename');
    },
    deprecate(request: wire.ArticlePropertyDefinitionDeprecateRequest, signal?: AbortSignal): Promise<wire.ArticlePropertyDefinitionMutationReceipt>
    {
        const { command, payload } = captureDefinitionRequest(request,
            wire.encodeArticlePropertyDefinitionDeprecateRequest, wire.decodeArticlePropertyDefinitionDeprecateRequest);
        return bindDefinitionReceipt(command, requestBinaryOnly<wire.ArticlePropertyDefinitionMutationReceipt>({
            binaryRoute: { operationId: 'binary_author_article_property_definition_deprecate', params: { definitionId: command.definitionId } },
            privateScope: 'admin', frameType: FrameType.ArticlePropertyDefinitionMutationReceipt, signal,
            requestOptions: { method: 'POST', cache: 'no-store', requiresPow: true,
                body: encodeAedsFrame(FrameType.ArticlePropertyDefinitionDeprecateRequest, payload) }
        }), 'deprecate');
    },
    delete(request: wire.ArticlePropertyDefinitionDeleteRequest, signal?: AbortSignal): Promise<wire.ArticlePropertyDefinitionMutationReceipt>
    {
        const { command, payload } = captureDefinitionRequest(request,
            wire.encodeArticlePropertyDefinitionDeleteRequest, wire.decodeArticlePropertyDefinitionDeleteRequest);
        return bindDefinitionReceipt(command, requestBinaryOnly<wire.ArticlePropertyDefinitionMutationReceipt>({
            binaryRoute: { operationId: 'binary_author_article_property_definition_delete', params: { definitionId: command.definitionId } },
            privateScope: 'admin', frameType: FrameType.ArticlePropertyDefinitionMutationReceipt, signal,
            requestOptions: { method: 'DELETE', cache: 'no-store', requiresPow: true,
                body: encodeAedsFrame(FrameType.ArticlePropertyDefinitionDeleteRequest, payload) }
        }), 'delete');
    }
};
