using System.Text;
using System.Security.Cryptography;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Shared.Contracts.Validation;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface IAnonymousCredentialRootService
{
    Task<Result<AnonymousCredentialRootSnapshotCoreModel>> GetCurrentSnapshotAsync(
        CancellationToken cancellationToken = default);

    void Invalidate();
}

public interface IAnonymousCredentialRootStore
{
    Task<AnonymousCredentialRootRecord?> GetCurrentAsync(
        DateTimeOffset now,
        CancellationToken cancellationToken = default);
}

public readonly record struct AnonymousCredentialRootRecord(
    long CredentialEpoch,
    byte[] CredentialRoot,
    byte[] RevocationRoot,
    string RootHash,
    string CircuitId,
    uint CircuitNumericId,
    string VerifyingKeyHash,
    string IssuerPublicKeyHash,
    ushort PublicInputLayoutVersion,
    DateTime CreatedAtUtc,
    DateTime ExpiresAtUtc,
    DateTime GraceExpiresAtUtc,
    string Status,
    byte[] CircuitMetadata);

public sealed class AnonymousCredentialRootStore(ISqlSugarClient db) : IAnonymousCredentialRootStore
{
    public async Task<AnonymousCredentialRootRecord?> GetCurrentAsync(
        DateTimeOffset now,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DateTime utcNow = now.UtcDateTime;
        AnonymousCredentialRoot? root = await db.Queryable<AnonymousCredentialRoot>()
            .Where(static item => item.Status == AnonymousCredentialRootStatuses.Active)
            .Where(item => item.GraceExpiresAtUtc > utcNow)
            .OrderBy(item => item.Epoch, OrderByType.Desc)
            .FirstAsync(cancellationToken);
        return root is null ? null : ToRecord(root);
    }

    private static AnonymousCredentialRootRecord ToRecord(AnonymousCredentialRoot root)
        => new(
            root.Epoch,
            DecodePublicBytes(root.RootHash),
            DecodePublicBytes(root.RevocationRootHash),
            Normalize(root.RootHash, 128),
            Normalize(root.CircuitId, AnonymousCredentialIssuerLimits.MaxCircuitIdChars),
            root.CircuitNumericId <= 0 ? 0U : (uint)root.CircuitNumericId,
            Normalize(root.VerifyingKeyHash, 128),
            Normalize(root.IssuerPublicKeyHash, 128),
            root.PublicInputLayoutVersion <= 0 ? (ushort)0 : (ushort)Math.Min(root.PublicInputLayoutVersion, ushort.MaxValue),
            AsUtc(root.CreatedAtUtc),
            AsUtc(root.ExpiresAtUtc),
            AsUtc(root.GraceExpiresAtUtc),
            Normalize(root.Status, 32),
            string.IsNullOrWhiteSpace(root.CircuitMetadata) ? [] : Encoding.UTF8.GetBytes(root.CircuitMetadata));

    private static string Normalize(string? value, int maxLength)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static DateTime AsUtc(DateTime value)
        => value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };

    private static byte[] DecodePublicBytes(string? value)
    {
        string normalized = Normalize(value, 4096);
        if (normalized.Length == 0)
        {
            return [];
        }

        string compact = normalized.Replace("0x", string.Empty, StringComparison.OrdinalIgnoreCase)
            .Replace(" ", string.Empty, StringComparison.Ordinal)
            .Replace("-", string.Empty, StringComparison.Ordinal);
        if (compact.Length > 0 &&
            compact.Length % 2 == 0 &&
            compact.All(static ch => Uri.IsHexDigit(ch)))
        {
            return Convert.FromHexString(compact);
        }

        return Encoding.UTF8.GetBytes(normalized);
    }
}

