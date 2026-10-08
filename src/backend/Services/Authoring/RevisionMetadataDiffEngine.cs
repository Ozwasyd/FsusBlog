using System.Collections.Immutable;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Services.Articles;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Computes read-only metadata evidence from an independently authorized compare plan.
/// Current package authorities do not expose cover AssetIds or historical lifecycle state;
/// their absence always prevents full metadata qualification.
/// </summary>
public sealed class RevisionMetadataDiffEngine(RevisionComparePlanVerifier planVerifier)
{
    public const string EngineVersion = "revision-metadata-diff-v1";
    public const string ProjectionVersion = "authoring-snapshot-typed-projection-v1";

    public async Task<RevisionMetadataDiffResult> ComputeAsync(
        RevisionComparePlanBundle bundle,
        DateTimeOffset observedAtUtc,
        CancellationToken cancellationToken = default,
        long reservedMemoryBytes = 0)
    {
        ArgumentNullException.ThrowIfNull(bundle);
        long started = Stopwatch.GetTimestamp();
        if (reservedMemoryBytes < 0 || reservedMemoryBytes > bundle.Plan.Budgets.MaxMemoryBytes)
            return Failure(RevisionMetadataDiffStatus.BudgetExceeded, "metadata_diff_memory_reservation_invalid", started);
        if (cancellationToken.IsCancellationRequested)
        {
            return Failure(RevisionMetadataDiffStatus.Cancelled, "metadata_diff_cancelled", started);
        }
        if (observedAtUtc.Offset != TimeSpan.Zero || !RevisionComparePlanVerifier.LocalBundleValid(bundle))
        {
            return Failure(RevisionMetadataDiffStatus.Tampered, "metadata_diff_plan_tampered", started);
        }
        using var timeout = new CancellationTokenSource(bundle.Plan.Budgets.TimeoutMilliseconds);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
        try
        {
            RevisionComparePlanVerification verified = await planVerifier.VerifyAsync(
                bundle, observedAtUtc, linked.Token).WaitAsync(linked.Token).ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested();
            if (!verified.Valid)
            {
                return VerificationFailure(verified, started);
            }
            CheckExpiry(bundle);
            RevisionMetadataDiffResult result = await Task.Run(
                () => ComputeVerified(bundle, linked.Token, started, reservedMemoryBytes), linked.Token).ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested();
            CheckExpiry(bundle);
            // Revocation, draft epoch changes and current-pointer changes during worker
            // execution invalidate every derived field before any result is published.
            verified = await planVerifier.VerifyAsync(
                bundle, DateTimeOffset.UtcNow, linked.Token).WaitAsync(linked.Token).ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested();
            CheckExpiry(bundle);
            return verified.Valid
                ? result with
                {
                    Timing = Timing(started)
                }
                : VerificationFailure(verified, started);
        }
        catch (OperationCanceledException)
        {
            return Failure(RevisionMetadataDiffStatus.Cancelled,
                timeout.IsCancellationRequested && !cancellationToken.IsCancellationRequested
                    ? "metadata_diff_timeout" : "metadata_diff_cancelled", started);
        }
        catch (MetadataDiffRefusal refusal)
        {
            return Failure(refusal.Status, refusal.Message, started);
        }
        catch (JsonException)
        {
            return Failure(RevisionMetadataDiffStatus.Invalid, "metadata_diff_snapshot_invalid", started);
        }
    }

