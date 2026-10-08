using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Operations;

public sealed record PerceptionCharacterV3CutoverTarget(
    string ContractDigest,
    string PoolGeneration,
    string PoolManifestDigest,
    string BackendAedsSchemaFingerprint,
    string SharedAedsSchemaFingerprint,
    string FrontendAedsSchemaFingerprint,
    string PolicySnapshotVersion,
    string TargetFingerprint);

public sealed record PerceptionCharacterV3CutoverRequest(
    string OperationId,
    string ReleaseId,
    string Slot,
    long Generation,
    PerceptionCharacterV3CutoverTarget Target,
    bool DryRun = false);

public sealed record PerceptionCharacterV3CutoverMutationResult(
    long ChallengeRowsRevoked,
    long StateKeysRetired,
    long ActiveIdentityKeysRetired,
    long DeviceKeysRetired,
    long OldPoolGenerationsRevoked,
    long EnvelopesExamined,
    long EnvelopesRevoked,
    string RetiredStateDigest);

public sealed record PerceptionCharacterV3CutoverReceipt(
    string SchemaVersion,
    string OperationId,
    string RequestFingerprint,
    string ReceiptFingerprint,
    string ReleaseId,
    string Slot,
    long Generation,
    string ContractDigest,
    string PoolGeneration,
    string PoolManifestDigest,
    string BackendAedsSchemaFingerprint,
    string SharedAedsSchemaFingerprint,
    string FrontendAedsSchemaFingerprint,
    string PolicySnapshotVersion,
    string TargetFingerprint,
    bool DryRun,
    bool Accepted,
    bool Idempotent,
    string Status,
    string? ErrorCode,
    bool FenceVerifiedBefore,
    bool FenceVerifiedImmediatelyBeforeMutation,
    bool FenceVerifiedAfter,
    PerceptionCharacterV3CutoverMutationResult Mutation,
    DateTimeOffset CompletedAtUtc);

public interface IPerceptionCharacterV3CutoverStore
{
    Task<PerceptionCharacterV3CutoverReceipt?> ReadReceiptAsync(
        string operationId,
        CancellationToken cancellationToken = default);

    Task<PerceptionCharacterV3CutoverMutationResult> ApplyAsync(
        PerceptionCharacterV3CutoverRequest request,
        string requestFingerprint,
        CancellationToken cancellationToken = default);

    Task<PerceptionCharacterV3CutoverReceipt> SaveReceiptAsync(
        PerceptionCharacterV3CutoverReceipt receipt,
        CancellationToken cancellationToken = default);
}

public interface IPerceptionCharacterV3ActivationGate
{
    Task<bool> IsOpenAsync(CancellationToken cancellationToken = default);

    Task CloseAsync(CancellationToken cancellationToken = default);

    Task OpenAsync(
        PerceptionCharacterV3CutoverReceipt receipt,
        CancellationToken cancellationToken = default);
}

