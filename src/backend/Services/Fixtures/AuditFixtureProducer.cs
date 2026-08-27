// fixture-catalog: producer audit-records
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Models.Dtos;

using SqlSugar;

namespace FsusBlog.Server.Services.Fixtures;

public static class AuditFixtureCapabilities
{
    public const string Empty = "audit.empty";
    public const string SingleValid = "audit.single-valid";
    public const string ChainMultiRecord = "audit.chain-multi-record";
    public const string HighValue = "audit.high-value";
    public const string LegalHoldEligible = "audit.legal-hold-eligible";
    public const string PseudonymRetention = "audit.pseudonym-retention";
    public const string InvestigationPage = "audit.investigation-page";
    public const string TamperNegative = "audit.tamper-negative";
    public const string UnknownActionNegative = "audit.unknown-action-negative";

    public static IReadOnlySet<string> All
    {
        get;
    } = new HashSet<string>(StringComparer.Ordinal)
    {
        ChainMultiRecord,
        Empty,
        HighValue,
        InvestigationPage,
        LegalHoldEligible,
        PseudonymRetention,
        SingleValid,
        TamperNegative,
        UnknownActionNegative
    };
}

public sealed record AuditFixtureRequest(
    string Namespace,
    string RunId,
    DateTimeOffset BusinessEpochUtc,
    IReadOnlyList<string> Capabilities,
    int ScaleRecordCount = 0,
    JsonElement? TemporalContext = null);

public sealed record AuditFixtureRecordEvidence(
    string Identity,
    string Capability,
    string Action,
    string ChainId,
    string? PreviousHash,
    string RecordHash,
    string RecordMacDigest,
    string SemanticDigest,
    bool HighValue,
    bool PayloadProtected);

public sealed record AuditFixtureNegativeEvidence(
    string MutationId,
    string MutatedField,
    string ExpectedReason,
    string ActualReason,
    bool Isolated,
    string SourceRecordDigest,
    string MutatedRecordDigest,
    string Isolation,
    string ContentDigest);

public sealed record AuditFixturePerformanceEvidence(
    int RecordCount,
    int BatchCount,
    int MaximumBatchSize,
    double ElapsedMilliseconds);

public sealed record AuditFixtureRetentionEvidence(
    string Action,
    long MaximumFullRecordAgeSeconds,
    long MaximumPseudonymAgeSeconds,
    long AggregateAfterSeconds,
    bool LegalHoldAllowed,
    string BeforeBoundaryUtc,
    string AtBoundaryUtc,
    string AfterBoundaryUtc,
    bool EligibleHoldActiveBeforeExpiry,
    bool EligibleHoldInactiveAtExpiry,
    string IneligibleHoldReason);

public sealed record AuditFixtureQueryEvidence(
    int Total,
    int FirstPageCount,
    int SecondPageCount,
    bool CursorBound,
    bool OrderedDescending,
    bool PiiRedacted,
    bool ChainVerified,
    string ProjectionDigest);

public sealed record AuditFixtureAuthorityEvidence(
    string ActionCatalog,
    string Store,
    string Protector,
    string Signer,
    string Query,
    string TemporalAuthority,
    string CommandDigest);

public sealed record AuditFixturePrivacyEvidence(
    int ProtectedRecordCount,
    bool PlaintextDetected,
    string ProjectionDigest);

public sealed record AuditFixtureReceipt(
    string Schema,
    string ProducerId,
    string Strategy,
    string Owner,
    IReadOnlyList<string> Capabilities,
    IReadOnlyList<AuditFixtureRecordEvidence> Records,
    IReadOnlyList<AuditFixtureNegativeEvidence> NegativeCases,
    IReadOnlyList<AuditFixtureRetentionEvidence> Retention,
    AuditFixtureQueryEvidence? Query,
    AuditFixtureAuthorityEvidence Authorities,
    AuditFixturePrivacyEvidence Privacy,
    AuditFixturePerformanceEvidence Performance,
    string PolicyDigest,
    string SemanticRecordSetDigest,
    string ContentDigest,
    string Status,
    IReadOnlyList<string> Warnings);

/// <summary>
/// Test-only audit composition root. Positive records use the production store,
/// retention protector and tamper signer. Reads and cleanup are source-owned.
/// </summary>
public interface IAuditFixtureProducer
{
    Task<AuditFixtureReceipt> PrepareAsync(
        AuditFixtureRequest request,
        CancellationToken cancellationToken = default);