    private static RevisionMetadataDiffResult ComputeVerified(
        RevisionComparePlanBundle bundle, CancellationToken token, long started, long heldMemoryBytes)
    {
        RevisionCompareBudgets budgets = bundle.Plan.Budgets;
        long reservedMemory = EstimateInputReserveBytes(bundle, token) + heldMemoryBytes;
        if (reservedMemory > budgets.MaxMemoryBytes)
        {
            throw new MetadataDiffRefusal(RevisionMetadataDiffStatus.BudgetExceeded, "metadata_diff_memory_budget");
        }

        var before = new SortedDictionary<string, ProjectedMetadataField>(StringComparer.Ordinal);
        var after = new SortedDictionary<string, ProjectedMetadataField>(StringComparer.Ordinal);
        Project(bundle.BasePackage, bundle.Plan.Options.MetadataFields, before, token);
        Project(bundle.ComparePackage, bundle.Plan.Options.MetadataFields, after, token);
        string[] ids = before.Keys.Concat(after.Keys).Distinct(StringComparer.Ordinal)
            .OrderBy(static id => id, StringComparer.Ordinal).ToArray();
        if (ids.Length > budgets.MaxTokenCount)
        {
            throw new MetadataDiffRefusal(RevisionMetadataDiffStatus.BudgetExceeded, "metadata_diff_field_budget");
        }
        long outputBytes = 0;
        var fields = ImmutableArray.CreateBuilder<RevisionMetadataDiffField>(ids.Length);
        var missing = new SortedSet<string>(StringComparer.Ordinal)
        {
            "cover_asset_id_missing_authority",
            "release_snapshot_coordinates_missing_authority",
            "responsibility_snapshot_content_digest_missing_authority",
            "rights_license_copy_enum_missing_authority",
            "release_transition_enum_missing_authority"
        };
        if (!bundle.BasePackage.Metadata.Any(static value => value.FieldId == "status")
            || !bundle.ComparePackage.Metadata.Any(static value => value.FieldId == "status"))
        {
            missing.Add("historical_lifecycle_missing_authority");
        }
        foreach (string id in ids)
        {
            token.ThrowIfCancellationRequested();
            ProjectedMetadataField descriptor = before.GetValueOrDefault(id) ?? after[id];
            RevisionMetadataDiffValue oldValue = before.TryGetValue(id, out ProjectedMetadataField? oldField)
                ? oldField.Value : MissingValue(id, before);
            RevisionMetadataDiffValue newValue = after.TryGetValue(id, out ProjectedMetadataField? newField)
                ? newField.Value : MissingValue(id, after);
            RevisionMetadataDiffChangeKind change = Change(oldValue, newValue);
            if (change == RevisionMetadataDiffChangeKind.MissingAuthority)
            {
                missing.Add(id + ":missing-authority");
            }
            ImmutableArray<int> added = [], removed = [];
            if (change == RevisionMetadataDiffChangeKind.SetChanged)
            {
                added = [.. newValue.Ids.Except(oldValue.Ids)];
                removed = [.. oldValue.Ids.Except(newValue.Ids)];
            }
            var field = new RevisionMetadataDiffField(id, bundle.BasePackage.PackageDigest,
                bundle.ComparePackage.PackageDigest, descriptor.Authority,
                descriptor.Normalization, descriptor.DisplayFormat, descriptor.Sensitive,
                oldValue, newValue, change, added, removed);
            outputBytes += EstimateFieldOutputBytes(field);
            if (outputBytes > budgets.MaxOutputBytes || reservedMemory + outputBytes > budgets.MaxMemoryBytes)
            {
                throw new MetadataDiffRefusal(RevisionMetadataDiffStatus.BudgetExceeded, "metadata_diff_output_budget");
            }
            fields.Add(field);
        }
        var receipt = new RevisionMetadataDiffReceipt(EngineVersion, ProjectionVersion,
            RegistryDigest(), RevisionMetadataDiffStatus.PartialMissingAuthority,
            RevisionMetadataDiffCoverage.PartialMissingAuthority, "metadata_diff_missing_authority",
            bundle.Plan.ContentDigest, bundle.BasePackage.PackageDigest, bundle.ComparePackage.PackageDigest,
            fields.Count, [.. missing], string.Empty);
        ImmutableArray<RevisionMetadataDiffField> frozen = fields.MoveToImmutable();
        // All field/receipt identifiers, decimal numbers, JSON escaping, missing
        // reasons and the eventual digest are reserved before hashing/publication.
        outputBytes = EstimateOutputBytes(receipt, frozen, token);
        if (outputBytes > budgets.MaxOutputBytes || reservedMemory + outputBytes > budgets.MaxMemoryBytes)
            throw new MetadataDiffRefusal(RevisionMetadataDiffStatus.BudgetExceeded, "metadata_diff_output_budget");
        receipt = receipt with
        {
            ContentDigest = Digest(receipt, frozen, token)
        };
        return new RevisionMetadataDiffResult(receipt, frozen, Timing(started));
    }

