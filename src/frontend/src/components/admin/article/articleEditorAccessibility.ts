const VALIDATION_ERROR_FOCUS_SELECTOR =
    '.write-validation-form [aria-invalid="true"]:not([disabled]):not([tabindex="-1"])';

function findFirstFocusable(root: ParentNode): HTMLElement | null
{
    const candidate = root.querySelector<HTMLElement>(VALIDATION_ERROR_FOCUS_SELECTOR);
    if (candidate && !candidate.hidden && !candidate.closest('[aria-hidden="true"]'))
    {
        return candidate;
    }
    return null;
}

export function focusFirstArticleValidationError(root: ParentNode = document): boolean
{
    const target = findFirstFocusable(root);
    if (!target)
    {
        return false;
    }

    target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior: 'auto', block: 'center' });
    return true;
}
