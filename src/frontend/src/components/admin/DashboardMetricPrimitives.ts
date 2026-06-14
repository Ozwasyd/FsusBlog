import { computed, defineComponent, h, type PropType } from 'vue'

type DashboardMetricDensity = 'default' | 'compact'
type DashboardMetricValue = string | number

const densityProp = {
  type: String as PropType<DashboardMetricDensity>,
  default: 'default'
}

const densityClass = (density: DashboardMetricDensity): string =>
  density === 'compact' ? 'gap-3' : 'gap-4'

const itemPaddingClass = (density: DashboardMetricDensity): string =>
  density === 'compact' ? 'py-3' : 'py-4'

export const DashboardMetricList = defineComponent({
  name: 'DashboardMetricList',
  props: {
    density: densityProp,
    role: {
      type: String,
      default: 'list'
    }
  },
  setup(props, { slots }) {
    return () => h('div', {
      class: ['grid', densityClass(props.density)],
      role: props.role
    }, slots.default?.())
  }
})

export const DashboardMetricItem = defineComponent({
  name: 'DashboardMetricItem',
  props: {
    label: {
      type: String,
      default: ''
    },
    primary: {
      type: [String, Number] as PropType<DashboardMetricValue>,
      default: ''
    },
    secondary: {
      type: [String, Number, Array] as PropType<DashboardMetricValue | readonly DashboardMetricValue[]>,
      default: () => []
    },
    meta: {
      type: String,
      default: ''
    },
    density: densityProp
  },
  setup(props, { slots }) {
    const secondaryItems = computed(() => {
      const value = props.secondary
      if (Array.isArray(value)) return value.map((item) => String(item))
      if (value === '' || value === null || value === undefined) return []
      return [String(value)]
    })

    return () => h('div', {
      class: [
        'border-b border-[var(--fsusblog-panel-border)] last:border-b-0',
        itemPaddingClass(props.density)
      ],
      role: 'listitem'
    }, [
      h('div', { class: 'flex min-w-0 items-baseline justify-between gap-4' }, [
        h('span', { class: 'min-w-0 truncate text-[15px] font-bold leading-snug text-[var(--fsusblog-text-primary)]' }, slots.label?.() ?? props.label),
        props.meta
          ? h('span', { class: 'shrink-0 text-[12px] font-semibold tabular-nums text-[var(--fsusblog-text-tertiary)]' }, slots.meta?.() ?? props.meta)
          : null
      ]),
      h('div', { class: 'mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] leading-relaxed' }, [
        h('strong', { class: 'font-bold tabular-nums text-[var(--fsusblog-text-secondary)]' }, slots.primary?.() ?? props.primary),
        ...secondaryItems.value.map((item) => h('span', {
          class: 'tabular-nums text-[var(--fsusblog-text-tertiary)]'
        }, slots.secondary?.() ?? item))
      ])
    ])
  }
})

export const DashboardDistributionList = defineComponent({
  name: 'DashboardDistributionList',
  props: {
    density: densityProp,
    role: {
      type: String,
      default: 'list'
    }
  },
  setup(props, { slots }) {
    return () => h('div', {
      class: ['grid', densityClass(props.density)],
      role: props.role
    }, slots.default?.())
  }
})

export const DashboardDistributionBarRow = defineComponent({
  name: 'DashboardDistributionBarRow',
  props: {
    label: {
      type: String,
      default: ''
    },
    value: {
      type: [String, Number] as PropType<DashboardMetricValue>,
      default: ''
    },
    ratio: {
      type: Number,
      default: 0
    },
    rank: {
      type: [String, Number] as PropType<DashboardMetricValue>,
      default: ''
    },
    density: densityProp
  },
  setup(props, { slots }) {
    const clampedRatio = computed(() => Math.min(1, Math.max(0, props.ratio)))

    return () => h('div', {
      class: [
        'border-b border-[var(--fsusblog-panel-border)] last:border-b-0',
        itemPaddingClass(props.density)
      ],
      role: 'listitem'
    }, [
      h('div', { class: 'flex min-w-0 items-baseline gap-3' }, [
        props.rank
          ? h('span', { class: 'w-5 shrink-0 text-[12px] font-semibold tabular-nums text-[var(--fsusblog-text-muted)]' }, slots.rank?.() ?? String(props.rank))
          : null,
        h('span', { class: 'min-w-0 flex-1 truncate text-[15px] font-bold leading-snug text-[var(--fsusblog-text-primary)]' }, slots.label?.() ?? props.label),
        h('span', { class: 'shrink-0 text-[13px] font-bold tabular-nums text-[var(--fsusblog-text-secondary)]' }, slots.value?.() ?? props.value)
      ]),
      h('div', {
        class: 'mt-2 h-1 overflow-hidden rounded-full bg-[var(--fsusblog-panel-bg-soft)]',
        'aria-hidden': 'true'
      }, [
        h('span', {
          class: 'block h-full rounded-full bg-[var(--fsusblog-text-tertiary)] opacity-45',
          style: { width: `${Math.round(clampedRatio.value * 100)}%` }
        })
      ])
    ])
  }
})

export const DashboardInlineEmptyState = defineComponent({
  name: 'DashboardInlineEmptyState',
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
  setup(props) {
    return () => h('div', {
      class: 'mt-5 border-t border-[var(--fsusblog-panel-border)] pt-4',
      role: 'status',
      'aria-live': 'polite'
    }, [
      h('p', { class: 'm-0 text-[14px] font-bold text-[var(--fsusblog-text-secondary)]' }, props.title),
      props.description
        ? h('p', { class: 'mt-1 text-[12px] leading-relaxed text-[var(--fsusblog-text-tertiary)]' }, props.description)
        : null
    ])
  }
})
