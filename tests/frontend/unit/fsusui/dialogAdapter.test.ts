// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  FsusUiDialog,
  fsusDialogWidths,
  isFsusDialogWidth
} from '@/fsusui/dialog'
import {
  findDialogAdapterApiViolations,
  findDialogBridgeResiduesInSource,
  findDialogWrapperGeometryViolations,
  findTaskSurfaceGeometryViolations
} from '../../checks/static/check-task-surface-geometry.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const dialogAdapterPath = path.join(repoRoot, 'src/frontend/src/fsusui/dialog.ts')
const dialogWrapperPath = path.join(repoRoot, 'src/frontend/src/components/ui/FsusDialog.vue')

describe('dialog adapter API (#1787)', () => {
  it('exports only component, width presets and type guard', () => {
    expect(FsusUiDialog).toBeTruthy()
    expect(fsusDialogWidths).toEqual({
      default: '50%',
      compact: 'min(92vw, 28rem)',
      extraCompact: 'min(92vw, 24rem)',
      longForm: 'min(92vw, 48rem)'
    })
    expect(isFsusDialogWidth(fsusDialogWidths.compact)).toBe(true)
    expect(isFsusDialogWidth(fsusDialogWidths.longForm)).toBe(true)
    expect(isFsusDialogWidth('40rem')).toBe(false)

    const runtimeKeys = Object.keys({
      FsusUiDialog,
      fsusDialogWidths,
      isFsusDialogWidth
    }).sort()
    expect(runtimeKeys).toEqual([
      'FsusUiDialog',
      'fsusDialogWidths',
      'isFsusDialogWidth'
    ])
  })

  it('static source has zero CSS class string exports and bridge residues', () => {
    const source = readFileSync(dialogAdapterPath, 'utf8')
    expect(findDialogAdapterApiViolations(source)).toEqual([])
    expect(findDialogBridgeResiduesInSource(source, 'dialog.ts')).toEqual([])
    expect(source).not.toMatch(/export\s+const\s+fsusDialog(?:Modal)?Class/)
    expect(source).not.toContain('fsusblog-dialog')
  })

  it('mutation reintroducing class bridge fails the adapter gate', () => {
    const clean = readFileSync(dialogAdapterPath, 'utf8')
    const polluted = `${clean}\nexport const fsusDialogModalClass = 'fsusblog-dialog-overlay'\n`
    const violations = findDialogAdapterApiViolations(polluted)
    expect(
      violations.some(
        (item) => item.includes('fsusDialogModalClass') || item.includes('CSS class') || item.includes('string-class-bridge')
      )
    ).toBe(true)
  })
})

describe('FsusDialog wrapper static contract (#1787)', () => {
  it('keeps workflow width prop contract without Blog overlay geometry', () => {
    const source = readFileSync(dialogWrapperPath, 'utf8')
    expect(findDialogWrapperGeometryViolations(source)).toEqual([])
    expect(source).toContain('width?: FsusDialogWidth')
    expect(source).toContain("emit('close')")
    expect(source).toContain("emit('closed')")
    expect(source).toContain("emit('opened')")
    expect(source).toContain('#footer')
    expect(source).not.toContain('modal-class')
    expect(source).not.toContain('modalClass')
    expect(source).not.toContain('position: fixed')
    expect(source).not.toContain('100dvh')
    expect(source).not.toContain('.el-overlay')
  })

  it('mutation reintroducing modal-class or viewport geometry fails the wrapper gate', () => {
    const clean = readFileSync(dialogWrapperPath, 'utf8')
    const polluted = clean
      .replace(
        'align-center',
        ':modal-class="\'fsusblog-dialog-overlay\'"\n    align-center'
      )
      .replace(
        '.fsus-dialog__content {\n  min-width: 0;\n}',
        `.fsus-dialog__content {
  min-width: 0;
}
:global(.fsusblog-dialog-overlay) {
  position: fixed;
  inset: 0;
  max-height: calc(var(--fsus-viewport-block-size) - 32px);
}`
      )
    const violations = findDialogWrapperGeometryViolations(polluted)
    expect(violations.length).toBeGreaterThan(0)
    expect(
      violations.some(
        (item) =>
          item.includes('modal-class')
          || item.includes('modalClass')
          || item.includes('position-fixed')
          || item.includes('overlay')
          || item.includes('generic-max-height')
      )
    ).toBe(true)
  })

  it('repository geometry scan is clean after bridge removal', () => {
    const { errors } = findTaskSurfaceGeometryViolations({ root: repoRoot })
    expect(errors).toEqual([])
  })
})

