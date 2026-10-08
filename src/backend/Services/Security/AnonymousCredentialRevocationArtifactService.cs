using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Shared.Contracts.Validation;

using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public static class AnonymousCredentialRevocationArtifactKinds
{
    public const byte Full = 1;
    public const byte Delta = 2;
}

public interface IAnonymousCredentialRevocationArtifactService
{
    Task<Result<AnonymousCredentialRevocationArtifactCoreModel>> GetAsync(
        long epoch,
        long version,
        string revocationRoot,
        byte kind,
        long baseVersion,
        CancellationToken cancellationToken = default);
}

public sealed class AnonymousCredentialRevocationArtifactService(
    ISqlSugarClient db,
    TimeProvider timeProvider) : IAnonymousCredentialRevocationArtifactService
{
    private const string ArtifactSignatureDomain = "fsus.anonymous.revocation.public-artifact.v1";
    public const string DistributionProtocol = "public-snapshot-delta.v1";

    public async Task<Result<AnonymousCredentialRevocationArtifactCoreModel>> GetAsync(
        long epoch,
        long version,
        string revocationRoot,
        byte kind,
        long baseVersion,
        CancellationToken cancellationToken = default)
    {
        if (epoch <= 0 || version < 0 || baseVersion < 0 || baseVersion > version ||
            kind is not (AnonymousCredentialRevocationArtifactKinds.Full or AnonymousCredentialRevocationArtifactKinds.Delta) ||
            !AnonymousCredentialRevocationAccumulator.IsHexHash(revocationRoot, 64, 64))
        {
            return Result<AnonymousCredentialRevocationArtifactCoreModel>.Failure(
                ErrorCode.Validation,
                "anonymous_revocation_artifact_request_invalid");
        }

        AnonymousCredentialRoot? root = await db.Queryable<AnonymousCredentialRoot>()
            .Where(item => item.Epoch == epoch)
            .FirstAsync(cancellationToken);
        DateTimeOffset now = timeProvider.GetUtcNow();
        if (root is null || root.RevokedAtUtc.HasValue || root.GraceExpiresAtUtc <= now.UtcDateTime ||
            !string.Equals(root.RevocationRootHash, revocationRoot, StringComparison.OrdinalIgnoreCase))
        {
            return Result<AnonymousCredentialRevocationArtifactCoreModel>.Failure(
                ErrorCode.NotFound,
                "anonymous_revocation_artifact_unavailable");
        }

        AnonymousCredentialRevocationAccumulatorProfile profile =
            AnonymousCredentialRevocationAccumulator.ResolveProfileFromCircuitMetadata(root.CircuitMetadata);
        Result compatible = AnonymousCredentialRevocationAccumulator.EnsureProductionZkCompatible(profile);
        if (compatible.IsFailure)
        {
            return Result<AnonymousCredentialRevocationArtifactCoreModel>.Failure(compatible.Error);
        }

        List<AnonymousCredentialRevocation> rows = await db.Queryable<AnonymousCredentialRevocation>()
            .Where(item => item.Epoch == epoch)
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken);
        if (rows.Count != version || rows.Count > AnonymousPrivacyContract.MaxRevocationArtifactEntries ||
            (kind == AnonymousCredentialRevocationArtifactKinds.Full && baseVersion != 0) ||
            (kind == AnonymousCredentialRevocationArtifactKinds.Delta && baseVersion >= version))
        {
            return Result<AnonymousCredentialRevocationArtifactCoreModel>.Failure(
                ErrorCode.Conflict,
                "anonymous_revocation_artifact_version_mismatch");
        }

        string issuer = root.IssuerPublicKeyHash.Trim().ToLowerInvariant();
        string[] allEntries = rows.Select(static item => item.RevocationHandleHash.Trim().ToLowerInvariant()).ToArray();
        Result<string> computedRoot = AnonymousCredentialRevocationAccumulator.TryComputeRoot(epoch, issuer, allEntries, profile);
        if (computedRoot.IsFailure || computedRoot.Value is null ||
            !FixedHexEquals(computedRoot.Value, revocationRoot))
        {
            return Result<AnonymousCredentialRevocationArtifactCoreModel>.Failure(
                ErrorCode.Validation,
                "anonymous_revocation_artifact_root_mismatch");
        }

        IEnumerable<string> selected = kind == AnonymousCredentialRevocationArtifactKinds.Full
            ? allEntries
            : allEntries.Skip(checked((int)baseVersion));
        if (!TryConcatEntries(selected, out byte[] entryHashes))
        {
            return Result<AnonymousCredentialRevocationArtifactCoreModel>.Failure(
                ErrorCode.Validation,
                "anonymous_revocation_artifact_entries_invalid");
        }

        byte[] rootBytes = Convert.FromHexString(revocationRoot);
        byte[] contentHash = ComputeContentHash(
            epoch,
            version,
            baseVersion,
            root.GraceExpiresAtUtc,
            kind,
            profile.PathDepth,
            profile.AlgorithmId,
            issuer,
            rootBytes,
            entryHashes);
        byte[] signature = SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\0',
            ArtifactSignatureDomain,
            epoch.ToString(System.Globalization.CultureInfo.InvariantCulture),
            version.ToString(System.Globalization.CultureInfo.InvariantCulture),
            baseVersion.ToString(System.Globalization.CultureInfo.InvariantCulture),
            revocationRoot,
            issuer,
            Convert.ToHexStringLower(contentHash))));
        return Result<AnonymousCredentialRevocationArtifactCoreModel>.Success(
            new AnonymousCredentialRevocationArtifactCoreModel(
                epoch,
                version,
                baseVersion,
                new DateTimeOffset(DateTime.SpecifyKind(root.GraceExpiresAtUtc, DateTimeKind.Utc)).ToUnixTimeMilliseconds(),
                kind,
                profile.PathDepth,
                profile.AlgorithmId,
                issuer,
                rootBytes,
                contentHash,
                signature,
                entryHashes));
    }

    public static string WithDistributionMetadata(
        string? circuitMetadata,
        long epoch,
        long version,
        string revocationRoot)
    {
        JsonObject root = string.IsNullOrWhiteSpace(circuitMetadata)
            ? new JsonObject()
            : JsonNode.Parse(circuitMetadata) as JsonObject ?? new JsonObject();
        string normalizedRoot = revocationRoot.Trim().ToLowerInvariant();
        root["revocationDistribution"] = new JsonObject
        {
            ["protocol"] = DistributionProtocol,
            ["epoch"] = epoch,
            ["version"] = version,
            ["contentAddress"] = normalizedRoot,
            ["snapshot"] = new JsonObject
            {
                ["kind"] = "snapshot",
                ["epoch"] = epoch,
                ["version"] = version,
                ["revocationRoot"] = normalizedRoot
            },
            ["delta"] = version > 0 ? new JsonObject
            {
                ["kind"] = "delta",
                ["epoch"] = epoch,
                ["version"] = version,
                ["revocationRoot"] = normalizedRoot,
                ["baseVersion"] = version - 1
            } : null,
            ["entryBytes"] = 32,
            ["maxArtifactBytes"] = AnonymousPrivacyContract.MaxRevocationArtifactBytes
        };
        return root.ToJsonString(new JsonSerializerOptions { WriteIndented = false });
    }

    public static byte[] ComputeContentHash(
        long epoch,
        long version,
        long baseVersion,
        DateTime expiresAtUtc,
        byte kind,
        ushort pathDepth,
        string algorithmId,
        string issuer,
        byte[] root,
        byte[] entries)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(Encoding.UTF8.GetBytes($"{DistributionProtocol}\0{epoch}\0{version}\0{baseVersion}\0{new DateTimeOffset(DateTime.SpecifyKind(expiresAtUtc, DateTimeKind.Utc)).ToUnixTimeMilliseconds()}\0{kind}\0{pathDepth}\0{algorithmId}\0{issuer}\0"));
        hash.AppendData(root);
        hash.AppendData(entries);
        return hash.GetHashAndReset();
    }

    private static bool TryConcatEntries(IEnumerable<string> entries, out byte[] bytes)
    {
        var output = new List<byte>();
        foreach (string entry in entries)
        {
            if (entry.Length != 64 || !AnonymousCredentialRevocationAccumulator.IsHexHash(entry, 64, 64))
            {
                bytes = [];
                return false;
            }

            output.AddRange(Convert.FromHexString(entry));
            if (output.Count > AnonymousPrivacyContract.MaxRevocationArtifactBytes)
            {
                bytes = [];
                return false;
            }
        }

        bytes = [.. output];
        return true;
    }

    private static bool FixedHexEquals(string left, string right)
    {
        byte[] leftBytes = Convert.FromHexString(left);
        byte[] rightBytes = Convert.FromHexString(right);
        return leftBytes.Length == rightBytes.Length && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }
}
