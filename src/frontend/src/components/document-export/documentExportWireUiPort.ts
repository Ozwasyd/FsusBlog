import {
    cancelDocumentExport, captureDocumentExportRequest, classifyDocumentExportFailure, deleteDocumentExport,
    documentExportSameSource, downloadDocumentExport, getDocumentExport, listDocumentExports, requestDocumentExport, retryDocumentExport
} from '@/api/documentExport';
import type { DocumentExportPrivateDeliver } from '@/api/documentExport';
import type { DocumentExportJobResponse, DocumentExportRequest, DocumentExportSource } from '@/codecs/binary/documentExportWire.generated';

import { documentExportValidatePresentation } from './documentExportUiPort';

import type {
    DocumentExportFormatChoice, DocumentExportPresentation, DocumentExportSelection, DocumentExportSourceChoice,
    DocumentExportUiPort
} from './documentExportUiPort';

export interface DocumentExportWireUiOptions {
    /** Authenticated canonical catalog/source projection; never a browser provider registry. */
    catalog: readonly DocumentExportFormatChoice[];
    sources: readonly (DocumentExportSourceChoice & { coordinate: Readonly<DocumentExportSource>; })[];
    /** Original admission adapter binds exact source coordinates and request/idempotency identity. */
    prepareRequest: (selection: Readonly<DocumentExportSelection>) => DocumentExportRequest;
    deliverPrivate: DocumentExportPrivateDeliver;
}

function sourceLabel(snapshot: DocumentExportJobResponse): string
{
    const source = snapshot.source;
    const coordinate = source.kind === 1 ? `草稿 ${source.draftKey}`
        : source.kind === 2 ? `修订 ${source.revisionId}`
            : `发布 ${source.publicationId} · 修订 ${source.revisionId}`;
    return `文章 ${source.articleId} · ${coordinate} · version ${source.sourceVersion}`;
}

/** Display only authorized snapshot facts; absent warnings/filename stay unavailable. */
export function inspectDocumentExportWire(snapshot: DocumentExportJobResponse): DocumentExportPresentation
{
    const lastAttempt = snapshot.attempts.at(-1);
    const view: DocumentExportPresentation = {
        taskId: snapshot.taskId, status: snapshot.status, version: snapshot.version,
        source: sourceLabel(snapshot), format: snapshot.formatId, provider: `${snapshot.providerId}@${snapshot.providerVersion}`,
        options: `${snapshot.layoutProfile}/${snapshot.themeProfile}/${snapshot.locale}`,
        inputDigest: snapshot.inputDigest, contentDigest: snapshot.taskDigest, reason: snapshot.reason,
        warnings: null,
        diagnostic: lastAttempt?.diagnostic ?? snapshot.output !== null,
        output: snapshot.output === null ? null : {
            filename: null, bytes: snapshot.output.length, mediaType: snapshot.output.mediaType,
            expiresAt: new Date(Number(snapshot.output.expiresAtUnixMs)).toISOString(),
            deleted: snapshot.output.deletedAtUnixMs !== null
        }
    };
    documentExportValidatePresentation(view);
    return view;
}

export function createDocumentExportWireUiPort(options: DocumentExportWireUiOptions): DocumentExportUiPort<DocumentExportJobResponse, DocumentExportRequest>
{
    return {
        catalog: options.catalog,
        sources: options.sources,
        prepareRequest: selection =>
        {
            const format = options.catalog.find(choice => choice.id === selection.formatId);
            const source = options.sources.find(choice => choice.id === selection.sourceId);
            if (!format?.available || !format.layouts.includes(selection.layout) || !format.themes.includes(selection.theme)
                || !source)
            {
                throw new RangeError('document_export_selection_unavailable');
            }
            const request = captureDocumentExportRequest(options.prepareRequest(selection));
            if (request.formatId !== selection.formatId || request.layoutProfile !== selection.layout
                || request.themeProfile !== selection.theme || !documentExportSameSource(request.source, source.coordinate))
            {
                throw new RangeError('document_export_selection_mismatch');
            }
            return request;
        },
        captureRequest: captureDocumentExportRequest,
        request: requestDocumentExport,
        list: async (offset, limit) => (await listDocumentExports(offset, limit)).jobs,
        status: getDocumentExport,
        cancel: cancelDocumentExport,
        retry: retryDocumentExport,
        delete: deleteDocumentExport,
        download: (taskId, signal) => downloadDocumentExport(taskId, signal, options.deliverPrivate),
        inspect: inspectDocumentExportWire,
        classifyFailure: classifyDocumentExportFailure
    };
}
