<script lang="ts">
import {
  Comment,
  Transition,
  cloneVNode,
  defineComponent,
  h,
  onBeforeUnmount,
  watch,
  type PropType,
  type VNode,
} from 'vue'
import { useRoute } from 'vue-router'
import { fsusBlogMotionPresets } from '@/fsusui/blogMotion'
import {
  runMotion,
  useMotionRouteCleanup,
  type MotionPhase,
  type MotionPresetName,
} from '@ozwasyd/element-plus/motion'

export default defineComponent({
  name: 'FsusBlogRouteTransition',
  props: {
    name: {
      type: String as PropType<MotionPresetName>,
      default: fsusBlogMotionPresets.route,
    },
    appear: {
      type: Boolean,
      default: false,
    },
    disabled: {
      type: Boolean,
      default: false,
    },
    routeKey: {
      type: [String, Number] as PropType<string | number>,
      default: undefined,
    },
  },
  setup(props, { slots }) {
    const route = useRoute()
    const routeCleanup = useMotionRouteCleanup()
    const cleanupByElement = new WeakMap<HTMLElement, () => boolean>()

    function runRouteMotion(el: Element, phase: MotionPhase, done: () => void): void {
      if (typeof HTMLElement === 'undefined' || !(el instanceof HTMLElement)) {
        done()
        return
      }

      let settled = false
      const finish = (): void => {
        if (settled) {
          return
        }
        settled = true
        cleanupByElement.get(el)?.()
        cleanupByElement.delete(el)
        done()
      }

      const controls = runMotion(el, {
        name: props.name,
        disabled: props.disabled,
        phase,
        onFinish: finish,
      })
      const removeCleanup = routeCleanup.add(() => {
        controls.cancel()
        finish()
      })
      cleanupByElement.set(el, removeCleanup)
    }

    function runEnter(el: Element, done: () => void): void {
      runRouteMotion(el, 'enter', done)
    }

    function runLeave(el: Element, done: () => void): void {
      runRouteMotion(el, 'leave', done)
    }

    watch(
      () => route.fullPath,
      () => routeCleanup.cleanup(),
      { flush: 'pre' },
    )

    onBeforeUnmount(() => {
      routeCleanup.cleanup()
    })

    function renderRouteSlot(): VNode[] {
      const children = slots.default?.() ?? []
      if (props.routeKey === undefined) {
        return children
      }

      return children.map((child) => {
        if (child.type === Comment) {
          return child
        }

        return cloneVNode(child, { key: props.routeKey })
      })
    }

    return () =>
      h(
        Transition,
        {
          mode: 'out-in',
          appear: props.appear,
          css: false,
          onEnter: runEnter,
          onLeave: runLeave,
        },
        {
          default: renderRouteSlot,
        },
      )
  },
})
</script>
