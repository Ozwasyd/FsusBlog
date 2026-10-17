using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>An ordinal key and opaque bytes owned by one exact state scope.</summary>
public sealed record AuthoringStateEntry(string Key, ImmutableArray<byte> Value);

/// <summary>A versioned, content-addressed state snapshot. Revisions never rewind.</summary>
public sealed record AuthoringStateSnapshot(
    int ContractVersion,
    AuthoringStateScope Scope,
    string PackageIdentity,
    long Revision,
    ImmutableArray<AuthoringStateEntry> Entries,
    string ContentSha256);

/// <summary>Exact current and retained-backup measurement for a separate deletion approval.</summary>
public sealed record AuthoringStateMeasurement(
    AuthoringStateScope Scope,
    long Revision,
    long Records,
    long Bytes,
    string ContentSha256);

/// <summary>
/// Version-one fenced migration. Its digest binds this complete record with an empty
/// ContentSha256, including the source snapshot digest and both expected revisions.
/// This is a new contract; it does not reinterpret the legacy migration-plan hash.
/// </summary>
public sealed record AuthoringFencedStateMigration(
    int ContractVersion,
    string PlanId,
    AuthoringStateScope From,
    AuthoringStateScope To,
    long ExpectedFromRevision,
    long ExpectedToRevision,
    string SourceContentSha256,
    long MaximumRecords,
    long MaximumBytes,
    TimeSpan MaximumDuration,
    ImmutableArray<AuthoringStateTransform> Transforms,
    string BackupReference,
    string RollbackReference,
    string ContentSha256);

/// <summary>Separate host approval binding the exact persisted deletion measurement.</summary>
public sealed record AuthoringFencedStateDeletion(
    AuthoringStateMeasurement Expected,
    string ApprovalReceiptId);

/// <summary>
/// Host-only persistence port. The host supplies verified packages and authorizes site/user
/// access. This port does not grant runtime capabilities or authenticate a caller.
/// Completion requires the host's exact durable lifecycle acceptance; restart never guesses it.
/// </summary>
public interface IAuthoringFencedExtensionStateStore : IAuthoringExtensionStateStore
{
    ValueTask InitializeAsync(VerifiedAuthoringPackage package, AuthoringStateScope scope, CancellationToken cancellationToken);
    ValueTask<AuthoringStateSnapshot> ReadAsync(VerifiedAuthoringPackage package, AuthoringStateScope scope, CancellationToken cancellationToken);
    ValueTask WriteAsync(VerifiedAuthoringPackage package, AuthoringStateScope scope, long expectedRevision, AuthoringStateEntry entry, CancellationToken cancellationToken);
    ValueTask<AuthoringStateMeasurement> MeasureAsync(VerifiedAuthoringPackage package, AuthoringStateScope scope, CancellationToken cancellationToken);
    ValueTask DeleteAsync(VerifiedAuthoringPackage package, AuthoringFencedStateDeletion approval, CancellationToken cancellationToken);
    ValueTask BackupAsync(VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, CancellationToken cancellationToken);
    ValueTask<AuthoringStateSnapshot> ApplyAsync(VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, CancellationToken cancellationToken);
    ValueTask RollbackAsync(VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, CancellationToken cancellationToken);
    ValueTask CompleteAsync(VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, CancellationToken cancellationToken);
}

/// <summary>Closed canonical encoding, ownership validation and strict transforms for state v1.</summary>
public static class AuthoringExtensionStateContract
{
    public const int MaximumRecords = 4096;
    public const int MaximumBytes = 16 * 1024 * 1024;
    public const int MaximumValueBytes = 1024 * 1024;
    public const int MaximumBackups = 32;

