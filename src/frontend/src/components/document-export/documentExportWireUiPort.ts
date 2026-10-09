import {
    cancelDocumentExport, captureDocumentExportRequest, classifyDocumentExportFailure, deleteDocumentExport,
    documentExportSameSource, downloadDocumentExport, getDocumentExport, listDocumentExports, requestDocumentExport, retryDocumentExport
} from '@/api/documentExport';
import type { DocumentExportPrivateDeliver } from '@/api/documentExport';
import type { DocumentExportJobResponse, DocumentExportRequest, DocumentExportSource } from '@/codecs/binary/documentExportWire.generated';

import { createDocumentExportPrivateUiLifecycle } from './documentExportPrivateUiLifecycle';
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
    let catalog: readonly DocumentExportFormatChoice[] = Object.freeze(options.catalog.map(choice => Object.freeze({
        ...choice, layouts: Object.freeze([...choice.layouts]), themes: Object.freeze([...choice.themes]), support: Object.freeze([...choice.support])
    })));
    let sources: DocumentExportWireUiOptions['sources'] = Object.freeze(options.sources.map(choice => Object.freeze({
        ...choice, coordinate: Object.freeze({ ...choice.coordinate })
    })));
    let prepareRequest: DocumentExportWireUiOptions['prepareRequest'] | undefined = options.prepareRequest;
    let deliverPrivate: DocumentExportPrivateDeliver | undefined = options.deliverPrivate;
    const lifecycle = createDocumentExportPrivateUiLifecycle(() =>
    {
        catalog = [];
        sources = [];
        prepareRequest = undefined;
        deliverPrivate = undefined;
    });

    async function run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>
    {
        lifecycle.assertCurrent();
        try
        {
            const result = await operation(lifecycle.signal);
            lifecycle.assertCurrent();
            return result;
        }
        catch (error)
        {
            lifecycle.assertCurrent();
            throw error;
        }
    }

    return {
        get catalog()
        {
            return catalog;
        },
        get sources()
        {
            return sources;
        },
        prepareRequest: selection =>
        {
            lifecycle.assertCurrent();
            const format = catalog.find(choice => choice.id === selection.formatId);
            const source = sources.find(choice => choice.id === selection.sourceId);
            if (!format?.available || !format.layouts.includes(selection.layout) || !format.themes.includes(selection.theme)
                || !source)
            {
                throw new RangeError('document_export_selection_unavailable');
            }
            const request = captureDocumentExportRequest(prepareRequest!(selection));
            lifecycle.assertCurrent();
            if (request.formatId !== selection.formatId || request.layoutProfile !== selection.layout
                || request.themeProfile !== selection.theme || !documentExportSameSource(request.source, source.coordinate))
            {
                throw new RangeError('document_export_selection_mismatch');
            }
            return request;
        },
        captureRequest: request =>
        {
            lifecycle.assertCurrent();
            return captureDocumentExportRequest(request);
        },
        request: request => run(signal => requestDocumentExport(request, signal)),
        list: async (offset, limit) => (await run(signal => listDocumentExports(offset, limit, signal))).jobs,
        status: taskId => run(signal => getDocumentExport(taskId, signal)),
        cancel: taskId => run(signal => cancelDocumentExport(taskId, signal)),
        retry: taskId => run(signal => retryDocumentExport(taskId, signal)),
        delete: taskId => run(signal => deleteDocumentExport(taskId, signal)),
        download: (taskId, signal) => run(privateSignal => downloadDocumentExport(taskId,
            AbortSignal.any([signal, privateSignal]), deliverPrivate!)),
        inspect: inspectDocumentExportWire,
        classifyFailure: classifyDocumentExportFailure,
        subscribePermissionRevoked: lifecycle.subscribePermissionRevoked,
        dispose: lifecycle.dispose
    };
}
