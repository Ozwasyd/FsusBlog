import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getFontActivations,
  getFontDetail,
  getFontRegistry
} from '@/api/fontAdmin'
import {
  getThemeActivation,
  getThemeActivationHistory,
  getThemeActivations,
  getThemeDetail,
  getThemeRegistry
} from '@/api/themeAdmin'
import { requestBinaryOnly } from '@/composition/binaryTransport'

import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/composition/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

vi.mock('@/utils/fingerprint', () => ({
  getBrowserFp: () => 'fp-font-theme-test'
}))

const binaryMock = vi.mocked(requestBinaryOnly)

describe('font and theme admin AEDS consumers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    binaryMock.mockResolvedValue([])
  })

  it('routes every font read through the font snapshot frame', async () => {
    const signal = new AbortController().signal

    await getFontRegistry({ signal })
    await getFontDetail('font/id', { signal })
    await getFontActivations({ signal })

    expect(binaryMock.mock.calls.map(([request]) => ({
      url: request.binaryUrl,
      frameType: request.frameType,
      signal: request.signal
    }))).toEqual([
      {
        url: '/api/binary/author/ops/fonts/registry',
        frameType: FrameType.FontAdminSnapshot,
        signal
      },
      {
        url: '/api/binary/author/ops/fonts/registry/font%2Fid',
        frameType: FrameType.FontAdminSnapshot,
        signal
      },
      {
        url: '/api/binary/author/ops/fonts/activations',
        frameType: FrameType.FontAdminSnapshot,
        signal
      }
    ])
  })

  it('routes every theme read through the theme snapshot frame', async () => {
    const signal = new AbortController().signal

    await getThemeRegistry({ signal })
    await getThemeDetail('theme/id', { signal })
    await getThemeActivations({ signal })
    await getThemeActivation('user-preview:42', { signal })
    await getThemeActivationHistory('user-preview:42', { signal })

    expect(binaryMock.mock.calls.map(([request]) => ({
      url: request.binaryUrl,
      frameType: request.frameType,
      signal: request.signal
    }))).toEqual([
      {
        url: '/api/binary/author/ops/themes/registry',
        frameType: FrameType.ThemeAdminSnapshot,
        signal
      },
      {
        url: '/api/binary/author/ops/themes/registry/theme%2Fid',
        frameType: FrameType.ThemeAdminSnapshot,
        signal
      },
      {
        url: '/api/binary/author/ops/themes/activations',
        frameType: FrameType.ThemeAdminSnapshot,
        signal
      },
      {
        url: '/api/binary/author/ops/themes/activations/user-preview%3A42',
        frameType: FrameType.ThemeAdminSnapshot,
        signal
      },
      {
        url: '/api/binary/author/ops/themes/activations/user-preview%3A42/history',
        frameType: FrameType.ThemeAdminSnapshot,
        signal
      }
    ])
  })
})
