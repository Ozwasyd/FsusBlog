import '@/assets/navigation-progress.css';

const PROGRESS_ROOT_ID = 'nprogress';
const PROGRESS_COMPLETE_DELAY_MS = 180;

let removalTimer: ReturnType<typeof setTimeout> | undefined;

export function showNavigationProgress(): void
{
    if (typeof document === 'undefined')
    {
        return;
    }

    if (removalTimer !== undefined)
    {
        globalThis.clearTimeout(removalTimer);
        removalTimer = undefined;
    }

    const existing = document.getElementById(PROGRESS_ROOT_ID);
    if (existing)
    {
        existing.classList.remove('is-completing');
        existing.classList.add('is-active');
        return;
    }

    const root = document.createElement('div');
    const bar = document.createElement('div');
    const peg = document.createElement('div');
    root.id = PROGRESS_ROOT_ID;
    root.className = 'is-active';
    root.setAttribute('role', 'progressbar');
    root.setAttribute('aria-label', '页面加载进度');
    bar.className = 'bar';
    peg.className = 'peg';
    bar.appendChild(peg);
    root.appendChild(bar);
    document.body.appendChild(root);
}

export function hideNavigationProgress(): void
{
    if (typeof document === 'undefined')
    {
        return;
    }

    const root = document.getElementById(PROGRESS_ROOT_ID);
    if (!root)
    {
        return;
    }

    root.classList.remove('is-active');
    root.classList.add('is-completing');
    if (removalTimer !== undefined)
    {
        globalThis.clearTimeout(removalTimer);
    }
    removalTimer = globalThis.setTimeout(() =>
    {
        root.remove();
        removalTimer = undefined;
    }, PROGRESS_COMPLETE_DELAY_MS);
}
