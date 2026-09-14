export type SettingsUploadSurfaceState =
  | 'empty'
  | 'preview'
  | 'preview-loading'
  | 'preview-failed'
  | 'uploading'
  | 'disabled'

export type SettingsUploadSurfaceReport = {
  surface: string
  state: string
  activationOwners: number
  tabbableOwners: number
  nestedInteractive: number
  nativeButtons: number
  roleButtons: number
  fileInputs: number
  accessibleName: string
  ariaDisabled: boolean
  ariaBusy: boolean
  tabIndexes: string[]
}

const OWNER_SELECTOR = [
  'a[href]',
  'button',
  'select',
  'textarea',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]'
].join(',')

function isFileInput(node: Element): boolean {
  return node instanceof HTMLInputElement && node.type === 'file'
}

function isOwnerCandidate(node: Element): boolean {
  if (isFileInput(node)) {
    return false
  }
  if (node.matches(OWNER_SELECTOR)) {
    return true
  }
  return node instanceof HTMLInputElement && node.type !== 'hidden'
}

function accessibleName(node: Element): string {
  const labelled = node.getAttribute('aria-label')
  if (labelled && labelled.trim()) {
    return labelled.trim()
  }
  const labelledBy = node.getAttribute('aria-labelledby')
  if (labelledBy) {
    const names = labelledBy
      .split(/\s+/u)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .replace(/\s+/gu, ' ')
      .trim()
    if (names) {
      return names
    }
  }
  const imageAlts = Array.from(node.querySelectorAll('img[alt]'))
    .map((image) => image.getAttribute('alt') ?? '')
    .join(' ')
  return `${imageAlts} ${node.textContent ?? ''}`.replace(/\s+/gu, ' ').trim()
}

export function inspectSettingsUploadSurface(surface: Element): SettingsUploadSurfaceReport {
  const nodes = [surface, ...Array.from(surface.querySelectorAll('*'))]
  const owners = nodes.filter(isOwnerCandidate)
  const tabbable = owners.filter((node) => {
    const tabindex = node.getAttribute('tabindex')
    if (tabindex === '-1') {
      return false
    }
    if ('disabled' in node && Boolean((node as HTMLButtonElement).disabled)) {
      return false
    }
    if (node.getAttribute('aria-disabled') === 'true') {
      return false
    }
    return node.matches(OWNER_SELECTOR) || node instanceof HTMLInputElement
  })
  const nestedInteractive = owners.filter((owner) =>
    owners.some((other) => other !== owner && owner.contains(other))).length
  const disabledHost = surface.matches('[aria-disabled="true"]')
    ? surface
    : surface.querySelector('[aria-disabled="true"]')
  const trigger = tabbable[0] ?? owners[0] ?? disabledHost ?? surface
  const busyHost = surface.querySelector('[aria-busy="true"]')

  return {
    surface: surface.getAttribute('data-settings-upload-surface') ?? '',
    state: surface.getAttribute('data-upload-state') ?? '',
    activationOwners: owners.length,
    tabbableOwners: tabbable.length,
    nestedInteractive,
    nativeButtons: surface.querySelectorAll('button').length,
    roleButtons: surface.querySelectorAll('[role="button"]').length,
    fileInputs: surface.querySelectorAll('input[type="file"]').length,
    accessibleName: accessibleName(trigger),
    ariaDisabled: disabledHost?.getAttribute('aria-disabled') === 'true',
    ariaBusy: Boolean(busyHost),
    tabIndexes: owners.map((node) => node.getAttribute('tabindex') ?? '')
  }
}

export function assertSingleActivationOwner(report: SettingsUploadSurfaceReport): void {
  if (report.nativeButtons !== 0) {
    throw new Error(`${report.surface}: native button inside Upload trigger`)
  }
  if (report.roleButtons !== 0) {
    throw new Error(`${report.surface}: role=button inside Upload trigger`)
  }
  if (report.nestedInteractive !== 0) {
    throw new Error(`${report.surface}: nested interactive descendants`)
  }
  if (report.fileInputs !== 1) {
    throw new Error(`${report.surface}: expected one file input, got ${report.fileInputs}`)
  }
  if (report.state === 'disabled' || report.state === 'uploading') {
    if (report.tabbableOwners !== 0) {
      throw new Error(`${report.surface}: disabled/uploading surface still has a tab stop`)
    }
    if (!report.ariaDisabled) {
      throw new Error(`${report.surface}: disabled/uploading surface is not aria-disabled`)
    }
    return
  }
  if (report.activationOwners !== 1) {
    throw new Error(`${report.surface}: expected one activation owner, got ${report.activationOwners}`)
  }
  if (report.tabbableOwners !== 1) {
    throw new Error(`${report.surface}: expected one tab stop, got ${report.tabbableOwners}`)
  }
  if (!report.accessibleName) {
    throw new Error(`${report.surface}: missing accessible name`)
  }
}

export function fsusUiSourceMode(): 'local' | 'published' {
  const flag = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.FSUSBLOG_USE_LOCAL_FSUSUI
  if (flag === '0' || flag?.toLowerCase() === 'false') {
    return 'published'
  }
  return 'local'
}
