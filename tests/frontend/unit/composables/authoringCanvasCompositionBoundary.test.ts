import { describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useAuthoringCanvas } from '@/composables/useAuthoringCanvas';
import { authoringCanvasStorage, createCanvasTestSession } from '../../fixtures/authoringCanvasTransportFixture';

describe('Authoring Canvas current composition boundaries', () => {
    it('does not publish an old creation response into a disposed component scope', async () => {
        authoringCanvasStorage.clear();
        const base = createCanvasTestSession();
        const document = await base.storage.createCanvas({ ...base.ownerContext, title: 'Remote fixture' });
        let respond!: (value: typeof document) => void;
        const session = { ...base, storage: { ...base.storage, createCanvas: vi.fn(() => new Promise<typeof document>(resolve => { respond = resolve; })) } };
        const scope = effectScope();
        const canvas = scope.run(() => useAuthoringCanvas(session))!;
        const creation = canvas.createCanvas('Requested canvas');
        scope.stop();
        respond(document);
        expect(await creation).toBeNull();
        expect(canvas.document.value).toBeNull();
    });
    it('rejects caller identity substitution through the explicit storage projection adapter', async () => {
        authoringCanvasStorage.clear();
        const session = createCanvasTestSession();
        const document = await session.storage.createCanvas({ ...session.ownerContext, title: 'Private fixture' });
        const canvas = useAuthoringCanvas(session);
        await canvas.loadCanvas(document.id);
        expect(canvas.document.value?.userId).toBe(session.ownerContext.userId);
        expect(await session.storage.getCanvas(document.id, { userId: 'other-user', siteId: session.ownerContext.siteId })).toBeNull();
    });
});
