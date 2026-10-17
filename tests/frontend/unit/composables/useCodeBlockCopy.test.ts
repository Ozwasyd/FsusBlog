// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCodeBlockCopy } from '@/composables/article/useCodeBlockCopy'
import { toast } from '@/fsusui/feedback'
import { activateLocaleRuntime, translate } from '@/locales'

const { revealMock, killMock } = vi.hoisted(() => ({
  revealMock: vi.fn(),
  killMock: vi.fn()
}))

vi.mock('@ozwasyd/element-plus/motion', () => ({
  useScrollReveal: () => ({
    reveal: revealMock,
    kill: killMock
  })
}))

vi.mock('@/fsusui/feedback', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

describe('useCodeBlockCopy', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('does not insert code copy controls when Rights V3 disables code copying', async () => {
    const wrapper = mount(defineComponent({
      setup() {
        const root = ref<HTMLElement | null>(null)
        const allowCodeCopy = ref(false)
        const controls = useCodeBlockCopy(() => root.value, () => allowCodeCopy.value)
        return { root, allowCodeCopy, refreshCodeCopy: controls.refresh }
      },
      template: '<div><div ref="root"><pre><code>const value = 1</code></pre></div></div>'
    }))

    await nextTick()
    await (wrapper.vm as unknown as { refreshCodeCopy: () => Promise<void> }).refreshCodeCopy()

    expect(wrapper.element.querySelector('.fsus-code-copy-button')).toBeNull()
    expect(wrapper.element.querySelector('pre')?.hasAttribute('data-fsus-code-copy')).toBe(false)

    ;(wrapper.vm as unknown as { allowCodeCopy: boolean }).allowCodeCopy = true
    await nextTick()
    await (wrapper.vm as unknown as { refreshCodeCopy: () => Promise<void> }).refreshCodeCopy()

    expect(wrapper.element.querySelector('.fsus-code-copy-button')).not.toBeNull()
    expect(wrapper.element.querySelector('pre')?.getAttribute('data-fsus-code-copy')).toBe('true')

    ;(wrapper.vm as unknown as { allowCodeCopy: boolean }).allowCodeCopy = false
    await nextTick()
    await (wrapper.vm as unknown as { refreshCodeCopy: () => Promise<void> }).refreshCodeCopy()

    expect(wrapper.element.querySelector('.fsus-code-copy-button')).toBeNull()
    expect(wrapper.element.querySelector('pre')?.hasAttribute('data-fsus-code-copy')).toBe(false)

    wrapper.unmount()
  })

  it('keeps code copy usable when motion reveal cannot initialize', async () => {
    revealMock.mockImplementationOnce(() => {
      throw new ReferenceError('ScrollTrigger environment is unavailable')
    })
    const wrapper = mount(defineComponent({
      setup() {
        const root = ref<HTMLElement | null>(null)
        const controls = useCodeBlockCopy(() => root.value, true)
        return { root, refreshCodeCopy: controls.refresh }
      },
      template: '<div><div ref="root"><pre><code>const value = 1</code></pre></div></div>'
    }))

    await nextTick()
    await (wrapper.vm as unknown as { refreshCodeCopy: () => Promise<void> }).refreshCodeCopy()

    expect(wrapper.element.querySelector('.fsus-code-copy-button')).not.toBeNull()
    expect(wrapper.element.querySelector('pre')?.getAttribute('data-fsus-code-copy')).toBe('true')

    wrapper.unmount()
  })
})

function mountCodeCopyHarness(onButtonUnmount = vi.fn())
{
    return mount(defineComponent({
        setup()
        {
            const root = ref<HTMLElement | null>(null);
            const controls = useCodeBlockCopy(() => root.value);
            return { root, ...controls };
        },
        template: '<div ref="root"><pre><code>const value = 1</code></pre></div>'
    }), {
        global: {
            mixins: [{
                unmounted()
                {
                    if (this.$options.name === 'ElButton')
                    {
                        onButtonUnmount();
                    }
                }
            }]
        }
    });
}

