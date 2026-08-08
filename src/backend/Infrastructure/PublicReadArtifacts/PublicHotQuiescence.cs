namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

/// <summary>
/// Single atomic snapshot of every PublicHot activity owner that release drain,
/// runtime health and readiness share. Each field is nullable: an unavailable
/// collector or an unknown field must fail closed instead of being assumed zero.
/// </summary>
public sealed record PublicHotActivitySnapshot(
    long? QueuedCount,
    long? InFlightBatchCount,
    long? ActiveProjectorCount,
    string? StoreState,
    long? PendingObligationCount,
    long? FailedTerminalObligationCount,
    long? PublishedGeneration,
    long? RevocationPendingCount,
    long? ActiveBackgroundClaimCountForPublicHot,
    long? CurrentTargetGeneration,
    string? CollectorError = null);

public sealed record PublicHotQuiescenceResult(
    bool Drained,
    IReadOnlyList<string> Blockers,
    string? Error);

/// <summary>
/// The unique quiescence predicate for PublicHot. A snapshot is drained only when
/// every mandatory field is available, non-negative and at its quiescent value and
/// the published generation reaches the requested drain generation. Any unknown,
/// negative or collector-failed field blocks with the exact field name and value.
/// </summary>
public static class PublicHotQuiescence
{
    public static PublicHotQuiescenceResult Evaluate(
        PublicHotActivitySnapshot snapshot,
        long targetGeneration)
    {
        if (!string.IsNullOrWhiteSpace(snapshot.CollectorError))
        {
            return new PublicHotQuiescenceResult(
                Drained: false,
                ["collector-error=" + snapshot.CollectorError],
                snapshot.CollectorError);
        }

        var blockers = new List<string>(10);
        EvaluateZero(snapshot.QueuedCount, "queued-count", blockers);
        EvaluateZero(snapshot.InFlightBatchCount, "in-flight-batch-count", blockers);
        EvaluateZero(snapshot.ActiveProjectorCount, "active-projector-count", blockers);
        if (snapshot.StoreState is null)
        {
            blockers.Add("store-state=unavailable");
        }
        else if (string.Equals(
            snapshot.StoreState,
            nameof(PublicHotReadState.Building),
            StringComparison.Ordinal))
        {
            blockers.Add($"store-state={snapshot.StoreState}");
        }

        EvaluateZero(snapshot.PendingObligationCount, "pending-obligation-count", blockers);
        EvaluateZero(snapshot.FailedTerminalObligationCount, "failed-terminal-obligation-count", blockers);
        if (!snapshot.PublishedGeneration.HasValue)
        {
            blockers.Add("published-generation=unavailable");
        }
        else if (snapshot.PublishedGeneration.Value < targetGeneration)
        {
            blockers.Add(
                $"published-generation={snapshot.PublishedGeneration.Value}<requested-drain-generation={targetGeneration}");
        }

        EvaluateZero(snapshot.RevocationPendingCount, "revocation-pending-count", blockers);
        EvaluateZero(
            snapshot.ActiveBackgroundClaimCountForPublicHot,
            "active-background-claim-count-for-public-hot",
            blockers);
        return new PublicHotQuiescenceResult(
            blockers.Count == 0,
            blockers,
            Error: null);
    }

    private static void EvaluateZero(
        long? value,
        string field,
        List<string> blockers)
    {
        if (!value.HasValue)
        {
            blockers.Add(field + "=unavailable");
        }
        else if (value.Value < 0)
        {
            blockers.Add($"{field}={value.Value}");
        }
        else if (value.Value != 0)
        {
            blockers.Add($"{field}={value.Value}");
        }
    }
}
