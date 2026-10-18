using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Contracts.SchemaMigration;

/// <summary>
/// A current-schema receipt is successful only after schema and all required
/// migration postconditions have been independently observed.
/// </summary>
public enum CurrentSchemaReceiptStatus
{
    VerifiedCurrent,
    Rejected
}

/// <summary>Opaque digests binding a verified operation postcondition to its frozen step.</summary>
public sealed record CurrentSchemaStepPostcondition(
    string StepId,
    string PredicateReference,
    string ExpectedDigest,
    string ActualDigest,
    string EvidenceDigest);

/// <summary>
/// The single production migration verification receipt. This is not a test
/// materialization receipt, a release compatibility window or an apply result.
/// Its historical semantic observations do not freeze subsequent business writes.
/// </summary>
public sealed record CurrentSchemaReceipt(
    string Format,
    [property: JsonRequired] CurrentSchemaReceiptStatus Status,
    CurrentSchemaTargetIdentity Target,
    string SourceFingerprintId,
    string SourceFingerprintVersion,
    string SourceRegistryDigest,
    string SourceObservationDigest,
    CurrentSchemaArtifactReference Plan,
    CurrentSchemaArtifactReference Apply,
    ImmutableArray<CurrentSchemaArtifactReference> Checkpoints,
    CurrentSchemaDatabaseIdentity Database,
    string ActualSchemaDigest,
    ImmutableArray<CurrentSchemaStepPostcondition> SemanticPostconditions,
    CurrentSchemaArtifactReference BackupPackage,
    CurrentSchemaArtifactReference BackupManifest,
    CurrentSchemaArtifactReference RestoreDrill,
    ImmutableArray<CurrentSchemaArtifactReference> RecoveryReferences,
    CurrentSchemaVerifierIdentity Verifier,
    ImmutableArray<string> Reasons,
    string ContentDigest);

/// <summary>
/// Fresh read-only startup observations. The target's source digest identifies
/// schema source; it is distinct from the receipt producer's source revision.
/// </summary>
public sealed record CurrentSchemaAdmissionObservation(
    CurrentSchemaTargetIdentity Target,
    CurrentSchemaDatabaseIdentity Database,
    string ActualSchemaDigest);

/// <summary>
/// Canonical receipt bytes and structural integrity only. A matching digest or
/// verified-current status does not prove a database observation or authorize startup.
/// </summary>
public static class CurrentSchemaReceiptCodec
{
    /// <summary>The closed current-only receipt format accepted by this codec.</summary>
    public const string Format = "fsusblog.current-schema-receipt.v1";
    /// <summary>Bounds the artifact before parsing or emitting receipt JSON.</summary>
    public const int MaximumEncodedBytes = 1024 * 1024;