    Task CleanupAsync(
        string fixtureNamespace,
        string runId,
        CancellationToken cancellationToken = default);
}

public sealed class AuditFixtureProducer(
    IAuditLogStore store,
    ISqlSugarClient db,
    IConfiguration configuration,
    AuditQueryService? queryService = null) : IAuditFixtureProducer
{
    public const string ProducerId = "audit-records";
    public const string Strategy = "transaction-fixture";
    public const string ReceiptSchema = "fsusblog.audit-fixture-receipt.v1";
    private const int MaximumBatchSize = 100;
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);
    private readonly byte[]? _tamperKey = AuditTamperEvidence.ResolveKey(configuration);

    public async Task<AuditFixtureReceipt> PrepareAsync(
        AuditFixtureRequest request,
        CancellationToken cancellationToken = default)
    {
        AuditFixturePlan plan = BuildPlan(request);
        string[] plannedChainIds = plan.Records
            .Select(static item => NormalizeUtc(item.OccurredAtUtc).ToString("yyyyMMdd", CultureInfo.InvariantCulture))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        await CleanupOwnedAsync(plan.Owner, cancellationToken, plannedChainIds).ConfigureAwait(false);
        long startedAt = Stopwatch.GetTimestamp();
        try
        {
            int batchCount = 0;
            foreach (AuditRecord[] batch in plan.Records.Chunk(MaximumBatchSize))
            {
                await store.WriteBatchAsync(batch, cancellationToken).ConfigureAwait(false);
                batchCount++;
            }

            List<AuditLog> rows = await ObserveOwnedAsync(plan.Owner, cancellationToken).ConfigureAwait(false);
            if (rows.Count != plan.Records.Count)
            {
                throw new InvalidOperationException(
                    $"audit_fixture_record_count_mismatch:expected={plan.Records.Count}:actual={rows.Count}");
            }

            IReadOnlyList<AuditFixtureRecordEvidence> evidence = VerifyPositiveRows(rows);
            IReadOnlyList<AuditFixtureNegativeEvidence> negatives = BuildNegativeEvidence(plan, rows);
            IReadOnlyList<AuditFixtureRetentionEvidence> retention = BuildRetentionEvidence(plan);
            AuditFixtureQueryEvidence? query = await BuildQueryEvidenceAsync(
                plan,
                cancellationToken).ConfigureAwait(false);
            AuditFixtureAuthorityEvidence authorities = BuildAuthorityEvidence(plan);
            AuditFixturePrivacyEvidence privacy = BuildPrivacyEvidence(rows);
            string policyDigest = ComputePolicyDigest(evidence.Select(static item => item.Action));
            string semanticRecordSetDigest = DigestJson(evidence.Select(static item => new
            {
                item.Capability,
                item.Action,
                item.ChainId,
                item.SemanticDigest,
                item.HighValue,
                item.PayloadProtected
            }).ToArray());
            double elapsedMilliseconds = Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds;
            var unsigned = new
            {
                schema = ReceiptSchema,
                producerId = ProducerId,
                strategy = Strategy,
                owner = plan.Owner,
                capabilities = plan.Capabilities,
                records = evidence,
                negativeCases = negatives,
                retention,
                query,
                authorities,
                privacy,
                performance = new AuditFixturePerformanceEvidence(
                    evidence.Count,
                    batchCount,
                    MaximumBatchSize,
                    elapsedMilliseconds),
                policyDigest,
                semanticRecordSetDigest,
                status = "verified",
                warnings = Array.Empty<string>()
            };
            return new AuditFixtureReceipt(
                ReceiptSchema,
                ProducerId,
                Strategy,
                plan.Owner,
                plan.Capabilities,
                evidence,
                negatives,
                retention,
                query,
                authorities,
                privacy,
                unsigned.performance,
                policyDigest,
                semanticRecordSetDigest,
                DigestJson(unsigned),
                "verified",
                []);
        }
        catch
        {
            await CleanupOwnedAsync(plan.Owner, CancellationToken.None, plannedChainIds).ConfigureAwait(false);
            throw;
        }
    }

    public Task CleanupAsync(
        string fixtureNamespace,
        string runId,
        CancellationToken cancellationToken = default)
        => CleanupOwnedAsync(ResolveOwner(fixtureNamespace, runId), cancellationToken);

    internal static AuditFixturePlan BuildPlan(AuditFixtureRequest request)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(request.Namespace);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.RunId);
        if (request.BusinessEpochUtc.Offset != TimeSpan.Zero)
        {
            throw new InvalidOperationException("audit_fixture_business_epoch_must_be_utc");
        }

        string[] capabilities = request.Capabilities
            .Select(static item => item?.Trim() ?? string.Empty)
            .Where(static item => item.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        string? unknown = capabilities.FirstOrDefault(id => !AuditFixtureCapabilities.All.Contains(id));
        if (unknown is not null)
        {
            throw new InvalidOperationException($"audit_fixture_capability_unknown:{unknown}");
        }
        if (capabilities.Contains(AuditFixtureCapabilities.Empty, StringComparer.Ordinal)
            && capabilities.Length != 1)
        {
            throw new InvalidOperationException("audit.empty cannot be combined with mutating capabilities");
        }
        if (request.ScaleRecordCount is < 0 or > 1000)
        {
            throw new ArgumentOutOfRangeException(nameof(request.ScaleRecordCount));
        }
        if (request.ScaleRecordCount > 0
            && capabilities.Any(static id => id is AuditFixtureCapabilities.TamperNegative
                or AuditFixtureCapabilities.UnknownActionNegative))
        {
            throw new InvalidOperationException("audit_fixture_scale_cannot_mix_negative_corpus");
        }

        string owner = ResolveOwner(request.Namespace, request.RunId);
        DateTime epoch = request.BusinessEpochUtc.UtcDateTime;
        var records = new List<AuditRecord>();
        void Add(
            string capability,
            string action,
            int offsetSeconds,
            bool highValue = false,
            bool sensitive = false)
        {
            AuditRetentionPolicy policy = AuditRetentionCatalog.GetRequired(action);
            DateTime occurredAt = epoch.AddSeconds(offsetSeconds);
            records.Add(new AuditRecord(
                AuditSourceCatalog.System,
                highValue ? AuditTypeCatalog.Audit : AuditTypeCatalog.Security,
                occurredAt,
                sensitive ? $"synthetic protected audit fixture {capability}" : $"audit fixture {capability}",
                sensitive ? Encoding.UTF8.GetBytes($"synthetic:{owner}:{capability}") : null,
                Action: policy.Action,
                Outcome: AuditOutcomeCatalog.Success,
                Severity: highValue ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Info,
                ActorType: AuditActorTypeCatalog.System,
                ActorId: sensitive ? owner : null,
                TargetType: ResolveOwnedTargetType(owner, capability),
                TargetId: null,
                IsHighValue: highValue,
                ReasonCode: capability,
                ContextJson: sensitive ? $"{{\"fixtureOwnerDigest\":\"{DigestText(owner)}\"}}" : null));
        }

        if (capabilities.Contains(AuditFixtureCapabilities.SingleValid, StringComparer.Ordinal))
        {
            Add(AuditFixtureCapabilities.SingleValid, AuditActionCatalog.LogRecorded, 0);
        }
        if (capabilities.Contains(AuditFixtureCapabilities.ChainMultiRecord, StringComparer.Ordinal))
        {
            Add(AuditFixtureCapabilities.ChainMultiRecord, AuditActionCatalog.AuthSelfServicePrincipalRejected, 10);
            Add(AuditFixtureCapabilities.ChainMultiRecord, AuditActionCatalog.AuthSelfServicePrincipalRejected, 10);
            Add(AuditFixtureCapabilities.ChainMultiRecord, AuditActionCatalog.AuthSelfServicePrincipalRejected, 11);
            Add(AuditFixtureCapabilities.ChainMultiRecord, AuditActionCatalog.AuthSelfServicePrincipalRejected, 86_410);
        }
        if (capabilities.Contains(AuditFixtureCapabilities.HighValue, StringComparer.Ordinal))
        {
            Add(AuditFixtureCapabilities.HighValue, AuditActionCatalog.SecurityPolicyActivated, 20, highValue: true);
        }
        if (capabilities.Contains(AuditFixtureCapabilities.LegalHoldEligible, StringComparer.Ordinal))
        {
            Add(AuditFixtureCapabilities.LegalHoldEligible, AuditActionCatalog.SecurityPolicyActivated, 30, highValue: true);
        }
        if (capabilities.Contains(AuditFixtureCapabilities.PseudonymRetention, StringComparer.Ordinal))
        {
            Add(AuditFixtureCapabilities.PseudonymRetention, AuditActionCatalog.PasskeyCounterRollback, 40, highValue: true, sensitive: true);
        }
        if (capabilities.Contains(AuditFixtureCapabilities.InvestigationPage, StringComparer.Ordinal))
        {
            for (int index = 0; index < 3; index++)
            {
                Add(AuditFixtureCapabilities.InvestigationPage, AuditActionCatalog.AuditQueried, 50 + index, highValue: true);
            }
        }
        if (capabilities.Contains(AuditFixtureCapabilities.TamperNegative, StringComparer.Ordinal)
            && !capabilities.Contains(AuditFixtureCapabilities.PseudonymRetention, StringComparer.Ordinal))
        {
            Add(AuditFixtureCapabilities.TamperNegative, AuditActionCatalog.PasskeyCounterRollback, 60, highValue: true, sensitive: true);
        }

        if (request.ScaleRecordCount > 0)
        {
            records.Clear();
            for (int index = 0; index < request.ScaleRecordCount; index++)
            {
                Add(AuditFixtureCapabilities.ChainMultiRecord, AuditActionCatalog.LogRecorded, 100 + index);
            }
        }

        if (capabilities.Contains(AuditFixtureCapabilities.UnknownActionNegative, StringComparer.Ordinal))
        {
            try
            {
                _ = AuditRetentionCatalog.GetRequired("fixture.unknown-action");
                throw new InvalidOperationException("audit_fixture_unknown_action_was_accepted");
            }
            catch (InvalidOperationException ex) when (
                ex.Message.StartsWith("audit_retention_policy_missing:", StringComparison.Ordinal))
            {
            }
        }

        return new AuditFixturePlan(owner, capabilities, records);
    }

    private async Task<List<AuditLog>> ObserveOwnedAsync(string owner, CancellationToken cancellationToken)
        => await db.Queryable<AuditLog>()
            .Where(item => item.TargetType!.StartsWith(owner + ":"))
            .OrderBy(item => item.OccurredAtUtc)
            .OrderBy(item => item.Id)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

    private IReadOnlyList<AuditFixtureRecordEvidence> VerifyPositiveRows(IReadOnlyList<AuditLog> rows)
    {
        var result = new List<AuditFixtureRecordEvidence>(rows.Count);
        var tails = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (AuditLog row in rows)
        {
            _ = AuditRetentionCatalog.GetRequired(row.Action);
            tails.TryGetValue(row.ChainId ?? string.Empty, out string? expectedPreviousHash);
            AuditTamperVerificationResult verification = AuditTamperEvidence.VerifyDetailed(
                row,
                _tamperKey,
                expectedPreviousHash);
            if (!verification.IsValid)
            {
                throw new InvalidOperationException(
                    $"audit_fixture_verification_failed:{row.Id}:{verification.Reason}:{verification.Field}");
            }
            tails[row.ChainId!] = row.RecordHash;
            result.Add(new AuditFixtureRecordEvidence(
                row.Id.ToString(CultureInfo.InvariantCulture),
                ResolveCapability(row),
                row.Action,
                row.ChainId!,
                row.PrevHash,
                row.RecordHash!,
                DigestText(row.RecordMac!),
                DigestJson(new
                {
                    row.Source,
                    row.Type,
                    occurredAtUtc = NormalizeUtc(row.OccurredAtUtc).ToString("O", CultureInfo.InvariantCulture),
                    row.Action,
                    row.Outcome,
                    row.Severity,
                    row.IsHighValue,
                    row.ChainId
                }),
                row.IsHighValue,
                row.ContextPayload is { Length: > 0 }
                    && string.Equals(
                        row.EventInfo,
                        AuditRetentionPayloadProtector.EncryptedEventInfo,
                        StringComparison.Ordinal)));
        }
        return result;
    }

    private static string ResolveCapability(AuditLog row)
    {
        string? capability = row.TargetType?.Split(':', 3) is { Length: 3 } parts
            ? parts[2]
            : null;
        if (capability is not null && AuditFixtureCapabilities.All.Contains(capability))
        {
            return capability;
        }
        throw new InvalidOperationException($"audit_fixture_capability_identity_missing:{row.Id}");
    }

    private IReadOnlyList<AuditFixtureNegativeEvidence> BuildNegativeEvidence(
        AuditFixturePlan plan,
        IReadOnlyList<AuditLog> rows)
    {
        var result = new List<AuditFixtureNegativeEvidence>();
        if (plan.Capabilities.Contains(AuditFixtureCapabilities.UnknownActionNegative, StringComparer.Ordinal))
        {
            var unsigned = new
            {
                mutationId = "unknown-action",
                mutatedField = "action",
                expectedReason = "audit_retention_policy_missing",
                actualReason = "audit_retention_policy_missing",
                isolated = true,
                sourceRecordDigest = DigestText("prewrite"),
                mutatedRecordDigest = DigestText("fixture.unknown-action"),
                isolation = "prewrite-production-catalog"
            };
            result.Add(new AuditFixtureNegativeEvidence(
                "unknown-action",
                "action",
                "audit_retention_policy_missing",
                "audit_retention_policy_missing",
                true,
                unsigned.sourceRecordDigest,
                unsigned.mutatedRecordDigest,
                unsigned.isolation,
                DigestJson(unsigned)));
        }
        if (!plan.Capabilities.Contains(AuditFixtureCapabilities.TamperNegative, StringComparer.Ordinal))
        {
            return result;
        }

        AuditLog source = rows.FirstOrDefault(static row => row.ContextPayload is { Length: > 0 })
            ?? throw new InvalidOperationException("audit_fixture_tamper_source_missing");
        foreach ((string mutationId, string field, AuditLog mutated, string expectedReason) in
            AuditFixtureNegativeCorpus.Create(source))
        {
            string actualReason = AuditFixtureNegativeCorpus.Verify(source, mutated, _tamperKey, field);
            if (!string.Equals(actualReason, expectedReason, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"audit_fixture_negative_reason_mismatch:{mutationId}:{expectedReason}:{actualReason}");
            }
            string sourceDigest = DigestAuditLog(source);
            string mutatedDigest = DigestAuditLog(mutated);
            var unsigned = new
            {
                mutationId,
                mutatedField = field,
                expectedReason,
                actualReason,
                isolated = true,
                sourceRecordDigest = sourceDigest,
                mutatedRecordDigest = mutatedDigest,
                isolation = "in-memory-run-owned-negative-corpus"
            };
            result.Add(new AuditFixtureNegativeEvidence(
                mutationId,
                field,
                expectedReason,
                actualReason,
                true,
                sourceDigest,
                mutatedDigest,
                unsigned.isolation,
                DigestJson(unsigned)));
        }
        return result;
    }

    private static IReadOnlyList<AuditFixtureRetentionEvidence> BuildRetentionEvidence(AuditFixturePlan plan)
    {
        if (!plan.Capabilities.Any(static capability => capability is AuditFixtureCapabilities.LegalHoldEligible
            or AuditFixtureCapabilities.PseudonymRetention))
        {
            return [];
        }

        DateTimeOffset epoch = new(plan.Records.Min(static item => NormalizeUtc(item.OccurredAtUtc)));
        var registry = new AuditLegalHoldRegistry(new AuditFixtureTimeProvider(epoch));
        AuditRetentionPolicy eligible = AuditRetentionCatalog.GetRequired(AuditActionCatalog.SecurityPolicyActivated);
        AuditLegalHold hold = registry.Approve(
            $"fixture-hold-{DigestText(plan.Owner)[..12]}",
            eligible.Action,
            "synthetic fixture retention verification",
            $"fixture-approval-{DigestText(plan.Owner)[..12]}",
            epoch.AddHours(1));
        string ineligibleReason;
        try
        {
            _ = registry.Approve(
                $"fixture-ineligible-{DigestText(plan.Owner)[..12]}",
                AuditActionCatalog.AnonymousCredentialIssued,
                "synthetic fixture ineligible verification",
                $"fixture-approval-{DigestText(plan.Owner)[..12]}",
                epoch.AddHours(1));
            ineligibleReason = "accepted";
        }
        catch (InvalidOperationException ex)
        {
            ineligibleReason = ex.Message;
        }

        return plan.Records
            .Select(static item => item.Action)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .Select(action =>
            {
                AuditRetentionPolicy policy = AuditRetentionCatalog.GetRequired(action);
                DateTimeOffset boundary = epoch.Add(policy.MaxFullRecordAge);
                return new AuditFixtureRetentionEvidence(
                    policy.Action,
                    (long)policy.MaxFullRecordAge.TotalSeconds,
                    (long)policy.MaxPseudonymAge.TotalSeconds,
                    (long)policy.AggregateAfter.TotalSeconds,
                    policy.LegalHoldAllowed,
                    boundary.AddTicks(-1).ToString("O", CultureInfo.InvariantCulture),
                    boundary.ToString("O", CultureInfo.InvariantCulture),
                    boundary.AddTicks(1).ToString("O", CultureInfo.InvariantCulture),
                    registry.IsHeld(eligible.Action, hold.ExpiresAtUtc.AddTicks(-1)),
                    !registry.IsHeld(eligible.Action, hold.ExpiresAtUtc),
                    ineligibleReason);
            })
            .ToArray();
    }

    private static AuditFixtureAuthorityEvidence BuildAuthorityEvidence(AuditFixturePlan plan)
        => new(
            nameof(AuditRetentionCatalog),
            nameof(AuditLogStore),
            nameof(AuditRetentionPayloadProtector),
            nameof(AuditTamperEvidence),
            nameof(AuditQueryService),
            "TestTemporalRuntimeContext.BusinessEpochUtc",
            DigestJson(new
            {
                plan.Owner,
                plan.Capabilities,
                records = plan.Records.Select(static record => new
                {
                    record.Source,
                    record.Type,
                    occurredAtUtc = NormalizeUtc(record.OccurredAtUtc).ToString("O", CultureInfo.InvariantCulture),
                    record.Action,
                    record.Outcome,
                    record.Severity,
                    record.IsHighValue,
                    record.TargetType
                }).ToArray()
            }));

    private static AuditFixturePrivacyEvidence BuildPrivacyEvidence(IReadOnlyList<AuditLog> rows)
    {
        bool plaintextDetected = rows.Any(static row =>
            row.EventInfo.Contains("synthetic protected audit fixture", StringComparison.Ordinal)
            || row.EventInfo.Contains("synthetic:", StringComparison.Ordinal)
            || (row.ContextJson?.Contains("synthetic protected audit fixture", StringComparison.Ordinal) ?? false));
        int protectedRecordCount = rows.Count(static row =>
            row.ContextPayload is { Length: > 0 }
            && string.Equals(
                row.EventInfo,
                AuditRetentionPayloadProtector.EncryptedEventInfo,
                StringComparison.Ordinal));
        return new AuditFixturePrivacyEvidence(
            protectedRecordCount,
            plaintextDetected,
            DigestJson(rows.Select(static row => new
            {
                row.Id,
                row.Action,
                row.TargetType,
                payloadProtected = row.ContextPayload is { Length: > 0 },
                eventInfoDigest = DigestText(row.EventInfo)
            }).ToArray()));
    }

    private async Task<AuditFixtureQueryEvidence?> BuildQueryEvidenceAsync(
        AuditFixturePlan plan,
        CancellationToken cancellationToken)
    {
        if (!plan.Capabilities.Contains(AuditFixtureCapabilities.InvestigationPage, StringComparer.Ordinal))
        {
            return null;
        }
        if (queryService is null)
        {
            throw new InvalidOperationException("audit_fixture_production_query_service_missing");
        }

        string targetType = ResolveOwnedTargetType(plan.Owner, AuditFixtureCapabilities.InvestigationPage);
        var request = new AuditLogQueryRequest(PageSize: 2, TargetType: targetType);
        AuditLogListResponse first = await queryService.ListAsync(
            request,
            cancellationToken,
            AuditDisclosureMode.PiiRedacted).ConfigureAwait(false);
        AuditLogListResponse second = await queryService.ListAsync(
            request with
            {
                Cursor = first.NextCursor
            },
            cancellationToken,
            AuditDisclosureMode.PiiRedacted).ConfigureAwait(false);
        AuditLogItemResponse[] items = [.. first.Items, .. second.Items];
        bool chainVerified = true;
        foreach (AuditLogItemResponse item in items)
        {
            AuditLogDetailResponse? detail = await queryService.GetAsync(
                long.Parse(item.Id, CultureInfo.InvariantCulture),
                cancellationToken,
                AuditDisclosureMode.PiiRedacted).ConfigureAwait(false);
            chainVerified &= detail?.TamperEvidenceValid is true;
        }
        bool orderedDescending = items.Zip(items.Skip(1), static (left, right) =>
                left.OccurredAtUtc > right.OccurredAtUtc
                || (left.OccurredAtUtc == right.OccurredAtUtc
                    && long.Parse(left.Id, CultureInfo.InvariantCulture) > long.Parse(right.Id, CultureInfo.InvariantCulture)))
            .All(static value => value);
        bool piiRedacted = items.All(static item =>
            string.Equals(item.PiiMode, "pii-redacted", StringComparison.Ordinal)
            && item.IpHash is null or "pii-redacted"
            && item.UserAgentHash is null or "pii-redacted"
            && item.SessionIdHash is null or "pii-redacted"
            && item.DeviceFingerprintHash is null or "pii-redacted");
        return new AuditFixtureQueryEvidence(
            first.Total,
            first.Items.Count,
            second.Items.Count,
            first.NextCursor is not null && second.NextCursor is null,
            orderedDescending,
            piiRedacted,
            chainVerified,
            DigestJson(items.Select(static item => new
            {
                item.Id,
                item.Action,
                occurredAtUtc = NormalizeUtc(item.OccurredAtUtc).ToString("O", CultureInfo.InvariantCulture),
                item.ChainId,
                item.RecordHash,
                item.PiiMode
            }).ToArray()));
    }

    private async Task CleanupOwnedAsync(
        string owner,
        CancellationToken cancellationToken,
        IEnumerable<string>? plannedChainIds = null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        List<AuditLog> ownedRows = await db.Queryable<AuditLog>()
            .Where(item => item.TargetType!.StartsWith(owner + ":"))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        string[] ownedChainIds = ownedRows
            .Select(static item => item.ChainId!)
            .Where(static item => !string.IsNullOrWhiteSpace(item))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        string[] chainIds = ownedChainIds
            .Concat(plannedChainIds ?? [])
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        foreach (string chainId in ownedChainIds)
        {
            long firstOwnedId = ownedRows
                .Where(item => string.Equals(item.ChainId, chainId, StringComparison.Ordinal))
                .Min(static item => item.Id);
            bool hasForeignSuccessor = await db.Queryable<AuditLog>()
                .Where(item => item.ChainId == chainId
                    && item.Id > firstOwnedId
                    && !item.TargetType!.StartsWith(owner + ":"))
                .AnyAsync(cancellationToken)
                .ConfigureAwait(false);
            if (hasForeignSuccessor)
            {
                throw new InvalidOperationException($"audit_fixture_owned_chain_not_tail:{chainId}");
            }
        }
        await db.Deleteable<AuditLog>()
            .Where(item => item.TargetType!.StartsWith(owner + ":"))
            .ExecuteCommandAsync()
            .ConfigureAwait(false);
        AuditLogStore.InvalidateChainTailCacheForFixtureCleanup(chainIds);
    }

    private static string ComputePolicyDigest(IEnumerable<string> actions)
        => DigestJson(actions.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).Select(action =>
        {
            AuditRetentionPolicy policy = AuditRetentionCatalog.GetRequired(action);
            return new
            {
                policy.Action,
                maxFullRecordAge = policy.MaxFullRecordAge.Ticks,
                maxPseudonymAge = policy.MaxPseudonymAge.Ticks,
                aggregateAfter = policy.AggregateAfter.Ticks,
                policy.AnchorForever,
                policy.LegalHoldAllowed,
                policy.CryptographicEraseKeyDomain
            };
        }).ToArray());

    private static string ResolveOwner(string fixtureNamespace, string runId)
        => $"audit-fixture:{DigestText($"{fixtureNamespace.Trim()}\n{runId.Trim()}")[..24]}";

    private static string ResolveOwnedTargetType(string owner, string capability)
        => $"{owner}:{capability}";

    internal static string DigestAuditLog(AuditLog row)
        => DigestJson(new
        {
            row.Source,
            row.Type,
            occurredAtUtc = NormalizeUtc(row.OccurredAtUtc).ToString("O", CultureInfo.InvariantCulture),
            row.ActorType,
            row.ActorId,
            row.ActorRole,
            row.Action,
            row.TargetType,
            row.TargetId,
            row.Outcome,
            row.Severity,
            row.IsHighValue,
            row.TraceId,
            row.RequestPath,
            row.RequestMethod,
            row.IpHash,
            row.UserAgentHash,
            row.SessionIdHash,
            row.DeviceFingerprintHash,
            row.ReasonCode,
            row.EventInfo,
            contextPayloadDigest = row.ContextPayload is null
                ? null
                : DigestText(Convert.ToBase64String(row.ContextPayload)),
            row.ContextJson,
            row.ChainId,
            row.PrevHash,
            row.RecordHash,
            recordMacDigest = row.RecordMac is null ? null : DigestText(row.RecordMac)
        });

    internal static string DigestJson<T>(T value)
        => DigestText(JsonSerializer.Serialize(value, s_jsonOptions));

    internal static string DigestText(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static DateTime NormalizeUtc(DateTime value)
        => value.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(value, DateTimeKind.Utc)
            : value.ToUniversalTime();

    private sealed class AuditFixtureTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow()
            => now;
    }
}

