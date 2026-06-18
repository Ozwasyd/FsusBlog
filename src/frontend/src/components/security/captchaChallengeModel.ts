import {
  SecurityChallengeKind,
  type SecurityChallengeAssignment,
  type SecurityChallengeIssueResponse
} from '@/api/security'
import type { CaptchaWorkerSolveResult } from '@/services/securityCaptchaClient'
import { getErrorMessage } from '@/utils/errors'

export function selectCaptchaChallenge(response: SecurityChallengeIssueResponse): {
  assignment: SecurityChallengeAssignment
  payload: Record<string, string>
} {
  const assignment = response.envelope?.assignments.find((item) => item.kind === SecurityChallengeKind.CaptchaV1)
  if (!assignment) {
    throw new Error('captcha_assignment_missing')
  }
  const providerPayload = response.providerPayloads.find((item) => item.challengeId === assignment.challengeId)
  if (!providerPayload) {
    throw new Error('captcha_provider_payload_missing')
  }
  return { assignment, payload: providerPayload.payload }
}

export function buildCaptchaVerifyProviderPayload(
  payload: Record<string, string>,
  answerText: string,
  proof: CaptchaWorkerSolveResult,
  solveDurationMs: number
): Record<string, string> {
  return {
    ...payload,
    answerText: answerText.trim().toUpperCase(),
    responseTokenHex: proof.responseTokenHex,
    nonceHex: proof.nonceHex,
    solveDurationMs: String(Math.max(0, Math.round(solveDurationMs)))
  }
}

export function mapCaptchaErrorMessage(error: unknown): string {
  const raw = getErrorMessage(error, '验证码加载失败，请刷新重试')
  if (raw.includes('captcha_wasm_load_failed')) {
    return '图形校验引擎加载失败，请刷新重试。'
  }
  if (raw.includes('captcha_worker_unavailable') || raw.includes('captcha_worker_failed')) {
    return '图形校验暂时不可用，请刷新重试。'
  }
  if (raw.includes('captcha_assignment_missing') || raw.includes('captcha_provider_payload_missing')) {
    return '验证码数据异常，请刷新重试。'
  }
  return raw
}
