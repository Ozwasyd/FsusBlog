namespace FsusBlog.Core.Services.Articles;

public sealed class RevisionComparePlanner(IRevisionComparePackageReader packageReader)
{
    public async Task<RevisionComparePlanResult> CreateAsync(
        RevisionComparePlanRequest request,
        CancellationToken cancellationToken = default)
    {
        try
        {
            RevisionCompareContract.ValidateRequest(request);
        }
        catch (RevisionCompareContractException exception)
        {
            return Failure(request, RevisionComparePlanStatus.Invalid, exception.Code);
        }

        if (cancellationToken.IsCancellationRequested)
        {
            return Failure(request, RevisionComparePlanStatus.Cancelled, "revision_compare_cancelled");
        }
        if (DateTimeOffset.UtcNow > request.ExpiresAtUtc)
        {
            return Failure(request, RevisionComparePlanStatus.Stale, "revision_compare_plan_expired");
        }

        using var timeout = new CancellationTokenSource(request.Budgets.TimeoutMilliseconds);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
        try
        {
            RevisionComparePackageReadResult baseRead = await packageReader.ReadAuthorizedAsync(
                    request.Reader,
                    request.ArticleId,
                    request.Base,
                    linked.Token)
                .WaitAsync(linked.Token)
                .ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested();
            if (DateTimeOffset.UtcNow > request.ExpiresAtUtc)
            {
                return Failure(request, RevisionComparePlanStatus.Stale, "revision_compare_plan_expired");
            }
            RevisionComparePlanResult? baseFailure = ReadFailure(request, baseRead);
            if (baseFailure is not null)
            {
                return baseFailure;
            }

            RevisionComparePackageReadResult compareRead = await packageReader.ReadAuthorizedAsync(
                    request.Reader,
                    request.ArticleId,
                    request.Compare,
                    linked.Token)
                .WaitAsync(linked.Token)
                .ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested();
            if (DateTimeOffset.UtcNow > request.ExpiresAtUtc)
            {
                return Failure(request, RevisionComparePlanStatus.Stale, "revision_compare_plan_expired");
            }
            RevisionComparePlanResult? compareFailure = ReadFailure(request, compareRead);
            if (compareFailure is not null)
            {
                return compareFailure;
            }

            RevisionComparePackage basePackage = baseRead.Package!;
            RevisionComparePackage comparePackage = compareRead.Package!;
            string? validationCode = ValidatePackages(
                request,
                basePackage,
                comparePackage,
                out RevisionCompareAdmission? admission);
            if (validationCode is not null)
            {
                return Failure(
                    request,
                    ValidationStatus(validationCode),
                    validationCode,
                    basePackage.PackageDigest,
                    comparePackage.PackageDigest);
            }

            RevisionComparePackageReference baseReference = RevisionCompareCanonical.Reference(basePackage);
            RevisionComparePackageReference compareReference = RevisionCompareCanonical.Reference(comparePackage);
            string planDigest = RevisionCompareCanonical.PlanDigest(
                request,
                baseReference,
                compareReference,
                admission!);
            var plan = new RevisionComparePlan(
                RevisionCompareContract.SchemaVersion,
                RevisionCompareContract.PlannerVersion,
                request.ArticleId,
                request.Reader,
                request.Base,
                request.Compare,
                baseReference,
                compareReference,
                request.Options,
                request.Budgets,
                admission!,
                request.CancellationIdentity,
                request.ExpiresAtUtc,
                planDigest);
            RevisionComparePlanReceipt receipt = Receipt(
                request,
                RevisionComparePlanStatus.Accepted,
                "accepted",
                planDigest,
                baseReference,
                compareReference,
                admission);
            linked.Token.ThrowIfCancellationRequested();
            if (DateTimeOffset.UtcNow > request.ExpiresAtUtc)
            {
                return Failure(request, RevisionComparePlanStatus.Stale, "revision_compare_plan_expired");
            }
            var bundle = new RevisionComparePlanBundle(plan, basePackage, comparePackage, receipt);
            return new RevisionComparePlanResult(RevisionComparePlanStatus.Accepted, bundle, receipt);
        }
        catch (OperationCanceledException)
        {
            string reason = timeout.IsCancellationRequested && !cancellationToken.IsCancellationRequested
                ? "revision_compare_timeout"
                : "revision_compare_cancelled";
            return Failure(request, RevisionComparePlanStatus.Cancelled, reason);
        }
    }

