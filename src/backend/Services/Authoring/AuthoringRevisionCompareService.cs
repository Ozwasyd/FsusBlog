using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Services.Authoring;

public sealed record AuthoringRevisionCompareResult(
    RevisionComparePlanResult? Plan,
    RevisionSourceDiffResult? Diff,
    RevisionMetadataDiffResult? MetadataDiff = null,
    RevisionMetadataDiffStatus Status = RevisionMetadataDiffStatus.Complete,
    string ReasonCode = "accepted")
{
    public bool IsReviewable => Plan?.IsSuccess == true && Diff?.IsSuccess == true
        && Status is RevisionMetadataDiffStatus.Complete or RevisionMetadataDiffStatus.PartialMissingAuthority
        && (MetadataDiff is null ? Status == RevisionMetadataDiffStatus.Complete
            : MetadataDiff.IsReviewable && Status == MetadataDiff.Receipt.Status && ReasonCode == MetadataDiff.Receipt.Reason);
    public bool IsSuccess => IsReviewable && Status == RevisionMetadataDiffStatus.Complete
        && (MetadataDiff is null || MetadataDiff.IsSuccess);
}

public interface IAuthoringRevisionCompareService
{
    Task<RevisionComparePlanResult> CreatePlanAsync(
        RevisionComparePlanRequest request,
        CancellationToken cancellationToken = default);

    Task<AuthoringRevisionCompareResult> CompareAsync(
        RevisionComparePlanRequest request,
        CancellationToken cancellationToken = default);
}

