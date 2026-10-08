using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>Finite package-file or classic ZIP bytes only. No streaming authority is declared.</summary>
public enum AuthoringImportProviderCandidateInput
{
    PackageFileBytes = 0,
    ZipBytes = 1
}

/// <summary>Closed candidate-stage metadata; execution and IO grants stay with their original owners.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record AuthoringImportProviderContribution(
    [property: JsonRequired] int SchemaVersion,
    [property: JsonRequired] string ProviderId,
    [property: JsonRequired] string ExtensionId,
    [property: JsonRequired] string ExtensionVersion,
    string PackageSha256,
    [property: JsonRequired] AuthoringImportProviderCandidateInput InputKind,
    [property: JsonRequired] int InputSchemaVersion,
    [property: JsonRequired] int CandidateSchemaVersion,
    [property: JsonRequired] bool SupportsStreaming);

/// <summary>Caller assertions, never observed runtime, consent, input-read or persisted facts.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record AuthoringImportProviderCandidateAttempt(
    [property: JsonRequired] string RuntimeIdentity,
    [property: JsonRequired] string RequestId,
    [property: JsonRequired] string AttemptId,
    [property: JsonRequired] string DeclaredGrantDigest,
    [property: JsonRequired] string ExpectedPackageBytesDigest,
    string? ExpectedArchiveSha256 = null);