    private static RevisionComparePlanResult? ReadFailure(
        RevisionComparePlanRequest request,
        RevisionComparePackageReadResult read)
    {
        if (read.Status == RevisionComparePackageReadStatus.Available && read.Package is not null)
        {
            return null;
        }

        RevisionComparePlanStatus status = read.Status switch
        {
            RevisionComparePackageReadStatus.Stale => RevisionComparePlanStatus.Stale,
            RevisionComparePackageReadStatus.Invalid => RevisionComparePlanStatus.Invalid,
            RevisionComparePackageReadStatus.BudgetExceeded => RevisionComparePlanStatus.BudgetExceeded,
            _ => RevisionComparePlanStatus.Unavailable
        };
        string reason = status switch
        {
            RevisionComparePlanStatus.Stale => "revision_compare_source_stale",
            RevisionComparePlanStatus.Invalid => "revision_compare_source_invalid",
            RevisionComparePlanStatus.BudgetExceeded => "revision_compare_source_budget_exceeded",
            _ => "revision_compare_source_unavailable"
        };
        // Failure receipts intentionally omit package coordinates and digests so an
        // unauthorized or unavailable comparison cannot reveal source existence or size.
        return Failure(request, status, reason);
    }

    internal static string? ValidatePackages(
        RevisionComparePlanRequest request,
        RevisionComparePackage basePackage,
        RevisionComparePackage comparePackage,
        out RevisionCompareAdmission? admission)
    {
        admission = null;
        if (basePackage.RawMarkdown.Length > request.Budgets.MaxSourceBytes
            || comparePackage.RawMarkdown.Length > request.Budgets.MaxSourceBytes)
        {
            return "revision_compare_source_budget_exceeded";
        }
        if (!RevisionComparePackageSeal.Verify(basePackage)
            || !RevisionComparePackageSeal.Verify(comparePackage))
        {
            return "revision_compare_package_tampered";
        }
        if (basePackage.ArticleId != comparePackage.ArticleId
            || basePackage.ArticleId != request.ArticleId)
        {
            return "revision_compare_cross_article_invalid";
        }
        if (!MatchesSelector(request.ArticleId, request.Base, basePackage)
            || !MatchesSelector(request.ArticleId, request.Compare, comparePackage))
        {
            return "revision_compare_source_stale";
        }
        if (basePackage.Snapshots.Any(static snapshot => snapshot.State == RevisionCompareSnapshotState.Missing)
            || comparePackage.Snapshots.Any(static snapshot => snapshot.State == RevisionCompareSnapshotState.Missing))
        {
            return "revision_compare_package_incomplete";
        }
        foreach (string fieldId in request.Options.MetadataFields)
        {
            if (!basePackage.Metadata.Any(value => string.Equals(value.FieldId, fieldId, StringComparison.Ordinal))
                || !comparePackage.Metadata.Any(value => string.Equals(value.FieldId, fieldId, StringComparison.Ordinal)))
            {
                return "revision_compare_metadata_incomplete";
            }
        }

        int baseLines = RevisionCompareContract.CountLines(basePackage.RawMarkdown.AsSpan());
        int compareLines = RevisionCompareContract.CountLines(comparePackage.RawMarkdown.AsSpan());
        admission = CreateAdmission(request, basePackage, comparePackage, baseLines, compareLines);
        if (baseLines > request.Budgets.MaxLineCount || compareLines > request.Budgets.MaxLineCount)
        {
            return "revision_compare_source_budget_exceeded";
        }

        if (admission.InitialEstimatedMemoryBytes > request.Budgets.MaxMemoryBytes)
        {
            return "revision_compare_memory_budget_exceeded";
        }

        if (admission.MinimumEstimatedOutputBytes > request.Budgets.MaxOutputBytes)
        {
            return "revision_compare_output_budget_exceeded";
        }

        return null;
    }

    internal static RevisionCompareAdmission CreateAdmission(
        RevisionComparePlanRequest request,
        RevisionComparePackage basePackage,
        RevisionComparePackage comparePackage)
        => CreateAdmission(
            request,
            basePackage,
            comparePackage,
            RevisionCompareContract.CountLines(basePackage.RawMarkdown.AsSpan()),
            RevisionCompareContract.CountLines(comparePackage.RawMarkdown.AsSpan()));

