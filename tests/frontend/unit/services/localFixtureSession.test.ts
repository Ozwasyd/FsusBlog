// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  activateLocalFixtureSession,
  buildLocalFixtureAdminUrl,
  canUseLocalFixtureSessionEnvironment,
  clearLocalFixtureSession,
  sanitizeLocalFixturePath
} from '@/services/localFixtureSession'

const developmentEnvironment = {
  hostname: 'localhost',
  dev: true,
  prod: false,
  mode: 'development'
}

describe('local fixture URL hygiene', () => {
  beforeEach(() => {
    sessionStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  it('persists activation then immediately removes only fixture query flags', () => {
    window.history.replaceState(
      { local: true },
      '',
      '/user/manage?fsusLocalFixtureLogin=1&viewport=mobile&fsusLocalFixtureAdmin=1#sessions'
    )

    expect(activateLocalFixtureSession({ environment: developmentEnvironment })).toBe(true)

    expect(sessionStorage.getItem('fsusblog_local_fixture_session')).toBe('1')
    expect(sessionStorage.getItem('fsusblog_local_fixture_admin_session')).toBe('1')
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`)
      .toBe('/user/manage?viewport=mobile#sessions')
    expect(window.history.state).toEqual({ local: true })
  })

  it('does not clean the URL when fixture storage activation fails', () => {
    window.history.replaceState(null, '', '/login?fsusLocalFixtureLogin=1&keep=1')
    const unavailableStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('storage unavailable') },
      removeItem: () => undefined
    }

    expect(activateLocalFixtureSession({
      environment: developmentEnvironment,
      storage: unavailableStorage
    })).toBe(false)
    expect(window.location.search).toBe('?fsusLocalFixtureLogin=1&keep=1')
  })

  it('sanitizes fixture flags from redirect paths without dropping allowed parameters', () => {
    expect(sanitizeLocalFixturePath(
      '/user/manage?fsusLocalFixtureLogin=1&viewport=tablet&fsusLocalFixtureAdmin=1#security',
      window.location.origin
    )).toBe('/user/manage?viewport=tablet#security')

    const endpoint = new URL(buildLocalFixtureAdminUrl(
      '/user/manage?fsusLocalFixtureLogin=1&viewport=tablet&fsusLocalFixtureAdmin=1#security'
    ))
    expect(endpoint.pathname).toBe('/api/local/auth-fixture/admin')
    expect(endpoint.searchParams.get('redirect')).toBe('/user/manage?viewport=tablet#security')
  })

  it('requires localhost, DEV, development mode, and non-PROD together', () => {
    expect(canUseLocalFixtureSessionEnvironment(developmentEnvironment)).toBe(true)
    expect(canUseLocalFixtureSessionEnvironment({ ...developmentEnvironment, hostname: 'example.com' })).toBe(false)
    expect(canUseLocalFixtureSessionEnvironment({ ...developmentEnvironment, dev: false })).toBe(false)
    expect(canUseLocalFixtureSessionEnvironment({ ...developmentEnvironment, prod: true })).toBe(false)
    expect(canUseLocalFixtureSessionEnvironment({ ...developmentEnvironment, mode: 'production' })).toBe(false)
  })

  it('clears account and admin markers during logout or test teardown', () => {
    sessionStorage.setItem('fsusblog_local_fixture_session', '1')
    sessionStorage.setItem('fsusblog_local_fixture_admin_session', '1')

    clearLocalFixtureSession()

    expect(sessionStorage.getItem('fsusblog_local_fixture_session')).toBeNull()
    expect(sessionStorage.getItem('fsusblog_local_fixture_admin_session')).toBeNull()
  })
})
