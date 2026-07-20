import {
  SecurityChallengeKind,
  type SecurityChallengeKind as SecurityChallengeKindValue
} from '@/contracts/binaryApi'
import { securityChallengeKindWireName } from './challenge-kind-wire'

export const SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION = '2026.07.20.4'

export type ChallengeExecutionMode = 'ui' | 'headless'
export type ChallengeUiHost = 'captcha' | 'perception' | 'pospace' | 'sha256-pow'
export type ChallengeHeadlessHost = 'notification-sha256-pow' | 'notification-pospace'
export type ChallengeExecutorMode = ChallengeExecutionMode | 'universal'
export type ChallengeKindGroup = 'captcha' | 'pow' | 'pospace' | 'passkey' | 'perception' | 'unsupported'

export interface ChallengeExecutorRegistration {
  readonly id: string
  readonly mode: ChallengeExecutorMode
  readonly loadExecutor: () => Promise<unknown>
}

export interface ChallengeCapabilityRegistration {
  readonly kind: SecurityChallengeKindValue
  readonly wireName: string
  readonly group: ChallengeKindGroup
  readonly kindKnown: boolean
  readonly providerAvailable: boolean
  readonly executorFactory: (() => ChallengeExecutorRegistration) | null
  readonly uiHost: ChallengeUiHost | null
  readonly headlessHost: ChallengeHeadlessHost | null
  readonly cancellable: boolean
  readonly surfaces: readonly string[]
}

export interface ChallengeCapabilityResolution extends ChallengeCapabilityRegistration {
  readonly manifestCompatible: boolean
  readonly executorAvailable: boolean
  readonly hostAvailable: boolean
  readonly policyEligible: boolean
  readonly unavailableReason: 'kind_unknown' | 'provider_unavailable' | 'version_incompatible' | 'executor_unavailable' | 'host_unavailable' | null
}

export interface ResolveChallengeCapabilityOptions {
  readonly action: string
  readonly mode?: ChallengeExecutionMode
  readonly manifestVersion?: string
  readonly providerAvailable?: boolean
}

const executor = (id: string, mode: ChallengeExecutorMode, loadExecutor: () => Promise<unknown>) =>
  (): ChallengeExecutorRegistration => Object.freeze({ id, mode, loadExecutor })

const registrations = [
  registration(SecurityChallengeKind.Unknown, 'unsupported', false, false, null, null, null, false, []),
  registration(SecurityChallengeKind.Sha256PowV1, 'pow', true, true, executor('sha256-pow-v1', 'universal', () => import('@/composables/usePow')), 'sha256-pow', 'notification-sha256-pow', true, ['*']),
  registration(SecurityChallengeKind.Argon2IdPoSpaceV1, 'pospace', true, true, executor('pospace-v1', 'universal', () => import('@/services/securityPoSpaceChallengeExecutor')), 'pospace', 'notification-pospace', true, ['*']),
  registration(SecurityChallengeKind.CaptchaV1, 'captcha', true, true, executor('captcha-v1', 'ui', () => import('@/components/security/FsusCaptchaChallenge.vue')), 'captcha', null, false, ['*']),
  registration(SecurityChallengeKind.HumanReadProofV1, 'pow', true, true, null, null, null, false, []),
  registration(SecurityChallengeKind.PasskeyStepUpV1, 'passkey', true, true, null, null, null, false, []),
  registration(SecurityChallengeKind.AdminPasskeyStepUpV1, 'passkey', true, true, null, null, null, false, []),
  registration(SecurityChallengeKind.RecoveryKeyProofV1, 'passkey', true, false, null, null, null, false, []),
  registration(SecurityChallengeKind.AnonymousCredentialProofV1, 'passkey', true, false, null, null, null, false, []),
  registration(SecurityChallengeKind.ZkAnonymousCommentProofV1, 'passkey', true, false, null, null, null, false, []),
  registration(SecurityChallengeKind.PerceptionCharacterV2, 'perception', true, false, executor('perception-v2', 'ui', () => import('@/services/securityPerceptionChallengeFlow')), 'perception', null, true, ['*']),
  registration(SecurityChallengeKind.PerceptionLocalizationV2, 'perception', true, true, executor('perception-v2', 'ui', () => import('@/services/securityPerceptionChallengeFlow')), 'perception', null, true, ['*']),
  registration(SecurityChallengeKind.PerceptionMicroInteractionV2, 'perception', true, true, executor('perception-v2', 'ui', () => import('@/services/securityPerceptionChallengeFlow')), 'perception', null, true, ['*']),
  registration(SecurityChallengeKind.PerceptionTextTaskV2, 'perception', true, true, executor('perception-v2', 'ui', () => import('@/services/securityPerceptionChallengeFlow')), 'perception', null, true, ['*']),
  registration(SecurityChallengeKind.PerceptionCharacterV3, 'perception', true, true, executor('perception-character-v3', 'ui', () => import('@/services/securityPerceptionCharacterV3Flow')), 'perception', null, true, ['*'])
] as const satisfies readonly ChallengeCapabilityRegistration[]

