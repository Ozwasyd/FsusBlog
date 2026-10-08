import type { SecurityChallengeKind as SecurityChallengeKindValue } from '@/contracts/binaryApi';
import { securityChallengeKindWireNames } from '@/contracts/securityRiskPolicyCatalog.generated';

export function securityChallengeKindWireName(kind: SecurityChallengeKindValue): string
{
    return securityChallengeKindWireNames[kind] ?? securityChallengeKindWireNames[0];
}