    private static readonly JsonSerializerOptions s_jsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 16,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false) }
    };

    public static byte[] Encode<T>(T value) => JsonSerializer.SerializeToUtf8Bytes(value, s_jsonOptions);

    public static string Digest<T>(T value) => Convert.ToHexStringLower(SHA256.HashData(Encode(value)));

    public static string ScopeId(AuthoringStateScope scope)
    {
        ValidateScope(scope);
        return Digest(new
        {
            Kind = "authoring-state-scope-v1",
            Scope = scope
        });
    }

    public static string PlanId(AuthoringFencedStateMigration plan) =>
        Digest(new
        {
            Kind = "authoring-state-plan-id-v1",
            plan.From.ExtensionId,
            plan.PlanId
        });

    public static string ComputeContentSha256(AuthoringFencedStateMigration plan)
    {
        BoundDigestInput(plan);
        return Digest(plan with
        {
            ContentSha256 = string.Empty
        });
    }

    public static AuthoringStateSnapshot Snapshot(
        AuthoringStateScope scope,
        string packageIdentity,
        long revision,
        IEnumerable<AuthoringStateEntry> entries)
    {
        ValidateScope(scope);
        Require(IsDigest(packageIdentity) && revision >= 0, "state_snapshot_identity_invalid");
        ArgumentNullException.ThrowIfNull(entries);
        ImmutableArray<AuthoringStateEntry> supplied = entries.Take(MaximumRecords + 1).ToImmutableArray();
        ValidateEntries(supplied);
        ImmutableArray<AuthoringStateEntry> copied = supplied
            .Select(static entry => entry with { Value = ImmutableArray.CreateRange(entry.Value.AsSpan().ToArray()) })
            .OrderBy(static entry => entry.Key, StringComparer.Ordinal).ToImmutableArray();
        var snapshot = new AuthoringStateSnapshot(1, scope, packageIdentity, revision, copied, string.Empty);
        return snapshot with
        {
            ContentSha256 = Digest(snapshot)
        };
    }

    public static AuthoringStateSnapshot DecodeSnapshot(byte[] payload)
    {
        Require(payload.Length <= MaximumBytes * 5 + 1024 * 1024, "state_payload_unbounded");
        AuthoringStateSnapshot snapshot;
        try
        {
            snapshot = JsonSerializer.Deserialize<AuthoringStateSnapshot>(payload, s_jsonOptions)
                ?? throw new AuthoringExtensionContractException("state_snapshot_missing");
        }
        catch (JsonException)
        {
            throw new AuthoringExtensionContractException("state_snapshot_encoding_invalid");
        }
        Require(snapshot.ContractVersion == 1 && !snapshot.Entries.IsDefault, "state_snapshot_version_invalid");
        AuthoringStateSnapshot expected = Snapshot(snapshot.Scope, snapshot.PackageIdentity, snapshot.Revision, snapshot.Entries);
        Require(expected.ContentSha256 == snapshot.ContentSha256 && payload.AsSpan().SequenceEqual(Encode(expected)),
            "state_snapshot_tampered_or_noncanonical");
        return expected;
    }

    public static void ValidateOwner(VerifiedAuthoringPackage package, AuthoringStateScope scope)
    {
        ArgumentNullException.ThrowIfNull(package);
        ValidateScope(scope);
        VerifiedAuthoringExtensionContract contract = AuthoringExtensionContractValidator.Verify(package.Contract.Manifest);
        Require(contract.ContractIdentity == package.Contract.ContractIdentity &&
            package.Trust.Status == AuthoringPackageTrustStatus.Trusted && IsDigest(package.PackageIdentity) &&
            scope.ExtensionId == contract.Manifest.Id && scope.ExtensionVersion == contract.Manifest.Version &&
            scope.SchemaVersion == contract.Manifest.StateSchemaVersion, "state_package_scope_mismatch");
    }

    public static void ValidateScope(AuthoringStateScope scope)
    {
        ArgumentNullException.ThrowIfNull(scope);
        Require(IsField(scope.ExtensionId, 128) && IsField(scope.ExtensionVersion, 64) &&
            IsField(scope.SiteId, 256) && IsField(scope.UserId, 256) &&
            (scope.DocumentId is null || IsField(scope.DocumentId, 256)) && scope.SchemaVersion > 0,
            "state_scope_invalid");
    }

    public static void ValidatePlan(VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ValidateOwner(oldPackage, plan.From);
        ValidateOwner(newPackage, plan.To);
        Require(plan.ContractVersion == 1 && plan.From.ExtensionId == plan.To.ExtensionId &&
            plan.From.SiteId == plan.To.SiteId && plan.From.UserId == plan.To.UserId &&
            plan.From.DocumentId == plan.To.DocumentId && plan.From != plan.To &&
            plan.ExpectedFromRevision >= 0 && plan.ExpectedToRevision >= 0 &&
            IsField(plan.PlanId, 256) && IsDigest(plan.SourceContentSha256) &&
            IsField(plan.BackupReference, 256) && IsField(plan.RollbackReference, 256) &&
            plan.MaximumRecords is >= 0 and <= MaximumRecords && plan.MaximumBytes is >= 0 and <= MaximumBytes &&
            plan.MaximumDuration > TimeSpan.Zero && plan.MaximumDuration <= TimeSpan.FromMinutes(5) &&
            !plan.Transforms.IsDefault && plan.Transforms.Length <= 1000 &&
            IsDigest(plan.ContentSha256), "state_migration_plan_invalid");
        foreach (AuthoringStateTransform transform in plan.Transforms)
        {
            Require(transform is not null && Enum.IsDefined(transform.Kind) && IsField(transform.SourceKey, 256) &&
                !transform.DefaultValue.IsDefault && transform.DefaultValue.Length <= MaximumValueBytes &&
                (transform.Kind == AuthoringStateTransformKind.RenameKey
                    ? IsField(transform.DestinationKey, 256) && transform.SourceKey != transform.DestinationKey && transform.DefaultValue.IsEmpty
                    : transform.DestinationKey is null &&
                        (transform.Kind == AuthoringStateTransformKind.SetDefault || transform.DefaultValue.IsEmpty)),
                "state_transform_invalid");
        }
        Require(plan.Transforms.Sum(static transform => (long)transform.DefaultValue.Length) <= MaximumBytes,
            "state_migration_default_bytes_unbounded");
        Require(plan.ContentSha256 == ComputeContentSha256(plan), "state_migration_plan_digest_invalid");
    }

    /// <summary>Owns all transform/value bytes before a persistence operation can yield.</summary>
    public static AuthoringFencedStateMigration FreezePlan(VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan)
    {
        ValidatePlan(oldPackage, newPackage, plan);
        AuthoringFencedStateMigration frozen = JsonSerializer.Deserialize<AuthoringFencedStateMigration>(Encode(plan), s_jsonOptions)
            ?? throw new AuthoringExtensionContractException("state_migration_plan_missing");
        ValidatePlan(oldPackage, newPackage, frozen);
        return frozen;
    }

    public static ImmutableArray<AuthoringStateEntry> Transform(AuthoringStateSnapshot source, AuthoringFencedStateMigration plan, CancellationToken cancellationToken)
    {
        var values = source.Entries.ToDictionary(static entry => entry.Key, static entry => entry.Value, StringComparer.Ordinal);
        CheckBudget(values, plan);
        foreach (AuthoringStateTransform transform in plan.Transforms)
        {
            cancellationToken.ThrowIfCancellationRequested();
            switch (transform.Kind)
            {
                case AuthoringStateTransformKind.RenameKey:
                    Require(values.TryGetValue(transform.SourceKey, out ImmutableArray<byte> value) &&
                        !values.ContainsKey(transform.DestinationKey!), "state_rename_missing_or_collision");
                    values.Remove(transform.SourceKey);
                    values.Add(transform.DestinationKey!, value);
                    break;
                case AuthoringStateTransformKind.DeleteExtensionKey:
                    Require(values.Remove(transform.SourceKey), "state_delete_key_missing");
                    break;
                case AuthoringStateTransformKind.SetDefault:
                    Require(values.TryAdd(transform.SourceKey, transform.DefaultValue), "state_default_key_exists");
                    break;
                default:
                    throw new AuthoringExtensionContractException("state_transform_unknown");
            }
            CheckBudget(values, plan);
        }
        return values.OrderBy(static pair => pair.Key, StringComparer.Ordinal)
            .Select(static pair => new AuthoringStateEntry(pair.Key, pair.Value)).ToImmutableArray();
    }

    public static long ValueBytes(AuthoringStateSnapshot snapshot) => snapshot.Entries.Sum(static entry => (long)entry.Value.Length);

    public static bool IsField(string? value, int limit) => !string.IsNullOrWhiteSpace(value) &&
        value.Length <= limit && value == value.Trim() && !value.Any(static c => char.IsControl(c) || char.IsSurrogate(c));

    public static bool IsDigest(string? value) => value?.Length == 64 &&
        value.All(static c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    public static void Require(bool valid, string code)
    {
        if (!valid)
        {
            throw new AuthoringExtensionContractException(code);
        }
    }

    private static void ValidateEntries(ImmutableArray<AuthoringStateEntry> entries)
    {
        Require(entries.Length <= MaximumRecords && entries.All(static entry => entry is not null &&
            IsField(entry.Key, 256) && !entry.Value.IsDefault && entry.Value.Length <= MaximumValueBytes) &&
            entries.Select(static entry => entry.Key).Distinct(StringComparer.Ordinal).Count() == entries.Length &&
            entries.Sum(static entry => (long)entry.Value.Length) <= MaximumBytes, "state_entries_invalid_or_unbounded");
    }

    private static void BoundDigestInput(AuthoringFencedStateMigration plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ValidateScope(plan.From);
        ValidateScope(plan.To);
        Require(plan.ContractVersion == 1 && IsField(plan.PlanId, 256) &&
            IsField(plan.BackupReference, 256) && IsField(plan.RollbackReference, 256) &&
            IsDigest(plan.SourceContentSha256) && !plan.Transforms.IsDefault && plan.Transforms.Length <= 1000,
            "state_migration_digest_input_invalid");
        foreach (AuthoringStateTransform transform in plan.Transforms)
        {
            Require(transform is not null && Enum.IsDefined(transform.Kind) &&
                IsField(transform.SourceKey, 256) && (transform.DestinationKey is null || IsField(transform.DestinationKey, 256)) &&
                !transform.DefaultValue.IsDefault && transform.DefaultValue.Length <= MaximumValueBytes,
                "state_migration_digest_transform_invalid");
        }
        Require(plan.Transforms.Sum(static transform => (long)transform.DefaultValue.Length) <= MaximumBytes,
            "state_migration_default_bytes_unbounded");
    }

    private static void CheckBudget(Dictionary<string, ImmutableArray<byte>> values, AuthoringFencedStateMigration plan) =>
        Require(values.Count <= plan.MaximumRecords && values.Values.Sum(static value => (long)value.Length) <= plan.MaximumBytes,
            "state_migration_budget_exceeded");
}
