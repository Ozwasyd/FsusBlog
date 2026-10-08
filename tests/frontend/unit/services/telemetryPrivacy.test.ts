import { describe, expect, it } from 'vitest'
import {
  BINARY_FAILURE_TELEMETRY_FIELDS,
  createBinaryFailureTelemetryDetail,
  redactConsoleArguments
} from '@/services/telemetryPrivacy'

describe('telemetry privacy boundary', () => {
  it.each([['public','binary_get_category'], ['account','binary_get_auth_me'], ['admin','binary_get_admin_article']] as const)('keeps the stable %s route class without request identity', (routeClass, operationId) => {
    const detail = createBinaryFailureTelemetryDetail({
      operationId,
      routeClass: 'public',
      status: 503,
      kind: 'network',
      frameType: 163,
      url: `/api/private/${routeClass}?session_id=secret`
    } as never)

    expect(detail.routeClass).toBe(routeClass)
    expect(JSON.stringify(detail)).not.toContain('/api/private')
  })

  it('projects hostile binary failures onto the categorical allowlist', () => {
    const detail = createBinaryFailureTelemetryDetail({
      operationId: 'binary_get_auth_me',
      routeClass: 'account',
      status: 401,
      backendCode: 7,
      kind: 'auth_failed',
      backendCategory: 2,
      frameType: 163,
      url: '/api/binary/auth/me?token=secret-token',
      details: 'private message body',
      traceId: 'trace-account-42',
      accountId: 42
    } as never)

    expect(Object.keys(detail)).toEqual(BINARY_FAILURE_TELEMETRY_FIELDS)
    expect(detail).toMatchInlineSnapshot(`
      {
        "category": 2,
        "errorCode": 7,
        "frameType": 163,
        "operationId": "binary_get_auth_me",
        "routeClass": "account",
        "status": 401,
      }
    `)
    expect(JSON.stringify(detail)).not.toMatch(/secret-token|private message body|trace-account-42|accountId|\/api\//)
  })

  it('reduces console errors to stable categorical fields', () => {
    const error = Object.assign(new Error('Recovery Key ABCD-EFGH private body'), {
      kind: 'auth_failed',
      status: 401,
      traceId: 'trace-secret',
      details: 'message body'
    })

    const args = redactConsoleArguments(['[BinaryTransport] failure', error, 'private article body'])

    expect(JSON.stringify(args)).not.toMatch(/ABCD-EFGH|private body|trace-secret|message body|private article body/)
    expect(args).toMatchObject([
      '[BinaryTransport] failure',
      { name: 'Error', kind: 'auth_failed', status: 401 },
      '[REDACTED]'
    ])
  })
})
