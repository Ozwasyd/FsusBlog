type PublicReadHydrationWindow = typeof window & {
    __FSUSBLOG_DISABLE_PUBLIC_READ_HYDRATION__?: boolean;
};

export function isPublicReadHydrationSuppressed(): boolean
{
    if (typeof window === 'undefined' || typeof document === 'undefined')
    {
        return false;
    }

    const runtimeWindow = window as PublicReadHydrationWindow;
    return runtimeWindow.__FSUSBLOG_DISABLE_PUBLIC_READ_HYDRATION__ === true
    || document.documentElement.dataset.fsusDisablePublicReadHydration === 'true';
}
