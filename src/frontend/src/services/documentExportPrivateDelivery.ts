import type { DocumentExportPrivateDeliver } from '@/api/documentExport';

/**
 * Original browser Blob/anchor delivery, with cancellation at the click boundary.
 * A resolved call means dispatch to the browser, not a persisted-file receipt.
 * The authenticated consumer owns response verification and generation checks.
 * Object URLs stay inside this call and are revoked on every exit.
 */
export const deliverDocumentExportPrivate: DocumentExportPrivateDeliver = (delivery, signal) =>
{
    return Promise.resolve().then(() =>
    {
        signal.throwIfAborted();
        const blob = new Blob([delivery.bytes], { type: delivery.mediaType });
        const url = URL.createObjectURL(blob);
        let link: HTMLAnchorElement | undefined;
        try
        {
            signal.throwIfAborted();
            link = document.createElement('a');
            link.href = url;
            link.download = delivery.filename;
            document.body.append(link);
            signal.throwIfAborted();
            link.click();
        }
        finally
        {
            try
            {
                link?.remove();
            }
            finally
            {
                URL.revokeObjectURL(url);
            }
        }
    });
};
