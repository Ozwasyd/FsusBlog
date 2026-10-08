import { buildFsusBinaryRoute } from '@/generated/fsusBinaryRoutes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/composition/binaryTransport', () => ({
    requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/composition/binaryTransport'
import { getFontActivations, getFontDetail, getFontRegistry } from '@/api/fontAdmin'
import {
    getThemeActivation,
    getThemeActivationHistory,
    getThemeActivations,
    getThemeDetail,
    getThemeRegistry
} from '@/api/themeAdmin'

const requestBinaryOnlyMock = vi.mocked(requestBinaryOnly)

describe('Font/Theme administration binary API', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        requestBinaryOnlyMock.mockResolvedValue(null as never)
    })

    it('binds the three Font GET routes to distinct typed AEDS frames', async () => {
        await getFontRegistry()
        await getFontDetail('font/a')
        await getFontActivations()

        expect(requestBinaryOnlyMock.mock.calls.map(([request]) => request)).toEqual([
            {
                binaryRoute: { operationId: 'binary_get_author_ops_fonts_registry' },
                frameType: FrameType.FontRegistryList
            },
            {
                binaryRoute: { operationId: 'binary_get_author_ops_fonts_registry_fontId', params: { fontId: 'font/a' } },
                frameType: FrameType.FontRegistryDetail
            },
            {
                binaryRoute: { operationId: 'binary_get_author_ops_fonts_activations' },
                frameType: FrameType.FontActivationList
            }
        ])
    })

    it('binds the five Theme GET routes to distinct typed AEDS frames', async () => {
        await getThemeRegistry()
        await getThemeDetail('theme/a')
        await getThemeActivations()
        await getThemeActivation('user-preview:1')
        await getThemeActivationHistory('user-preview:1')

        expect(requestBinaryOnlyMock.mock.calls.map(([request]) => request)).toEqual([
            {
                binaryRoute: { operationId: 'binary_get_author_ops_themes_registry' },
                frameType: FrameType.ThemeRegistryList
            },
            {
                binaryRoute: { operationId: 'binary_get_author_ops_themes_registry_themeId', params: { themeId: 'theme/a' } },
                frameType: FrameType.ThemeRegistryDetail
            },
            {
                binaryRoute: { operationId: 'binary_get_author_ops_themes_activations' },
                frameType: FrameType.ThemeActivationList
            },
            {
                binaryRoute: { operationId: 'binary_get_author_ops_themes_activations_scope', params: { scope: 'user-preview:1' } },
                frameType: FrameType.ThemeActivation
            },
            {
                binaryRoute: { operationId: 'binary_get_author_ops_themes_activations_scope_history', params: { scope: 'user-preview:1' } },
                frameType: FrameType.ThemeActivationHistory
            }
        ])
    })
})

function routeUrl(call: Partial<import('@/contracts/binaryTransport').BinaryTransportRequest> | undefined): string | undefined {
  const route = call?.binaryRoute
  return route ? buildFsusBinaryRoute(route.operationId, route.params, route.query) : undefined
}