    private static RevisionCompareAdmission CreateAdmission(
        RevisionComparePlanRequest request,
        RevisionComparePackage basePackage,
        RevisionComparePackage comparePackage,
        int baseLines,
        int compareLines)
    {
        long estimatedMemory = ((long)basePackage.RawMarkdown.Length + comparePackage.RawMarkdown.Length) * 4L
            + ((long)baseLines + compareLines) * 64L;
        long minimumOutput = ((long)baseLines + compareLines) * 48L;
        int hunkLimit = checked(request.Budgets.MaxHunksPerChunk * request.Budgets.MaxChunks);
        return new RevisionCompareAdmission(
            RevisionCompareAdmissionMode.BoundedWorkerChunksV1,
            basePackage.RawMarkdown.Length,
            comparePackage.RawMarkdown.Length,
            baseLines,
            compareLines,
            estimatedMemory,
            minimumOutput,
            request.Budgets.MaxTokenCount,
            hunkLimit,
            request.Budgets.MaxChunks,
            RevisionCompareCanonical.AdmissionDigest(
                RevisionCompareAdmissionMode.BoundedWorkerChunksV1,
                basePackage.RawMarkdown.Length,
                comparePackage.RawMarkdown.Length,
                baseLines,
                compareLines,
                estimatedMemory,
                minimumOutput,
                request.Budgets.MaxTokenCount,
                hunkLimit,
                request.Budgets.MaxChunks));
    }

    internal static RevisionComparePlanStatus ValidationStatus(string validationCode)
        => validationCode.Contains("stale", StringComparison.Ordinal)
            ? RevisionComparePlanStatus.Stale
            : validationCode.Contains("budget", StringComparison.Ordinal)
                ? RevisionComparePlanStatus.BudgetExceeded
                : validationCode.Contains("tampered", StringComparison.Ordinal)
                    ? RevisionComparePlanStatus.Tampered
                    : RevisionComparePlanStatus.Invalid;

    internal static bool MatchesSelector(
        int articleId,
        RevisionCompareSourceSelector selector,
        RevisionComparePackage package)
    {
        if (package.ArticleId != articleId || package.SourceKind != selector.Kind)
        {
            return false;
        }

        bool coordinatesMatch = selector.Kind switch
        {
            RevisionCompareSourceKind.CurrentDraft => package.RevisionId is null
                && package.ServerRevision == selector.ExpectedServerRevision
                && string.Equals(package.DocumentEpoch, selector.DocumentEpoch, StringComparison.Ordinal),
            RevisionCompareSourceKind.CurrentRevision or RevisionCompareSourceKind.HistoricalRevision =>
                package.RevisionId == selector.RevisionId,
            _ => false
        };
        return coordinatesMatch
            && (selector.ExpectedSourceDigest is null
                || string.Equals(selector.ExpectedSourceDigest, package.SourceDigest, StringComparison.Ordinal));
    }

    private static RevisionComparePlanResult Failure(
        RevisionComparePlanRequest request,
        RevisionComparePlanStatus status,
        string reasonCode,
        string? basePackageDigest = null,
        string? comparePackageDigest = null)
    {
        RevisionComparePlanReceipt receipt = Receipt(
            request,
            status,
            reasonCode,
            null,
            null,
            null,
            null,
            basePackageDigest,
            comparePackageDigest);
        return new RevisionComparePlanResult(status, null, receipt);
    }

    private static RevisionComparePlanReceipt Receipt(
        RevisionComparePlanRequest request,
        RevisionComparePlanStatus status,
        string reasonCode,
        string? planDigest,
        RevisionComparePackageReference? basePackageReference,
        RevisionComparePackageReference? comparePackageReference,
        RevisionCompareAdmission? admission,
        string? basePackageDigest = null,
        string? comparePackageDigest = null)
    {
        var receipt = new RevisionComparePlanReceipt(
            RevisionCompareContract.SchemaVersion,
            request.Reader.RequestId,
            status,
            reasonCode,
            planDigest,
            basePackageReference?.PackageDigest ?? basePackageDigest,
            comparePackageReference?.PackageDigest ?? comparePackageDigest,
            basePackageReference,
            comparePackageReference,
            RevisionCompareCanonical.PermissionScopeDigest(request),
            RevisionCompareCanonical.MetadataSchemaDigest(),
            RevisionCompareCanonical.OptionsDigest(request.Options),
            RevisionCompareCanonical.BudgetDigest(request.Budgets),
            admission?.ContentDigest,
            request.CancellationIdentity,
            string.Empty);
        return receipt with
        {
            ContentDigest = RevisionCompareCanonical.ReceiptDigest(receipt)
        };
    }
}

