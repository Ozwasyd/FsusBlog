export const TEST_SESSION_HEADER = 'X-Fsus-Test-Session';

const safeSessionPattern = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function sanitizeTestSession(raw) {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41);

  return safeSessionPattern.test(normalized) ? normalized : 'pw-0';
}

export function resolveTestSession() {
  if (process.env.FSUSBLOG_TEST_SESSION) {
    return sanitizeTestSession(process.env.FSUSBLOG_TEST_SESSION);
  }

  if (process.env.FSUSBLOG_TEST_SESSION_ISOLATION !== '1') {
    return '';
  }

  const workerIndex = process.env.TEST_PARALLEL_INDEX || process.env.TEST_WORKER_INDEX || '0';
  return sanitizeTestSession(`pw-${workerIndex}`);
}

export function testSessionHeaders(session = resolveTestSession()) {
  return session ? { [TEST_SESSION_HEADER]: session } : {};
}

export function withTestSessionHeaders(init = {}, session = resolveTestSession()) {
  const inputHeaders = init.headers instanceof Headers
    ? Object.fromEntries(init.headers.entries())
    : Array.isArray(init.headers)
      ? Object.fromEntries(init.headers)
      : { ...(init.headers || {}) };

  return {
    ...init,
    headers: {
      ...inputHeaders,
      ...testSessionHeaders(session)
    }
  };
}
