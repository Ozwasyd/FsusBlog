import { describe, expect, it } from 'vitest'

import {
  FsusUiDialog,
  fsusDialogWidths,
  isFsusDialogWidth
} from '@/fsusui/dialog'
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
  })
})
