import { onMounted, onUnmounted } from 'vue';

export type WindowEventSpec = Readonly<{
    name: string;
    handler: EventListenerOrEventListenerObject;
    options?: AddEventListenerOptions | boolean;
}>;

export function useWindowEvents(events: readonly WindowEventSpec[]): void
{
    onMounted(() =>
    {
        for (const { name, handler, options } of events)
        {
            window.addEventListener(name, handler, options);
        }
    });

    onUnmounted(() =>
    {
        for (const { name, handler, options } of events)
        {
            window.removeEventListener(name, handler, options);
        }
    });
}
