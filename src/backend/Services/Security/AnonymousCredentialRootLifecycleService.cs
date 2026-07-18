using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface IAnonymousCredentialRootReader
{
    AnonymousCredentialRootRuntimeSnapshot CurrentSnapshot
    {
        get;
    }

    Task RefreshAsync(CancellationToken cancellationToken = default);

    bool IsRootAccepted(string rootHash, long epoch);

    bool IsRootAccepted(
        string rootHash,
        string revocationRootHash,
        string issuerPublicKeyHash,
        long epoch);
}

public interface IAnonymousCredentialRootWriter
{
    Task<Result<AnonymousCredentialRootRecord>> RotateAsync(
        AnonymousCredentialRootRotationRequest request,
        CancellationToken cancellationToken = default);
}

public interface IAnonymousCredentialRevocationService
{
    Task<Result> RevokeAsync(
        AnonymousCredentialRevocationRequest request,
        CancellationToken cancellationToken = default);
}

public sealed record AnonymousCredentialRootRotationRequest(
    long Epoch,
    string RootHash,
    string RevocationRootHash,
    string CircuitId,
    uint CircuitNumericId,
    string VerifyingKeyHash,
    ushort PublicInputLayoutVersion,
    DateTimeOffset ExpiresAtUtc,
    DateTimeOffset GraceExpiresAtUtc,
    string? CircuitMetadata = null,
    string? Reason = null,
    string? ActorId = null,
    string? IssuerPublicKeyHash = null);

public sealed record AnonymousCredentialRevocationRequest(
    long Epoch,
    string RevocationHandleHash,
    string RevocationRootHash,
    string? RootHash = null,
    string? Reason = null,
    string? ActorId = null);

public sealed record AnonymousCredentialAcceptedRoot(
    long Epoch,
    string RootHash,
    string RevocationRootHash,
    string IssuerPublicKeyHash,
    string Status,
    DateTimeOffset GraceExpiresAtUtc);

public sealed record AnonymousCredentialRootRuntimeSnapshot(
    IReadOnlyList<AnonymousCredentialAcceptedRoot> AcceptedRoots,
    long Version,
    DateTimeOffset LoadedAtUtc,
    IReadOnlyDictionary<(long Epoch, string RootHash), AnonymousCredentialAcceptedRoot> AcceptedRootByEpochAndHash,
    IReadOnlyDictionary<(long Epoch, string RootHash, string RevocationRootHash, string IssuerPublicKeyHash), AnonymousCredentialAcceptedRoot> AcceptedRootLookup)
{
    public AnonymousCredentialRootRuntimeSnapshot(
        IReadOnlyList<AnonymousCredentialAcceptedRoot> acceptedRoots,
        long version,
        DateTimeOffset loadedAtUtc)
        : this(
            acceptedRoots,
            version,
            loadedAtUtc,
            BuildRootLookup(acceptedRoots),
            BuildFullLookup(acceptedRoots))
    {
    }

    public static AnonymousCredentialRootRuntimeSnapshot Empty
    {
        get;
    } = new(
        [],
        0,
        DateTimeOffset.UnixEpoch,
        new Dictionary<(long Epoch, string RootHash), AnonymousCredentialAcceptedRoot>(),
        new Dictionary<(long Epoch, string RootHash, string RevocationRootHash, string IssuerPublicKeyHash), AnonymousCredentialAcceptedRoot>());

    private static Dictionary<(long Epoch, string RootHash), AnonymousCredentialAcceptedRoot> BuildRootLookup(
        IReadOnlyList<AnonymousCredentialAcceptedRoot> acceptedRoots)
    {
        var lookup = new Dictionary<(long Epoch, string RootHash), AnonymousCredentialAcceptedRoot>(acceptedRoots.Count);
        foreach (AnonymousCredentialAcceptedRoot root in acceptedRoots)
        {
            lookup.TryAdd((root.Epoch, root.RootHash), root);
        }

        return lookup;
    }

    private static Dictionary<(long Epoch, string RootHash, string RevocationRootHash, string IssuerPublicKeyHash), AnonymousCredentialAcceptedRoot> BuildFullLookup(
        IReadOnlyList<AnonymousCredentialAcceptedRoot> acceptedRoots)
    {
        var lookup = new Dictionary<(long Epoch, string RootHash, string RevocationRootHash, string IssuerPublicKeyHash), AnonymousCredentialAcceptedRoot>(acceptedRoots.Count);
        foreach (AnonymousCredentialAcceptedRoot root in acceptedRoots)
        {
            lookup.TryAdd((root.Epoch, root.RootHash, root.RevocationRootHash, root.IssuerPublicKeyHash), root);
        }

        return lookup;
    }
}

