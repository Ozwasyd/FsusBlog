import { ElImageViewer } from '@ozwasyd/element-plus';
import '@ozwasyd/element-plus/dist/index.css';
import '@ozwasyd/element-plus/dist/el-fsus-theme.css';
import { createSSRApp, defineComponent, h, nextTick, ref, Teleport } from 'vue';

const imageUrl = (label: string) => `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><text x="20" y="80">${label}</text></svg>`
)}`;

export const probeImages = [
    { src: imageUrl('First figure'), alt: 'First figure' },
    { src: imageUrl('Second figure'), alt: 'Second figure' }
];

export function createImageViewerConsumerProbe(initialOpen = false, teleportControl = false)
{
    const visible = ref(initialOpen);
    const index = ref(0);
    const images = ref([...probeImages]);
    const viewer = ref<InstanceType<typeof ElImageViewer> | null>(null);
    const events: Array<{ name: string; index?: number }> = [];
    const component = defineComponent({
        setup()
        {
            return () => h('main', { 'data-consumer-probe': true }, [
                h('button', {
                    id: 'probe-trigger',
                    onClick: () => { visible.value = true; }
                }, 'Open article image'),
                h('button', { id: 'probe-background' }, 'Background action'),
                h('div', { 'data-probe-article': true }, 'Scrollable article'),
                teleportControl ? h(Teleport, { to: '#probe-teleports' },
                    h('p', { 'data-probe-teleport-control': true }, 'SSR control')) : null,
                !teleportControl ? h(ElImageViewer, {
                    visible: visible.value,
                    ref: viewer,
                    urlList: images.value.map((image) => image.src),
                    initialIndex: index.value,
                    activeIndex: index.value,
                    altList: images.value.map((image) => image.alt),
                    appendTo: '#probe-teleports',
                    cspSafe: true,
                    ariaLabel: '查看大图',
                    labels: { close: '关闭大图', previous: '上一张', next: '下一张' },
                    infinite: false,
                    teleported: true,
                    hideOnClickModal: true,
                    onClose: () =>
                    {
                        events.push({ name: 'close' });
                        visible.value = false;
                    },
                    onPrevious: (value: number) => events.push({ name: 'previous', index: value }),
                    onNext: (value: number) => events.push({ name: 'next', index: value }),
                    onSwitch: (value: number) =>
                    {
                        events.push({ name: 'switch', index: value });
                        index.value = value;
                    }
                }, {
                    caption: ({ alt }: { alt: string }) => h('p', {
                        'data-probe-caption': true
                    }, alt)
                }) : null
            ]);
        }
    });
    const app = createSSRApp(component);
    return {
        app,
        async setIndex(value: number)
        {
            index.value = value;
            await nextTick();
        },
        async setActiveItem(value: number)
        {
            viewer.value?.setActiveItem(value);
            await nextTick();
        },
        async setImages(value: typeof probeImages)
        {
            images.value = value;
            await nextTick();
        },
        async open()
        {
            visible.value = true;
            await nextTick();
        },
        async close()
        {
            visible.value = false;
            await nextTick();
        },
        async reset()
        {
            visible.value = false;
            index.value = 0;
            images.value = [...probeImages];
            await nextTick();
        },
        unmount: () => app.unmount(),
        snapshot: () => ({
            visible: visible.value,
            index: index.value,
            events: [...events],
            publicProps: Object.keys(ElImageViewer.props ?? {}),
            publicEvents: Object.keys(ElImageViewer.emits ?? {})
        })
    };
}