describe('useCodeBlockCopy lifecycle with the public FsusUI Button', () =>
{
    afterEach(() =>
    {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('unmounts detached controls after repeated same-root content replacement and deletion', async () =>
    {
        const unmounted = vi.fn();
        const wrapper = mountCodeCopyHarness(unmounted);
        try
        {
            await wrapper.vm.refresh();
            const firstButton = wrapper.element.querySelector('.fsus-code-copy-button');
            await wrapper.vm.refresh();
            expect(wrapper.element.querySelectorAll('.fsus-code-copy-button')).toHaveLength(1);
            expect(wrapper.element.querySelector('.fsus-code-copy-button')).toBe(firstButton);

            for (let revision = 0; revision < 3; revision++)
            {
                wrapper.element.innerHTML = `<pre><code>revision ${revision}</code></pre>`;
                await wrapper.vm.refresh();
                expect(unmounted).toHaveBeenCalledTimes(revision + 1);
                expect(wrapper.element.querySelectorAll('.fsus-code-copy-button')).toHaveLength(1);
            }
            wrapper.element.innerHTML = '<p>No code remains</p>';
            await wrapper.vm.refresh();
            expect(unmounted).toHaveBeenCalledTimes(4);
            expect(wrapper.element.querySelector('.fsus-code-copy-button')).toBeNull();
        }
        finally
        {
            wrapper.unmount();
        }
        expect(unmounted).toHaveBeenCalledTimes(4);
    });

    it('releases a replaced code block even when its host remains inside the same root', async () =>
    {
        const unmounted = vi.fn();
        const wrapper = mountCodeCopyHarness(unmounted);
        try
        {
            await wrapper.vm.refresh();
            const pre = wrapper.element.querySelector('pre')!;
            pre.innerHTML = '<code>changed source</code>';
            await wrapper.vm.refresh();
            expect(unmounted).toHaveBeenCalledTimes(1);
            expect(pre.querySelectorAll('.fsus-code-copy-button')).toHaveLength(1);
        }
        finally
        {
            wrapper.unmount();
        }
        await nextTick();
        expect(unmounted).toHaveBeenCalledTimes(2);
    });

    it('clears the copied-state timer when its code block is replaced', async () =>
    {
        vi.useFakeTimers();
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        const wrapper = mountCodeCopyHarness();
        try
        {
            await wrapper.vm.refresh();
            const button = wrapper.element.querySelector<HTMLButtonElement>('button')!;
            expect(button.getAttribute('aria-live')).toBe('polite');
            button.click();
            await nextTick();
            await nextTick();
            expect(writeText).toHaveBeenCalledExactlyOnceWith('const value = 1');
            expect(vi.getTimerCount()).toBe(1);
            wrapper.element.innerHTML = '<p>Removed</p>';
            await wrapper.vm.refresh();
            expect(vi.getTimerCount()).toBe(0);
        }
        finally
        {
            wrapper.unmount();
        }
    });

    it('does not create a reset timer when pending clipboard completion follows replacement', async () =>
    {
        vi.useFakeTimers();
        let finishCopy!: () => void;
        const writeText = vi.fn(() => new Promise<void>((resolve) => { finishCopy = resolve; }));
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        const unmounted = vi.fn();
        const wrapper = mountCodeCopyHarness(unmounted);
        try
        {
            await wrapper.vm.refresh();
            const oldContainer = wrapper.element.querySelector<HTMLButtonElement>('button')!.parentElement!;
            wrapper.element.querySelector<HTMLButtonElement>('button')!.click();
            wrapper.element.innerHTML = '<pre><code>replacement</code></pre>';
            await wrapper.vm.refresh();
            finishCopy();
            await nextTick();
            expect(unmounted).toHaveBeenCalledTimes(1);
            expect(oldContainer.children).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(0);
            expect(wrapper.element.querySelector('button')?.getAttribute('aria-label')).toBe(translate('article.actions.copyCode'));
        }
        finally
        {
            wrapper.unmount();
        }
    });

    it('does not mount a queued refresh after unmount', async () =>
    {
        const wrapper = mountCodeCopyHarness();
        const root = wrapper.element;
        const pending = wrapper.vm.refresh();
        wrapper.unmount();
        await pending;
        expect(root.querySelector('.fsus-code-copy-button')).toBeNull();
    });

    it('copies the original text and resets localized feedback after the original 1400ms', async () =>
    {
        vi.useFakeTimers();
        const schedule = vi.spyOn(globalThis, 'setTimeout');
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        const wrapper = mountCodeCopyHarness();
        try
        {
            await wrapper.vm.refresh();
            const button = wrapper.element.querySelector<HTMLButtonElement>('button')!;
            button.click();
            await nextTick();
            await nextTick();
            expect(writeText).toHaveBeenCalledExactlyOnceWith('const value = 1');
            expect(button.getAttribute('type')).toBe('button');
            expect(button.getAttribute('aria-label')).toBe(translate('article.actions.codeCopied'));
            expect(toast.success).toHaveBeenCalledWith(translate('article.actions.codeCopied'), 1200);
            await vi.advanceTimersByTimeAsync(1399);
            expect(button.getAttribute('aria-label')).toBe(translate('article.actions.codeCopied'));
            await vi.advanceTimersByTimeAsync(1);
            expect(button.getAttribute('aria-label')).toBe(translate('article.actions.copyCode'));
            expect(schedule.mock.calls.filter((call) => call[1] === 1400)).toHaveLength(1);
        }
        finally
        {
            wrapper.unmount();
        }
    });

    it('reports clipboard rejection without allocating a reset timer', async () =>
    {
        vi.useFakeTimers();
        vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
        const wrapper = mountCodeCopyHarness();
        try
        {
            await wrapper.vm.refresh();
            wrapper.element.querySelector<HTMLButtonElement>('button')!.click();
            await nextTick();
            await nextTick();
            expect(toast.error).toHaveBeenCalledWith(translate('article.actions.copyFailed'), 2200);
            expect(vi.getTimerCount()).toBe(0);
            expect(wrapper.element.querySelector('button')?.getAttribute('aria-label'))
                .toBe(translate('article.actions.copyCode'));
        }
        finally
        {
            wrapper.unmount();
        }
    });

    it('refreshes the public Button label when the real locale changes', async () =>
    {
        const unmounted = vi.fn();
        const wrapper = mountCodeCopyHarness(unmounted);
        try
        {
            await wrapper.vm.refresh();
            await activateLocaleRuntime('en-US', ['article']);
            await wrapper.vm.refresh();
            expect(unmounted).toHaveBeenCalledTimes(1);
            expect(wrapper.element.querySelector('button')?.getAttribute('aria-label'))
                .toBe(translate('article.actions.copyCode'));
            expect(wrapper.element.querySelector('button')?.textContent).toContain('Copy');
            expect(wrapper.element.querySelectorAll('.fsus-code-copy-button')).toHaveLength(1);
        }
        finally
        {
            wrapper.unmount();
        }
    });

});
