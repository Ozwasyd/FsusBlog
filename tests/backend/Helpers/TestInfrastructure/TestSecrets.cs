namespace FsusBlog.Server.Tests.TestInfrastructure;

public static class TestSecrets
{
    public const string JwtSigningKey = "TEST_ONLY_DO_NOT_DEPLOY_JWT_SECRET_0001";
    public const string SecondaryJwtSigningKey = "TEST_ONLY_DO_NOT_DEPLOY_JWT_SECRET_0002";
    public const string IntegrationJwtSigningKey = "TEST_ONLY_DO_NOT_DEPLOY_JWT_SECRET_0003";
    public const string PowSigningKey = "TEST_ONLY_DO_NOT_DEPLOY_POW_SECRET_0001";
    public const string RecoveryKeyPepper = "TEST_ONLY_DO_NOT_DEPLOY_RECOVERY_PEPPER_0001";
    public const string MfaTicketSigningKey = "TEST_ONLY_DO_NOT_DEPLOY_MFA_TICKET_SECRET_0001";
    public const string AuditTamperEvidenceKey = "TEST_ONLY_DO_NOT_DEPLOY_AUDIT_TAMPER_SECRET_0001";
    public const string SubjectHashPepper = "TEST_ONLY_DO_NOT_DEPLOY_SUBJECT_HASH_PEPPER_0001";
    public const string VisitLogIpPseudonymKey = "HyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4=";
    public const string HumanReadProofSigningKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
    public const string HumanReadProofDedupKey = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=";
    public const string ReadAnalyticsNoiseKey = "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8=";
    public const string RegionIpHashKey = "TEST_ONLY_DO_NOT_DEPLOY_REGION_IP_HASH_SECRET_0001";
    public const string ModerationPepper = "TEST_ONLY_DO_NOT_DEPLOY_MODERATION_PEPPER_0001";
    public const string SubscriptionEmailHashPepper = "TEST_ONLY_DO_NOT_DEPLOY_SUBSCRIPTION_HASH_PEPPER_0001";
    public const string MessageAdminSessionAuditReferenceKey = "TEST_ONLY_DO_NOT_DEPLOY_MESSAGE_SESSION_AUDIT_KEY_0001";
    public const string AnonymousNullifierPepper = "TEST_ONLY_DO_NOT_DEPLOY_NULLIFIER_PEPPER_0001";
    public const string AnonymousRootAttestationKey = "TEST_ONLY_DO_NOT_DEPLOY_ROOT_ATTESTATION_SECRET_0001";
}
