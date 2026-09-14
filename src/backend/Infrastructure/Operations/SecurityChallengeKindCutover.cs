using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Operations;

public sealed record SecurityChallengeKindCutoverTarget(int NumericKind, string WireName);

public sealed record SecurityChallengeKindCutoverRequest(
    string OperationId,
    string ReleaseId,
    string Slot,
    long Generation,
    IReadOnlyList<SecurityChallengeKindCutoverTarget> Targets,
    bool DryRun = false);

public sealed record SecurityChallengeKindCutoverMutationResult(
    long V2AttemptKeys,
    long V2UsedKeys,
    long EnvelopesExamined,
    long EnvelopesRevoked,
    IReadOnlyList<string> RevokedEnvelopeIds);

public sealed record SecurityChallengeKindCutoverIntent(
    string OperationId,
    string RequestFingerprint,
    string TargetFingerprint,
    string ReleaseId,
    string Slot,
    long Generation,
    bool DryRun,
    DateTimeOffset PreparedAtUtc);

public sealed record SecurityChallengeKindCutoverPreparation(
    SecurityChallengeKindCutoverIntent Intent,
    string Status,
    SecurityChallengeKindCutoverReceipt? Receipt);

public sealed record SecurityChallengeKindCutoverReceipt(
    string SchemaVersion,
    string OperationId,
    string RequestFingerprint,
    string ReleaseId,
    string Slot,
    long Generation,
    IReadOnlyList<int> NumericKinds,
    string TargetFingerprint,
    bool DryRun,
    bool Accepted,
    bool Idempotent,
    string Status,
    string? ErrorCode,
    bool FenceVerifiedBefore,
    bool FenceVerifiedImmediatelyBeforeMutation,
    bool FenceVerifiedAfter,
    long V2AttemptKeys,
    long V2UsedKeys,
    long EnvelopesExamined,
    long EnvelopesRevoked,
    string RevokedEnvelopeIdsDigest,
    DateTimeOffset CompletedAtUtc);

public interface ISecurityChallengeKindCutoverStore
{
    Task<SecurityChallengeKindCutoverPreparation> PrepareAsync(
        SecurityChallengeKindCutoverIntent intent,
        CancellationToken cancellationToken = default);

    Task<SecurityChallengeKindCutoverMutationResult> ApplyAsync(
        SecurityChallengeKindCutoverRequest request,
        CancellationToken cancellationToken = default);

    Task<SecurityChallengeKindCutoverMutationResult> ReadMutationResultAsync(
        string operationId,
        CancellationToken cancellationToken = default);

    Task<SecurityChallengeKindCutoverReceipt?> ReadReceiptAsync(
        string operationId,
        CancellationToken cancellationToken = default);

    Task MarkStatusAsync(
        string operationId,
        string requestFingerprint,
        string status,
        CancellationToken cancellationToken = default);

    Task<SecurityChallengeKindCutoverReceipt> SaveReceiptAsync(
        SecurityChallengeKindCutoverReceipt receipt,
        CancellationToken cancellationToken = default);
}

