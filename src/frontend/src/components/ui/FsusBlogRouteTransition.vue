<template>
  <Transition
    mode="out-in"
    :appear="appear"
    :css="false"
    @enter="runEnter"
    @leave="runLeave"
  >
    <slot />
  </Transition>
</template>

<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  fsusBlogMotionPresets,
  runMotion,
  useMotionRouteCleanup,
  type MotionPhase,
  type MotionPresetName
} from '@/fsusui/motion'

const props = withDefaults(defineProps<{
  name?: MotionPresetName
  appear?: boolean
  disabled?: boolean
}>(), {
  name: fsusBlogMotionPresets.route,
  appear: false,
  disabled: false
})

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
    onFinish: finish
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
  { flush: 'pre' }
)

onBeforeUnmount(() => {
  routeCleanup.cleanup()
})
</script>
