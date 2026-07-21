import { inject, provide, ref, type InjectionKey, type Ref } from 'vue';

const accountFrameDrawerVisibleKey: InjectionKey<Ref<boolean>> = Symbol('account-frame-drawer-visible');

export function provideAccountFrameDrawerState(): Ref<boolean>
{
    const visible = ref(false);
    provide(accountFrameDrawerVisibleKey, visible);
    return visible;
}

export function useAccountFrameDrawerState(): Ref<boolean>
{
    const visible = inject(accountFrameDrawerVisibleKey);
    if (!visible)
    {
        throw new Error('Account frame drawer state requires its provider');
    }

    return visible;
}
