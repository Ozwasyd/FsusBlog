import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { ElDialog, ElImageViewer } from '@ozwasyd/element-plus';
import '@ozwasyd/element-plus/dist/index.css';
import '@ozwasyd/element-plus/dist/el-fsus-theme.css';

// Portable copy of reviewer 01a11b43's navigation-only fixture. The upper
// Dialog is a sibling opened programmatically, not a pointer-return test.
const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="red"/></svg>')}`;
const nested = ref(false), opened = ref(false), index = ref(0), caption = ref('Short caption');
const app = createApp(defineComponent({ setup: () => () => h('main', [
    h('button', { id: 'opener', onClick: () => opened.value = true }, 'Open viewer'),
    h(ElImageViewer, {
        visible: opened.value, teleported: true, urlList: [image, `${image} `],
        activeIndex: index.value, altList: ['a', 'b'], cspSafe: true, showToolbar: false,
        'onUpdate:visible': (value: boolean) => opened.value = value
    }, {
        default: () => h('button', { id: 'nested-opener', onClick: () => nested.value = true }, 'Open nested dialog'),
        caption: () => h('p', { 'data-long-caption': true }, caption.value)
    }),
    h(ElDialog, {
        modelValue: nested.value, appendToBody: true, title: 'Nested dialog',
        'onUpdate:modelValue': (value: boolean) => nested.value = value
    }, { default: () => h('button', { id: 'nested-action' }, 'Nested action') })
]) }));
app.mount('#app');
Object.assign(window, {
    review: {
        async longCaption() { caption.value = 'Caption '.repeat(2000); await nextTick(); },
        async showNested() { nested.value = true; await nextTick(); },
        async setIndex(value: number) { index.value = value; await nextTick(); }
    }
});