    internal static long EstimateInputReserveBytes(RevisionComparePlanBundle bundle, CancellationToken token = default)
    {
        long inputBytes = 0;
        foreach (RevisionComparePackage package in new[] { bundle.BasePackage, bundle.ComparePackage })
        {
            foreach (RevisionCompareMetadataValue value in package.Metadata)
            {
                token.ThrowIfCancellationRequested();
                inputBytes += Encoding.UTF8.GetByteCount(value.CanonicalValue) + 256L;
            }
            foreach (RevisionCompareSnapshot snapshot in package.Snapshots)
            {
                token.ThrowIfCancellationRequested();
                inputBytes += snapshot.Payload.Length;
            }
        }
        // Payload copies, parser/DTO strings, both projections and hash workspace.
        return inputBytes * 24L + 65_536L + bundle.Plan.Admission.InitialEstimatedMemoryBytes;
    }

    internal static long EstimateOutputBytes(RevisionMetadataDiffReceipt receipt,
        ImmutableArray<RevisionMetadataDiffField> fields, CancellationToken token = default)
    {
        long bytes = 2_048L + 6L * (receipt.EngineVersion.Length + receipt.ProjectionVersion.Length
            + receipt.RegistryDigest.Length + receipt.Reason.Length + (receipt.PlanDigest?.Length ?? 0)
            + (receipt.BasePackageDigest?.Length ?? 0) + (receipt.ComparePackageDigest?.Length ?? 0) + 64);
        foreach (string reason in receipt.MissingAuthorities)
        {
            token.ThrowIfCancellationRequested();
            bytes += reason.Length * 6L + 2;
        }
        foreach (RevisionMetadataDiffField field in fields)
        {
            token.ThrowIfCancellationRequested();
            bytes += EstimateFieldOutputBytes(field);
        }
        return bytes;
    }

    private static long EstimateFieldOutputBytes(RevisionMetadataDiffField field)
        => 1_024L + 6L * (field.FieldId.Length + field.BeforePackageDigest.Length + field.AfterPackageDigest.Length
            + field.Authority.Length + field.Normalization.Length + field.DisplayFormat.Length
            + (field.Before.Text?.Length ?? 0) + (field.After.Text?.Length ?? 0))
            + ((long)field.Before.Ids.Length + field.After.Ids.Length + field.AddedIds.Length + field.RemovedIds.Length) * 12L;

    private static void Project(RevisionComparePackage package, ImmutableArray<string> requested,
        SortedDictionary<string, ProjectedMetadataField> fields, CancellationToken token)
    {
        foreach (string id in requested.OrderBy(static id => id, StringComparer.Ordinal))
        {
            token.ThrowIfCancellationRequested();
            RevisionCompareMetadataDescriptor descriptor = RevisionCompareMetadataRegistry.Descriptors
                .Single(item => item.FieldId == id);
            RevisionCompareMetadataValue value = package.Metadata.Single(item => item.FieldId == id);
            RevisionMetadataDiffValue typed = value.ValueType switch
            {
                RevisionCompareMetadataValueType.String => new(RevisionMetadataDiffValueKind.String, Text: value.CanonicalValue),
                RevisionCompareMetadataValueType.NullableString => StringValue(JsonSerializer.Deserialize<string>(value.CanonicalValue)),
                RevisionCompareMetadataValueType.Int32 => new(RevisionMetadataDiffValueKind.Integer,
                    Number: int.Parse(value.CanonicalValue, CultureInfo.InvariantCulture)),
                RevisionCompareMetadataValueType.Boolean => new(RevisionMetadataDiffValueKind.Boolean,
                    Boolean: bool.Parse(value.CanonicalValue)),
                RevisionCompareMetadataValueType.NullableInstant => value.CanonicalValue == "null"
                    ? new(RevisionMetadataDiffValueKind.Null)
                    : new(RevisionMetadataDiffValueKind.UtcTicks, Number: DateTime.ParseExact(value.CanonicalValue,
                        "O", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).Ticks),
                RevisionCompareMetadataValueType.Int32List => new(RevisionMetadataDiffValueKind.UnorderedIntegerSet,
                    Ids: value.CanonicalValue.Length == 0 ? [] : [.. value.CanonicalValue.Split(',')
                        .Select(static item => int.Parse(item, CultureInfo.InvariantCulture))]),
                _ => throw new MetadataDiffRefusal(RevisionMetadataDiffStatus.Invalid, "metadata_diff_type_invalid")
            };
            fields.Add(id, new ProjectedMetadataField(descriptor.Authority, descriptor.Normalization,
                descriptor.DisplayFormat, descriptor.Sensitive, typed));
        }
        RevisionMetadataSnapshotProjection.Project(package, fields, token);
    }