public sealed class AnonymousCredentialRootLifecycleService(
    IServiceScopeFactory scopeFactory,
    IAnonymousCredentialRootService rootSnapshotCache,
    TimeProvider timeProvider,
    IConfiguration configuration) : IAnonymousCredentialRootReader, IAnonymousCredentialRootWriter, IAnonymousCredentialRevocationService
{
    private AnonymousCredentialRootRuntimeSnapshot _snapshot = AnonymousCredentialRootRuntimeSnapshot.Empty;
    private long _version;

    public AnonymousCredentialRootRuntimeSnapshot CurrentSnapshot => Volatile.Read(ref _snapshot);

    public async Task RefreshAsync(CancellationToken cancellationToken = default)
    {
        DateTimeOffset now = timeProvider.GetUtcNow();
        await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
            scopeFactory,
            "anonymous_credential_root_bootstrap");
        ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        List<AnonymousCredentialRoot> roots = await db.Queryable<AnonymousCredentialRoot>()
            .Where(item =>
                (item.Status == AnonymousCredentialRootStatuses.Active ||
                 item.Status == AnonymousCredentialRootStatuses.Grace) &&
                item.RevokedAtUtc == null &&
                item.GraceExpiresAtUtc > now.UtcDateTime)
            .OrderBy(item => item.Epoch, OrderByType.Desc)
            .ToListAsync(cancellationToken);

        AnonymousCredentialAcceptedRoot[] accepted = roots
            .Select(item => new AcceptedRootCandidate(
                new AnonymousCredentialAcceptedRoot(
                    item.Epoch,
                    NormalizeToken(item.RootHash, 128),
                    NormalizeToken(item.RevocationRootHash, 128),
                    ResolveIssuerPublicKeyHash(item.IssuerPublicKeyHash),
                    NormalizeToken(item.Status, 32),
                    ToUtcOffset(item.GraceExpiresAtUtc)),
                AnonymousCredentialRevocationAccumulator.ResolveProfileFromCircuitMetadata(item.CircuitMetadata),
                AnonymousCredentialRootAttestation.Verify(item, configuration),
                IsRootFreshForProductionSnapshot(item, now)))
            .Where(static item =>
                item.Root.RootHash.Length > 0 &&
                item.Root.RevocationRootHash.Length > 0 &&
                item.Root.IssuerPublicKeyHash.Length > 0 &&
                item.RevocationAccumulatorProfile.IsProductionZkCompatible &&
                item.AttestationValid &&
                item.FreshForProductionSnapshot)
            .Select(static item => item.Root)
            .ToArray();
        var snapshot = new AnonymousCredentialRootRuntimeSnapshot(
            accepted,
            Interlocked.Increment(ref _version),
            now);
        Volatile.Write(ref _snapshot, snapshot);
    }

    public bool IsRootAccepted(string rootHash, long epoch)
    {
        if (epoch <= 0)
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(rootHash))
        {
            return false;
        }

        DateTimeOffset now = timeProvider.GetUtcNow();
        AnonymousCredentialRootRuntimeSnapshot snapshot = CurrentSnapshot;
        return snapshot.AcceptedRootByEpochAndHash.TryGetValue((epoch, rootHash), out AnonymousCredentialAcceptedRoot? root) &&
            root.GraceExpiresAtUtc > now &&
            IsAcceptedStatus(root.Status);
    }

    public bool IsRootAccepted(
        string rootHash,
        string revocationRootHash,
        string issuerPublicKeyHash,
        long epoch)
    {
        if (epoch <= 0)
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(rootHash) ||
            string.IsNullOrWhiteSpace(revocationRootHash) ||
            string.IsNullOrWhiteSpace(issuerPublicKeyHash))
        {
            return false;
        }

        DateTimeOffset now = timeProvider.GetUtcNow();
        AnonymousCredentialRootRuntimeSnapshot snapshot = CurrentSnapshot;
        return snapshot.AcceptedRootLookup.TryGetValue((epoch, rootHash, revocationRootHash, issuerPublicKeyHash), out AnonymousCredentialAcceptedRoot? root) &&
            root.GraceExpiresAtUtc > now &&
            IsAcceptedStatus(root.Status);
    }

    private static bool IsAcceptedStatus(string status)
        => string.Equals(status, AnonymousCredentialRootStatuses.Active, StringComparison.Ordinal) ||
            string.Equals(status, AnonymousCredentialRootStatuses.Grace, StringComparison.Ordinal);

    public async Task<Result<AnonymousCredentialRootRecord>> RotateAsync(
        AnonymousCredentialRootRotationRequest request,
        CancellationToken cancellationToken = default)
    {
        Result<NormalizedRotation> normalizedResult = NormalizeRotation(request);
        if (normalizedResult.IsFailure || normalizedResult.Value is null)
        {
            return Result<AnonymousCredentialRootRecord>.Failure(normalizedResult.Error);
        }

        NormalizedRotation rotation = normalizedResult.Value;
        DateTime utcNow = timeProvider.GetUtcNow().UtcDateTime;
        AnonymousCredentialRoot? inserted = null;

        await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
            scopeFactory,
            "anonymous_credential_root_refresh");
        ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            string distributionMetadata = AnonymousCredentialRevocationArtifactService.WithDistributionMetadata(
                rotation.CircuitMetadata,
                rotation.Epoch,
                version: 0,
                rotation.RevocationRootHash);
            await db.Updateable<AnonymousCredentialRoot>()
                .SetColumns(static item => item.Status == AnonymousCredentialRootStatuses.Expired)
                .SetColumns(item => item.UpdatedAtUtc == utcNow)
                .Where(item =>
                    item.Status == AnonymousCredentialRootStatuses.Grace &&
                    item.GraceExpiresAtUtc <= utcNow)
                .ExecuteCommandAsync(cancellationToken);

            await db.Updateable<AnonymousCredentialRoot>()
                .SetColumns(static item => item.Status == AnonymousCredentialRootStatuses.Grace)
                .SetColumns(item => item.UpdatedAtUtc == utcNow)
                .Where(static item => item.Status == AnonymousCredentialRootStatuses.Active)
                .ExecuteCommandAsync(cancellationToken);

            var epoch = new AnonymousCredentialEpoch
            {
                Epoch = rotation.Epoch,
                Status = AnonymousCredentialRootStatuses.Active,
                CreatedAtUtc = utcNow,
                ActivatedAtUtc = utcNow,
                ExpiresAtUtc = rotation.ExpiresAtUtc.UtcDateTime,
                GraceExpiresAtUtc = rotation.GraceExpiresAtUtc.UtcDateTime,
                ActiveRootHash = rotation.RootHash,
                Reason = rotation.Reason
            };
            await db.Insertable(epoch).ExecuteCommandAsync(cancellationToken);
            string attestationKeyId = AnonymousCredentialRootAttestation.ResolveKeyId(configuration);
            string rootAttestation = AnonymousCredentialRootAttestation.Create(
                rotation.Epoch,
                rotation.RootHash,
                rotation.RevocationRootHash,
                rotation.IssuerPublicKeyHash,
                rotation.CircuitId,
                rotation.CircuitNumericId,
                rotation.VerifyingKeyHash,
                rotation.PublicInputLayoutVersion,
                distributionMetadata,
                configuration,
                attestationKeyId);

            inserted = new AnonymousCredentialRoot
            {
                Epoch = rotation.Epoch,
                RootHash = rotation.RootHash,
                RevocationRootHash = rotation.RevocationRootHash,
                CircuitId = rotation.CircuitId,
                CircuitNumericId = (int)Math.Min(rotation.CircuitNumericId, int.MaxValue),
                VerifyingKeyHash = rotation.VerifyingKeyHash,
                IssuerPublicKeyHash = rotation.IssuerPublicKeyHash,
                PublicInputLayoutVersion = rotation.PublicInputLayoutVersion,
                CircuitMetadata = distributionMetadata,
                RootAttestation = rootAttestation,
                RootAttestationKeyId = attestationKeyId,
                CreatedAtUtc = utcNow,
                ActivatedAtUtc = utcNow,
                ExpiresAtUtc = rotation.ExpiresAtUtc.UtcDateTime,
                GraceExpiresAtUtc = rotation.GraceExpiresAtUtc.UtcDateTime,
                UpdatedAtUtc = utcNow,
                Status = AnonymousCredentialRootStatuses.Active
            };
            await db.Insertable(inserted).ExecuteCommandAsync(cancellationToken);
        });

        if (!transaction.IsSuccess || inserted is null)
        {
            return Result<AnonymousCredentialRootRecord>.Failure(ErrorCode.Conflict, "anonymous_credential_root_rotation_conflict");
        }

        InvalidateSnapshots();
        await RefreshAsync(cancellationToken);
        await RecordAuditAsync(
            scope.ServiceProvider,
            AuditActionCatalog.AnonymousCredentialRootRotated,
            AuditOutcomeCatalog.Success,
            AuditSeverityCatalog.Info,
            "anonymous credential root rotated",
            "anonymous_credential_root",
            rotation.RootHash,
            rotation.ActorId,
            rotation.Reason,
            new Dictionary<string, object?>
            {
                ["epoch"] = rotation.Epoch,
                ["root_hash"] = rotation.RootHash,
                ["status"] = AnonymousCredentialRootStatuses.Active
            },
            cancellationToken);

        return Result<AnonymousCredentialRootRecord>.Success(ToRecord(inserted));
    }

    public async Task<Result> RevokeAsync(
        AnonymousCredentialRevocationRequest request,
        CancellationToken cancellationToken = default)
    {
        Result<NormalizedRevocation> normalizedResult = NormalizeRevocation(request);
        if (normalizedResult.IsFailure || normalizedResult.Value is null)
        {
            return Result.Failure(normalizedResult.Error);
        }

        NormalizedRevocation revocation = normalizedResult.Value;
        DateTime utcNow = timeProvider.GetUtcNow().UtcDateTime;

        await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
            scopeFactory,
            "anonymous_credential_root_revoke");
        ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        AnonymousCredentialRoot? root = await db.Queryable<AnonymousCredentialRoot>()
            .Where(item => item.Epoch == revocation.Epoch)
            .WhereIF(revocation.RootHash is not null, item => item.RootHash == revocation.RootHash)
            .Where(item =>
                (item.Status == AnonymousCredentialRootStatuses.Active ||
                 item.Status == AnonymousCredentialRootStatuses.Grace) &&
                item.RevokedAtUtc == null &&
                item.GraceExpiresAtUtc > utcNow)
            .OrderBy(item => item.Epoch, OrderByType.Desc)
            .FirstAsync(cancellationToken);
        if (root is null)
        {
            return Result.Failure(ErrorCode.NotFound, "anonymous_credential_root_not_found");
        }

        string issuerPublicKeyHash = ResolveIssuerPublicKeyHash(root.IssuerPublicKeyHash);
        List<string> revokedHandles = await db.Queryable<AnonymousCredentialRevocation>()
            .Where(item => item.Epoch == root.Epoch)
            .Select(static item => item.RevocationHandleHash)
            .ToListAsync(cancellationToken);
        revokedHandles.Add(revocation.RevocationHandleHash);
        long distributionVersion = revokedHandles.Count;
        AnonymousCredentialRevocationAccumulatorProfile revocationAccumulatorProfile =
            AnonymousCredentialRevocationAccumulator.ResolveProfileFromCircuitMetadata(root.CircuitMetadata);
        Result<string> expectedRevocationRoot = AnonymousCredentialRevocationAccumulator.TryComputeRoot(
            root.Epoch,
            issuerPublicKeyHash,
            revokedHandles,
            revocationAccumulatorProfile);
        if (expectedRevocationRoot.IsFailure || expectedRevocationRoot.Value is null)
        {
            return Result.Failure(expectedRevocationRoot.Error);
        }

        if (!string.Equals(expectedRevocationRoot.Value, revocation.RevocationRootHash, StringComparison.OrdinalIgnoreCase))
        {
            return Result.Failure(ErrorCode.Validation, "anonymous_credential_revocation_root_mismatch");
        }

        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            string distributionMetadata = AnonymousCredentialRevocationArtifactService.WithDistributionMetadata(
                root.CircuitMetadata,
                root.Epoch,
                distributionVersion,
                revocation.RevocationRootHash);
            string attestationKeyId = AnonymousCredentialRootAttestation.ResolveKeyId(configuration);
            string rootAttestation = AnonymousCredentialRootAttestation.Create(
                root.Epoch,
                root.RootHash,
                revocation.RevocationRootHash,
                issuerPublicKeyHash,
                root.CircuitId,
                root.CircuitNumericId <= 0 ? 0U : (uint)root.CircuitNumericId,
                root.VerifyingKeyHash,
                root.PublicInputLayoutVersion <= 0 ? (ushort)0 : (ushort)Math.Min(root.PublicInputLayoutVersion, ushort.MaxValue),
                distributionMetadata,
                configuration,
                attestationKeyId);
            var row = new AnonymousCredentialRevocation
            {
                Epoch = revocation.Epoch,
                RootHash = root.RootHash,
                RevocationHandleHash = revocation.RevocationHandleHash,
                RevocationRootHash = revocation.RevocationRootHash,
                Reason = revocation.Reason,
                ActorId = revocation.ActorId,
                RevokedAtUtc = utcNow
            };
            await db.Insertable(row).ExecuteCommandAsync(cancellationToken);

            await db.Updateable<AnonymousCredentialRoot>()
                .SetColumns(item => item.RevocationRootHash == revocation.RevocationRootHash)
                .SetColumns(item => item.RootAttestation == rootAttestation)
                .SetColumns(item => item.RootAttestationKeyId == attestationKeyId)
                .SetColumns(item => item.CircuitMetadata == distributionMetadata)
                .SetColumns(item => item.UpdatedAtUtc == utcNow)
                .Where(item => item.Epoch == root.Epoch)
                .ExecuteCommandAsync(cancellationToken);
        });

        if (!transaction.IsSuccess)
        {
            return Result.Failure(ErrorCode.Conflict, "anonymous_credential_revocation_conflict");
        }

        InvalidateSnapshots();
        await RefreshAsync(cancellationToken);
        await RecordAuditAsync(
            scope.ServiceProvider,
            AuditActionCatalog.AnonymousCredentialRevoked,
            AuditOutcomeCatalog.Success,
            AuditSeverityCatalog.Warning,
            "anonymous credential revocation accumulator updated",
            "anonymous_credential_revocation",
            root.RootHash,
            revocation.ActorId,
            revocation.Reason,
            new Dictionary<string, object?>
            {
                ["epoch"] = revocation.Epoch,
                ["root_hash"] = root.RootHash,
                ["revocation_root_hash"] = revocation.RevocationRootHash,
                ["reason"] = revocation.Reason
            },
            cancellationToken);
        return Result.Success();
    }

    private void InvalidateSnapshots()
    {
        rootSnapshotCache.Invalidate();
        Volatile.Write(ref _snapshot, AnonymousCredentialRootRuntimeSnapshot.Empty);
    }

    private static async Task RecordAuditAsync(
        IServiceProvider serviceProvider,
        string action,
        string outcome,
        string severity,
        string eventInfo,
        string targetType,
        string targetId,
        string? actorId,
        string? reason,
        IReadOnlyDictionary<string, object?> context,
        CancellationToken cancellationToken)
    {
        IAuditEventService? audit = serviceProvider.GetService<IAuditEventService>();
        if (audit is null)
        {
            return;
        }

        await audit.RecordHighValueAsync(new AuditEvent(
            AuditSourceCatalog.Security,
            AuditTypeCatalog.Security,
            action,
            outcome,
            severity,
            eventInfo,
            ActorType: string.IsNullOrWhiteSpace(actorId) ? AuditActorTypeCatalog.System : AuditActorTypeCatalog.Admin,
            ActorId: actorId,
            TargetType: targetType,
            TargetId: targetId,
            ReasonCode: reason,
            Context: context,
            IsHighValue: true), cancellationToken);
    }

    private static Result<NormalizedRotation> NormalizeRotation(AnonymousCredentialRootRotationRequest request)
    {
        string rootHash = NormalizeToken(request.RootHash, 128);
        string revocationRoot = NormalizeToken(request.RevocationRootHash, 128);
        string circuitId = NormalizeToken(request.CircuitId, AnonymousCredentialIssuerLimits.MaxCircuitIdChars);
        string verifyingKeyHash = NormalizeToken(request.VerifyingKeyHash, 128);
        string issuerPublicKeyHash = ResolveIssuerPublicKeyHash(request.IssuerPublicKeyHash);
        string? circuitMetadata = TextHelpers.NormalizeNullable(request.CircuitMetadata, 4096);
        AnonymousCredentialRevocationAccumulatorProfile revocationAccumulatorProfile =
            AnonymousCredentialRevocationAccumulator.ResolveProfileFromCircuitMetadata(circuitMetadata);
        if (request.Epoch <= 0 ||
            rootHash.Length == 0 ||
            !AnonymousCredentialRevocationAccumulator.IsHexHash(revocationRoot) ||
            circuitId.Length == 0 ||
            verifyingKeyHash.Length == 0 ||
            !AnonymousCredentialRevocationAccumulator.IsHexHash(issuerPublicKeyHash) ||
            request.CircuitNumericId == 0 ||
            request.PublicInputLayoutVersion == 0 ||
            request.ExpiresAtUtc >= request.GraceExpiresAtUtc)
        {
            return Result<NormalizedRotation>.Failure(ErrorCode.Validation, "anonymous_credential_root_rotation_invalid");
        }

        if (revocationAccumulatorProfile.ProductionZkReady)
        {
            Result compatibility = AnonymousCredentialRevocationAccumulator.EnsureProductionZkCompatible(revocationAccumulatorProfile);
            if (compatibility.IsFailure)
            {
                return Result<NormalizedRotation>.Failure(compatibility.Error);
            }
        }

        return Result<NormalizedRotation>.Success(new NormalizedRotation(
            request.Epoch,
            rootHash,
            revocationRoot,
            circuitId,
            request.CircuitNumericId,
            verifyingKeyHash,
            issuerPublicKeyHash,
            request.PublicInputLayoutVersion,
            request.ExpiresAtUtc.ToUniversalTime(),
            request.GraceExpiresAtUtc.ToUniversalTime(),
            circuitMetadata,
            TextHelpers.NormalizeNullable(request.Reason, 128),
            TextHelpers.NormalizeNullable(request.ActorId, 128)));
    }

    private static Result<NormalizedRevocation> NormalizeRevocation(AnonymousCredentialRevocationRequest request)
    {
        string handleHash = NormalizeToken(request.RevocationHandleHash, 128);
        string revocationRoot = NormalizeToken(request.RevocationRootHash, 128);
        if (request.Epoch <= 0 ||
            !AnonymousCredentialRevocationAccumulator.IsHexHash(handleHash) ||
            !AnonymousCredentialRevocationAccumulator.IsHexHash(revocationRoot))
        {
            return Result<NormalizedRevocation>.Failure(ErrorCode.Validation, "anonymous_credential_revocation_invalid");
        }

        return Result<NormalizedRevocation>.Success(new NormalizedRevocation(
            request.Epoch,
            handleHash,
            revocationRoot,
            TextHelpers.NormalizeNullable(request.RootHash, 128),
            TextHelpers.NormalizeNullable(request.Reason, 128),
            TextHelpers.NormalizeNullable(request.ActorId, 128)));
    }

    private static AnonymousCredentialRootRecord ToRecord(AnonymousCredentialRoot root)
        => new(
            root.Epoch,
            DecodePublicBytes(root.RootHash),
            DecodePublicBytes(root.RevocationRootHash),
            NormalizeToken(root.RootHash, 128),
            NormalizeToken(root.CircuitId, AnonymousCredentialIssuerLimits.MaxCircuitIdChars),
            root.CircuitNumericId <= 0 ? 0U : (uint)root.CircuitNumericId,
            NormalizeToken(root.VerifyingKeyHash, 128),
            ResolveIssuerPublicKeyHash(root.IssuerPublicKeyHash),
            root.PublicInputLayoutVersion <= 0 ? (ushort)0 : (ushort)Math.Min(root.PublicInputLayoutVersion, ushort.MaxValue),
            AsUtc(root.CreatedAtUtc),
            AsUtc(root.ExpiresAtUtc),
            AsUtc(root.GraceExpiresAtUtc),
            NormalizeToken(root.Status, 32),
            string.IsNullOrWhiteSpace(root.CircuitMetadata) ? [] : System.Text.Encoding.UTF8.GetBytes(root.CircuitMetadata));

    private static string NormalizeToken(string? value, int maxLength)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static string ResolveIssuerPublicKeyHash(string? value)
    {
        string normalized = NormalizeToken(value, 128);
        if (normalized.Length > 0)
        {
            return normalized.ToLowerInvariant();
        }

        return string.Empty;
    }

    private static DateTime AsUtc(DateTime value)
        => value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };

    private static DateTimeOffset ToUtcOffset(DateTime value)
    {
        DateTime utc = AsUtc(value);
        return new DateTimeOffset(utc);
    }

    private bool IsRootFreshForProductionSnapshot(AnonymousCredentialRoot root, DateTimeOffset now)
    {
        string status = NormalizeToken(root.Status, 32);
        if (!string.Equals(status, AnonymousCredentialRootStatuses.Grace, StringComparison.Ordinal))
        {
            return true;
        }

        DateTimeOffset updatedAt = ToUtcOffset(root.UpdatedAtUtc);
        TimeSpan maxAge = TimeSpan.FromSeconds(Math.Clamp(
            configuration.GetValue("AnonymousCredentialRoot:GraceRootMaxAgeSeconds", 300),
            30,
            3600));
        return updatedAt.Add(maxAge) > now;
    }

    private static byte[] DecodePublicBytes(string? value)
    {
        string normalized = NormalizeToken(value, 4096);
        if (normalized.Length == 0)
        {
            return [];
        }

        string compact = normalized.Replace("0x", string.Empty, StringComparison.OrdinalIgnoreCase)
            .Replace(" ", string.Empty, StringComparison.Ordinal)
            .Replace("-", string.Empty, StringComparison.Ordinal);
        if (compact.Length > 0 &&
            compact.Length % 2 == 0 &&
            HexText.IsHex(compact.AsSpan()))
        {
            return Convert.FromHexString(compact);
        }

        return System.Text.Encoding.UTF8.GetBytes(normalized);
    }

    private sealed record NormalizedRotation(
        long Epoch,
        string RootHash,
        string RevocationRootHash,
        string CircuitId,
        uint CircuitNumericId,
        string VerifyingKeyHash,
        string IssuerPublicKeyHash,
        ushort PublicInputLayoutVersion,
        DateTimeOffset ExpiresAtUtc,
        DateTimeOffset GraceExpiresAtUtc,
        string? CircuitMetadata,
        string? Reason,
        string? ActorId);

    private sealed record NormalizedRevocation(
        long Epoch,
        string RevocationHandleHash,
        string RevocationRootHash,
        string? RootHash,
        string? Reason,
        string? ActorId);

    private sealed record AcceptedRootCandidate(
        AnonymousCredentialAcceptedRoot Root,
        AnonymousCredentialRevocationAccumulatorProfile RevocationAccumulatorProfile,
        bool AttestationValid,
        bool FreshForProductionSnapshot);
}