public sealed class PerceptionCharacterV3ContractCutover(
    IActiveReleaseFence activeReleaseFence,
    IPerceptionCharacterV3ArtifactPool artifactPool,
    ISecurityRiskPolicyProvider policyProvider,
    IPerceptionCharacterV3CutoverStore store,
    IPerceptionCharacterV3ActivationGate activationGate,
    TimeProvider timeProvider)
{
    public const string ReceiptSchemaVersion = "fsus.security.perception-character-v3-cutover-receipt.v1";

    public async Task<PerceptionCharacterV3CutoverReceipt> ExecuteAsync(
        PerceptionCharacterV3CutoverRequest request,
        CancellationToken cancellationToken = default)
    {
        ValidatedRequest validated = await ValidateAsync(request, cancellationToken).ConfigureAwait(false);
        PerceptionCharacterV3CutoverReceipt? existing = await store
            .ReadReceiptAsync(validated.Request.OperationId, cancellationToken)
            .ConfigureAwait(false);
        if (existing is not null)
        {
            if (!FixedEquals(existing.RequestFingerprint, validated.RequestFingerprint))
            {
                throw new InvalidOperationException("The V3 cutover operation id is already bound to another target.");
            }
            if (existing.Accepted && !existing.DryRun)
            {
                await activationGate.OpenAsync(existing, cancellationToken).ConfigureAwait(false);
            }
            return existing with
            {
                Idempotent = true
            };
        }

        ActiveReleaseFenceVerifyRequest fenceRequest = new(
            validated.Request.ReleaseId,
            validated.Request.Slot,
            validated.Request.Generation,
            RequireActive: true);
        ActiveReleaseFenceOperationResult before = await activeReleaseFence
            .VerifyAsync(fenceRequest, cancellationToken)
            .ConfigureAwait(false);
        if (!before.Accepted)
        {
            return Rejected(validated, before.ErrorCode ?? "active_release_fence_rejected", false, false, false);
        }

        if (await activationGate.IsOpenAsync(cancellationToken).ConfigureAwait(false))
        {
            if (!validated.Request.DryRun)
            {
                await activationGate.CloseAsync(cancellationToken).ConfigureAwait(false);
            }
            return Rejected(
                validated,
                "perception_character_v3_issuance_not_closed_at_cutover_start",
                true,
                false,
                false);
        }

        if (!validated.Request.DryRun)
        {
            await activationGate.CloseAsync(cancellationToken).ConfigureAwait(false);
        }
        ActiveReleaseFenceOperationResult immediatelyBefore = await activeReleaseFence
            .VerifyAsync(fenceRequest, cancellationToken)
            .ConfigureAwait(false);
        if (!immediatelyBefore.Accepted)
        {
            return Rejected(validated, immediatelyBefore.ErrorCode ?? "active_release_fence_changed", true, false, false);
        }

        PerceptionCharacterV3CutoverMutationResult mutation = await store
            .ApplyAsync(validated.Request, validated.RequestFingerprint, cancellationToken)
            .ConfigureAwait(false);
        ActiveReleaseFenceOperationResult after = await activeReleaseFence
            .VerifyAsync(fenceRequest, cancellationToken)
            .ConfigureAwait(false);
        if (!after.Accepted)
        {
            return Rejected(
                validated,
                after.ErrorCode ?? "active_release_fence_changed_after_mutation",
                true,
                true,
                false,
                mutation);
        }

        PerceptionCharacterV3CutoverReceipt receipt = BuildReceipt(
            validated,
            accepted: true,
            status: validated.Request.DryRun ? "would-activate" : "activated",
            errorCode: null,
            fenceVerifiedBefore: true,
            fenceVerifiedImmediatelyBeforeMutation: true,
            fenceVerifiedAfter: true,
            mutation);
        receipt = await store.SaveReceiptAsync(receipt, cancellationToken).ConfigureAwait(false);
        if (!validated.Request.DryRun)
        {
            await activationGate.OpenAsync(receipt, cancellationToken).ConfigureAwait(false);
            if (!await activationGate.IsOpenAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new InvalidOperationException("PerceptionCharacterV3 activation smoke check failed.");
            }
        }
        return receipt;
    }

    private async Task<ValidatedRequest> ValidateAsync(
        PerceptionCharacterV3CutoverRequest request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(request.Target);
        string operationId = Required(request.OperationId, nameof(request.OperationId), 128);
        string releaseId = Required(request.ReleaseId, nameof(request.ReleaseId), 128);
        string slot = Required(request.Slot, nameof(request.Slot), 32);
        if (request.Generation <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(request.Generation));
        }

        PerceptionCharacterV3CutoverTarget target = request.Target with
        {
            ContractDigest = Digest(request.Target.ContractDigest, nameof(request.Target.ContractDigest)),
            PoolGeneration = Required(request.Target.PoolGeneration, nameof(request.Target.PoolGeneration), 128),
            PoolManifestDigest = Digest(request.Target.PoolManifestDigest, nameof(request.Target.PoolManifestDigest)),
            BackendAedsSchemaFingerprint = Digest(request.Target.BackendAedsSchemaFingerprint, nameof(request.Target.BackendAedsSchemaFingerprint)),
            SharedAedsSchemaFingerprint = Digest(request.Target.SharedAedsSchemaFingerprint, nameof(request.Target.SharedAedsSchemaFingerprint)),
            FrontendAedsSchemaFingerprint = Digest(request.Target.FrontendAedsSchemaFingerprint, nameof(request.Target.FrontendAedsSchemaFingerprint)),
            PolicySnapshotVersion = Required(request.Target.PolicySnapshotVersion, nameof(request.Target.PolicySnapshotVersion), 128),
            TargetFingerprint = Digest(request.Target.TargetFingerprint, nameof(request.Target.TargetFingerprint))
        };
        if (!FixedEquals(target.ContractDigest, PerceptionCharacterV3ReleaseTarget.ContractDigest)
            || !FixedEquals(target.BackendAedsSchemaFingerprint, PerceptionCharacterV3ReleaseTarget.AedsSchemaFingerprint)
            || !FixedEquals(target.SharedAedsSchemaFingerprint, PerceptionCharacterV3ReleaseTarget.AedsSchemaFingerprint)
            || !FixedEquals(target.FrontendAedsSchemaFingerprint, PerceptionCharacterV3ReleaseTarget.AedsSchemaFingerprint))
        {
            throw new InvalidOperationException("The V3 contract or backend/shared/frontend AEDS schema fingerprint is mixed or stale.");
        }

        PerceptionCharacterV3PoolIdentity pool = await artifactPool
            .GetIdentityAsync(cancellationToken)
            .ConfigureAwait(false);
        if (!FixedEquals(pool.GenerationId, target.PoolGeneration)
            || !FixedEquals(pool.ManifestDigest, target.PoolManifestDigest)
            || !FixedEquals(pool.ContractDigest, target.ContractDigest))
        {
            throw new InvalidOperationException("The active V3 pool identity does not match the approved target.");
        }
        PerceptionCharacterV3PoolInventory inventory = await artifactPool
            .GetInventoryAsync(cancellationToken)
            .ConfigureAwait(false);
        if (!FixedEquals(inventory.GenerationId, target.PoolGeneration)
            || inventory.Revoked || inventory.Corrupted || !inventory.RedisAvailable)
        {
            throw new InvalidOperationException("The active V3 pool is not healthy for cutover.");
        }
        if (!FixedEquals(policyProvider.CurrentRiskPolicy.PolicyVersion, target.PolicySnapshotVersion))
        {
            throw new InvalidOperationException("The active RiskControl policy version does not match the V3 target.");
        }

        string computedTargetFingerprint = ComputeTargetFingerprint(target with
        {
            TargetFingerprint = string.Empty
        });
        if (!FixedEquals(computedTargetFingerprint, target.TargetFingerprint))
        {
            throw new InvalidOperationException("The V3 target fingerprint does not match its target map.");
        }

        var normalized = request with
        {
            OperationId = operationId,
            ReleaseId = releaseId,
            Slot = slot,
            Target = target
        };
        string requestFingerprint = Hash(JsonSerializer.SerializeToUtf8Bytes(new
        {
            normalized.OperationId,
            normalized.ReleaseId,
            normalized.Slot,
            normalized.Generation,
            normalized.Target,
            normalized.DryRun
        }));
        return new(normalized, requestFingerprint);
    }

    public static string ComputeTargetFingerprint(PerceptionCharacterV3CutoverTarget target)
    {
        ArgumentNullException.ThrowIfNull(target);
        return Hash(JsonSerializer.SerializeToUtf8Bytes(new
        {
            target.ContractDigest,
            target.PoolGeneration,
            target.PoolManifestDigest,
            target.BackendAedsSchemaFingerprint,
            target.SharedAedsSchemaFingerprint,
            target.FrontendAedsSchemaFingerprint,
            target.PolicySnapshotVersion,
            releaseTargetFingerprint = PerceptionCharacterV3ReleaseTarget.TargetFingerprint
        }));
    }

    private PerceptionCharacterV3CutoverReceipt Rejected(
        ValidatedRequest validated,
        string errorCode,
        bool fenceVerifiedBefore,
        bool fenceVerifiedImmediatelyBeforeMutation,
        bool fenceVerifiedAfter,
        PerceptionCharacterV3CutoverMutationResult? mutation = null)
        => BuildReceipt(
            validated,
            accepted: false,
            status: "closed",
            errorCode,
            fenceVerifiedBefore,
            fenceVerifiedImmediatelyBeforeMutation,
            fenceVerifiedAfter,
            mutation ?? EmptyMutation());

    private PerceptionCharacterV3CutoverReceipt BuildReceipt(
        ValidatedRequest validated,
        bool accepted,
        string status,
        string? errorCode,
        bool fenceVerifiedBefore,
        bool fenceVerifiedImmediatelyBeforeMutation,
        bool fenceVerifiedAfter,
        PerceptionCharacterV3CutoverMutationResult mutation)
    {
        PerceptionCharacterV3CutoverTarget target = validated.Request.Target;
        DateTimeOffset completedAt = timeProvider.GetUtcNow();
        string receiptFingerprint = Hash(JsonSerializer.SerializeToUtf8Bytes(new
        {
            schema = ReceiptSchemaVersion,
            validated.Request.OperationId,
            validated.RequestFingerprint,
            validated.Request.ReleaseId,
            validated.Request.Slot,
            validated.Request.Generation,
            target.ContractDigest,
            target.PoolGeneration,
            target.PoolManifestDigest,
            target.BackendAedsSchemaFingerprint,
            target.SharedAedsSchemaFingerprint,
            target.FrontendAedsSchemaFingerprint,
            target.PolicySnapshotVersion,
            target.TargetFingerprint,
            validated.Request.DryRun,
            accepted,
            status,
            errorCode,
            fenceVerifiedBefore,
            fenceVerifiedImmediatelyBeforeMutation,
            fenceVerifiedAfter,
            mutation
        }));
        return new(
            ReceiptSchemaVersion,
            validated.Request.OperationId,
            validated.RequestFingerprint,
            receiptFingerprint,
            validated.Request.ReleaseId,
            validated.Request.Slot,
            validated.Request.Generation,
            target.ContractDigest,
            target.PoolGeneration,
            target.PoolManifestDigest,
            target.BackendAedsSchemaFingerprint,
            target.SharedAedsSchemaFingerprint,
            target.FrontendAedsSchemaFingerprint,
            target.PolicySnapshotVersion,
            target.TargetFingerprint,
            validated.Request.DryRun,
            accepted,
            Idempotent: false,
            status,
            errorCode,
            fenceVerifiedBefore,
            fenceVerifiedImmediatelyBeforeMutation,
            fenceVerifiedAfter,
            mutation,
            completedAt);
    }

    private static PerceptionCharacterV3CutoverMutationResult EmptyMutation()
        => new(0, 0, 0, 0, 0, 0, 0, Hash(ReadOnlySpan<byte>.Empty));

    private static string Required(string? value, string name, int maximum)
    {
        string normalized = (value ?? string.Empty).Trim();
        return normalized.Length is > 0 && normalized.Length <= maximum
            ? normalized
            : throw new ArgumentException($"{name} is missing or too long.", name);
    }

    private static string Digest(string? value, string name)
    {
        string normalized = Required(value, name, 64).ToLowerInvariant();
        return normalized.Length == 64 && normalized.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f')
            ? normalized
            : throw new ArgumentException($"{name} must be a lowercase SHA-256 digest.", name);
    }

    private static bool FixedEquals(string left, string right)
    {
        byte[] leftBytes = Encoding.UTF8.GetBytes(left ?? string.Empty);
        byte[] rightBytes = Encoding.UTF8.GetBytes(right ?? string.Empty);
        return leftBytes.Length == rightBytes.Length
            && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }

    private static string Hash(ReadOnlySpan<byte> value)
        => Convert.ToHexStringLower(SHA256.HashData(value));

    private sealed record ValidatedRequest(
        PerceptionCharacterV3CutoverRequest Request,
        string RequestFingerprint);
}

