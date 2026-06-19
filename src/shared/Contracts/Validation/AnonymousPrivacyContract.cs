namespace FsusBlog.Shared.Contracts.Validation;

public static class AnonymousPrivacyContract
{
    public const string CircuitId = "fsus.anonymous.comment.v1";
    public const ushort PublicInputLayoutVersion = 2;

    public const int MaxBbsBlindedCommitmentBytes = 256;
    public const int MaxBbsSignatureBytes = 256;
    public const int MaxClientNonceBytes = 128;
    public const int MaxIssuerPublicKeyIdBytes = 128;
    public const int MaxIssuerPublicKeyHashBytes = 128;
    public const int MaxVerifyingKeyHashBytes = 128;
    public const int MaxCredentialRootBytes = 64;
    public const int MaxRevocationRootBytes = 64;
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
