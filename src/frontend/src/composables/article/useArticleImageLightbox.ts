import { useScrollReveal } from '@ozwasyd/element-plus/motion';
import { nextTick, onUnmounted, ref, type MaybeRefOrGetter, toValue, watch } from 'vue';

import { fsusBlogScrollRevealOptions } from '@/fsusui/blogMotion';
import { activeLocale, translate } from '@/locales';

export type ArticleLightboxImage = Readonly<{
    src: string;
    alt: string;
}>;

type ListenerRecord = Readonly<{
    image: HTMLImageElement;
    click: (event: MouseEvent) => void;
    keydown: (event: KeyboardEvent) => void;
}>;

export function useArticleImageLightbox(contentRoot: MaybeRefOrGetter<HTMLElement | null>)
{
    const images = ref<ArticleLightboxImage[]>([]);
    const activeIndex = ref(0);
    const open = ref(false);
    const listeners: ListenerRecord[] = [];
    const revealControls = useScrollReveal({ ...fsusBlogScrollRevealOptions });

    const cleanup = (): void =>
    {
        revealControls.kill();
        for (const record of listeners.splice(0))
        {
            record.image.removeEventListener('click', record.click);
            record.image.removeEventListener('keydown', record.keydown);
            record.image.classList.remove('fsus-article-preview-image');
            record.image.removeAttribute('data-fsus-motion-surface');
            record.image.removeAttribute('role');
            record.image.removeAttribute('tabindex');
            record.image.removeAttribute('aria-label');
        }
    };

    const show = (index: number, trigger?: HTMLImageElement | null): void =>
    {
        activeIndex.value = index;
        // Establish the article trigger before ImageViewer takes modal focus.
        (trigger ?? listeners[index]?.image)?.focus({ preventScroll: true });
        open.value = true;
    };

    const scan = async (): Promise<void> =>
    {
        await nextTick();
        cleanup();
        const root = toValue(contentRoot);
        if (!root)
        {
            images.value = [];
            open.value = false;
            return;
        }

        const candidates = Array.from(root.querySelectorAll<HTMLImageElement>('img'))
            .filter((image) => image.currentSrc || image.src)
            .filter((image) =>
            {
                const link = image.closest('a');
                return !(link instanceof HTMLAnchorElement && link.href);
            });

        images.value = candidates.map((image) => ({
            src: image.currentSrc || image.src,
            alt: image.alt?.trim() ?? ''
        }));

        candidates.forEach((image, index) =>
        {
            const click = (event: MouseEvent): void =>
            {
                event.preventDefault();
                show(index, image);
            };
            const keydown = (event: KeyboardEvent): void =>
            {
                if (event.key !== 'Enter' && event.key !== ' ')
                {
                    return;
                }
                event.preventDefault();
                show(index, image);
            };

            image.classList.add('fsus-article-preview-image');
            image.setAttribute('data-fsus-motion-surface', 'article-body-image');
            image.setAttribute('role', 'button');
            image.setAttribute('tabindex', '0');
            image.setAttribute('aria-label', image.alt?.trim()
                ? translate('article.actions.viewImageNamed', { title: image.alt.trim() })
                : translate('article.actions.viewImage'));
            image.addEventListener('click', click);
            image.addEventListener('keydown', keydown);
            revealControls.reveal(image, fsusBlogScrollRevealOptions);
            listeners.push({ image, click, keydown });
        });
    };

    const close = (): void =>
    {
        open.value = false;
    };

    const next = (): void =>
    {
        if (images.value.length === 0)
        {
            return;
        }
        activeIndex.value = (activeIndex.value + 1) % images.value.length;
    };

    const previous = (): void =>
    {
        if (images.value.length === 0)
        {
            return;
        }
        activeIndex.value = (activeIndex.value + images.value.length - 1) % images.value.length;
    };

    watch(() => [toValue(contentRoot), activeLocale.value] as const, () =>
    {
        void scan();
    }, { flush: 'post' });

    onUnmounted(cleanup);

    return {
        images,
        activeIndex,
        open,
        refresh: scan,
        close,
        next,
        previous
    };
}
