namespace FsusBlog.Shared.Contracts.Validation;

public static class AnonymousPrivacyContract
{
    public const string CircuitId = "fsus.anonymous.comment.v2";
    public const ushort PublicInputLayoutVersion = 3;

    public const int MaxCircuitNativeCredentialRequestBytes = 256;
    public const int MaxCircuitNativeIssuerSignatureBytes = 256;
    public const int MaxClientNonceBytes = 128;
    public const int MaxIssuerPublicKeyIdBytes = 128;
    public const int MaxIssuerPublicKeyHashBytes = 128;
    public const int MaxVerifyingKeyHashBytes = 128;
    public const int MaxCredentialRootBytes = 64;
    public const int MaxRevocationRootBytes = 64;
    public const int MaxRevocationHandleHashBytes = 64;
    public const int MaxRevocationWitnessHashBytes = 64;
    public const int MaxRevocationWitnessLeafKeyBytes = 32;
    public const int MaxRevocationWitnessPathDepth = 128;
    public const int MaxRevocationWitnessSiblingHashesBytes = MaxRevocationWitnessPathDepth * 32;
    public const int MaxRevocationWitnessAlgorithmIdBytes = 64;
    public const int MaxNullifierHashBytes = 64;
    public const int MaxGroth16ProofBytes = 4096;
    public const int MaxAnonymousTicketPublicInputsBytes = 4096;
    public const int MaxCircuitMetadataBytes = 4096;
    public const int MaxCredentialLevelBytes = 32;
    public const int MaxReputationBucketBytes = 64;
    public const int MaxScopeBytes = 128;
    public const int MaxActionContextBytes = 64;
    public const int MaxOpaqueTicketBytes = 512;
    public const int MaxModerationSubjectHashBytes = 64;

    public const string CommentCreateActionContext = "comment.create";
}