internal sealed record AuditFixturePlan(
    string Owner,
    IReadOnlyList<string> Capabilities,
    IReadOnlyList<AuditRecord> Records);

internal static class AuditFixtureNegativeCorpus
{
    public static IReadOnlyList<(string MutationId, string Field, AuditLog Record, string ExpectedReason)> Create(
        AuditLog source)
        =>
        [
            ("record-body", "record_body", Clone(source, record => record.EventInfo += ":tampered"), "record_body_mismatch"),
            ("prev-hash", "prev_hash", Clone(source, record => record.PrevHash = FlipHash(record.PrevHash)), "prev_hash_mismatch"),
            ("record-hash", "record_hash", Clone(source, record => record.RecordHash = FlipHash(record.RecordHash)), "record_hash_mismatch"),
            ("record-mac", "record_mac", Clone(source, record => record.RecordMac = FlipHash(record.RecordMac)), "record_mac_mismatch"),
            ("chain-id", "chain_id", Clone(source, record => record.ChainId = "19000101"), "chain_id_mismatch"),
            ("protected-payload", "protected_payload", Clone(source, record => record.ContextPayload![0] ^= 0x01), "protected_payload_mismatch")
        ];

    public static string Verify(AuditLog source, AuditLog mutated, byte[]? key, string expectedField)
    {
        AuditTamperVerificationResult result = AuditTamperEvidence.VerifyIsolatedMutation(source, mutated, key);
        if (!string.Equals(result.Field, expectedField, StringComparison.Ordinal))
        {
            return "negative_case_multiple_fields";
        }
        return result.Reason;
    }

