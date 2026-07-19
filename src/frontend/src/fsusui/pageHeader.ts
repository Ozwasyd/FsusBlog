import { defineComponent, h } from 'vue';

export const AccountPageHeader = defineComponent({
    name: 'AccountPageHeader',
    inheritAttrs: false,
    props: {
        title: {
            type: String,
            required: true
        },
        content: {
            type: String,
            default: ''
        }
    },
    setup(props, { attrs, slots })
    {
        return () => h(
            'header',
            {
                ...attrs,
                class: ['account-page-header', attrs.class]
            },
            [
                h('h1', { class: 'account-page-title' }, slots.title?.() ?? props.title),
                (slots.default || props.content)
                    ? h('p', { class: 'account-page-description' }, slots.default?.() ?? props.content)
                    : null
            ]
        );
    }
});

// Compatibility alias for the page migrations tracked by #1304. New local
// implementations must use a Blog-owned runtime name instead of `FsusUi*`.
export const FsusUiPageHeader = AccountPageHeader;