public sealed class AuthoringRevisionCompareService(
    RevisionComparePlanner planner,
    RevisionSourceDiffEngine diffEngine,
    RevisionMetadataDiffEngine metadataEngine,
    RevisionMetadataDiffVerifier metadataVerifier,
    RevisionComparePlanVerifier planVerifier,
    IRevisionMarkdownStructureAuthority structureAuthority,
    TimeProvider timeProvider) : IAuthoringRevisionCompareService
{
    // Small plan/status and mapped DTO reserve. This logical reserve does not
    // establish actual serialized output or final JSON/frame storage limits.
    internal const long TransportOutputReserveBytes = 4_096;

    public Task<RevisionComparePlanResult> CreatePlanAsync(
        RevisionComparePlanRequest request,
        CancellationToken cancellationToken = default)
        => planner.CreateAsync(request, cancellationToken);

    public async Task<AuthoringRevisionCompareResult> CompareAsync(
        RevisionComparePlanRequest request,
        CancellationToken cancellationToken = default)
    {
        // Validation precedes timeout allocation so invalid budgets keep the
        // canonical planner's refusal semantics without starting any reader.
        try
        {
            RevisionCompareContract.ValidateRequest(request);
        }
        catch (RevisionCompareContractException)
        {
            RevisionComparePlanResult invalid = await planner.CreateAsync(request, cancellationToken).ConfigureAwait(false);
            return new(invalid, null, Status: MapStatus(invalid.Status), ReasonCode: invalid.Receipt.ReasonCode);
        }

        // One deadline covers admission, both workers, independent verification
        // and final authorization. Inner engine deadlines cannot renew it.
        using var timeout = new CancellationTokenSource(request.Budgets.TimeoutMilliseconds);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
        try
        {
            RevisionComparePlanResult plan = await planner.CreateAsync(request, linked.Token)
                .WaitAsync(linked.Token).ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested();
            if (!plan.IsSuccess)
                return new(plan, null, Status: MapStatus(plan.Status), ReasonCode: plan.Receipt.ReasonCode);

            RevisionComparePlanBundle bundle = plan.Bundle!;
            RevisionSourceDiffResult diff = await diffEngine.ComputeAsync(bundle, timeProvider.GetUtcNow(), linked.Token)
                .WaitAsync(linked.Token).ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested();
            if (!diff.IsSuccess)
                return Refused(MapStatus(diff.Receipt.Status), diff.Receipt.ReasonCode);
            if (bundle.Plan.Options.MetadataFields.IsEmpty)
            {
                string? sourceWireRefusal = AdmitWire(plan, diff, null, 0, request.Budgets, linked.Token);
                return sourceWireRefusal is null ? new(plan, diff)
                    : Refused(RevisionMetadataDiffStatus.BudgetExceeded, sourceWireRefusal);
            }

            long heldSourceMemory = diff.Receipt.EstimatedMemoryBytes + TransportOutputReserveBytes;
            RevisionMetadataDiffResult metadata = await metadataEngine.ComputeAsync(bundle, timeProvider.GetUtcNow(), linked.Token,
                    heldSourceMemory)
                .WaitAsync(linked.Token).ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested();
            if (!metadata.IsReviewable)
                return Refused(metadata.Receipt.Status, metadata.Receipt.Reason);
            long metadataOutput = RevisionMetadataDiffEngine.EstimateOutputBytes(metadata.Receipt, metadata.Fields, linked.Token);
            if (metadataOutput > request.Budgets.MaxOutputBytes - diff.Receipt.EstimatedOutputBytes - TransportOutputReserveBytes)
                return Refused(RevisionMetadataDiffStatus.BudgetExceeded, "article_revision_compare_output_budget");
            // Verification retains this candidate while the existing worker
            // independently recomputes it. Reserve both outputs and held source.
            long verificationMemory = RevisionMetadataDiffEngine.EstimateInputReserveBytes(bundle, linked.Token) + metadataOutput * 2;
            if (verificationMemory > request.Budgets.MaxMemoryBytes - heldSourceMemory)
                return Refused(RevisionMetadataDiffStatus.BudgetExceeded, "article_revision_compare_memory_budget");
            var sourceVerifier = new RevisionSourceDiffResultVerifier(structureAuthority);
            if (!await sourceVerifier.VerifyAsync(bundle, diff, linked.Token).WaitAsync(linked.Token).ConfigureAwait(false)
                || !await metadataVerifier.VerifyAsync(bundle, metadata, timeProvider.GetUtcNow(), linked.Token, heldSourceMemory)
                    .WaitAsync(linked.Token).ConfigureAwait(false))
                return Refused(RevisionMetadataDiffStatus.Unavailable, "article_revision_compare_verification_failed");
            linked.Token.ThrowIfCancellationRequested();
            string? wireRefusal = AdmitWire(plan, diff, metadata, metadataOutput, request.Budgets, linked.Token);
            if (wireRefusal is not null)
                return Refused(RevisionMetadataDiffStatus.BudgetExceeded, wireRefusal);
            // Count potentially large output before final authorization, so a
            // revoked epoch/permission during counting cannot publish values.
            RevisionComparePlanVerification publication = await planVerifier.VerifyAsync(bundle, timeProvider.GetUtcNow(), linked.Token)
                .WaitAsync(linked.Token).ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested();
            if (!publication.Valid || plan.Receipt != bundle.Receipt)
                return Refused(MapStatus(publication.Status), "article_revision_compare_not_authorized");
            return new(plan, diff, metadata, metadata.Receipt.Status, metadata.Receipt.Reason);
        }
        catch (OperationCanceledException)
        {
            return Refused(RevisionMetadataDiffStatus.Cancelled,
                timeout.IsCancellationRequested && !cancellationToken.IsCancellationRequested
                    ? "article_revision_compare_timeout" : "article_revision_compare_cancelled");
        }
    }

    private static string? AdmitWire(
        RevisionComparePlanResult plan,
        RevisionSourceDiffResult diff,
        RevisionMetadataDiffResult? metadata,
        long metadataOutput,
        RevisionCompareBudgets budgets,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        // Keep original worker estimates and both metadata output/DTO copies
        // held while the canonical serializer counts into its fixed buffer.
        long heldBytes = diff.Receipt.EstimatedMemoryBytes + TransportOutputReserveBytes + metadataOutput * 2;
        if (heldBytes > budgets.MaxMemoryBytes - AedsJsonResults.SerializationMemoryReserveBytes)
            return "article_revision_compare_wire_memory_budget";
        var response = ArticleRevisionCompareResponse.From(
            ArticleRevisionComparePlanReceipt.From(plan.Receipt), diff, metadata);
        AedsJsonOutputBudgetResult wire = AedsJsonResults.MeasureOutput(response, budgets.MaxOutputBytes, cancellationToken);
        if (wire.Status != AedsJsonOutputBudgetStatus.Accepted)
            return wire.Status == AedsJsonOutputBudgetStatus.SerializationBufferExceeded
                ? "article_revision_compare_serialization_buffer_budget" : "article_revision_compare_wire_output_budget";
        if (!AedsJsonResults.MemoryWithinBudget(wire, heldBytes, budgets.MaxMemoryBytes))
            return "article_revision_compare_wire_memory_budget";
        cancellationToken.ThrowIfCancellationRequested();
        return null;
    }

    private static AuthoringRevisionCompareResult Refused(RevisionMetadataDiffStatus status, string reason)
        => new(null, null, null, status, reason);

    private static RevisionMetadataDiffStatus MapStatus(RevisionComparePlanStatus status)
        => status switch
        {
            RevisionComparePlanStatus.Cancelled => RevisionMetadataDiffStatus.Cancelled,
            RevisionComparePlanStatus.Stale => RevisionMetadataDiffStatus.Stale,
            RevisionComparePlanStatus.Tampered => RevisionMetadataDiffStatus.Tampered,
            RevisionComparePlanStatus.Invalid => RevisionMetadataDiffStatus.Invalid,
            RevisionComparePlanStatus.BudgetExceeded => RevisionMetadataDiffStatus.BudgetExceeded,
            _ => RevisionMetadataDiffStatus.Unavailable
        };
}
