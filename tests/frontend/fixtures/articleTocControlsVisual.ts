import { createApp, defineComponent, h, ref } from 'vue';
import { ElButton, ElDrawer } from '@ozwasyd/element-plus';

import '@/assets/main.css';
import ArticleTocPanel from '@/components/article/ArticleTocPanel.vue';
import { activateLocaleRuntime } from '@/locales';

const query = new URL(window.location.href).searchParams;
document.documentElement.classList.toggle('dark', query.get('theme') === 'dark');
await activateLocaleRuntime('zh-CN', ['article']);

const items = query.get('empty') === '1' ? [] : [
    { id: 'chapter-introduction', level: 2 as const, text: '引言 Introduction' },
    {
        id: 'chapter-long',
        level: 3 as const,
        text: '一个需要完整保留的长章节标题 LongUnbrokenHeadingWithoutWhitespace'.repeat(3)
    },
    { id: 'chapter-conclusion', level: 2 as const, text: '结语 Conclusion' }
];

createApp(defineComponent({
    setup()
    {
        const mobileOpen = ref(false);
        const activeId = ref('chapter-introduction');
        const events = ref<Array<{ event: string; value: string | boolean }>>([]);
        return () => h('main', { 'aria-label': '真实文章目录控件' }, [
            h('form', {
                onSubmit(event: Event)
                {
                    event.preventDefault();
                    events.value.push({ event: 'submit', value: true });
                }
            }, [
                h(ElButton, {
                    nativeType: 'button',
                    onClick: () => mobileOpen.value = true
                }, () => '打开文章目录'),
                h(ArticleTocPanel, {
                    items,
                    activeId: activeId.value,
                    mobileOpen: mobileOpen.value,
                    onNavigate(id: string)
                    {
                        events.value.push({ event: 'navigate', value: id });
                        activeId.value = id;
                    },
                    'onUpdate:mobileOpen'(value: boolean)
                    {
                        events.value.push({ event: 'mobileOpen', value });
                        mobileOpen.value = value;
                    }
                })
            ]),
            h('output', { 'aria-label': '目录事件记录' }, JSON.stringify(events.value))
        ]);
    }
})).component('ElDrawer', ElDrawer).mount('#article-toc-controls-fixture');
document.documentElement.dataset.articleTocControlsReady = 'true';
