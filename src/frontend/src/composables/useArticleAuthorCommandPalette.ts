import { computed, onScopeDispose, watch, type Ref } from 'vue';

// Exact public method of MarkdownTextEditor; no command or editor state is projected here.
type PaletteOwner = Readonly<{ openCommandPalette: () => void; }>;

interface ArticleAuthorCommandPaletteOptions {
    readonly editor: Readonly<Ref<PaletteOwner | null>>;
    readonly shortcutScope: Readonly<Ref<HTMLElement | null>>;
    readonly enabled: Readonly<Ref<boolean>>;
}

/** Present the existing editor palette; command availability and execution stay with its owner. */
export function useArticleAuthorCommandPalette(options: ArticleAuthorCommandPaletteOptions)
{
    const available = computed(() => options.enabled.value && options.editor.value !== null);

    // The boolean confirms delegation, never a business result or an opened-surface receipt.
    const open = (): boolean =>
    {
        const editor = options.editor.value;
        if (!options.enabled.value || editor === null)
        {
            return false;
        }
        editor.openCommandPalette();
        return true;
    };

    const handleShortcut = (event: KeyboardEvent): void =>
    {
        if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
            event.altKey || event.shiftKey || event.ctrlKey === event.metaKey ||
            event.key.toLowerCase() !== 'p' || !available.value)
        {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat)
        {
            open();
        }
    };

    const stopWatching = watch(options.shortcutScope, (scope, _previous, onCleanup) =>
    {
        if (scope === null)
        {
            return;
        }
        scope.addEventListener('keydown', handleShortcut, true);
        onCleanup(() => scope.removeEventListener('keydown', handleShortcut, true));
    }, { immediate: true, flush: 'sync' });
    onScopeDispose(stopWatching);

    return { available, open };
}