public sealed class RedisPerceptionCharacterV3CutoverStore(
    IRedisOperationExecutor redis,
    IRuntimeKeyScope keyScope,
    IConfiguration configuration,
    IServiceScopeFactory scopeFactory) : IPerceptionCharacterV3CutoverStore
{
    private const string EnvelopeDataField = "data";
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);
    private readonly string _cacheInstancePrefix = configuration["RedisOptions:InstanceName"] ?? "FsusBlog_";
    private readonly ConcurrentDictionary<string, string> _operationLocks = new(StringComparer.Ordinal);

    public async Task<PerceptionCharacterV3CutoverReceipt?> ReadReceiptAsync(
        string operationId,
        CancellationToken cancellationToken = default)
    {
        RedisValue value = await ExecuteDatabaseAsync(
            database => database.StringGetAsync(ReceiptKey(operationId)),
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return value.HasValue
            ? JsonSerializer.Deserialize<PerceptionCharacterV3CutoverReceipt>((string)value!, s_jsonOptions)
            : null;
    }

    public async Task<PerceptionCharacterV3CutoverMutationResult> ApplyAsync(
        PerceptionCharacterV3CutoverRequest request,
        string requestFingerprint,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RedisValue existing = await ExecuteDatabaseAsync(
            database => database.StringGetAsync(MutationKey(request.OperationId)),
            cancellationToken).ConfigureAwait(false);
        if (existing.HasValue)
        {
            MutationEnvelope restored = JsonSerializer.Deserialize<MutationEnvelope>((string)existing!, s_jsonOptions)
                ?? throw new InvalidOperationException("The durable V3 cutover mutation result is invalid.");
            if (!FixedEquals(restored.RequestFingerprint, requestFingerprint))
            {
                throw new InvalidOperationException("The V3 cutover operation id is already bound to another request.");
            }
            return restored.Result;
        }

        string lockToken = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
        if (!await ExecuteDatabaseAsync(
                database => database.StringSetAsync(
                    LockKey(request.OperationId),
                    lockToken,
                    TimeSpan.FromMinutes(5),
                    When.NotExists),
                cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException("The V3 cutover operation is already running.");
        }
        _operationLocks[request.OperationId] = lockToken;

        try
        {
            var retired = new HashSet<string>(StringComparer.Ordinal);
            long state = await RetirePatternAsync(
                KeyPattern("security:perception-v3:*"),
                key => IsChallengeStateKey(key),
                request.DryRun,
                retired,
                cancellationToken).ConfigureAwait(false);
            long active = await RetirePatternAsync(
                KeyPattern("security:perception-v3-active:*"),
                static _ => true,
                request.DryRun,
                retired,
                cancellationToken).ConfigureAwait(false);
            long device = await RetirePatternAsync(
                KeyPattern("security:perception-v3-device:*"),
                static _ => true,
                request.DryRun,
                retired,
                cancellationToken).ConfigureAwait(false);
            device += await RetirePatternAsync(
                KeyPattern("security:perception-v3-device-ip:*"),
                static _ => true,
                request.DryRun,
                retired,
                cancellationToken).ConfigureAwait(false);
            long oldPoolGenerations = await RetireOldPoolGenerationsAsync(
                request.Target.PoolGeneration,
                request.DryRun,
                retired,
                cancellationToken).ConfigureAwait(false);
            (long examined, long revoked) = await RevokeEnvelopesAsync(
                request.DryRun,
                retired,
                cancellationToken).ConfigureAwait(false);
            long challengeRows = request.DryRun
                ? 0
                : await RevokeChallengeRowsAsync(cancellationToken).ConfigureAwait(false);

            var result = new PerceptionCharacterV3CutoverMutationResult(
                challengeRows,
                state,
                active,
                device,
                oldPoolGenerations,
                examined,
                revoked,
                DigestSet(retired));
            var envelope = new MutationEnvelope(requestFingerprint, result);
            bool saved = await ExecuteDatabaseAsync(
                database => database.StringSetAsync(
                    MutationKey(request.OperationId),
                    JsonSerializer.Serialize(envelope, s_jsonOptions),
                    expiry: null,
                    when: When.NotExists),
                cancellationToken).ConfigureAwait(false);
            if (!saved)
            {
                throw new InvalidOperationException("The V3 cutover mutation result collided with another operation.");
            }
            return result;
        }
        finally
        {
            await ReleaseLockAsync(request.OperationId).ConfigureAwait(false);
        }
    }

    public async Task<PerceptionCharacterV3CutoverReceipt> SaveReceiptAsync(
        PerceptionCharacterV3CutoverReceipt receipt,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        bool saved = await ExecuteDatabaseAsync(
            database => database.StringSetAsync(
                ReceiptKey(receipt.OperationId),
                JsonSerializer.Serialize(receipt, s_jsonOptions),
                expiry: null,
                when: When.NotExists),
            cancellationToken).ConfigureAwait(false);
        if (saved)
        {
            return receipt;
        }
        PerceptionCharacterV3CutoverReceipt existing = await ReadReceiptAsync(receipt.OperationId, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("The durable V3 cutover receipt disappeared.");
        if (!FixedEquals(existing.RequestFingerprint, receipt.RequestFingerprint)
            || !FixedEquals(existing.ReceiptFingerprint, receipt.ReceiptFingerprint))
        {
            throw new InvalidOperationException("The V3 cutover receipt conflicts with the existing operation.");
        }
        return existing with
        {
            Idempotent = true
        };
    }

    private async Task<long> RevokeChallengeRowsAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using IServiceScope scope = scopeFactory.CreateScope();
        ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        return await db.Updateable<SecurityChallenge>()
            .SetColumns(item => new SecurityChallenge
            {
                Status = SecurityChallengeStatuses.Revoked,
                RevokedAtUtc = DateTime.UtcNow,
                UpdatedAtUtc = DateTime.UtcNow
            })
            .Where(item =>
                item.Kind == PerceptionCharacterV3ReleaseTarget.WireName
                && item.Status == SecurityChallengeStatuses.Issued)
            .ExecuteCommandAsync()
            .ConfigureAwait(false);
    }

    private async Task<long> RetirePatternAsync(
        RedisValue pattern,
        Func<string, bool> predicate,
        bool dryRun,
        ISet<string> retired,
        CancellationToken cancellationToken)
    {
        long count = 0;
        foreach (RedisKey key in await ScanAsync(pattern, cancellationToken).ConfigureAwait(false))
        {
            string text = (string)key!;
            if (!predicate(text))
            {
                continue;
            }
            string digest = Hash(text);
            retired.Add(digest);
            count++;
            if (!dryRun)
            {
                await ExecuteDatabaseAsync(
                    database => database.KeyDeleteAsync(key),
                    cancellationToken).ConfigureAwait(false);
            }
        }
        return count;
    }

    private async Task<long> RetireOldPoolGenerationsAsync(
        string activeGeneration,
        bool dryRun,
        ISet<string> retired,
        CancellationToken cancellationToken)
    {
        var generations = new HashSet<string>(StringComparer.Ordinal);
        string marker = keyScope.PrefixKey("security:perception-v3-pool:");
        foreach (RedisKey key in await ScanAsync(
            KeyPattern("security:perception-v3-pool:*"),
            cancellationToken).ConfigureAwait(false))
        {
            string text = (string)key!;
            int start = text.IndexOf(marker, StringComparison.Ordinal);
            if (start < 0)
            {
                continue;
            }
            string suffix = text[(start + marker.Length)..];
            int separator = suffix.IndexOf(':');
            if (separator <= 0)
            {
                continue;
            }
            string generation = suffix[..separator];
            if (!FixedEquals(generation, activeGeneration))
            {
                generations.Add(generation);
            }
        }
        foreach (string generation in generations)
        {
            retired.Add(Hash(generation));
            if (dryRun)
            {
                continue;
            }
            foreach (RedisKey key in await ScanAsync(
                         KeyPattern($"security:perception-v3-pool:{generation}:*"),
                         cancellationToken).ConfigureAwait(false))
            {
                await ExecuteDatabaseAsync(
                    database => database.KeyDeleteAsync(key),
                    cancellationToken).ConfigureAwait(false);
            }
            await ExecuteDatabaseAsync(
                database => database.StringSetAsync(
                    keyScope.PrefixKey($"security:perception-v3-pool:{generation}:revoked"),
                    "retired-contract",
                    expiry: null,
                    when: When.Always),
                cancellationToken).ConfigureAwait(false);
        }
        return generations.Count;
    }

    private async Task<(long Examined, long Revoked)> RevokeEnvelopesAsync(
        bool dryRun,
        ISet<string> retired,
        CancellationToken cancellationToken)
    {
        long examined = 0;
        long revoked = 0;
        HashSet<string> target = [PerceptionCharacterV3ReleaseTarget.WireName];
        foreach (RedisKey key in await ScanAsync(EnvelopePattern(), cancellationToken).ConfigureAwait(false))
        {
            cancellationToken.ThrowIfCancellationRequested();
            examined++;
            RedisValue encoded = await ExecuteDatabaseAsync(
                database => database.HashGetAsync(key, EnvelopeDataField),
                cancellationToken).ConfigureAwait(false);
            if (!SecurityChallengeKindCutoverEnvelopeCodec.TryBuildRevocation(
                    (string?)encoded ?? string.Empty,
                    target,
                    out string replacement,
                    out string? envelopeId))
            {
                continue;
            }
            retired.Add(Hash(envelopeId!));
            revoked++;
            if (dryRun)
            {
                continue;
            }
            const string CompareAndReplace = """
local current = redis.call('HGET', KEYS[1], ARGV[1])
if current ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1
""";
            _ = await ExecuteDatabaseAsync(
                database => database.ScriptEvaluateAsync(
                    CompareAndReplace,
                    [key],
                    [EnvelopeDataField, encoded, replacement]),
                cancellationToken).ConfigureAwait(false);
        }
        return (examined, revoked);
    }

    private bool IsChallengeStateKey(string key)
    {
        string marker = keyScope.PrefixKey("security:perception-v3:");
        int start = key.IndexOf(marker, StringComparison.Ordinal);
        if (start < 0)
        {
            return false;
        }
        string suffix = key[(start + marker.Length)..];
        return suffix.Length == 36
            && Guid.TryParseExact(suffix, "D", out Guid challengeId)
            && challengeId.Version == 7;
    }

    private Task<RedisKey[]> ScanAsync(RedisValue pattern, CancellationToken cancellationToken)
        => redis.ExecuteAsync(
            RedisOperationPort.PerceptionCharacterCutover,
            async (multiplexer, deadlineToken) =>
            {
                var keys = new HashSet<RedisKey>();
                int databaseId = multiplexer.GetDatabase().Database;
                foreach (EndPoint endpoint in multiplexer.GetEndPoints())
                {
                    deadlineToken.ThrowIfCancellationRequested();
                    IServer server = multiplexer.GetServer(endpoint);
                    if (!server.IsConnected || server.ServerType == ServerType.Sentinel)
                    {
                        continue;
                    }
                    await foreach (RedisKey key in server.KeysAsync(
                        databaseId,
                        pattern,
                        pageSize: 250).WithCancellation(deadlineToken).ConfigureAwait(false))
                    {
                        keys.Add(key);
                    }
                }
                return keys.ToArray();
            },
            cancellationToken);

    private async Task ReleaseLockAsync(string operationId)
    {
        if (!_operationLocks.TryRemove(operationId, out string? token))
        {
            return;
        }
        const string Release = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
""";
        _ = await ExecuteDatabaseAsync(
            database => database.ScriptEvaluateAsync(
                Release,
                [LockKey(operationId)],
                [token]),
            CancellationToken.None).ConfigureAwait(false);
    }

    private Task<T> ExecuteDatabaseAsync<T>(
        Func<IDatabase, Task<T>> operation,
        CancellationToken cancellationToken)
        => redis.ExecuteAsync(
            RedisOperationPort.PerceptionCharacterCutover,
            (multiplexer, _) => operation(multiplexer.GetDatabase()),
            cancellationToken);

    private RedisValue KeyPattern(string suffix) => keyScope.PrefixKey(suffix);

    private RedisValue EnvelopePattern()
        => $"{_cacheInstancePrefix}{keyScope.PrefixKey("fsus:sec:challenge-envelope:envelope:*")}";

    private RedisKey ReceiptKey(string operationId)
        => keyScope.PrefixKey($"security:perception-v3-cutover:receipt:{operationId.Trim()}");

    private RedisKey MutationKey(string operationId)
        => keyScope.PrefixKey($"security:perception-v3-cutover:mutation:{operationId.Trim()}");

    private RedisKey LockKey(string operationId)
        => keyScope.PrefixKey($"security:perception-v3-cutover:lock:{operationId.Trim()}");

    private static string DigestSet(IEnumerable<string> values)
        => Hash(string.Join('\n', values.Order(StringComparer.Ordinal)));

    private static string Hash(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static bool FixedEquals(string left, string right)
    {
        byte[] a = Encoding.UTF8.GetBytes(left ?? string.Empty);
        byte[] b = Encoding.UTF8.GetBytes(right ?? string.Empty);
        return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
    }

    private sealed record MutationEnvelope(
        string RequestFingerprint,
        PerceptionCharacterV3CutoverMutationResult Result);
}