internal static class AnonymousCredentialRootAttestation
{
    public static bool Verify(AnonymousCredentialRoot root, IConfiguration configuration)
    {
        string attestation = NormalizeToken(root.RootAttestation, 128).ToLowerInvariant();
        if (!AnonymousCredentialRevocationAccumulator.IsHexHash(attestation))
        {
            return false;
        }

        string keyId = NormalizeToken(root.RootAttestationKeyId, 96);
        try
        {
            if (!string.Equals(keyId, ResolveKeyId(configuration), StringComparison.Ordinal))
            {
                return false;
            }

            string expected = Create(
                root.Epoch,
                NormalizeToken(root.RootHash, 128),
                NormalizeToken(root.RevocationRootHash, 128),
                ResolveIssuerPublicKeyHash(root.IssuerPublicKeyHash),
                NormalizeToken(root.CircuitId, AnonymousCredentialIssuerLimits.MaxCircuitIdChars),
                root.CircuitNumericId <= 0 ? 0U : (uint)root.CircuitNumericId,
                NormalizeToken(root.VerifyingKeyHash, 128),
                root.PublicInputLayoutVersion <= 0 ? (ushort)0 : (ushort)Math.Min(root.PublicInputLayoutVersion, ushort.MaxValue),
                TextHelpers.NormalizeNullable(root.CircuitMetadata, 4096),
                configuration,
                keyId);

            byte[] actualBytes = Convert.FromHexString(attestation);
            byte[] expectedBytes = Convert.FromHexString(expected);
            return CryptographicOperations.FixedTimeEquals(actualBytes, expectedBytes);
        }
        catch (InvalidOperationException)
        {
            return false;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    public static string Create(
        long epoch,
        string rootHash,
        string revocationRootHash,
        string issuerPublicKeyHash,
        string circuitId,
        uint circuitNumericId,
        string verifyingKeyHash,
        ushort publicInputLayoutVersion,
        string? circuitMetadata,
        IConfiguration configuration,
        string attestationKeyId)
    {
        string payload = string.Join('\n',
            "fsus.anonymous.root-attestation.v1",
            attestationKeyId,
            epoch.ToString(System.Globalization.CultureInfo.InvariantCulture),
            NormalizeToken(rootHash, 128).ToLowerInvariant(),
            NormalizeToken(revocationRootHash, 128).ToLowerInvariant(),
            ResolveIssuerPublicKeyHash(issuerPublicKeyHash),
            NormalizeToken(circuitId, AnonymousCredentialIssuerLimits.MaxCircuitIdChars),
            circuitNumericId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            NormalizeToken(verifyingKeyHash, 128).ToLowerInvariant(),
            publicInputLayoutVersion.ToString(System.Globalization.CultureInfo.InvariantCulture),
            TextHelpers.NormalizeNullable(circuitMetadata, 4096) ?? string.Empty);
        return Convert.ToHexStringLower(HMACSHA256.HashData(
            ResolveKey(configuration),
            Encoding.UTF8.GetBytes(payload)));
    }

    public static string ResolveKeyId(IConfiguration configuration)
        => NormalizeToken(configuration["AnonymousCredentialRoot:AttestationKeyId"], 96) is { Length: > 0 } keyId
            ? keyId
            : "default";

    private static byte[] ResolveKey(IConfiguration configuration)
    {
        string? value = configuration["AnonymousCredentialRoot:AttestationKey"];
        if (string.IsNullOrWhiteSpace(value) || value.Trim().Length < 32)
        {
            throw new InvalidOperationException("AnonymousCredentialRoot:AttestationKey must be configured with at least 32 characters.");
        }

        return SHA256.HashData(Encoding.UTF8.GetBytes(value.Trim()));
    }

    private static string ResolveIssuerPublicKeyHash(string? value)
    {
        string normalized = NormalizeToken(value, 128);
        if (normalized.Length > 0)
        {
            return normalized.ToLowerInvariant();
        }

        return string.Empty;
    }

    private static string NormalizeToken(string? value, int maxLength)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

}

public sealed class AnonymousCredentialRootRefreshHostedService(
    IAnonymousCredentialRootReader reader,
    IConfiguration configuration,
    ILogger<AnonymousCredentialRootRefreshHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        TimeSpan interval = TimeSpan.FromSeconds(Math.Clamp(
            configuration.GetValue("AnonymousCredentialRoot:RefreshIntervalSeconds", 60),
            10,
            3600));
        using PeriodicTimer timer = new(interval);

        await RefreshOnceAsync(stoppingToken);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            await RefreshOnceAsync(stoppingToken);
        }
    }

    private async Task RefreshOnceAsync(CancellationToken cancellationToken)
    {
        try
        {
            await reader.RefreshAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "anonymous credential root snapshot refresh failed");
        }
    }
}
