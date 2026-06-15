import { defineComponent, h, type PropType } from 'vue'
import {
  resolveFsusUiEmptyState,
  toFsusUiInlineEmptyStateProps
} from '@/fsusui/primitiveAdapters'

type AdminSegmentedControlValue = string | number | boolean | undefined

export type AdminSegmentedControlItem = {
  label: string
  value: AdminSegmentedControlValue
}

export const AdminCollectionToolbar = defineComponent({
  name: 'AdminCollectionToolbar',
  props: {
    label: {
      type: String,
      required: true
    }
  },
  setup(props, { slots }) {
    return () => h('section', {
      class: 'border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] px-4 py-4',
      'aria-label': props.label
    }, [
      h('div', {
        class: 'flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between'
      }, [
        h('div', { class: 'min-w-0 flex-1' }, slots.filters?.()),
        slots.actions
          ? h('div', { class: 'flex shrink-0 items-center gap-2 lg:justify-end' }, slots.actions())
          : null
      ]),
      slots.default?.()
    ])
  }
})

export const AdminFilterGroup = defineComponent({
  name: 'AdminFilterGroup',
  props: {
    label: {
      type: String,
      required: true
    }
  },
  setup(props, { slots }) {
    return () => h('div', { class: 'grid gap-1.5' }, [
      h('span', { class: 'text-[11px] font-bold text-[var(--fsusblog-text-muted)]' }, props.label),
      slots.default?.()
    ])
  }
})

export const AdminSegmentedControl = defineComponent({
  name: 'AdminSegmentedControl',
  props: {
    modelValue: {
      type: [String, Number, Boolean] as PropType<AdminSegmentedControlValue>,
      default: undefined
    },
    items: {
      type: Array as PropType<readonly AdminSegmentedControlItem[]>,
      default: () => []
    },
    disabled: {
      type: Boolean,
      default: false
    },
    ariaLabel: {
      type: String,
      default: ''
    }
  },
  emits: {
    'update:modelValue': (_value: AdminSegmentedControlValue) => true
  },
  setup(props, { emit }) {
    return () => h('div', {
      class: 'inline-flex max-w-full flex-wrap items-center gap-1 rounded-md border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)] p-1',
      role: 'group',
      'aria-label': props.ariaLabel
    }, props.items.map((item) => {
      const active = item.value === props.modelValue
      return h('button', {
        type: 'button',
        class: [
          'min-h-8 rounded px-2.5 text-[12px] font-bold transition-colors',
          active
            ? 'bg-[var(--fsusblog-page-bg-soft)] text-[var(--fsusblog-text-primary)] shadow-sm'
            : 'text-[var(--fsusblog-text-muted)] hover:bg-[var(--fsusblog-page-bg-soft)] hover:text-[var(--fsusblog-text-secondary)]',
          props.disabled ? 'cursor-not-allowed opacity-55' : ''
        ],
        disabled: props.disabled,
        'aria-pressed': active,
        onClick: () => emit('update:modelValue', item.value)
      }, item.label)
    }))
  }
})

export const AdminCollectionSummary = defineComponent({
  name: 'AdminCollectionSummary',
  props: {
    title: {
      type: String,
      required: true
    },
    description: {
      type: String,
      default: ''
    },
    id: {
      type: String,
      default: undefined
    },
    meta: {
      type: String,
      default: ''
    }
  },
  setup(props, { slots }) {
    return () => {
      const metaContent = slots.meta?.() ?? (props.meta || props.description)

      return h('header', {
        class: 'flex flex-col gap-3 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between'
      }, [
        h('div', { class: 'min-w-0' }, [
          h('h2', {
            id: props.id,
            class: 'm-0 text-[14px] font-bold leading-snug text-[var(--fsusblog-text-primary)]'
          }, slots.title?.() ?? props.title),
          metaContent
            ? h('p', { class: 'mt-1 text-[12px] leading-relaxed text-[var(--fsusblog-text-tertiary)]' }, metaContent)
            : null,
          props.meta && props.description
            ? h('p', { class: 'mt-1 text-[12px] leading-relaxed text-[var(--fsusblog-text-tertiary)]' }, props.description)
            : null
        ]),
        slots.actions
          ? h('div', { class: 'flex shrink-0 flex-wrap items-center gap-2' }, slots.actions())
          : null
      ])
    }
  }
})

export const AdminInlineEmptyState = defineComponent({
  name: 'AdminInlineEmptyState',
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
    const ElEmptyState = resolveFsusUiEmptyState()
    const emptyStateProps = toFsusUiInlineEmptyStateProps('adminCollection')

    return () => h(ElEmptyState, {
      ...emptyStateProps,
      class: 'px-4 py-6 text-left',
      role: 'status',
      title: props.title,
      description: props.description
    }, slots.actions ? { actions: () => slots.actions?.() } : undefined)
  }
})
