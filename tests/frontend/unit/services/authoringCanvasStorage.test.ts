import { authoringCanvasStorage } from '../../fixtures/authoringCanvasTransportFixture';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    AuthoringCanvasAccessDeniedError,
    AuthoringCanvasBudgetExceededError,
    AuthoringCanvasCasMismatchError
} from '@/services/authoringCanvasStorage';

describe('Authoring Canvas Storage Authority & CAS (#2482, #2484)', () => {
    beforeEach(() => {
        authoringCanvasStorage.clear();
    });

    it('creates and fetches a new canvas document with revision 1', async () => {
        const doc = await authoringCanvasStorage.createCanvas({
            userId: 'user-alice',
            siteId: 'site-default',
            title: 'Systems Architecture Canvas'
        });

        expect(doc.id).toMatch(/^canvas-/);
        expect(doc.revision).toBe(1);
        expect(doc.userId).toBe('user-alice');
        expect(doc.title).toBe('Systems Architecture Canvas');
        expect(doc.contentDigest).toBeDefined();

        const fetched = await authoringCanvasStorage.getCanvas(doc.id, {
            userId: 'user-alice',
            siteId: 'site-default'
        });
        expect(fetched).toEqual(doc);
    });

    it('fails closed with CAS mismatch when updating with an outdated revision', async () => {
        const doc = await authoringCanvasStorage.createCanvas({
            userId: 'user-alice',
            siteId: 'site-default',
            title: 'Initial'
        });

        // Tab 1 updates doc from revision 1 -> 2
        const updated1 = await authoringCanvasStorage.updateCanvas(
            doc.id,
            1,
            { title: 'Updated by Tab 1' },
            { userId: 'user-alice', siteId: 'site-default' },
            crypto.randomUUID()
        );
        expect(updated1.revision).toBe(2);

        // Tab 2 tries to update with stale revision 1 -> should fail with CAS mismatch!
        await expect(
            authoringCanvasStorage.updateCanvas(
                doc.id,
                1,
                { title: 'Conflicting update from Tab 2' },
                { userId: 'user-alice', siteId: 'site-default' },
            crypto.randomUUID()
            )
        ).rejects.toThrow(AuthoringCanvasCasMismatchError);
    });

    it('isolates user permissions and fails closed for unauthorized requests without leaking existence', async () => {
        const doc = await authoringCanvasStorage.createCanvas({
            userId: 'user-alice',
            siteId: 'site-default',
            title: 'Secret Alice Research'
        });

        // User Bob tries to fetch Alice's canvas -> returns null (not leaking existence)
        const bobView = await authoringCanvasStorage.getCanvas(doc.id, {
            userId: 'user-bob',
            siteId: 'site-default'
        });
        expect(bobView).toBeNull();

        // User Bob tries to update Alice's canvas -> throws Access Denied
        await expect(
            authoringCanvasStorage.updateCanvas(
                doc.id,
                1,
                { title: 'Malicious Overwrite' },
                { userId: 'user-bob', siteId: 'site-default' },
                crypto.randomUUID()
            )
        ).rejects.toThrow(AuthoringCanvasAccessDeniedError);

        // Bob's canvas list does not contain Alice's canvas
        const bobList = await authoringCanvasStorage.listCanvases({
            userId: 'user-bob',
            siteId: 'site-default'
        });
        expect(bobList.length).toBe(0);
    });

    it('deletes canvas cleanly and verifies deletion isolation', async () => {
        const doc = await authoringCanvasStorage.createCanvas({
            userId: 'user-alice',
            siteId: 'site-default',
            title: 'To Be Deleted'
        });

        const deleteResult = await authoringCanvasStorage.deleteCanvas(
            doc.id,
            1,
            { userId: 'user-alice', siteId: 'site-default' },
            crypto.randomUUID()
        );
        expect(deleteResult.success).toBe(true);

        const afterDelete = await authoringCanvasStorage.getCanvas(doc.id, { userId: 'user-alice', siteId: 'site-default' });
        expect(afterDelete).toBeNull();
    });

    it('enforces maximum canvas limit per user', async () => {
        for (let i = 0; i < 100; i++) {
            await authoringCanvasStorage.createCanvas({
                userId: 'user-heavy',
                siteId: 'site-default',
                title: `Canvas #${i}`
            });
        }

        // 101st canvas should throw budget exceeded error
        await expect(
            authoringCanvasStorage.createCanvas({
                userId: 'user-heavy',
                siteId: 'site-default',
                title: 'Canvas #101'
            })
        ).rejects.toThrow(AuthoringCanvasBudgetExceededError);
    });

    it('records audit receipts with content digests without logging note plaintext', async () => {
        const doc = await authoringCanvasStorage.createCanvas({
            userId: 'user-alice',
            siteId: 'site-default',
            title: 'Audited Canvas'
        });

        const receipts = authoringCanvasStorage.getReceipts(doc.id);
        expect(receipts.length).toBe(1);
        expect(receipts[0].action).toBe('create');
        expect(receipts[0].canvasId).toBe(doc.id);
        expect(receipts[0].contentDigest).toBe(doc.contentDigest);
    });
});
