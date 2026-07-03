import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('endpoint depth runtime public unavailable contracts', () => {
  it('keeps anonymous credential root metadata unavailable as an accepted runtime outcome', () => {
    const generatorSource = readFileSync(
      fileURLToPath(new URL('../../../../tools/contracts/generate-endpoint-depth-matrix.mjs', import.meta.url)),
      'utf8'
    )
    const runtimeSource = readFileSync(
      fileURLToPath(new URL('../../../../tools/contracts/run-endpoint-depth-runtime.mjs', import.meta.url)),
      'utf8'
    )

    for (const source of [generatorSource, runtimeSource]) {
      expect(source).toContain('expectedUnavailablePublicChecks')
      expect(source).toContain('binary_get_anonymous_credential_root')
      expect(source).toContain('binary_get_anonymous_credential_circuit')
      expect(source).toContain('503')
    }
  })

  it('materializes public article routes from the bootstrap fixture ids', () => {
    const runtimeSource = readFileSync(
      fileURLToPath(new URL('../../../../tools/contracts/run-endpoint-depth-runtime.mjs', import.meta.url)),
      'utf8'
    )

    expect(runtimeSource).toContain('readPublicFixtureIds')
    expect(runtimeSource).toContain('publicFixtureIds.articleId')
    expect(runtimeSource).toContain("id: String(publicFixtureIds.articleId)")
  })
})
