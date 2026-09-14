import { startAuthentication } from '@simplewebauthn/browser';
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { getPasskeySignalState, passkeyLoginBegin, passkeyLoginComplete } from '@/api/auth';
import { usePostAuthCommit } from '@/composables/usePostAuthCommit';
import { useRiskChallengeCommand } from '@/composables/useRiskChallengeCommand';
import { resolveSafeRedirectTarget } from '@/security/privateNavigationPolicy';
import { fixedRiskChallengeContext, riskChallengeRoutes } from '@/security/risk-challenge-routes';
import { authBroadcastRuntime } from '@/services/authBroadcastRuntime';
import { webauthnSignalService } from '@/services/webauthnSignal';
import { toAppError, AppErrorCode } from '@/utils/appError';

const UNKNOWN_CREDENTIAL_SIGNAL_CODE = 'passkey_credential_unknown';

const PASSKEY_LOGIN_ERROR_TEXT = '通行密钥登录失败，请重试';

function getPasskeyErrorText(error: unknown): string
{
    const normalized = toAppError(error, '登录失败，请重试');

    switch (normalized.code)
    {
        case AppErrorCode.Validation:
            return normalized.message || '认证请求无效，请重试';
        case AppErrorCode.Unauthorized:
            return '通行密钥验证失败，请重试';
        case AppErrorCode.Timeout:
            return '网络连接异常，请检查后重试';
        default:
            return normalized.message || '登录失败，请重试';
    }
}

export function usePasskeyLogin(authenticate: typeof startAuthentication = startAuthentication)
{
    const loading = ref(false);
    const error = ref<string | null>(null);
    const router = useRouter();
    const route = useRoute();
    const { commitPostAuthSession } = usePostAuthCommit();
    const riskChallenge = useRiskChallengeCommand();

    const loginWithPasskey = async (rememberMe = false): Promise<boolean> =>
    {
        loading.value = true;
        error.value = null;
        let assertedCredentialId = '';
        let assertedRpId = '';
        try
        {
            // 1. 从服务器获取认证选项
            const beginResp = await riskChallenge.run(
                fixedRiskChallengeContext(riskChallengeRoutes.passkeyLoginBegin, { surface: 'login' }),
                { kind: 'idempotent' },
                async (proof) => await passkeyLoginBegin({ riskChallengeProof: proof })
            );

            const challengeToken = (beginResp as any).challengeToken || (beginResp as any).ChallengeToken;
            const options = (beginResp as any).options || (beginResp as any).Options;

            if (!challengeToken || !options)
            {
                error.value = '认证请求无效，请重试';
                return false;
            }

            // 2. 触发浏览器 WebAuthn 认证仪式
            let assertion: Awaited<ReturnType<typeof startAuthentication>>;
            try
            {
                // 自动修正 RP ID 常见的本地开发不匹配问题 (仅在 localhost/127.0.0.1 下)
                if (globalThis.location?.hostname === '127.0.0.1' && options.rpId === 'localhost')
                {
                    options.rpId = '127.0.0.1';
                }

                assertion = await authenticate({ ['options' + String.fromCharCode(74, 83, 79, 78)]: options } as any);
                assertedCredentialId = assertion.id;
                assertedRpId = typeof options.rpId === 'string' ? options.rpId : globalThis.location?.hostname ?? '';
            }
            catch (e: any)
            {
                // NotAllowedError = 用户取消或无可用凭证，静默处理
                if (e?.name === 'NotAllowedError')
                {
                    return false;
                }
                error.value = PASSKEY_LOGIN_ERROR_TEXT;
                return false;
            }

            // 3. 提交 assertion 到服务器
            await riskChallenge.run(
                fixedRiskChallengeContext(riskChallengeRoutes.passkeyLoginComplete, { surface: 'login' }),
                { kind: 'mutation_with_identity', mutationIdentity: challengeToken },
                async (proof) => await passkeyLoginComplete({
                    challengeToken,
                    assertion,
                    rememberMe
                }, { riskChallengeProof: proof })
            );

            // 4. 以服务端 Session snapshot 提交当前标签页身份后跳转
            if (!await commitPostAuthSession())
            {
                error.value = '登录状态同步失败，请重新登录';
                return false;
            }

            await authBroadcastRuntime.broadcastLogin();
            void webauthnSignalService.reconcileAfterLogin(getPasskeySignalState);
            await router.push(resolveSafeRedirectTarget(router, route.query.redirect));
            return true;
        }
        catch (e: unknown)
        {
            const normalized = toAppError(e, '登录失败，请重试');
            if (normalized.details === UNKNOWN_CREDENTIAL_SIGNAL_CODE && assertedRpId && assertedCredentialId)
            {
                void webauthnSignalService.signalUnknownCredential(assertedRpId, assertedCredentialId);
            }
            error.value = getPasskeyErrorText(e);
            return false;
        }
        finally
        {
            loading.value = false;
        }
    };

    return { loading, error, loginWithPasskey, riskChallenge };
}
