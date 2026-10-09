import { createDocumentExportWireUiPort } from '@/components/document-export/documentExportWireUiPort';
import type { DocumentExportWireUiOptions } from '@/components/document-export/documentExportWireUiPort';
import { deliverDocumentExportPrivate } from '@/services/documentExportPrivateDelivery';

/** Exact authorized catalog/source/admission projections remain required from the host. */
export function createDocumentExportBrowserUiPort(options: Omit<DocumentExportWireUiOptions, 'deliverPrivate'>): ReturnType<typeof createDocumentExportWireUiPort>
{
    return createDocumentExportWireUiPort({ ...options, deliverPrivate: deliverDocumentExportPrivate });
}