    internal static RevisionMetadataDiffValue StringValue(string? value)
        => value is null ? new(RevisionMetadataDiffValueKind.Null) : new(RevisionMetadataDiffValueKind.String, Text: value);

    private static RevisionMetadataDiffChangeKind Change(RevisionMetadataDiffValue before, RevisionMetadataDiffValue after)
    {
        if (before.Kind == RevisionMetadataDiffValueKind.NotObserved || after.Kind == RevisionMetadataDiffValueKind.NotObserved)
            return RevisionMetadataDiffChangeKind.MissingAuthority;
        if (before.Kind == RevisionMetadataDiffValueKind.NotApplicable && after.Kind == before.Kind)
            return RevisionMetadataDiffChangeKind.NotApplicable;
        if (Equal(before, after))
            return RevisionMetadataDiffChangeKind.Unchanged;
        if (before.Kind is RevisionMetadataDiffValueKind.Null or RevisionMetadataDiffValueKind.NotApplicable)
            return RevisionMetadataDiffChangeKind.Added;
        if (after.Kind is RevisionMetadataDiffValueKind.Null or RevisionMetadataDiffValueKind.NotApplicable)
            return RevisionMetadataDiffChangeKind.Removed;
        if (before.Kind == RevisionMetadataDiffValueKind.UnorderedIntegerSet && after.Kind == before.Kind)
            return RevisionMetadataDiffChangeKind.SetChanged;
        return RevisionMetadataDiffChangeKind.Replaced;
    }

    private static bool Equal(RevisionMetadataDiffValue first, RevisionMetadataDiffValue second)
        => first.Kind == second.Kind && first.Text == second.Text && first.Number == second.Number
            && first.Boolean == second.Boolean && first.Ids.AsSpan().SequenceEqual(second.Ids.AsSpan());

    private static RevisionMetadataDiffValue MissingValue(string id,
        SortedDictionary<string, ProjectedMetadataField> projection)
    {
        string prefix = id.Split('.')[0];
        if (projection.TryGetValue(prefix + ".state", out ProjectedMetadataField? state)
            && state.Value.Number == (int)RevisionCompareSnapshotState.NotApplicable)
            return new(RevisionMetadataDiffValueKind.NotApplicable);
        if (prefix == "responsibility"
            && (id.StartsWith("responsibility.authors.", StringComparison.Ordinal)
                || id.StartsWith("responsibility.sources.", StringComparison.Ordinal)
                || id.StartsWith("responsibility.reviewer.", StringComparison.Ordinal))
            && projection.ContainsKey("responsibility.sources.length"))
            return new(RevisionMetadataDiffValueKind.NotApplicable);
        return new(RevisionMetadataDiffValueKind.NotObserved);
    }

    private static void CheckExpiry(RevisionComparePlanBundle bundle)
    {
        if (DateTimeOffset.UtcNow > bundle.Plan.ExpiresAtUtc)
            throw new MetadataDiffRefusal(RevisionMetadataDiffStatus.Stale, "metadata_diff_plan_expired");
    }

    private static RevisionMetadataDiffResult VerificationFailure(
        RevisionComparePlanVerification verification, long started)
        => Failure(VerificationStatus(verification), verification.ReasonCode switch
        {
            "revision_compare_timeout" => "metadata_diff_timeout",
            "revision_compare_cancelled" => "metadata_diff_cancelled",
            _ => "metadata_diff_plan_not_authorized"
        }, started);

