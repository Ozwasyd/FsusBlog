import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';

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
    const active = ref(true);
    const available = computed(() => active.value && options.enabled.value && options.editor.value !== null);
    // Scoped shortcut admission only; input transactions remain with the native editor owner.
    let composing = false;
    const beginComposition = (): void =>
    {
        composing = true;
    };
    const endComposition = (): void =>
    {
        composing = false;
    };

    // The boolean confirms delegation, never a business result or an opened-surface receipt.
    const open = (): boolean =>
    {
        const editor = options.editor.value;
        if (!available.value || composing || editor === null)
        {
            return false;
        }
        editor.openCommandPalette();
        return true;
    };

    const handleShortcut = (event: KeyboardEvent): void =>
    {
        if (event.defaultPrevented || composing || event.isComposing || event.keyCode === 229 ||
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

    const stopWatching = watch([options.shortcutScope, options.editor], ([scope, editor], _previous, onCleanup) =>
    {
        composing = false;
        if (scope === null || editor === null)
        {
            return;
        }
        scope.addEventListener('keydown', handleShortcut, true);
        scope.addEventListener('compositionstart', beginComposition, true);
        scope.addEventListener('compositionend', endComposition, true);
        onCleanup(() =>
        {
            scope.removeEventListener('keydown', handleShortcut, true);
            scope.removeEventListener('compositionstart', beginComposition, true);
            scope.removeEventListener('compositionend', endComposition, true);
            composing = false;
        });
    }, { immediate: true, flush: 'sync' });
    onScopeDispose(() =>
    {
        active.value = false;
        stopWatching();
    });

    return { available, open };
}
