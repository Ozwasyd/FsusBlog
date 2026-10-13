import type { AuthoringCanvasSession } from '@/composables/useAuthoringCanvas';
import type { AuthoringCanvasDocument } from '@/contracts/authoringCanvas';

/**
 * Reads the original authenticated storage at the displayed document coordinate.
 * Storage has no historical revision read: a changed head must be rejected.
 * This read neither attests an export/download nor recomputes a server digest.
 */
export async function readAuthoringCanvasPackageSource(session: AuthoringCanvasSession,
    expected: Readonly<Pick<AuthoringCanvasDocument, 'id' | 'revision' | 'contentDigest'>>): Promise<AuthoringCanvasDocument>
{
    const coordinate = { id: expected.id, revision: expected.revision, contentDigest: expected.contentDigest };
    const owner = { userId: session.ownerContext.userId, siteId: session.ownerContext.siteId };
    if (!coordinate.id || !Number.isSafeInteger(coordinate.revision) || coordinate.revision < 1
        || !coordinate.contentDigest || !owner.userId || !owner.siteId)
    {
        throw new Error('canvas_package_source_unavailable');
    }
    if (session.pendingWrite?.())
    {
        throw new Error('canvas_operation_in_progress');
    }
    const document = await session.storage.getCanvas(coordinate.id, owner);
    if (session.pendingWrite?.())
    {
        throw new Error('canvas_operation_in_progress');
    }
    if (document?.id !== coordinate.id || document.revision !== coordinate.revision
        || document.contentDigest !== coordinate.contentDigest
        || document.userId !== owner.userId || document.siteId !== owner.siteId
        || session.ownerContext.userId !== owner.userId || session.ownerContext.siteId !== owner.siteId)
    {
        throw new Error('canvas_package_source_changed');
    }
    return document;
}