const byKind = new Map<SecurityChallengeKindValue, ChallengeCapabilityRegistration>(
  registrations.map((item) => [item.kind, Object.freeze(item)])
)

export const securityChallengeCapabilityManifest: readonly ChallengeCapabilityRegistration[] = Object.freeze([...registrations])

export function getChallengeCapabilityRegistration(kind: SecurityChallengeKindValue): ChallengeCapabilityRegistration {
  return byKind.get(kind) ?? byKind.get(SecurityChallengeKind.Unknown)!
}

export function resolveChallengeCapability(
  kind: SecurityChallengeKindValue,
  options: ResolveChallengeCapabilityOptions
): ChallengeCapabilityResolution {
  const registration = getChallengeCapabilityRegistration(kind)
  const mode = options.mode ?? 'ui'
  const manifestCompatible = !options.manifestVersion
    || options.manifestVersion === SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION
  const providerAvailable = options.providerAvailable ?? registration.providerAvailable
  const executorRegistration = registration.executorFactory?.() ?? null
  const executorAvailable = executorRegistration?.mode === mode || executorRegistration?.mode === 'universal'
  const surfaceAvailable = registration.surfaces.includes('*') || registration.surfaces.includes(options.action)
  const hostAvailable = surfaceAvailable && (mode === 'ui' ? registration.uiHost !== null : registration.headlessHost !== null)
  const policyEligible = registration.kindKnown
    && providerAvailable
    && manifestCompatible
    && executorAvailable
    && hostAvailable

  let unavailableReason: ChallengeCapabilityResolution['unavailableReason'] = null
  if (!registration.kindKnown) unavailableReason = 'kind_unknown'
  else if (!providerAvailable) unavailableReason = 'provider_unavailable'
  else if (!manifestCompatible) unavailableReason = 'version_incompatible'
  else if (!executorAvailable) unavailableReason = 'executor_unavailable'
  else if (!hostAvailable) unavailableReason = 'host_unavailable'

  return Object.freeze({
    ...registration,
    providerAvailable,
    manifestCompatible,
    executorAvailable,
    hostAvailable,
    policyEligible,
    unavailableReason
  })
}

function registration(
  kind: SecurityChallengeKindValue,
  group: ChallengeKindGroup,
  kindKnown: boolean,
  providerAvailable: boolean,
  executorFactory: ChallengeCapabilityRegistration['executorFactory'],
  uiHost: ChallengeUiHost | null,
  headlessHost: ChallengeHeadlessHost | null,
  cancellable: boolean,
  surfaces: readonly string[]
): ChallengeCapabilityRegistration {
  return {
    kind,
    wireName: securityChallengeKindWireName(kind),
    group,
    kindKnown,
    providerAvailable,
    executorFactory,
    uiHost,
    headlessHost,
    cancellable,
    surfaces
  }
}
