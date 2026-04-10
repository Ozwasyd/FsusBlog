const PUBLIC_SEO_PATH_PATTERNS = [
  /^\/$/,
  /^\/archive\/?$/,
  /^\/about\/?$/,
  /^\/article\/\d+\/?$/,
  /^\/category\/\d+\/?$/,
  /^\/tag\/\d+\/?$/
]

export function isPublicSeoPath(pathname: string): boolean {
  return PUBLIC_SEO_PATH_PATTERNS.some((pattern) => pattern.test(pathname))
}

export function hasServerAotShell(root: Element | null): boolean {
  if (!(root instanceof HTMLElement)) {
    return false
  }

  return root.querySelector('#fsus-aot-shell') instanceof HTMLElement
}

export function removeGlobalLoader(): void {
  const loader = document.getElementById('global-loader')
  if (!loader) {
    return
  }

  loader.hidden = true
}

export function showGlobalLoader(): void {
  const loader = document.getElementById('global-loader')
  if (!loader) {
    return
  }

  loader.hidden = false
  loader.style.opacity = '1'
}