    private static RevisionMetadataDiffStatus VerificationStatus(RevisionComparePlanVerification verification)
        => verification.ReasonCode == "revision_compare_plan_expired"
            ? RevisionMetadataDiffStatus.Stale
            : verification.Status switch
            {
                RevisionComparePlanStatus.Cancelled => RevisionMetadataDiffStatus.Cancelled,
                RevisionComparePlanStatus.Tampered => RevisionMetadataDiffStatus.Tampered,
                RevisionComparePlanStatus.Invalid => RevisionMetadataDiffStatus.Invalid,
                RevisionComparePlanStatus.BudgetExceeded => RevisionMetadataDiffStatus.BudgetExceeded,
                RevisionComparePlanStatus.Stale => RevisionMetadataDiffStatus.Stale,
                // The verifier intentionally combines unavailable/revoked and stale reads;
                // no package references or derived fields accompany either refusal.
                _ => RevisionMetadataDiffStatus.Unavailable
            };

    private static RevisionMetadataDiffTiming Timing(long started)
        => new(Stopwatch.GetTimestamp() - started, Stopwatch.Frequency);

    private static RevisionMetadataDiffResult Failure(RevisionMetadataDiffStatus status, string reason, long started)
    {
        var receipt = new RevisionMetadataDiffReceipt(EngineVersion, ProjectionVersion, RegistryDigest(),
            status, RevisionMetadataDiffCoverage.None, reason, null, null, null, null, [], string.Empty);
        return new RevisionMetadataDiffResult(receipt with
        {
            ContentDigest = Digest(receipt, [])
        }, [], Timing(started));
    }

    internal static string RegistryDigest()
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, ProjectionVersion);
        foreach (RevisionCompareMetadataDescriptor descriptor in RevisionCompareMetadataRegistry.Descriptors)
        {
            Append(hash, descriptor.FieldId);
            Append(hash, descriptor.ValueType);
            Append(hash, descriptor.Sensitive);
            Append(hash, descriptor.Normalization);
            Append(hash, descriptor.DisplayFormat);
            Append(hash, descriptor.Authority);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    internal static string Digest(RevisionMetadataDiffReceipt receipt, ImmutableArray<RevisionMetadataDiffField> fields,
        CancellationToken cancellationToken = default)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, receipt.EngineVersion);
        Append(hash, receipt.ProjectionVersion);
        Append(hash, receipt.RegistryDigest);
        Append(hash, receipt.Status);
        Append(hash, receipt.Coverage);
        Append(hash, receipt.Reason);
        Append(hash, receipt.PlanDigest);
        Append(hash, receipt.BasePackageDigest);
        Append(hash, receipt.ComparePackageDigest);
        Append(hash, receipt.FieldCount);
        Append(hash, receipt.MissingAuthorities.Length);
        foreach (string reason in receipt.MissingAuthorities)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Append(hash, reason);
        }
        Append(hash, fields.Length);
        foreach (RevisionMetadataDiffField field in fields)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Append(hash, field.FieldId);
            Append(hash, field.BeforePackageDigest);
            Append(hash, field.AfterPackageDigest);
            Append(hash, field.Authority);
            Append(hash, field.Normalization);
            Append(hash, field.DisplayFormat);
            Append(hash, field.Sensitive);
            Append(hash, field.Change);
            AppendValue(hash, field.Before, cancellationToken);
            AppendValue(hash, field.After, cancellationToken);
            AppendIds(hash, field.AddedIds, cancellationToken);
            AppendIds(hash, field.RemovedIds, cancellationToken);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static void AppendValue(IncrementalHash hash, RevisionMetadataDiffValue value, CancellationToken token)
    {
        Append(hash, value.Kind);
        Append(hash, value.Text);
        Append(hash, value.Number);
        Append(hash, value.Boolean);
        AppendIds(hash, value.Ids, token);
    }

    private static void AppendIds(IncrementalHash hash, ImmutableArray<int> ids, CancellationToken token)
    {
        Append(hash, ids.Length);
        foreach (int id in ids)
        {
            token.ThrowIfCancellationRequested();
            Append(hash, id);
        }
    }

    private static void Append(IncrementalHash hash, object? value)
    {
        hash.AppendData(value is null ? [0] : [1]);
        byte[] bytes = value is null ? [] : Encoding.UTF8.GetBytes(Convert.ToString(value, CultureInfo.InvariantCulture)!);
        Span<byte> length = stackalloc byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(length, bytes.Length);
        hash.AppendData(length);
        hash.AppendData(bytes);
    }
}

internal sealed record ProjectedMetadataField(string Authority, string Normalization,
    string DisplayFormat, bool Sensitive, RevisionMetadataDiffValue Value);

