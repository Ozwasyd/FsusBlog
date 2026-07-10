import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveTestSession,
  resolveTestSessionFixtureFile,
  testSessionHeaders,
  TEST_SESSION_HEADER,
  withTestSessionContextOptions
} from '../support/playwright/testSession'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
})

describe('test session helpers', () => {
  it('stays disabled without isolation env', () => {
    delete process.env.FSUSBLOG_TEST_SESSION
    delete process.env.FSUSBLOG_TEST_SESSION_ISOLATION
    expect(resolveTestSession()).toBeUndefined()
    expect(testSessionHeaders()).toEqual({})
  })

  it('normalizes configured session ids into the accepted header shape', () => {
    process.env.FSUSBLOG_TEST_SESSION = 'PW Worker 01!'
    expect(resolveTestSession()).toBe('pw-worker-01')
    expect(testSessionHeaders()).toEqual({
      [TEST_SESSION_HEADER]: 'pw-worker-01'
    })
  })

  it('falls back to worker index when isolation is enabled without explicit session', () => {
    process.env.FSUSBLOG_TEST_SESSION_ISOLATION = '1'
    process.env.TEST_PARALLEL_INDEX = '3'
    expect(resolveTestSession()).toBe('pw-3')
  })

  it('falls back to TEST_WORKER_INDEX when TEST_PARALLEL_INDEX is missing', () => {
    process.env.FSUSBLOG_TEST_SESSION_ISOLATION = '1'
    delete process.env.TEST_PARALLEL_INDEX
    process.env.TEST_WORKER_INDEX = '7'
    expect(resolveTestSession()).toBe('pw-7')
  })

  it('falls back to worker index 0 when both worker env vars are missing', () => {
    process.env.FSUSBLOG_TEST_SESSION_ISOLATION = '1'
    delete process.env.TEST_PARALLEL_INDEX
    delete process.env.TEST_WORKER_INDEX
    expect(resolveTestSession()).toBe('pw-0')
  })

  it('returns default-safe session when input sanitization becomes invalid', () => {
    process.env.FSUSBLOG_TEST_SESSION = '----'
    expect(resolveTestSession()).toBe('pw-0')
  })

  it('merges session headers into browser context options', () => {
    process.env.FSUSBLOG_TEST_SESSION = 'worker-A'
    const options = withTestSessionContextOptions({
      extraHTTPHeaders: {
        'X-Existing': '1'
      }
    })

    expect(options.extraHTTPHeaders).toEqual({
      'X-Existing': '1',
      [TEST_SESSION_HEADER]: 'worker-a'
    })
  })

  it('creates extraHTTPHeaders when options headers are missing', () => {
    process.env.FSUSBLOG_TEST_SESSION = 'worker-b'
    const options = withTestSessionContextOptions({})
    expect(options.extraHTTPHeaders).toEqual({
      [TEST_SESSION_HEADER]: 'worker-b'
    })
  })

  it('does not mutate options when no test session is active', () => {
    delete process.env.FSUSBLOG_TEST_SESSION
    delete process.env.FSUSBLOG_TEST_SESSION_ISOLATION
    const original = { locale: 'en-US' }
    expect(withTestSessionContextOptions(original)).toBe(original)
  })

  it('resolves fixture file path when session exists', () => {
    process.env.FSUSBLOG_TEST_SESSION = 'worker 9'
    const file = resolveTestSessionFixtureFile('/tmp/example')
    expect(file).toBe('/tmp/example/.tmp/fixtures/local/sessions/worker-9.aeds')
  })

  it('returns undefined fixture path when session is disabled', () => {
    delete process.env.FSUSBLOG_TEST_SESSION
    delete process.env.FSUSBLOG_TEST_SESSION_ISOLATION
    expect(resolveTestSessionFixtureFile('/tmp/example')).toBeUndefined()
  })
})
