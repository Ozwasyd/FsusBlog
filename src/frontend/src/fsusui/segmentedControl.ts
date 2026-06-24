import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CSSProperties, PropType } from 'vue'
import { RouterLink } from 'vue-router'

export type FsusUiSegmentedControlValue = string | number | boolean

export interface FsusUiSegmentedControlItem {
  label: string
  value: FsusUiSegmentedControlValue
  disabled?: boolean
  to?: string
  href?: string
}

export const FsusUiSegmentedControl = defineComponent({
  name: 'FsusUiSegmentedControl',
  inheritAttrs: false,
  props: {
    modelValue: {
      type: [String, Number, Boolean] as PropType<FsusUiSegmentedControlValue>,
      default: undefined
    },
    items: {
      type: Array as PropType<FsusUiSegmentedControlItem[]>,
      default: () => []
    },
    ariaLabel: {
      type: String,
      default: undefined
    },
    ariaLabelledby: {
      type: String,
      default: undefined
    },
    density: {
      type: String,
      default: 'default'
    },
    selectionMode: {
      type: String as PropType<'radio' | 'link'>,
      default: 'radio'
    }
  },
  emits: {
    'update:modelValue': (_value: FsusUiSegmentedControlValue) => true,
    change: (_value: FsusUiSegmentedControlValue) => true,
    'item-click': (_value: FsusUiSegmentedControlValue) => true
  },
  setup(props, { attrs, slots, emit }) {
    const rootRef = ref<HTMLElement>()
    const buttonRefs = ref<HTMLElement[]>([])
    const indicatorStyle = ref<CSSProperties>({
      opacity: '0',
      transform: 'translate3d(0, 0, 0)',
      width: '0px'
    })
    const activeIndex = computed(() =>
      props.items.findIndex((item) => item.value === props.modelValue)
    )
    let resizeObserver: ResizeObserver | undefined

    const setButtonRef = (element: Element | null, index: number): void => {
      if (element instanceof HTMLElement) {
        buttonRefs.value[index] = element
      }
    }

    const updateIndicator = async (): Promise<void> => {
      await nextTick()
      const index = activeIndex.value
      const button = index >= 0 ? buttonRefs.value[index] : undefined
      if (!button || !rootRef.value) {
        indicatorStyle.value = {
          opacity: '0',
          transform: 'translate3d(0, 0, 0)',
          width: '0px'
        }
        return
      }

      indicatorStyle.value = {
        opacity: '1',
        transform: `translate3d(${button.offsetLeft}px, 0, 0)`,
        width: `${button.offsetWidth}px`
      }
    }

    const selectItem = (item: FsusUiSegmentedControlItem): void => {
      if (item.disabled) {
        return
      }

      const value = item.value
      emit('item-click', value)
      emit('update:modelValue', value)
      emit('change', value)
    }

    const handleKeydown = (event: KeyboardEvent, index: number): void => {
      const keyMap: Record<string, number | 'first' | 'last'> = {
        ArrowRight: 1,
        ArrowDown: 1,
        ArrowLeft: -1,
        ArrowUp: -1,
        Home: 'first',
        End: 'last'
      }
      const action = keyMap[event.key]
      if (action === undefined) {
        return
      }

      event.preventDefault()
      const enabledItems = props.items.filter((item) => !item.disabled)
      if (enabledItems.length === 0) {
        return
      }

      const current = props.items[index]
      const enabledIndex = enabledItems.findIndex((item) => item.value === current?.value)
      const nextEnabledIndex = action === 'first'
        ? 0
        : action === 'last'
          ? enabledItems.length - 1
          : (enabledIndex + action + enabledItems.length) % enabledItems.length
      const nextItem = enabledItems[nextEnabledIndex]
      if (nextItem) {
        selectItem(nextItem)
      }
    }

    watch(
      () => [props.modelValue, props.items.length],
      () => {
        void updateIndicator()
      },
      { flush: 'post' }
    )

    onMounted(() => {
      void updateIndicator()
      if (typeof ResizeObserver !== 'undefined' && rootRef.value) {
        resizeObserver = new ResizeObserver(() => {
          void updateIndicator()
        })
        resizeObserver.observe(rootRef.value)
      }
    })

    onBeforeUnmount(() => {
      resizeObserver?.disconnect()
    })

    return () => h('div', {
      ...attrs,
      ref: rootRef,
      class: [
        'el-segmented-control',
        `el-segmented-control--${props.density}`,
        attrs.class
      ],
      style: [
        {
          position: 'relative',
          isolation: 'isolate'
        },
        attrs.style as CSSProperties | undefined
      ],
      role: props.selectionMode === 'radio' ? 'radiogroup' : 'navigation',
      'aria-label': props.ariaLabel,
      'aria-labelledby': props.ariaLabelledby
    }, [
      h('span', {
        class: 'el-segmented-control__indicator',
        'aria-hidden': 'true',
        style: [
          {
            position: 'absolute',
            top: '2px',
            bottom: '2px',
            left: '0',
            zIndex: '0',
            borderRadius: 'calc(var(--fsus-radius-control, var(--el-border-radius-base)) - 2px)',
            background: 'var(--fsusblog-page-bg, var(--el-fill-color-light))',
            boxShadow: 'inset 0 0 0 1px var(--fsusblog-panel-border, var(--el-border-color-light))',
            pointerEvents: 'none',
            transition: [
              'transform var(--fsus-motion-control, var(--el-transition-duration)) var(--fsus-motion-standard, var(--el-transition-function-standard))',
              'width var(--fsus-motion-control, var(--el-transition-duration)) var(--fsus-motion-standard, var(--el-transition-function-standard))',
              'opacity var(--fsus-motion-control-fast, var(--el-transition-duration-fast)) var(--fsus-motion-standard, var(--el-transition-function-standard))'
            ].join(', ')
          },
          indicatorStyle.value
        ]
      }),
      ...props.items.map((item, index) => {
      const selected = item.value === props.modelValue
      const linkMode = props.selectionMode === 'link' && (item.to || item.href)
      const rendersLink = Boolean(item.to || item.href)
      const itemProps = {
        key: String(item.value),
        ref: (element) => setButtonRef(element, index),
        href: item.disabled ? undefined : item.href,
        class: [
          'el-segmented-control__item',
          { 'is-active': selected }
        ],
        style: {
          position: 'relative',
          zIndex: '1',
          ...(selected
            ? {
                background: 'transparent',
                boxShadow: 'none'
              }
            : undefined)
        },
        disabled: rendersLink ? undefined : item.disabled,
        'aria-disabled': item.disabled ? 'true' : undefined,
        role: linkMode ? undefined : 'radio',
        type: rendersLink ? undefined : 'button',
        'aria-checked': linkMode ? undefined : selected,
        'aria-current': linkMode && selected ? 'page' : undefined,
        tabindex: linkMode ? undefined : (selected ? 0 : -1),
        onClick: () => selectItem(item),
        onKeydown: (event: KeyboardEvent) => handleKeydown(event, index)
      }
      const itemContent = slots.item
        ? slots.item({ item, selected })
        : item.label

      if (item.to) {
        return h(RouterLink, {
          key: String(item.value),
          to: item.to,
          custom: true
        }, {
          default: ({ href, navigate }: { href: string; navigate: (event?: MouseEvent) => void }) =>
            h('a', {
              ...itemProps,
              href: item.disabled ? undefined : href,
              onClick: (event: MouseEvent) => {
                selectItem(item)
                if (!item.disabled) {
                  navigate(event)
                }
              }
            }, itemContent)
        })
      }

      return h(item.href ? 'a' : 'button', itemProps, itemContent)
      })
    ])
  }
})
