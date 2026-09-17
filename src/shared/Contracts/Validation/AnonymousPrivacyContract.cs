namespace FsusBlog.Shared.Contracts.Validation;

/// <summary>
/// Provides canonical privacy limits and identifiers for anonymous contracts.
/// </summary>
public static class AnonymousPrivacyContract
{
    public const string CircuitId = "fsus.anonymous.comment.v5";
    public const ushort PublicInputLayoutVersion = 6;

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
    public const int MaxRevocationArtifactEntries = 100_000;
    public const int MaxRevocationArtifactBytes = 4 * 1024 * 1024;
    public const int MaxNullifierHashBytes = 64;
    public const int MaxCredentialCommitmentBytes = 64;
    public const int MaxGroth16ProofBytes = 4096;
    public const int MaxAnonymousTicketPublicInputsBytes = 4096;
    public const int MaxCircuitMetadataBytes = 4096;
    public const int MaxCredentialLevelBytes = 32;
    public const int MaxReputationBucketBytes = 64;
    public const int MaxRateClassBytes = 16;
    public const int MaxScopeBytes = 128;
    public const int MaxActionContextBytes = 64;
    public const int MaxOpaqueTicketBytes = 512;
    public const int MaxModerationSubjectHashBytes = 64;

    public const string CommentCreateActionContext = "comment.create";
    public const string CommonRateClass = "common";
    public const string UnknownRateClass = "unknown";
}

/// <summary>
/// Provides the canonical RFC 9474 blind-credential profile identifiers.
/// </summary>
public static class Rfc9474BlindCredentialProfile
{
    public const string SchemeId = "rfc9474-rsabssa-sha384-pss-randomized-3072";
    public const string MessageDomain = "fsus.anonymous.credential.v5";
    public const int ModulusBits = 3072;
    public const int ModulusBytes = ModulusBits / 8;
    public const int HashBytes = 48;
    public const int SaltBytes = 48;
    public const int MessageRandomizerBytes = 32;
    public const int CredentialSecretBytes = 32;
    public const int CredentialNonceBytes = 32;
    public const int MaxKeyIdBytes = 128;
    public const int MaxSubjectPublicKeyInfoBytes = 512;
}
