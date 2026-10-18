// @vitest-environment happy-dom

import { effectScope, nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useArticleWriteInspector } from '@/composables/useArticleWriteInspector';

const scopes: ReturnType<typeof effectScope>[] = [];
const elements: HTMLElement[] = [];
const frames = new Map<number, FrameRequestCallback>();

const createInspector = () =>
{
    const scope = effectScope();
    scopes.push(scope);
    const inspector = scope.run(() => useArticleWriteInspector());
    if (!inspector)
    {
        throw new Error('inspector scope did not initialize');
    }
    return { scope, inspector };
};

const createButton = (): HTMLButtonElement =>
{
    const button = document.createElement('button');
    document.body.append(button);
    elements.push(button);
    return button;
};

const controlFrames = (): void =>
{
    let sequence = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
    {
        const id = ++sequence;
        frames.set(id, callback);
        return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) =>
    {
        frames.delete(id);
    });
};

const latestFrame = (): { id: number; callback: FrameRequestCallback } =>
{
    const entry = [...frames].at(-1);
    if (!entry)
    {
        throw new Error('focus restoration did not schedule its frame');
    }
    return { id: entry[0], callback: entry[1] };
};

afterEach(() =>
{
    for (const scope of scopes.splice(0))
    {
        scope.stop();
    }
    for (const callback of frames.values())
    {
        callback(0);
    }
    frames.clear();
    for (const element of elements.splice(0))
    {
        element.remove();
    }
    vi.restoreAllMocks();
});

describe('article inspector focus lifecycle', () =>
{
    it('uses the current external trigger after the original opener is unmounted', async () =>
    {
        const { inspector } = createInspector();
        const opener = createButton();
        const replacement = createButton();
        await inspector.open('check', opener);
        opener.remove();
        inspector.registerTrigger('check', replacement);
        inspector.close();
        await inspector.restoreFocus();
        expect(document.activeElement).toBe(replacement);
    });

    it.each(['hidden', 'inert', 'aria-hidden', 'display', 'visibility'])(
        'ignores an opener concealed by an ancestor through %s',
        async (concealment) =>
        {
            const { inspector } = createInspector();
            const opener = createButton();
            const replacement = createButton();
            const ancestor = document.createElement('div');
            document.body.append(ancestor);
            elements.push(ancestor);
            ancestor.append(opener);
            await inspector.open('check', opener);
            if (concealment === 'display')
            {
                ancestor.style.display = 'none';
            }
            else if (concealment === 'visibility')
            {
                ancestor.style.visibility = 'hidden';
            }
            else
            {
                ancestor.setAttribute(concealment, concealment === 'aria-hidden' ? 'true' : '');
            }
            const focus = vi.spyOn(opener, 'focus');
            inspector.registerTrigger('check', replacement);
            inspector.close();
            await inspector.restoreFocus();
            expect(focus).not.toHaveBeenCalled();
            expect(document.activeElement).toBe(replacement);
        }
    );

    it('does not restore to an opener disabled while the inspector is open', async () =>
    {
        const { inspector } = createInspector();
        const opener = createButton();
        const replacement = createButton();
        await inspector.open('check', opener);
        opener.disabled = true;
        inspector.registerTrigger('check', replacement);
        inspector.close();
        await inspector.restoreFocus();
        expect(document.activeElement).toBe(replacement);
    });

    it('does not steal focus from a reopened inspector', async () =>
    {
        const { inspector } = createInspector();
        const opener = createButton();
        const nextOpener = createButton();
        const currentContent = createButton();
        await inspector.open('check', opener);
        inspector.close();
        const pending = inspector.restoreFocus();
        await inspector.open('resources', nextOpener);
        currentContent.focus();
        await pending;
        expect(document.activeElement).toBe(currentContent);
        expect(inspector.activeInspector.value).toBe('resources');
    });

    it('cancels a pending frame when its Vue owner is disposed', async () =>
    {
        controlFrames();
        const { scope, inspector } = createInspector();
        const opener = createButton();
        const otherOwner = createButton();
        const focus = vi.spyOn(opener, 'focus');
        await inspector.open('check', opener);
        inspector.close();
        const pending = inspector.restoreFocus();
        await nextTick();
        const stale = latestFrame();
        otherOwner.focus();
        scope.stop();
        expect(window.cancelAnimationFrame).toHaveBeenCalledWith(stale.id);
        await pending;
        stale.callback(0);
        expect(focus).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(otherOwner);
    });

    it('does not let an older close consume the next close target or frame', async () =>
    {
        controlFrames();
        const { inspector } = createInspector();
        const firstOpener = createButton();
        const nextOpener = createButton();
        const currentContent = createButton();
        await inspector.open('check', firstOpener);
        inspector.close();
        const firstRestore = inspector.restoreFocus();
        await nextTick();
        const stale = latestFrame();
        await inspector.open('resources', nextOpener);
        inspector.close();
        const currentRestore = inspector.restoreFocus();
        await nextTick();
        const current = latestFrame();
        currentContent.focus();
        stale.callback(0);
        await firstRestore;
        expect(document.activeElement).toBe(currentContent);
        current.callback(0);
        await currentRestore;
        expect(document.activeElement).toBe(nextOpener);
    });
});