public sealed class SecurityChallengeKindCutover(
    IActiveReleaseFence activeReleaseFence,
    ISecurityChallengeKindCutoverStore store,
    TimeProvider timeProvider)
{
    public const string ReceiptSchemaVersion = "fsus.security-challenge-kind-cutover-receipt.v1";
    public const string PreparedStatus = "prepared";
    public const string MutationStartedStatus = "mutation-started";
    public const string MutationRecordedStatus = "mutation-recorded";
    public const string FenceLostAfterMutationStatus = "fence-lost-after-mutation";
    public const string ExpectedTargetFingerprint = "48e9440c0b09fcd494d11f3773d7190f703bcb1295c171c3242ea9d3ea484c19";
    private static readonly int[] s_expectedNumericKinds = [3, 10, 13];

    public async Task<SecurityChallengeKindCutoverReceipt> ExecuteAsync(
        SecurityChallengeKindCutoverRequest request,
        CancellationToken cancellationToken = default)
    {
        ValidatedRequest validated = Validate(request);
        var intent = new SecurityChallengeKindCutoverIntent(
            validated.Request.OperationId,
            validated.Fingerprint,
            validated.TargetFingerprint,
            validated.Request.ReleaseId,
            validated.Request.Slot,
            validated.Request.Generation,
            validated.Request.DryRun,
            timeProvider.GetUtcNow());
        SecurityChallengeKindCutoverPreparation preparation = await store
            .PrepareAsync(intent, cancellationToken)
            .ConfigureAwait(false);
        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(preparation.Intent.RequestFingerprint),
                Encoding.UTF8.GetBytes(validated.Fingerprint))
            || !CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(preparation.Intent.TargetFingerprint),
                Encoding.UTF8.GetBytes(validated.TargetFingerprint)))
        {
            throw new InvalidOperationException("The cutover operation id is already bound to a different request.");
        }

        if (preparation.Receipt is not null)
        {
            return preparation.Receipt with
            {
                Idempotent = true
            };
        }

        if (string.Equals(preparation.Status, FenceLostAfterMutationStatus, StringComparison.Ordinal))
        {
            SecurityChallengeKindCutoverMutationResult recorded = await store
                .ReadMutationResultAsync(validated.Request.OperationId, cancellationToken)
                .ConfigureAwait(false);
            return await SaveAsync(
                validated,
                accepted: false,
                status: "manual-blocked-fence-lost-after-mutation",
                errorCode: "active_release_fence_changed_after_mutation",
                fenceVerifiedBefore: true,
                fenceVerifiedImmediatelyBeforeMutation: true,
                fenceVerifiedAfter: false,
                recorded,
                cancellationToken).ConfigureAwait(false);
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
            return await SaveAsync(
                validated,
                accepted: false,
                status: "rejected",
                errorCode: before.ErrorCode ?? "active_release_fence_rejected",
                fenceVerifiedBefore: false,
                fenceVerifiedImmediatelyBeforeMutation: false,
                fenceVerifiedAfter: false,
                EmptyMutation(),
                cancellationToken).ConfigureAwait(false);
        }

        ActiveReleaseFenceOperationResult immediatelyBeforeMutation = await activeReleaseFence
            .VerifyAsync(fenceRequest, cancellationToken)
            .ConfigureAwait(false);
        if (!immediatelyBeforeMutation.Accepted)
        {
            return await SaveAsync(
                validated,
                accepted: false,
                status: "fence-lost-before-mutation",
                errorCode: immediatelyBeforeMutation.ErrorCode ?? "active_release_fence_changed",
                fenceVerifiedBefore: true,
                fenceVerifiedImmediatelyBeforeMutation: false,
                fenceVerifiedAfter: false,
                EmptyMutation(),
                cancellationToken).ConfigureAwait(false);
        }

        SecurityChallengeKindCutoverMutationResult mutation = string.Equals(
            preparation.Status,
            MutationRecordedStatus,
            StringComparison.Ordinal)
            ? await store.ReadMutationResultAsync(validated.Request.OperationId, cancellationToken).ConfigureAwait(false)
            : await store.ApplyAsync(validated.Request, cancellationToken).ConfigureAwait(false);
        ActiveReleaseFenceOperationResult after = await activeReleaseFence
            .VerifyAsync(fenceRequest, cancellationToken)
            .ConfigureAwait(false);
        if (!after.Accepted)
        {
            await store.MarkStatusAsync(
                validated.Request.OperationId,
                validated.Fingerprint,
                FenceLostAfterMutationStatus,
                cancellationToken).ConfigureAwait(false);
            return await SaveAsync(
                validated,
                accepted: false,
                status: "manual-blocked-fence-lost-after-mutation",
                errorCode: after.ErrorCode ?? "active_release_fence_changed_after_mutation",
                fenceVerifiedBefore: true,
                fenceVerifiedImmediatelyBeforeMutation: true,
                fenceVerifiedAfter: false,
                mutation,
                cancellationToken).ConfigureAwait(false);
        }

        return await SaveAsync(
            validated,
            accepted: true,
            status: validated.Request.DryRun ? "would-apply" : "applied",
            errorCode: null,
            fenceVerifiedBefore: true,
            fenceVerifiedImmediatelyBeforeMutation: true,
            fenceVerifiedAfter: true,
            mutation,
            cancellationToken).ConfigureAwait(false);
    }

    private async Task<SecurityChallengeKindCutoverReceipt> SaveAsync(
        ValidatedRequest validated,
        bool accepted,
        string status,
        string? errorCode,
        bool fenceVerifiedBefore,
        bool fenceVerifiedImmediatelyBeforeMutation,
        bool fenceVerifiedAfter,
        SecurityChallengeKindCutoverMutationResult mutation,
        CancellationToken cancellationToken)
    {
        var receipt = new SecurityChallengeKindCutoverReceipt(
            ReceiptSchemaVersion,
            validated.Request.OperationId,
            validated.Fingerprint,
            validated.Request.ReleaseId,
            validated.Request.Slot,
            validated.Request.Generation,
            validated.Request.Targets.Select(static target => target.NumericKind).Order().ToArray(),
            validated.TargetFingerprint,
            validated.Request.DryRun,
            accepted,
            Idempotent: false,
            status,
            errorCode,
            fenceVerifiedBefore,
            fenceVerifiedImmediatelyBeforeMutation,
            fenceVerifiedAfter,
            mutation.V2AttemptKeys,
            mutation.V2UsedKeys,
            mutation.EnvelopesExamined,
            mutation.EnvelopesRevoked,
            ComputeStringSetDigest(mutation.RevokedEnvelopeIds),
            timeProvider.GetUtcNow());
        return await store.SaveReceiptAsync(receipt, cancellationToken).ConfigureAwait(false);
    }

    private static ValidatedRequest Validate(SecurityChallengeKindCutoverRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        string operationId = NormalizeRequired(request.OperationId, nameof(request.OperationId));
        string releaseId = NormalizeRequired(request.ReleaseId, nameof(request.ReleaseId));
        string slot = NormalizeRequired(request.Slot, nameof(request.Slot));
        if (request.Generation <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(request.Generation));
        }
        if (request.Targets is null || request.Targets.Count == 0)
        {
            throw new ArgumentException("At least one numeric challenge kind is required.", nameof(request.Targets));
        }

        SecurityChallengeKindCutoverTarget[] targets = request.Targets
            .Select(static target => new SecurityChallengeKindCutoverTarget(
                target.NumericKind,
                NormalizeRequired(target.WireName, nameof(target.WireName))))
            .OrderBy(static target => target.NumericKind)
            .ThenBy(static target => target.WireName, StringComparer.Ordinal)
            .ToArray();
        if (targets.Any(static target => target.NumericKind <= 0)
            || targets.Select(static target => target.NumericKind).Distinct().Count() != targets.Length
            || targets.Select(static target => target.WireName).Distinct(StringComparer.Ordinal).Count() != targets.Length)
        {
            throw new ArgumentException("Challenge kind numbers and wire names must be positive and unique.", nameof(request.Targets));
        }
        if (!targets.Select(static target => target.NumericKind).SequenceEqual(s_expectedNumericKinds))
        {
            throw new ArgumentException("Challenge kind numbers must match the complete retired numeric set.", nameof(request.Targets));
        }
        string targetFingerprint = ComputeTargetFingerprint(targets);
        if (!string.Equals(targetFingerprint, ExpectedTargetFingerprint, StringComparison.Ordinal))
        {
            throw new ArgumentException("Challenge kind target mapping is not the authoritative retired mapping.", nameof(request.Targets));
        }

        var normalized = request with
        {
            OperationId = operationId,
            ReleaseId = releaseId,
            Slot = slot,
            Targets = targets
        };
        string canonical = JsonSerializer.Serialize(new
        {
            normalized.OperationId,
            normalized.ReleaseId,
            normalized.Slot,
            normalized.Generation,
            targets,
            normalized.DryRun
        });
        string fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
        return new ValidatedRequest(normalized, fingerprint, targetFingerprint);
    }

    public static string ComputeTargetFingerprint(IEnumerable<SecurityChallengeKindCutoverTarget> targets)
    {
        ArgumentNullException.ThrowIfNull(targets);
        string canonical = string.Concat(targets
            .OrderBy(static target => target.NumericKind)
            .ThenBy(static target => target.WireName, StringComparer.Ordinal)
            .Select(static target => $"{target.NumericKind.ToString(System.Globalization.CultureInfo.InvariantCulture)}\0{target.WireName}\n"));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }

    private static string ComputeStringSetDigest(IEnumerable<string> values)
    {
        string canonical = string.Join('\n', values.Order(StringComparer.Ordinal));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }

    private static string NormalizeRequired(string value, string parameterName)
    {
        string normalized = (value ?? string.Empty).Trim();
        return normalized.Length > 0
            ? normalized
            : throw new ArgumentException("A non-empty value is required.", parameterName);
    }

    private static SecurityChallengeKindCutoverMutationResult EmptyMutation()
        => new(0, 0, 0, 0, []);

    private sealed record ValidatedRequest(
        SecurityChallengeKindCutoverRequest Request,
        string Fingerprint,
        string TargetFingerprint);
}