    private static readonly UTF8Encoding s_strictUtf8 = new(false, true);
    private static readonly JsonSerializerOptions s_json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 32,
        Converters = { new ReceiptStatusConverter() }
    };

    /// <summary>Emits bounded canonical bytes only after the receipt's structural seal is valid.</summary>
    public static byte[] Serialize(CurrentSchemaReceipt receipt)
    {
        ValidateIntegrity(receipt);
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(receipt, s_json);
        if (bytes.Length > MaximumEncodedBytes)
        {
            throw new InvalidOperationException("current_receipt_size_exceeded");
        }
        return bytes;
    }

    /// <summary>Rejects oversized, ambiguous, unknown-field or incorrectly sealed receipt JSON.</summary>
    public static CurrentSchemaReceipt Deserialize(ReadOnlyMemory<byte> bytes)
    {
        if (bytes.Length == 0 || bytes.Length > MaximumEncodedBytes)
        {
            throw new InvalidOperationException("current_receipt_size_invalid");
        }
        try
        {
            using JsonDocument document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 32 });
            RejectDuplicateMembers(document.RootElement);
            CurrentSchemaReceipt receipt = JsonSerializer.Deserialize<CurrentSchemaReceipt>(bytes.Span, s_json)
                ?? throw new JsonException("Receipt is null.");
            ValidateIntegrity(receipt);
            return receipt;
        }
        catch (JsonException exception)
        {
            throw new InvalidOperationException("current_receipt_json_invalid", exception);
        }
    }

    /// <summary>Hashes the canonical payload with its own digest field empty; this is not an artifact hash.</summary>
    public static string ComputeContentDigest(CurrentSchemaReceipt receipt)
        => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(
            receipt with
            {
                ContentDigest = string.Empty
            }, s_json))).ToLowerInvariant();

    /// <summary>Checks closed shape and payload integrity without asserting database truth or provenance.</summary>
    public static void ValidateIntegrity(CurrentSchemaReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        if (receipt.Format != Format || !Enum.IsDefined(receipt.Status)
            || receipt.Target is null || receipt.Database is null || receipt.Verifier is null
            || receipt.Checkpoints.IsDefaultOrEmpty || receipt.SemanticPostconditions.IsDefaultOrEmpty
            || receipt.RecoveryReferences.IsDefault || receipt.Reasons.IsDefault)
        {
            throw new InvalidOperationException("current_receipt_shape_invalid");
        }

        ValidateTarget(receipt.Target);
        ValidateDatabase(receipt.Database);
        RequireText(receipt.SourceFingerprintId);
        RequireText(receipt.SourceFingerprintVersion);
        RequireDigest(receipt.SourceRegistryDigest);
        RequireDigest(receipt.SourceObservationDigest);
        RequireDigest(receipt.ActualSchemaDigest);
        RequireReference(receipt.Plan);
        RequireReference(receipt.Apply);
        RequireReference(receipt.BackupPackage);
        RequireReference(receipt.BackupManifest);
        RequireReference(receipt.RestoreDrill);
        ValidateReferences(receipt.Checkpoints);
        ValidateReferences(receipt.RecoveryReferences);
        RequireHex(receipt.Verifier.SourceRevision, 40);
        RequireDigest(receipt.Verifier.WorktreeDigest);
        RequireDigest(receipt.Verifier.ToolchainDigest);
        RequireDigest(receipt.Verifier.ConfigurationDigest);

        var steps = new HashSet<string>(StringComparer.Ordinal);
        foreach (CurrentSchemaStepPostcondition postcondition in receipt.SemanticPostconditions)
        {
            if (postcondition is null || !steps.Add(postcondition.StepId))
            {
                throw new InvalidOperationException("current_receipt_semantic_vector_invalid");
            }
            RequireText(postcondition.StepId);
            RequireText(postcondition.PredicateReference);
            RequireDigest(postcondition.ExpectedDigest);
            RequireDigest(postcondition.ActualDigest);
            RequireDigest(postcondition.EvidenceDigest);
            if (receipt.Status == CurrentSchemaReceiptStatus.VerifiedCurrent
                && postcondition.ExpectedDigest != postcondition.ActualDigest)
            {
                throw new InvalidOperationException("current_receipt_postcondition_failed");
            }
        }

        foreach (string reason in receipt.Reasons)
        {
            RequireText(reason);
            if (reason.Any(character => character is not (>= 'a' and <= 'z')
                    and not (>= '0' and <= '9') and not '_'))
            {
                throw new InvalidOperationException("current_receipt_reason_invalid");
            }
        }
        if ((receipt.Status == CurrentSchemaReceiptStatus.VerifiedCurrent && receipt.Reasons.Length != 0)
            || (receipt.Status == CurrentSchemaReceiptStatus.Rejected && receipt.Reasons.Length == 0))
        {
            throw new InvalidOperationException("current_receipt_status_reasons_invalid");
        }
        RequireDigest(receipt.ContentDigest);
        if (receipt.ContentDigest != ComputeContentDigest(receipt))
        {
            throw new InvalidOperationException("current_receipt_digest_mismatch");
        }
    }

    /// <summary>Requires complete version and digest fields, without deriving a target from a receipt.</summary>
    public static void ValidateTarget(CurrentSchemaTargetIdentity target)
    {
        ArgumentNullException.ThrowIfNull(target);
        RequireText(target.ModelVersion);
        RequireText(target.ExtractorVersion);
        RequireText(target.GeneratorVersion);
        RequireDigest(target.SourceDigest);
        RequireDigest(target.ContentDigest);
    }

    /// <summary>Requires a closed provider and explicit native instance/database identity.</summary>
    public static void ValidateDatabase(CurrentSchemaDatabaseIdentity database)
    {
        ArgumentNullException.ThrowIfNull(database);
        if (!Enum.IsDefined(database.Provider))
        {
            throw new InvalidOperationException("current_receipt_provider_unknown");
        }
        RequireText(database.InstanceId);
        RequireText(database.DatabaseId);
    }

    private static void ValidateReferences(ImmutableArray<CurrentSchemaArtifactReference> references)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (CurrentSchemaArtifactReference reference in references)
        {
            RequireReference(reference);
            if (!names.Add(reference.Reference))
            {
                throw new InvalidOperationException("current_receipt_reference_duplicate");
            }
        }
    }

    private static void RequireReference(CurrentSchemaArtifactReference reference)
    {
        if (reference is null)
        {
            throw new InvalidOperationException("current_receipt_reference_missing");
        }
        RequireText(reference.Reference);
        if (reference.Reference.Split('/', '\\').Any(
            component => component.Equals("latest", StringComparison.OrdinalIgnoreCase)))
        {
            throw new InvalidOperationException("current_receipt_latest_reference_forbidden");
        }
        RequireDigest(reference.Sha256);
    }

    private static void RequireText(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value != value.Trim() || value.Any(char.IsControl))
        {
            throw new InvalidOperationException("current_receipt_text_invalid");
        }
        _ = s_strictUtf8.GetByteCount(value);
    }

    /// <summary>Requires an exact lowercase SHA-256 representation; equality does not prove an observation.</summary>
    public static void RequireDigest(string? value) => RequireHex(value, 64);

    private static void RequireHex(string? value, int length)
    {
        if (value is null || value.Length != length
            || value.Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
        {
            throw new InvalidOperationException("current_receipt_digest_invalid");
        }
    }

    private static void RejectDuplicateMembers(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!names.Add(property.Name))
                {
                    throw new JsonException("Duplicate receipt member.");
                }
                RejectDuplicateMembers(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement child in element.EnumerateArray())
            {
                RejectDuplicateMembers(child);
            }
        }
    }

    private sealed class ReceiptStatusConverter : JsonConverter<CurrentSchemaReceiptStatus>
    {
        public override CurrentSchemaReceiptStatus Read(
            ref Utf8JsonReader reader,
            Type typeToConvert,
            JsonSerializerOptions options)
            => reader.TokenType == JsonTokenType.String
                ? reader.GetString() switch
                {
                    "verified-current" => CurrentSchemaReceiptStatus.VerifiedCurrent,
                    "rejected" => CurrentSchemaReceiptStatus.Rejected,
                    _ => throw new JsonException("Unknown receipt status.")
                }
                : throw new JsonException("Receipt status must be a closed string.");

        public override void Write(
            Utf8JsonWriter writer,
            CurrentSchemaReceiptStatus value,
            JsonSerializerOptions options)
            => writer.WriteStringValue(value switch
            {
                CurrentSchemaReceiptStatus.VerifiedCurrent => "verified-current",
                CurrentSchemaReceiptStatus.Rejected => "rejected",
                _ => throw new JsonException("Unknown receipt status.")
            });
    }
}