describe('FsusUI #261 geometry ownership probe (#1787)', () => {
  const profiles = {
    desktop: { top: 0, bottom: 0, block: 900 },
    'portrait-notch': { top: 47, bottom: 34, block: 844 },
    'landscape-notch': { top: 0, bottom: 21, block: 390 },
    'short-visual': { top: 0, bottom: 0, block: 430 }
  } as const
  const gap = 16

  function maxGap(base: number, inset: number) {
    return Math.max(base, inset)
  }

  function fsusViewportSafeBlockSize(block: number, top: number, bottom: number) {
    // Mirrors FsusUI fsus-viewport-safe-block-size($fsus-overlay-content-gap).
    return block - maxGap(gap, top) - maxGap(gap, bottom)
  }

  it('Blog width presets stay consumable while max block-size follows FsusUI safe formula', () => {
    expect(Object.values(fsusDialogWidths)).toEqual([
      '50%',
      'min(92vw, 28rem)',
      'min(92vw, 24rem)',
      'min(92vw, 48rem)'
    ])

    const expected = {
      desktop: 900 - 16 - 16,
      'portrait-notch': 844 - 47 - 34,
      'landscape-notch': 390 - 16 - 21,
      'short-visual': 430 - 16 - 16
    }

    for (const [name, profile] of Object.entries(profiles)) {
      expect(fsusViewportSafeBlockSize(profile.block, profile.top, profile.bottom)).toBe(
        expected[name as keyof typeof expected]
      )
    }

    const wrapper = readFileSync(dialogWrapperPath, 'utf8')
    expect(wrapper).not.toMatch(/max-height\s*:/)
    expect(wrapper).not.toMatch(/max-block-size\s*:/)
  })

  it('local FsusUI Dialog contract (when present) owns overlay host geometry', () => {
    // Mirrors src/frontend local alias default: <repo>/../../FsusUI from frontend root,
    // which is sibling of the worktrees parent for this checkout layout.
    const candidates = [
      process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT,
      path.resolve(repoRoot, '../../FsusUI'),
      path.resolve(repoRoot, '../FsusUI'),
      path.resolve(repoRoot, 'FsusUI')
    ].filter(Boolean).map((root) => String(root))

    const dialogScssPath = candidates
      .map((root) => path.join(root, 'vue/packages/theme-chalk/src/dialog.scss'))
      .find((candidate) => existsSync(candidate))
    const safeAreaPath = candidates
      .map((root) => path.join(root, 'vue/packages/theme-chalk/src/mixins/safe-area.scss'))
      .find((candidate) => existsSync(candidate))

    if (!dialogScssPath || !safeAreaPath) {
      // Packaged-only environments still pass Blog-side ownership checks above.
      expect(dialogScssPath || safeAreaPath).toBeFalsy()
      return
    }

    const dialogScss = readFileSync(dialogScssPath, 'utf8')
    const safeArea = readFileSync(safeAreaPath, 'utf8')
    expect(safeArea).toContain('@mixin fsus-viewport-safe-overlay-host')
    expect(safeArea).toContain('@function fsus-viewport-safe-block-size')
    expect(dialogScss).toContain('fsus-viewport-safe-overlay-host')
    expect(dialogScss).toContain('fsus-viewport-safe-block-size')
    expect(dialogScss).toMatch(/#\{\$namespace\}-overlay-dialog|\.el-overlay-dialog/)
  })
})