public static class SecurityChallengeKindCutoverEnvelopeCodec
{
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);

    public static bool TryBuildRevocation(
        string encoded,
        IReadOnlySet<string> targetWires,
        out string replacement,
        out string? envelopeId)
    {
        ArgumentNullException.ThrowIfNull(targetWires);
        replacement = string.Empty;
        envelopeId = null;
        if (!TryDecode(encoded, out SecurityChallengeEnvelopeState? state)
            || state is null
            || !state.RequiredKinds.Any(targetWires.Contains)
            || (!string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Active, StringComparison.Ordinal)
                && !string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.ProofMinting, StringComparison.Ordinal)))
        {
            return false;
        }

        var revoked = state with
        {
            MemberStatuses = Enumerable.Repeat(SecurityChallengeEnvelopeMemberStatuses.Revoked, state.MemberCount).ToArray(),
            Status = SecurityChallengeEnvelopeStatuses.Revoked,
            Version = checked(state.Version + 1),
            TerminalReason = "challenge_kind_cutover",
            ProofToken = null,
            ProofNonce = null,
            ProofIssuedAtUnixMs = null,
            ProofExpiresAtUnixMs = null
        };
        replacement = Encode(revoked);
        envelopeId = state.EnvelopeId;
        return true;
    }

    public static bool TryDecode(string encoded, out SecurityChallengeEnvelopeState? state)
    {
        state = null;
        try
        {
            string[] parts = (encoded ?? string.Empty).Split('|', 3, StringSplitOptions.None);
            if (parts.Length != 3 || !string.Equals(parts[0], "v1", StringComparison.Ordinal))
            {
                return false;
            }
            string payload = parts[2].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight((payload.Length + 3) / 4 * 4, '=');
            state = JsonSerializer.Deserialize<SecurityChallengeEnvelopeState>(Convert.FromBase64String(payload), s_jsonOptions);
            return state is not null
                && state.RequiredKinds is not null
                && state.RequiredKinds.Length == state.MemberCount;
        }
        catch (Exception error) when (error is JsonException or FormatException)
        {
            return false;
        }
    }

    public static string Encode(SecurityChallengeEnvelopeState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        byte[] json = JsonSerializer.SerializeToUtf8Bytes(state, s_jsonOptions);
        string payload = Convert.ToBase64String(json).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return $"v1|{state.Version.ToString(System.Globalization.CultureInfo.InvariantCulture)}|{payload}";
    }
}