internal sealed class MetadataDiffRefusal(RevisionMetadataDiffStatus status, string reason) : Exception(reason)
{
    public RevisionMetadataDiffStatus Status { get; } = status;
}

/// <summary>Independent recomputation also rereads permissions and current package coordinates.</summary>
public sealed class RevisionMetadataDiffVerifier(RevisionMetadataDiffEngine engine)
{
    public async Task<bool> VerifyAsync(RevisionComparePlanBundle bundle, RevisionMetadataDiffResult result,
        DateTimeOffset observedAtUtc, CancellationToken cancellationToken = default, long reservedMemoryBytes = 0)
    {
        if (bundle is null || result is null || result.Receipt is null || result.Fields.IsDefault
            || result.Receipt.MissingAuthorities.IsDefault || cancellationToken.IsCancellationRequested
            || reservedMemoryBytes < 0 || reservedMemoryBytes > bundle.Plan.Budgets.MaxMemoryBytes
            || !RevisionComparePlanVerifier.LocalBundleValid(bundle))
            return false;
        using var timeout = new CancellationTokenSource(bundle.Plan.Budgets.TimeoutMilliseconds);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
        try
        {
            if (!CandidateShapeValid(bundle, result, linked.Token))
                return false;
            long candidateBytes = RevisionMetadataDiffEngine.EstimateOutputBytes(result.Receipt, result.Fields, linked.Token);
            if (candidateBytes > bundle.Plan.Budgets.MaxMemoryBytes - reservedMemoryBytes)
                return false;
            RevisionMetadataDiffResult reread = await engine.ComputeAsync(bundle, observedAtUtc, linked.Token,
                    reservedMemoryBytes + candidateBytes)
                .WaitAsync(linked.Token).ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested();
            return reread.IsReviewable
                && RevisionMetadataDiffEngine.Digest(result.Receipt, result.Fields, linked.Token) == result.Receipt.ContentDigest
                && reread.Receipt.ContentDigest == result.Receipt.ContentDigest
                && RevisionMetadataDiffRepresentativeVerifier.Verify(bundle, result, linked.Token);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    private static bool CandidateShapeValid(RevisionComparePlanBundle bundle,
        RevisionMetadataDiffResult result, CancellationToken token)
    {
        RevisionMetadataDiffReceipt receipt = result.Receipt;
        RevisionCompareBudgets budgets = bundle.Plan.Budgets;
        if (!result.IsReviewable || receipt.EngineVersion != RevisionMetadataDiffEngine.EngineVersion
            || receipt.ProjectionVersion != RevisionMetadataDiffEngine.ProjectionVersion
            || receipt.RegistryDigest != RevisionMetadataDiffEngine.RegistryDigest()
            || receipt.PlanDigest != bundle.Plan.ContentDigest
            || receipt.BasePackageDigest != bundle.BasePackage.PackageDigest
            || receipt.ComparePackageDigest != bundle.ComparePackage.PackageDigest
            || receipt.Status != RevisionMetadataDiffStatus.PartialMissingAuthority
            || receipt.Coverage != RevisionMetadataDiffCoverage.PartialMissingAuthority
            || receipt.Reason != "metadata_diff_missing_authority"
            || !ValidDigest(receipt.ContentDigest)
            || receipt.FieldCount != result.Fields.Length || result.Fields.Length > budgets.MaxTokenCount
            || result.Fields.Length * 1_024L + 2_048L > budgets.MaxOutputBytes
            || receipt.MissingAuthorities.Length > result.Fields.Length + 10)
            return false;
        long size = result.Fields.Length * 1_024L + 2_048L;
        string? previous = null;
        foreach (string reason in receipt.MissingAuthorities)
        {
            token.ThrowIfCancellationRequested();
            if (!ValidIdentity(reason) || previous is not null && string.CompareOrdinal(previous, reason) >= 0)
                return false;
            size += reason.Length * 6L;
            previous = reason;
        }
        previous = null;
        foreach (RevisionMetadataDiffField field in result.Fields)
        {
            token.ThrowIfCancellationRequested();
            if (field is null || !ValidIdentity(field.FieldId) || !ValidIdentity(field.Authority)
                || !ValidIdentity(field.Normalization) || !ValidIdentity(field.DisplayFormat)
                || previous is not null && string.CompareOrdinal(previous, field.FieldId) >= 0
                || field.BeforePackageDigest != receipt.BasePackageDigest
                || field.AfterPackageDigest != receipt.ComparePackageDigest
                || !WithinBudget(field.Before, budgets) || !WithinBudget(field.After, budgets)
                || !IdsWithinBudget(field.AddedIds, budgets) || !IdsWithinBudget(field.RemovedIds, budgets)
                || !Enum.IsDefined(field.Change) || !ValidValue(field.Before, token) || !ValidValue(field.After, token)
                || !ValidIds(field.AddedIds, token) || !ValidIds(field.RemovedIds, token))
                return false;
            size += ((long)(field.Before.Text?.Length ?? 0) + (field.After.Text?.Length ?? 0)) * 6L
                + ((long)field.Before.Ids.Length + field.After.Ids.Length + field.AddedIds.Length + field.RemovedIds.Length) * 12L;
            if (size > budgets.MaxOutputBytes || size + bundle.Plan.Admission.InitialEstimatedMemoryBytes > budgets.MaxMemoryBytes)
                return false;
            previous = field.FieldId;
        }
        long exactUpperBound = RevisionMetadataDiffEngine.EstimateOutputBytes(receipt, result.Fields, token);
        return exactUpperBound <= budgets.MaxOutputBytes
            && exactUpperBound + bundle.Plan.Admission.InitialEstimatedMemoryBytes <= budgets.MaxMemoryBytes;
    }

    private static bool WithinBudget(RevisionMetadataDiffValue? value, RevisionCompareBudgets budgets)
        => value is not null && (value.Text?.Length ?? 0) * 6L <= budgets.MaxOutputBytes
            && IdsWithinBudget(value.Ids, budgets);

    private static bool IdsWithinBudget(ImmutableArray<int> values, RevisionCompareBudgets budgets)
        => !values.IsDefault && values.Length <= budgets.MaxTokenCount && values.Length * 12L <= budgets.MaxOutputBytes;

    private static bool ValidValue(RevisionMetadataDiffValue? value, CancellationToken token)
    {
        if (value is null || value.Ids.IsDefault || !Enum.IsDefined(value.Kind))
            return false;
        return value.Kind switch
        {
            RevisionMetadataDiffValueKind.NotObserved or RevisionMetadataDiffValueKind.NotApplicable or RevisionMetadataDiffValueKind.Null =>
                value.Text is null && value.Number is null && value.Boolean is null && value.Ids.IsEmpty,
            RevisionMetadataDiffValueKind.String => value.Text is not null && value.Number is null
                && value.Boolean is null && value.Ids.IsEmpty,
            RevisionMetadataDiffValueKind.Integer => value.Number.HasValue && value.Text is null
                && value.Boolean is null && value.Ids.IsEmpty,
            RevisionMetadataDiffValueKind.UtcTicks => value.Number is >= 0 and <= 3_155_378_975_999_999_999
                && value.Text is null && value.Boolean is null && value.Ids.IsEmpty,
            RevisionMetadataDiffValueKind.DateDayNumber => value.Number is >= 0 and <= 3_652_058
                && value.Text is null && value.Boolean is null && value.Ids.IsEmpty,
            RevisionMetadataDiffValueKind.Boolean => value.Boolean.HasValue && value.Text is null
                && value.Number is null && value.Ids.IsEmpty,
            RevisionMetadataDiffValueKind.UnorderedIntegerSet => value.Text is null && value.Number is null
                && value.Boolean is null && ValidIds(value.Ids, token),
            _ => false
        };
    }

    private static bool ValidIds(ImmutableArray<int> values, CancellationToken token)
    {
        if (values.IsDefault)
            return false;
        int previous = 0;
        foreach (int value in values)
        {
            token.ThrowIfCancellationRequested();
            if (value <= previous)
                return false;
            previous = value;
        }
        return true;
    }

    private static bool ValidIdentity(string? value)
        => value is { Length: > 0 and <= RevisionCompareContract.MaxIdentityLength }
            && !string.IsNullOrWhiteSpace(value);

    private static bool ValidDigest(string? value)
        => value is not null && value.Length == 64 && value.AsSpan().IndexOfAnyExcept("0123456789abcdef") < 0;
}
