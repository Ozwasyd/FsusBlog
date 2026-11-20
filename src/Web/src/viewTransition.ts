import { runViewTransition, type ViewTransitionRunOptions, type ViewTransitionRunResult } from '@ozwasyd/element-plus'

let activeTransitions = 0

export function runSiteViewTransition(
  update: () => void | Promise<void>,
  options: ViewTransitionRunOptions = {},
): ViewTransitionRunResult {
  const root = document.documentElement
  const kind = options.name ?? 'transition'
  activeTransitions += 1
  root.dataset.fsusblogTransitioning = kind
  const result = runViewTransition(update, options)
  if (result.mode !== 'native') {
    activeTransitions = Math.max(0, activeTransitions - 1)
    if (activeTransitions === 0) delete root.dataset.fsusblogTransitioning
    return result
  }
  void result.finished.finally(() => {
    activeTransitions = Math.max(0, activeTransitions - 1)
    if (activeTransitions === 0) delete root.dataset.fsusblogTransitioning
  })
  return result
}