public sealed class RedisSecurityChallengeKindCutoverStore(
    IRedisOperationExecutor redis,
    IRuntimeKeyScope keyScope,
    IConfiguration configuration) : ISecurityChallengeKindCutoverStore
{
    private const string EnvelopeDataField = "data";
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);
    private readonly string _cacheInstancePrefix = configuration["RedisOptions:InstanceName"] ?? "FsusBlog_";
    private readonly ConcurrentDictionary<string, string> _operationLocks = new(StringComparer.Ordinal);

    public async Task<SecurityChallengeKindCutoverPreparation> PrepareAsync(
        SecurityChallengeKindCutoverIntent intent,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(intent);
        cancellationToken.ThrowIfCancellationRequested();
        string json = JsonSerializer.Serialize(intent, s_jsonOptions);
        bool stored = await ExecuteDatabaseAsync(
            database => database.StringSetAsync(
                IntentKey(intent.OperationId),
                json,
                expiry: null,
                when: When.NotExists),
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        SecurityChallengeKindCutoverIntent prepared = intent;
        if (!stored)
        {
            RedisValue existingValue = await ExecuteDatabaseAsync(
                database => database.StringGetAsync(IntentKey(intent.OperationId)),
                cancellationToken).ConfigureAwait(false);
            prepared = existingValue.HasValue
                ? JsonSerializer.Deserialize<SecurityChallengeKindCutoverIntent>((string)existingValue!, s_jsonOptions)
                    ?? throw new InvalidOperationException("The durable cutover intent is invalid.")
                : throw new InvalidOperationException("The durable cutover intent disappeared after preparation.");
            if (!string.Equals(prepared.RequestFingerprint, intent.RequestFingerprint, StringComparison.Ordinal)
                || !string.Equals(prepared.TargetFingerprint, intent.TargetFingerprint, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("The cutover operation id is already bound to a different request.");
            }
        }

        _ = await ExecuteDatabaseAsync(
            database => database.HashSetAsync(
                StateKey(intent.OperationId),
                "request_fingerprint",
                intent.RequestFingerprint,
                When.NotExists),
            cancellationToken).ConfigureAwait(false);
        _ = await ExecuteDatabaseAsync(
            database => database.HashSetAsync(
                StateKey(intent.OperationId),
                "status",
                SecurityChallengeKindCutover.PreparedStatus,
                When.NotExists),
            cancellationToken).ConfigureAwait(false);
        RedisValue stateFingerprint = await ExecuteDatabaseAsync(
            database => database.HashGetAsync(
                StateKey(intent.OperationId),
                "request_fingerprint"),
            cancellationToken).ConfigureAwait(false);
        if (!stateFingerprint.HasValue
            || !string.Equals((string)stateFingerprint!, intent.RequestFingerprint, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("The durable cutover operation state does not match the request.");
        }

        SecurityChallengeKindCutoverReceipt? receipt = await ReadReceiptAsync(intent.OperationId, cancellationToken)
            .ConfigureAwait(false);
        RedisValue status = await ExecuteDatabaseAsync(
            database => database.HashGetAsync(StateKey(intent.OperationId), "status"),
            cancellationToken).ConfigureAwait(false);
        return new SecurityChallengeKindCutoverPreparation(
            prepared,
            status.HasValue ? (string)status! : SecurityChallengeKindCutover.PreparedStatus,
            receipt);
    }

    public async Task<SecurityChallengeKindCutoverMutationResult> ApplyAsync(
        SecurityChallengeKindCutoverRequest request,
        CancellationToken cancellationToken = default)
    {
        string lockToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        bool lockAcquired = await ExecuteDatabaseAsync(
            database => database.StringSetAsync(
                LockKey(request.OperationId),
                lockToken,
                TimeSpan.FromMinutes(2),
                When.NotExists),
            cancellationToken).ConfigureAwait(false);
        if (!lockAcquired)
        {
            throw new InvalidOperationException("The cutover operation is already in progress; retry with the same operation id.");
        }
        _operationLocks[request.OperationId] = lockToken;
        await MarkStatusAsync(
            request.OperationId,
            RequestFingerprint(request),
            SecurityChallengeKindCutover.MutationStartedStatus,
            cancellationToken).ConfigureAwait(false);

        HashSet<string> targetWires = request.Targets
            .Select(static target => target.WireName)
            .ToHashSet(StringComparer.Ordinal);
        RedisKey[] attemptKeys = await ScanAsync(KeyPattern("security:challenge:v2:attempt:*"), cancellationToken).ConfigureAwait(false);
        RedisKey[] usedKeys = await ScanAsync(KeyPattern("security:challenge:v2:used:*"), cancellationToken).ConfigureAwait(false);
        RedisKey[] envelopeKeys = await ScanAsync(EnvelopePattern(), cancellationToken).ConfigureAwait(false);

        foreach (RedisKey key in attemptKeys)
        {
            if (request.DryRun)
            {
                await ExecuteDatabaseAsync(
                    database => database.SetAddAsync(AttemptAuditKey(request.OperationId), Fingerprint((string)key!)),
                    cancellationToken)
                    .ConfigureAwait(false);
            }
            else
            {
                await DeleteWithAuditAsync(key, AttemptAuditKey(request.OperationId), cancellationToken).ConfigureAwait(false);
            }
        }
        foreach (RedisKey key in usedKeys)
        {
            if (request.DryRun)
            {
                await ExecuteDatabaseAsync(
                    database => database.SetAddAsync(UsedAuditKey(request.OperationId), Fingerprint((string)key!)),
                    cancellationToken)
                    .ConfigureAwait(false);
            }
            else
            {
                await DeleteWithAuditAsync(key, UsedAuditKey(request.OperationId), cancellationToken).ConfigureAwait(false);
            }
        }

        foreach (RedisKey key in envelopeKeys)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await ExecuteDatabaseAsync(
                database => database.SetAddAsync(
                    ExaminedEnvelopeAuditKey(request.OperationId),
                    Fingerprint((string)key!)),
                cancellationToken).ConfigureAwait(false);
            RedisValue encoded = await ExecuteDatabaseAsync(
                database => database.HashGetAsync(key, EnvelopeDataField),
                cancellationToken).ConfigureAwait(false);
            if (!SecurityChallengeKindCutoverEnvelopeCodec.TryBuildRevocation(
                    (string?)encoded ?? string.Empty,
                    targetWires,
                    out string replacement,
                    out string? envelopeId))
            {
                continue;
            }

            string envelopeDigest = Fingerprint(envelopeId!);
            if (request.DryRun)
            {
                await ExecuteDatabaseAsync(
                    database => database.SetAddAsync(RevokedEnvelopeAuditKey(request.OperationId), envelopeDigest),
                    cancellationToken)
                    .ConfigureAwait(false);
            }
            else
            {
                const string CompareAndReplace = """
local current = redis.call('HGET', KEYS[1], ARGV[1])
if current ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('SADD', KEYS[2], ARGV[4])
return 1
""";
                _ = await ExecuteDatabaseAsync(
                    database => database.ScriptEvaluateAsync(
                        CompareAndReplace,
                        [key, RevokedEnvelopeAuditKey(request.OperationId)],
                        [EnvelopeDataField, encoded, replacement, envelopeDigest]),
                    cancellationToken).ConfigureAwait(false);
            }
        }

        await MarkStatusAsync(
            request.OperationId,
            RequestFingerprint(request),
            SecurityChallengeKindCutover.MutationRecordedStatus,
            cancellationToken).ConfigureAwait(false);
        return await ReadMutationResultAsync(request.OperationId, cancellationToken).ConfigureAwait(false);
    }

    public async Task<SecurityChallengeKindCutoverMutationResult> ReadMutationResultAsync(
        string operationId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        (long attemptCount, long usedCount, long examinedCount, RedisValue[] revokedMembers) = await redis.ExecuteAsync(
            RedisOperationPort.SecurityChallengeKindCutover,
            async (multiplexer, _) =>
            {
                IDatabase database = multiplexer.GetDatabase();
                Task<long> attemptCount = database.SetLengthAsync(AttemptAuditKey(operationId));
                Task<long> usedCount = database.SetLengthAsync(UsedAuditKey(operationId));
                Task<long> examinedCount = database.SetLengthAsync(ExaminedEnvelopeAuditKey(operationId));
                Task<RedisValue[]> revokedMembers = database.SetMembersAsync(RevokedEnvelopeAuditKey(operationId));
                await Task.WhenAll(attemptCount, usedCount, examinedCount, revokedMembers).ConfigureAwait(false);
                return (
                    await attemptCount.ConfigureAwait(false),
                    await usedCount.ConfigureAwait(false),
                    await examinedCount.ConfigureAwait(false),
                    await revokedMembers.ConfigureAwait(false));
            },
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        string[] revokedDigests = revokedMembers.Select(static value => (string)value!).ToArray();
        return new SecurityChallengeKindCutoverMutationResult(
            attemptCount,
            usedCount,
            examinedCount,
            revokedDigests.LongLength,
            revokedDigests);
    }

    public async Task MarkStatusAsync(
        string operationId,
        string requestFingerprint,
        string status,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        const string UpdateStatus = """
local fingerprint = redis.call('HGET', KEYS[1], 'request_fingerprint') or ''
if fingerprint ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2])
return 1
""";
        RedisResult changed = await ExecuteDatabaseAsync(
            database => database.ScriptEvaluateAsync(
                UpdateStatus,
                [StateKey(operationId)],
                [requestFingerprint, status]),
            cancellationToken).ConfigureAwait(false);
        if ((long)changed != 1)
        {
            throw new InvalidOperationException("The durable cutover operation state does not match the request.");
        }
    }

    public async Task<SecurityChallengeKindCutoverReceipt> SaveReceiptAsync(
        SecurityChallengeKindCutoverReceipt receipt,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string json = JsonSerializer.Serialize(receipt, s_jsonOptions);
        bool stored = await ExecuteDatabaseAsync(
            database => database.StringSetAsync(
                ReceiptKey(receipt.OperationId),
                json,
                expiry: null,
                when: When.NotExists),
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        SecurityChallengeKindCutoverReceipt saved;
        if (stored)
        {
            saved = receipt;
        }
        else
        {
            SecurityChallengeKindCutoverReceipt existing = await ReadReceiptAsync(receipt.OperationId, cancellationToken)
                .ConfigureAwait(false)
                ?? throw new InvalidOperationException("The cutover receipt disappeared after an idempotency collision.");
            if (!string.Equals(existing.RequestFingerprint, receipt.RequestFingerprint, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("The cutover operation id is already bound to a different request.");
            }
            saved = existing with
            {
                Idempotent = true
            };
        }

        await ReleaseLockAsync(receipt.OperationId).ConfigureAwait(false);
        return saved;
    }

    private async Task ReleaseLockAsync(string operationId)
    {
        if (!_operationLocks.TryRemove(operationId, out string? lockToken))
        {
            return;
        }
        const string Release = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
""";
        _ = await ExecuteDatabaseAsync(
                database => database.ScriptEvaluateAsync(Release, [LockKey(operationId)], [lockToken]),
                CancellationToken.None)
            .ConfigureAwait(false);
    }

    private Task<RedisKey[]> ScanAsync(RedisValue pattern, CancellationToken cancellationToken)
        => redis.ExecuteAsync(
            RedisOperationPort.SecurityChallengeKindCutover,
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

    private async Task DeleteWithAuditAsync(
        RedisKey key,
        RedisKey auditKey,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        const string DeleteWithAudit = """
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[1])
return 1
""";
        _ = await ExecuteDatabaseAsync(
            database => database.ScriptEvaluateAsync(
                DeleteWithAudit,
                [key, auditKey],
                [Fingerprint((string)key!)]),
            cancellationToken).ConfigureAwait(false);
    }

    private static string RequestFingerprint(SecurityChallengeKindCutoverRequest request)
    {
        string canonical = JsonSerializer.Serialize(new
        {
            request.OperationId,
            request.ReleaseId,
            request.Slot,
            request.Generation,
            targets = request.Targets,
            request.DryRun
        });
        return Fingerprint(canonical);
    }

    private static string Fingerprint(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private RedisValue KeyPattern(string suffix) => keyScope.PrefixKey(suffix);

    private RedisValue EnvelopePattern()
        => $"{_cacheInstancePrefix}{keyScope.PrefixKey("fsus:sec:challenge-envelope:envelope:*")}";

    private RedisKey ReceiptKey(string operationId)
        => keyScope.PrefixKey($"fsus:security:challenge-kind-cutover:receipt:{operationId.Trim()}");

    private RedisKey IntentKey(string operationId)
        => keyScope.PrefixKey($"fsus:security:challenge-kind-cutover:intent:{operationId.Trim()}");

    private RedisKey StateKey(string operationId)
        => keyScope.PrefixKey($"fsus:security:challenge-kind-cutover:state:{operationId.Trim()}");

    private RedisKey AttemptAuditKey(string operationId)
        => keyScope.PrefixKey($"fsus:security:challenge-kind-cutover:audit:{operationId.Trim()}:attempt");

    private RedisKey UsedAuditKey(string operationId)
        => keyScope.PrefixKey($"fsus:security:challenge-kind-cutover:audit:{operationId.Trim()}:used");

    private RedisKey ExaminedEnvelopeAuditKey(string operationId)
        => keyScope.PrefixKey($"fsus:security:challenge-kind-cutover:audit:{operationId.Trim()}:examined");

    private RedisKey RevokedEnvelopeAuditKey(string operationId)
        => keyScope.PrefixKey($"fsus:security:challenge-kind-cutover:audit:{operationId.Trim()}:revoked");

    private RedisKey LockKey(string operationId)
        => keyScope.PrefixKey($"fsus:security:challenge-kind-cutover:lock:{operationId.Trim()}");

    public async Task<SecurityChallengeKindCutoverReceipt?> ReadReceiptAsync(
        string operationId,
        CancellationToken cancellationToken)
    {
        RedisValue value = await ExecuteDatabaseAsync(
            database => database.StringGetAsync(ReceiptKey(operationId)),
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return value.HasValue
            ? JsonSerializer.Deserialize<SecurityChallengeKindCutoverReceipt>((string)value!, s_jsonOptions)
            : null;
    }

    private Task<T> ExecuteDatabaseAsync<T>(
        Func<IDatabase, Task<T>> operation,
        CancellationToken cancellationToken)
        => redis.ExecuteAsync(
            RedisOperationPort.SecurityChallengeKindCutover,
            (multiplexer, _) => operation(multiplexer.GetDatabase()),
            cancellationToken);
}
