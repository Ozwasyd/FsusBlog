import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deliverDocumentExportPrivate } from '@/services/documentExportPrivateDelivery';

describe('original private export browser delivery', () =>
{
    const delivery = { bytes: new Uint8Array([3, 5, 7]).buffer, filename: 'verified.html', mediaType: 'text/html' };
    let controller: AbortController;
    let link: HTMLAnchorElement;

    beforeEach(() =>
    {
        controller = new AbortController();
        link = document.createElement('a');
        vi.spyOn(document, 'createElement').mockReturnValue(link);
        vi.spyOn(link, 'click').mockImplementation(() => undefined);
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-export-test');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
        document.body.replaceChildren();
    });

    it('dispatches only the actual bytes and filename and releases the private URL', async () =>
    {
        await deliverDocumentExportPrivate(delivery, controller.signal);
        const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob;
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(delivery.bytes));
        expect(blob.type).toBe(delivery.mediaType);
        expect(link.download).toBe(delivery.filename);
        expect(link.click).toHaveBeenCalledOnce();
        expect(link.isConnected).toBe(false);
        expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:private-export-test');
    });

    it('refuses prior cancellation without allocating a URL or clicking', async () =>
    {
        controller.abort();
        await expect(deliverDocumentExportPrivate(delivery, controller.signal)).rejects.toThrow();
        expect(URL.createObjectURL).not.toHaveBeenCalled();
        expect(link.click).not.toHaveBeenCalled();
    });

    it('releases the URL without creating a link when cancellation follows allocation', async () =>
    {
        vi.mocked(URL.createObjectURL).mockImplementation(() =>
        {
            controller.abort();
            return 'blob:private-export-test';
        });
        await expect(deliverDocumentExportPrivate(delivery, controller.signal)).rejects.toThrow();
        expect(document.createElement).not.toHaveBeenCalled();
        expect(link.click).not.toHaveBeenCalled();
        expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    });

    it('refuses cancellation at the attached-link save boundary and removes the link', async () =>
    {
        const append = document.body.append.bind(document.body);
        vi.spyOn(document.body, 'append').mockImplementation((...nodes) =>
        {
            append(...nodes);
            controller.abort();
        });
        await expect(deliverDocumentExportPrivate(delivery, controller.signal)).rejects.toThrow();
        expect(link.click).not.toHaveBeenCalled();
        expect(link.isConnected).toBe(false);
        expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    });

    it('releases the URL when the original link cannot be created', async () =>
    {
        vi.mocked(document.createElement).mockImplementation(() => { throw new Error('create refused'); });
        await expect(deliverDocumentExportPrivate(delivery, controller.signal)).rejects.toThrow('create refused');
        expect(link.click).not.toHaveBeenCalled();
        expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    });

    it('cleans up when appending the link fails before dispatch', async () =>
    {
        vi.spyOn(document.body, 'append').mockImplementation(() => { throw new Error('append refused'); });
        await expect(deliverDocumentExportPrivate(delivery, controller.signal)).rejects.toThrow('append refused');
        expect(link.click).not.toHaveBeenCalled();
        expect(link.isConnected).toBe(false);
        expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    });

    it('preserves click refusal and cleans up the attached link and URL', async () =>
    {
        vi.mocked(link.click).mockImplementation(() => { throw new Error('click refused'); });
        await expect(deliverDocumentExportPrivate(delivery, controller.signal)).rejects.toThrow('click refused');
        expect(link.isConnected).toBe(false);
        expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    });

    it('repeated calls allocate and release separate URLs without retained links', async () =>
    {
        vi.mocked(URL.createObjectURL).mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
        await deliverDocumentExportPrivate(delivery, controller.signal);
        await deliverDocumentExportPrivate(delivery, controller.signal);
        expect(link.click).toHaveBeenCalledTimes(2);
        expect(document.body.querySelectorAll('a')).toHaveLength(0);
        expect(vi.mocked(URL.revokeObjectURL).mock.calls).toEqual([['blob:first'], ['blob:second']]);
    });

    it('does not dispatch when browser URL allocation fails', async () =>
    {
        vi.mocked(URL.createObjectURL).mockImplementation(() => { throw new Error('URL refused'); });
        await expect(deliverDocumentExportPrivate(delivery, controller.signal)).rejects.toThrow('URL refused');
        expect(link.click).not.toHaveBeenCalled();
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    });

    it('still releases the private URL when link removal refuses cleanup', async () =>
    {
        vi.spyOn(link, 'remove').mockImplementation(() => { throw new Error('remove refused'); });
        await expect(deliverDocumentExportPrivate(delivery, controller.signal)).rejects.toThrow('remove refused');
        expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    });
});