    internal static string[] ChangedFields(AuditLog source, AuditLog mutated)
        => AuditTamperEvidence.ChangedCanonicalFields(source, mutated);

    private static AuditLog Clone(AuditLog source, Action<AuditLog> mutate)
    {
        var clone = new AuditLog
        {
            Id = source.Id,
            Source = source.Source,
            Type = source.Type,
            OccurredAtUtc = source.OccurredAtUtc,
            ActorType = source.ActorType,
            ActorId = source.ActorId,
            ActorRole = source.ActorRole,
            Action = source.Action,
            TargetType = source.TargetType,
            TargetId = source.TargetId,
            Outcome = source.Outcome,
            Severity = source.Severity,
            IsHighValue = source.IsHighValue,
            TraceId = source.TraceId,
            RequestPath = source.RequestPath,
            RequestMethod = source.RequestMethod,
            IpHash = source.IpHash,
            UserAgentHash = source.UserAgentHash,
            SessionIdHash = source.SessionIdHash,
            DeviceFingerprintHash = source.DeviceFingerprintHash,
            ReasonCode = source.ReasonCode,
            EventInfo = source.EventInfo,
            ContextPayload = source.ContextPayload?.ToArray(),
            ContextJson = source.ContextJson,
            ChainId = source.ChainId,
            PrevHash = source.PrevHash,
            RecordHash = source.RecordHash,
            RecordMac = source.RecordMac
        };
        mutate(clone);
        return clone;
    }

    private static string FlipHash(string? value)
    {
        string hash = string.IsNullOrWhiteSpace(value) ? new string('0', 64) : value;
        char replacement = hash[0] == 'a' ? 'b' : 'a';
        return replacement + hash[1..];
    }
}
