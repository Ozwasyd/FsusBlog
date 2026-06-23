import { defineComponent, h, type PropType } from 'vue'

export type ProfileSectionNavItem = {
  href: string
  label: string
}

export const ProfileSectionNav = defineComponent({
  name: 'ProfileSectionNav',
  props: {
    items: {
      type: Array as PropType<readonly ProfileSectionNavItem[]>,
      required: true
    },
    ariaLabel: {
      type: String,
      default: '设置分区'
    }
  },
  setup(props) {
    return () => h('nav', {
      class: 'mb-10 border-b border-[var(--fsusblog-panel-border)] pb-3',
      'aria-label': props.ariaLabel
    }, h('div', {
      class: 'flex flex-wrap items-center gap-x-5 gap-y-2'
    }, props.items.map((item) => h('a', {
      href: item.href,
      class: 'text-[12px] font-bold text-[var(--fsusblog-text-secondary)] underline-offset-4 hover:text-[var(--fsusblog-color-primary)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--fsusblog-color-primary)]'
    }, item.label))))
  }
})

export const ProfileSettingsSection = defineComponent({
  name: 'ProfileSettingsSection',
  props: {
    id: {
      type: String,
      required: true
    },
    title: {
      type: String,
      required: true
    },
    description: {
      type: String,
      default: ''
    },
    danger: {
      type: Boolean,
      default: false
    }
  },
  setup(props, { slots }) {
    return () => h('section', {
      id: props.id,
      class: [
        'scroll-mt-24 border-t border-[var(--fsusblog-panel-border)] pt-8',
        props.danger ? 'border-[var(--fsusblog-color-error)]/25' : ''
      ]
    }, [
      h('header', {
        class: 'mb-6 flex flex-col gap-2'
      }, [
        h('h2', {
          class: [
            'm-0 text-[15px] font-bold leading-snug',
            props.danger ? 'text-[var(--fsusblog-color-error)]' : 'text-[var(--fsusblog-text-primary)]'
          ]
        }, props.title),
        props.description
          ? h('p', {
            class: 'm-0 max-w-2xl text-[13px] leading-relaxed text-[var(--fsusblog-text-tertiary)]'
          }, props.description)
          : null
      ]),
      slots.default?.()
    ])
  }
})

export const ProfileResourceList = defineComponent({
  name: 'ProfileResourceList',
  setup(_props, { slots }) {
    return () => h('div', {
      class: 'min-w-0 max-w-full overflow-hidden divide-y divide-[var(--fsusblog-panel-border)] border-y border-[var(--fsusblog-panel-border)]',
      role: 'list'
    }, slots.default?.())
  }
})

export const ProfileResourceListItem = defineComponent({
  name: 'ProfileResourceListItem',
  setup(_props, { slots }) {
    return () => h('article', {
      class: 'min-w-0 max-w-full overflow-hidden flex flex-col gap-4 py-6 sm:flex-row sm:items-center sm:justify-between',
      role: 'listitem'
    }, [
      h('div', {
        class: 'min-w-0 flex-1'
      }, [
        slots.title ? h('div', { class: 'min-w-0' }, slots.title()) : null,
        slots.meta ? h('div', { class: 'mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]' }, slots.meta()) : null,
        slots.default?.()
      ]),
      slots.actions ? h('div', { class: 'flex max-w-full shrink-0 flex-wrap items-center gap-2 sm:justify-end' }, slots.actions()) : null
    ])
  }
})

export const ProfileInlineEmptyState = defineComponent({
  name: 'ProfileInlineEmptyState',
  props: {
    title: {
      type: String,
      required: true
    },
    description: {
      type: String,
      default: ''
    }
  },
  setup(props, { slots }) {
    return () => h('div', {
      class: 'py-6 text-left',
      role: 'status',
      'aria-live': 'polite'
    }, [
      h('p', { class: 'm-0 text-[14px] font-bold text-[var(--fsusblog-text-secondary)]' }, props.title),
      props.description
        ? h('p', { class: 'mt-1 text-[12px] leading-relaxed text-[var(--fsusblog-text-tertiary)]' }, props.description)
        : null,
      slots.actions ? h('div', { class: 'mt-4 flex flex-wrap items-center gap-2' }, slots.actions()) : null
    ])
  }
})
