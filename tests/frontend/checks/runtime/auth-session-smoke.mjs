#!/usr/bin/env node
import { authBinary, loginWithFixtureSessionBypass } from '../../support/auth-helpers.mjs';
import { fetchWithTimeout, probeReachable, parseTimeoutMs } from '../../support/http.mjs';

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:7568';
const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD ?? '';
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);
const baseDeviceFingerprint = process.env.FSUSBLOG_DEVICE_FP || 'auth-session-smoke-node';
const trustedOrigin = process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_DEBUG_FRONTEND_URL || baseUrl;

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function assertRefreshDenied(response, message)
{
    assert(response.status === 401 || response.status === 403, `${message}, got ${response.status}`);
}

async function callBinary(path, cookieHeader, deviceFingerprint, init = {})
{
    const method = init.method || 'GET';
    const headers = {
        ...(method === 'GET' ? {} : { Origin: trustedOrigin }),
        ...(init.headers || {})
    };
    return await authBinary(path, {
        ...init,
        headers,
        cookieHeader,
        deviceFingerprint,
        timeoutMs: requestTimeoutMs
    });
}

async function main()
{
    await probeReachable(`${baseUrl}/api/binary/auth/pow-challenge`, '[auth-session-smoke backend]', requestTimeoutMs);

    const standardFp = `${baseDeviceFingerprint}-standard`;
    const rememberFp = `${baseDeviceFingerprint}-remember`;

    const standard = await loginWithFixtureSessionBypass(userName, userPassword, false, standardFp, requestTimeoutMs);
    const standardSessionsResult = await callBinary('/api/Auth/sessions', standard.cookieHeader, standardFp);
    assert(standardSessionsResult.response.ok, `list standard sessions failed: ${standardSessionsResult.response.status}`);
    const standardSessions = standardSessionsResult.payload?.data ?? standardSessionsResult.payload ?? [];
    const currentStandardSession = standardSessions.find((item) => item.sessionId === standard.sessionId);
    assert(currentStandardSession, 'standard session not found before replacement');
    assert(currentStandardSession.isCurrent === true, 'standard session should be current before replacement');
    // Session summary contracts expose authenticationStrength (not a coarse
    // mfaVerified boolean). Fixture sessions mint legacy_unverified by default.
    assert(
        typeof currentStandardSession.authenticationStrength === 'string'
      && currentStandardSession.authenticationStrength.length > 0,
        'standard session authenticationStrength should be a non-empty string'
    );

    const remembered = await loginWithFixtureSessionBypass(userName, userPassword, true, rememberFp, requestTimeoutMs);

    const sessionsResult = await callBinary('/api/Auth/sessions', remembered.cookieHeader, rememberFp);
    assert(sessionsResult.response.ok, `list sessions failed: ${sessionsResult.response.status}`);
    const sessions = sessionsResult.payload?.data ?? sessionsResult.payload ?? [];
    assert(Array.isArray(sessions), 'sessions payload is not an array');

    const standardSession = sessions.find((item) => item.sessionId === standard.sessionId);
    const rememberedSession = sessions.find((item) => item.sessionId === remembered.sessionId);
    assert(!standardSession, 'standard session should be replaced when remember-me login becomes active');
    assert(rememberedSession, 'remember-me session not found in session list');

    assert(rememberedSession.isCurrent === true, 'remember-me session should be current when listing via remember-me cookie');
    assert(
        typeof rememberedSession.authenticationStrength === 'string'
      && rememberedSession.authenticationStrength.length > 0,
        'remember-me session authenticationStrength should be a non-empty string'
    );

    const replacedStandardRefreshResult = await callBinary('/api/Auth/refresh-token', standard.cookieHeader, standardFp, {
        method: 'POST'
    });
    assertRefreshDenied(replacedStandardRefreshResult.response, 'replaced standard session refresh should be denied');

    const refreshResult = await callBinary('/api/Auth/refresh-token', remembered.cookieHeader, rememberFp, {
        method: 'POST'
    });
    assert(refreshResult.response.ok, `remember-me refresh failed: ${refreshResult.response.status}`);

    const revokeResult = await callBinary(`/api/Auth/sessions/${encodeURIComponent(remembered.sessionId)}/revoke`, remembered.cookieHeader, rememberFp, {
        method: 'POST'
    });
    assert(revokeResult.response.ok, `revoke session failed: ${revokeResult.response.status}`);

    const revokedRefreshResult = await callBinary('/api/Auth/refresh-token', remembered.cookieHeader, rememberFp, {
        method: 'POST'
    });
    assertRefreshDenied(revokedRefreshResult.response, 'revoked session refresh should be denied');

    const logoutSession = await loginWithFixtureSessionBypass(userName, userPassword, false, `${baseDeviceFingerprint}-logout`, requestTimeoutMs);
    const logoutResult = await callBinary('/api/Auth/logout', logoutSession.cookieHeader, `${baseDeviceFingerprint}-logout`, {
        method: 'POST'
    });
    assert(logoutResult.response.ok, `logout failed: ${logoutResult.response.status}`);

    console.log('[auth-session-smoke] ok: standard session is replaced by remember-me login');
    console.log('[auth-session-smoke] ok: replaced standard session can no longer refresh');
    console.log('[auth-session-smoke] ok: remember-me session refresh succeeded before revoke');
    console.log('[auth-session-smoke] ok: revoked remember-me session can no longer refresh');
    console.log('[auth-session-smoke] ok: logout endpoint completes for authenticated session');
}

main().catch((error) =>
{
    console.error('[auth-session-smoke] fatal:', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
