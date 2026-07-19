import { SecurityChallengeKind, type SecurityChallengeKind as SecurityChallengeKindValue } from '@/contracts/binaryApi'

export function securityChallengeKindWireName(kind: SecurityChallengeKindValue): string {
  switch (kind) {
    case SecurityChallengeKind.Sha256PowV1:
      return 'sha256PowV1'
    case SecurityChallengeKind.Argon2IdPoSpaceV1:
      return 'argon2idPoSpaceV1'
    case SecurityChallengeKind.CaptchaV1:
      return 'captchaV1'
    case SecurityChallengeKind.HumanReadProofV1:
      return 'humanReadProofV1'
    case SecurityChallengeKind.PasskeyStepUpV1:
      return 'passkeyStepUpV1'
    case SecurityChallengeKind.AdminPasskeyStepUpV1:
      return 'adminPasskeyStepUpV1'
    case SecurityChallengeKind.RecoveryKeyProofV1:
      return 'recoveryKeyProofV1'
    case SecurityChallengeKind.AnonymousCredentialProofV1:
      return 'anonymousCredentialProofV1'
    case SecurityChallengeKind.ZkAnonymousCommentProofV1:
      return 'zkAnonymousCommentProofV1'
    case SecurityChallengeKind.PerceptionCharacterV2:
      return 'perceptionCharacterV2'
    case SecurityChallengeKind.PerceptionLocalizationV2:
      return 'perceptionLocalizationV2'
    case SecurityChallengeKind.PerceptionMicroInteractionV2:
      return 'perceptionMicroInteractionV2'
    case SecurityChallengeKind.PerceptionTextTaskV2:
      return 'perceptionTextTaskV2'
    default:
      return 'unknown'
  }
}