public sealed record RevisionComparePlanVerification(
    bool Valid,
    RevisionComparePlanStatus Status,
    string ReasonCode,
    string ContentDigest);

public sealed class RevisionComparePlanVerifier(IRevisionComparePackageReader packageReader)
{
    public async Task<RevisionComparePlanVerification> VerifyAsync(
        RevisionComparePlanBundle bundle,
        DateTimeOffset observedAtUtc,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(bundle);
        if (observedAtUtc.Offset != TimeSpan.Zero)
        {
            return Invalid("revision_compare_observation_time_invalid");
        }
        if (observedAtUtc > bundle.Plan.ExpiresAtUtc)
        {
            return Invalid("revision_compare_plan_expired", RevisionComparePlanStatus.Stale);
        }
        if (!LocalBundleValid(bundle))
        {
            return Invalid("revision_compare_plan_tampered", RevisionComparePlanStatus.Tampered);
        }

        using var timeout = new CancellationTokenSource(bundle.Plan.Budgets.TimeoutMilliseconds);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
        try
        {
            linked.Token.ThrowIfCancellationRequested();
            RevisionComparePackageReadResult baseRead = await packageReader.ReadAuthorizedAsync(
                    bundle.Plan.Reader,
                    bundle.Plan.ArticleId,
                    bundle.Plan.BaseSelector,
                    linked.Token)
                .WaitAsync(linked.Token)
                .ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested();
            RevisionComparePackageReadResult compareRead = await packageReader.ReadAuthorizedAsync(
                    bundle.Plan.Reader,
                    bundle.Plan.ArticleId,
                    bundle.Plan.CompareSelector,
                    linked.Token)
                .WaitAsync(linked.Token)
                .ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested();
            if (DateTimeOffset.UtcNow > bundle.Plan.ExpiresAtUtc)
            {
                return Invalid("revision_compare_plan_expired", RevisionComparePlanStatus.Stale);
            }
            if (baseRead.Status != RevisionComparePackageReadStatus.Available
                || compareRead.Status != RevisionComparePackageReadStatus.Available
                || baseRead.Package is null
                || compareRead.Package is null)
            {
                return Invalid("revision_compare_source_stale", RevisionComparePlanStatus.Stale);
            }
            RevisionComparePackage basePackage = baseRead.Package;
            RevisionComparePackage comparePackage = compareRead.Package;
            RevisionComparePlanRequest request = Request(bundle.Plan);
            string? validationCode = RevisionComparePlanner.ValidatePackages(
                request,
                basePackage,
                comparePackage,
                out RevisionCompareAdmission? admission);
            if (validationCode is not null)
            {
                return Invalid(validationCode, RevisionComparePlanner.ValidationStatus(validationCode));
            }
            if (!RevisionCompareCanonical.ReferenceMatches(bundle.Plan.BasePackage, baseRead.Package)
                || !RevisionCompareCanonical.ReferenceMatches(bundle.Plan.ComparePackage, compareRead.Package)
                || admission != bundle.Plan.Admission)
            {
                return Invalid("revision_compare_source_stale", RevisionComparePlanStatus.Stale);
            }

            linked.Token.ThrowIfCancellationRequested();
            return new RevisionComparePlanVerification(
                true,
                RevisionComparePlanStatus.Accepted,
                "accepted",
                VerificationDigest(bundle.Plan.ContentDigest, "accepted"));
        }
        catch (OperationCanceledException)
        {
            string reason = timeout.IsCancellationRequested && !cancellationToken.IsCancellationRequested
                ? "revision_compare_timeout"
                : "revision_compare_cancelled";
            return Invalid(reason, RevisionComparePlanStatus.Cancelled);
        }
    }

