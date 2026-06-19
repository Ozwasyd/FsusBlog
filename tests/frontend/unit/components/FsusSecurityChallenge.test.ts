import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('FsusSecurityChallenge host', () => {
  it('dispatches challenge kinds through the generic host without persisting proof', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/security/FsusSecurityChallenge.vue'), 'utf8')

    expect(source).toContain('FsusCaptchaChallenge')
    expect(source).toContain('FsusPowChallenge')
    expect(source).toContain('FsusPoSpaceChallenge')
    expect(source).toContain('FsusPasskeyStepUpChallenge')
    expect(source).toContain('getChallengeKindGroup')
    expect(source).toContain("kindGroup === 'pow'")
    expect(source).toContain("kindGroup === 'pospace'")
    expect(source).toContain("kindGroup === 'passkey'")
    expect(source).toContain("data-test=\"security-challenge-refresh\"")
    expect(source).toContain("data-test=\"security-challenge-unsupported\"")
    expect(source).not.toContain('localStorage')
    expect(source).not.toContain('sessionStorage')
  })

  it('keeps non-captcha branches in child challenge components', () => {
    const powSource = readFileSync(resolve(process.cwd(), 'src/components/security/FsusPowChallenge.vue'), 'utf8')
    const poSpaceSource = readFileSync(resolve(process.cwd(), 'src/components/security/FsusPoSpaceChallenge.vue'), 'utf8')
    const passkeySource = readFileSync(resolve(process.cwd(), 'src/components/security/FsusPasskeyStepUpChallenge.vue'), 'utf8')

    expect(powSource).toContain('data-fsus-pow-challenge="true"')
    expect(poSpaceSource).toContain('data-fsus-pospace-challenge="true"')
    expect(passkeySource).toContain('data-fsus-passkey-step-up-challenge="true"')
    expect(powSource).toContain('providerPayload')
    expect(poSpaceSource).toContain('providerPayload')
    expect(passkeySource).toContain('providerPayload')
  })
})
