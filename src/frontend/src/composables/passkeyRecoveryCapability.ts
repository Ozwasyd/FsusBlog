export interface PasskeyRecoveryCredential {
    backupEligible: boolean;
}

export const shouldSuggestPasskeyRecovery = (
    credentials: readonly PasskeyRecoveryCredential[],
    recoveryEnabled: boolean
): boolean => credentials.length === 1
  && credentials[0]?.backupEligible === false
  && !recoveryEnabled;