public sealed class AnonymousCredentialRootService(
    IServiceScopeFactory scopeFactory,
    IConfiguration configuration,
    IZkProofVerifier verifier,
    TimeProvider timeProvider) : IAnonymousCredentialRootService
{
    private static readonly TimeSpan PositiveCacheTtl = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan NegativeCacheTtl = TimeSpan.FromSeconds(5);
    private readonly SemaphoreSlim _refreshLock = new(1, 1);
    private AnonymousCredentialRootCacheEntry? _cache;
    private long _version;

    public async Task<Result<AnonymousCredentialRootSnapshotCoreModel>> GetCurrentSnapshotAsync(
        CancellationToken cancellationToken = default)
    {
        DateTimeOffset now = timeProvider.GetUtcNow();
        long version = Volatile.Read(ref _version);
        AnonymousCredentialRootCacheEntry? cached = Volatile.Read(ref _cache);
        if (cached is not null &&
            cached.Version == version &&
            cached.ExpiresAtUtc > now)
        {
            return CloneResult(cached.Result);
        }

        await _refreshLock.WaitAsync(cancellationToken);
        try
        {
            now = timeProvider.GetUtcNow();
            version = Volatile.Read(ref _version);
            cached = Volatile.Read(ref _cache);
            if (cached is not null &&
                cached.Version == version &&
                cached.ExpiresAtUtc > now)
            {
                return CloneResult(cached.Result);
            }

            Result<AnonymousCredentialRootSnapshotCoreModel> result = await LoadSnapshotAsync(now, cancellationToken);
            DateTimeOffset expiresAt = ResolveCacheExpiry(result, now);
            var entry = new AnonymousCredentialRootCacheEntry(version, expiresAt, CloneResult(result));
            Volatile.Write(ref _cache, entry);
            return CloneResult(result);
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    public void Invalidate()
    {
        Interlocked.Increment(ref _version);
        Volatile.Write(ref _cache, null);
    }

    private async Task<Result<AnonymousCredentialRootSnapshotCoreModel>> LoadSnapshotAsync(
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        using IServiceScope scope = scopeFactory.CreateScope();
        IAnonymousCredentialRootStore store = scope.ServiceProvider.GetRequiredService<IAnonymousCredentialRootStore>();
        AnonymousCredentialRootRecord? record = await store.GetCurrentAsync(now, cancellationToken);
        if (record is null ||
            !string.Equals(record.Value.Status, AnonymousCredentialRootStatuses.Active, StringComparison.Ordinal) ||
            record.Value.CredentialRoot.Length == 0 ||
            record.Value.RevocationRoot.Length == 0 ||
            record.Value.CircuitNumericId == 0 ||
            record.Value.PublicInputLayoutVersion == 0 ||
            string.IsNullOrWhiteSpace(record.Value.CircuitId) ||
            string.IsNullOrWhiteSpace(record.Value.VerifyingKeyHash))
        {
            return Result<AnonymousCredentialRootSnapshotCoreModel>.Failure(ErrorCode.InfraFailure, "anonymous_root_unavailable");
        }

        DateTimeOffset graceExpiresAt = ToUtcOffset(record.Value.GraceExpiresAtUtc);
        if (graceExpiresAt <= now)
        {
            return Result<AnonymousCredentialRootSnapshotCoreModel>.Failure(ErrorCode.InfraFailure, "anonymous_root_unavailable");
        }

        var snapshot = new AnonymousCredentialRootSnapshotCoreModel(
            record.Value.CredentialEpoch,
            ToUtcOffset(record.Value.ExpiresAtUtc).ToUnixTimeMilliseconds(),
            graceExpiresAt.ToUnixTimeMilliseconds(),
            record.Value.CircuitNumericId,
            record.Value.PublicInputLayoutVersion,
            configuration.GetValue("AnonymousIdentity:ZkAnonymousCommentsEnabled", false),
            verifier.IsConfigured,
            record.Value.CircuitId,
            record.Value.VerifyingKeyHash,
            ResolveIssuerPublicKeyHash(record.Value.IssuerPublicKeyHash, configuration),
            [.. record.Value.CredentialRoot],
            [.. record.Value.RevocationRoot],
            [.. record.Value.CircuitMetadata]);
        return Result<AnonymousCredentialRootSnapshotCoreModel>.Success(snapshot);
    }

    private static string ResolveIssuerPublicKeyHash(string storedIssuerPublicKeyHash, IConfiguration configuration)
    {
        string stored = storedIssuerPublicKeyHash.Trim();
        if (stored.Length > 0)
        {
            return stored.Length <= AnonymousPrivacyContract.MaxIssuerPublicKeyHashBytes
                ? stored.ToLowerInvariant()
                : stored[..AnonymousPrivacyContract.MaxIssuerPublicKeyHashBytes].ToLowerInvariant();
        }

        string issuerPublicKeyId = configuration["AnonymousCredentialIssuer:IssuerPublicKeyId"] ?? "issuer-key:local";
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(issuerPublicKeyId.Trim())));
    }

    private static DateTimeOffset ResolveCacheExpiry(
        in Result<AnonymousCredentialRootSnapshotCoreModel> result,
        DateTimeOffset now)
    {
        if (!result.IsSuccess)
        {
            return now.Add(NegativeCacheTtl);
        }

        AnonymousCredentialRootSnapshotCoreModel snapshot = result.Value;
        DateTimeOffset grace = DateTimeOffset.FromUnixTimeMilliseconds(snapshot.RootGraceExpiresAtUnixMs);
        DateTimeOffset ttl = now.Add(PositiveCacheTtl);
        return grace < ttl ? grace : ttl;
    }

    private static Result<AnonymousCredentialRootSnapshotCoreModel> CloneResult(
        in Result<AnonymousCredentialRootSnapshotCoreModel> result)
        => result.IsSuccess
            ? Result<AnonymousCredentialRootSnapshotCoreModel>.Success(CloneSnapshot(result.Value))
            : Result<AnonymousCredentialRootSnapshotCoreModel>.Failure(result.Error);

    private static AnonymousCredentialRootSnapshotCoreModel CloneSnapshot(
        AnonymousCredentialRootSnapshotCoreModel snapshot)
        => snapshot with
        {
            CredentialRoot = [.. snapshot.CredentialRoot],
            RevocationRoot = [.. snapshot.RevocationRoot],
            CircuitMetadata = [.. snapshot.CircuitMetadata]
        };

    private static DateTimeOffset ToUtcOffset(DateTime value)
    {
        DateTime utc = value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };
        return new DateTimeOffset(utc);
    }

    private sealed record AnonymousCredentialRootCacheEntry(
        long Version,
        DateTimeOffset ExpiresAtUtc,
        Result<AnonymousCredentialRootSnapshotCoreModel> Result);
}
