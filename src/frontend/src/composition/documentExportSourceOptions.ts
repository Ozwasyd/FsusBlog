import { captureDocumentExportRevisionChoices, captureDocumentExportSources } from '@/api/documentExportSourceOptions';
import type {
    DocumentExportRevisionChoicesRequest, DocumentExportSourceCaptureRequest, DocumentExportSourceChoiceResponse,
    DocumentExportSourceChoicesResponse
} from '@/codecs/binary/documentExportSourceOptionsWire.generated';
import type { DocumentExportRequest } from '@/codecs/binary/documentExportWire.generated';
import { mapDocumentExportSourceChoices } from '@/components/document-export/documentExportSourceChoices';
import type { DocumentExportSelection } from '@/components/document-export/documentExportUiPort';
import type { DocumentExportWireUiOptions } from '@/components/document-export/documentExportWireUiPort';
import { createDocumentExportBrowserUiPort } from '@/composition/documentExport';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';

export interface DocumentExportSourceOptionsHost {
    /** Actual authenticated capabilities; the choices-only response supplies none. */
    catalog: DocumentExportWireUiOptions['catalog'];
    privateForSource: (choice: Readonly<DocumentExportSourceChoiceResponse>) => boolean;
    /** Original identity/options/locale preparation receives the exact bound choice. */
    prepareRequest: (selection: Readonly<DocumentExportSelection>, choice: Readonly<DocumentExportSourceChoiceResponse>) => DocumentExportRequest;
}

async function createFromCapture(
    capture: (signal: AbortSignal) => Promise<DocumentExportSourceChoicesResponse>,
    host: DocumentExportSourceOptionsHost, signal?: AbortSignal
): Promise<ReturnType<typeof createDocumentExportBrowserUiPort>>
{
    const lease = privateRequestRuntime.open('admin', signal);
    let port: ReturnType<typeof createDocumentExportBrowserUiPort> | undefined;
    try
    {
        lease.signal!.throwIfAborted();
        const response = await capture(lease.signal!);
        lease.assertCurrent();
        lease.signal!.throwIfAborted();
        const sources = mapDocumentExportSourceChoices(response, choice =>
        {
            lease.assertCurrent();
            lease.signal!.throwIfAborted();
            const isPrivate = host.privateForSource(choice);
            lease.assertCurrent();
            lease.signal!.throwIfAborted();
            return isPrivate;
        });
        lease.assertCurrent();
        lease.signal!.throwIfAborted();
        port = createDocumentExportBrowserUiPort({
            catalog: host.catalog, sources,
            prepareRequest: selection =>
            {
                const choice = response.choices.find(item => item.choiceId === selection.sourceId);
                if (!choice)
                {
                    throw new RangeError('document_export_selection_unavailable');
                }
                return host.prepareRequest(selection, choice);
            }
        });
        lease.assertCurrent();
        lease.signal!.throwIfAborted();
        return port;
    }
    catch (error)
    {
        port?.dispose?.();
        lease.assertCurrent();
        throw error;
    }
    finally
    {
        lease.release();
    }
}

/** Signal cancels acquisition; the returned port retains the original private UI lifetime. */
export function createDocumentExportBrowserUiPortFromSourceCapture(
    request: DocumentExportSourceCaptureRequest, host: DocumentExportSourceOptionsHost, signal?: AbortSignal
): Promise<ReturnType<typeof createDocumentExportBrowserUiPort>>
{
    return createFromCapture(privateSignal => captureDocumentExportSources(request, privateSignal), host, signal);
}

export function createDocumentExportBrowserUiPortFromRevisionChoices(
    request: DocumentExportRevisionChoicesRequest, host: DocumentExportSourceOptionsHost, signal?: AbortSignal
): Promise<ReturnType<typeof createDocumentExportBrowserUiPort>>
{
    return createFromCapture(privateSignal => captureDocumentExportRevisionChoices(request, privateSignal), host, signal);
}