    public static bool LocalBundleValid(RevisionComparePlanBundle bundle)
    {
        if (bundle.Plan.SchemaVersion != RevisionCompareContract.SchemaVersion
            || !string.Equals(bundle.Plan.PlannerVersion, RevisionCompareContract.PlannerVersion, StringComparison.Ordinal)
            || bundle.Plan.Admission is null
            || !RevisionComparePackageSeal.Verify(bundle.BasePackage)
            || !RevisionComparePackageSeal.Verify(bundle.ComparePackage)
            || !RevisionCompareCanonical.ReferenceMatches(bundle.Plan.BasePackage, bundle.BasePackage)
            || !RevisionCompareCanonical.ReferenceMatches(bundle.Plan.ComparePackage, bundle.ComparePackage)
            || bundle.Receipt.SchemaVersion != RevisionCompareContract.SchemaVersion
            || bundle.Receipt.RequestId != bundle.Plan.Reader.RequestId
            || bundle.Receipt.Status != RevisionComparePlanStatus.Accepted
            || !string.Equals(bundle.Receipt.ReasonCode, "accepted", StringComparison.Ordinal)
            || !string.Equals(bundle.Receipt.PlanDigest, bundle.Plan.ContentDigest, StringComparison.Ordinal)
            || !string.Equals(
                bundle.Receipt.BasePackageDigest,
                bundle.Plan.BasePackage.PackageDigest,
                StringComparison.Ordinal)
            || !string.Equals(
                bundle.Receipt.ComparePackageDigest,
                bundle.Plan.ComparePackage.PackageDigest,
                StringComparison.Ordinal)
            || bundle.Receipt.BasePackageReference != bundle.Plan.BasePackage
            || bundle.Receipt.ComparePackageReference != bundle.Plan.ComparePackage
            || !string.Equals(
                bundle.Receipt.PermissionScopeDigest,
                RevisionCompareCanonical.PermissionScopeDigest(Request(bundle.Plan)),
                StringComparison.Ordinal)
            || !string.Equals(
                bundle.Receipt.MetadataSchemaDigest,
                RevisionCompareCanonical.MetadataSchemaDigest(),
                StringComparison.Ordinal)
            || !string.Equals(
                bundle.Receipt.OptionsDigest,
                RevisionCompareCanonical.OptionsDigest(bundle.Plan.Options),
                StringComparison.Ordinal)
            || !string.Equals(
                bundle.Receipt.BudgetDigest,
                RevisionCompareCanonical.BudgetDigest(bundle.Plan.Budgets),
                StringComparison.Ordinal)
            || !string.Equals(
                bundle.Receipt.AdmissionDigest,
                bundle.Plan.Admission.ContentDigest,
                StringComparison.Ordinal)
            || !string.Equals(
                bundle.Receipt.CancellationIdentity,
                bundle.Plan.CancellationIdentity,
                StringComparison.Ordinal))
        {
            return false;
        }

        RevisionComparePlanRequest request = Request(bundle.Plan);
        try
        {
            RevisionCompareContract.ValidateRequest(request);
        }
        catch (RevisionCompareContractException)
        {
            return false;
        }

        RevisionCompareAdmission admission = RevisionComparePlanner.CreateAdmission(
            request,
            bundle.BasePackage,
            bundle.ComparePackage);
        if (admission != bundle.Plan.Admission)
        {
            return false;
        }

        string expectedPlan = RevisionCompareCanonical.PlanDigest(
            request,
            bundle.Plan.BasePackage,
            bundle.Plan.ComparePackage,
            bundle.Plan.Admission);
        string expectedReceipt = RevisionCompareCanonical.ReceiptDigest(bundle.Receipt);
        return string.Equals(expectedPlan, bundle.Plan.ContentDigest, StringComparison.Ordinal)
            && string.Equals(expectedReceipt, bundle.Receipt.ContentDigest, StringComparison.Ordinal);
    }

    private static RevisionComparePlanRequest Request(RevisionComparePlan plan)
        => new(
            plan.ArticleId,
            plan.Reader,
            plan.BaseSelector,
            plan.CompareSelector,
            plan.Options,
            plan.Budgets,
            plan.CancellationIdentity,
            plan.ExpiresAtUtc);

    private static RevisionComparePlanVerification Invalid(
        string reasonCode,
        RevisionComparePlanStatus status = RevisionComparePlanStatus.Invalid)
        => new(false, status, reasonCode, VerificationDigest(null, reasonCode));

    private static string VerificationDigest(string? planDigest, string reasonCode)
    {
        using var hash = System.Security.Cryptography.IncrementalHash.CreateHash(
            System.Security.Cryptography.HashAlgorithmName.SHA256);
        RevisionCompareCanonical.Append(hash, RevisionCompareContract.SchemaVersion);
        RevisionCompareCanonical.Append(hash, planDigest);
        RevisionCompareCanonical.Append(hash, reasonCode);
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }
}
