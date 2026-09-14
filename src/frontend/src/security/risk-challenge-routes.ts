import type { SecurityChallengeContext } from './challenge-client';

export const riskChallengeRoutes = Object.freeze({
    recoveryKeyVerify: Object.freeze({
        operationId: 'binary_post_auth_recovery_key_verify',
        action: 'recovery-key.verify',
        routeKey: 'recovery-key.verify'
    }),
    passkeyLoginBegin: Object.freeze({
        operationId: 'binary_post_auth_passkey_login_begin',
        action: 'auth.passkey.begin',
        routeKey: 'auth.passkey.begin'
    }),
    passkeyLoginComplete: Object.freeze({
        operationId: 'binary_post_auth_passkey_login_complete',
        action: 'auth.passkey.complete',
        routeKey: 'auth.passkey.complete'
    }),
    commentCreate: Object.freeze({
        operationId: 'binary_post_comment',
        action: 'comment.create',
        routeKey: 'comment.create'
    })
} as const);

export function fixedRiskChallengeContext(
    route: { action: string; routeKey: string; },
    attributes?: Record<string, unknown>
): SecurityChallengeContext
{
    return {
        action: route.action,
        routeKey: route.routeKey,
        attributes
    };
}
