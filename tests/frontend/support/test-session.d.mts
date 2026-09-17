export const TEST_SESSION_HEADER: 'X-Fsus-Test-Session'

export function sanitizeTestSession(raw: unknown): string
export function resolveWorkerTestSession(
  workerIndex: unknown,
  env?: Record<string, string | undefined>
): string
export function resolveTestSession(): string
export function testSessionHeaders(session?: string): Record<string, string>
export function withTestSessionHeaders(
  init?: Record<string, unknown>,
  session?: string
): Record<string, unknown>
