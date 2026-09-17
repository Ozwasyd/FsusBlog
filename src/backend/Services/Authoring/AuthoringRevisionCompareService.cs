using FsusBlog.Core.Services.Articles;

namespace FsusBlog.Server.Services.Authoring;

public sealed record AuthoringRevisionCompareResult(
    RevisionComparePlanResult Plan,
    RevisionSourceDiffResult? Diff)
{
    public bool IsSuccess => Plan.IsSuccess && Diff?.IsSuccess == true;
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
    TimeProvider timeProvider) : IAuthoringRevisionCompareService
{
    public Task<RevisionComparePlanResult> CreatePlanAsync(
        RevisionComparePlanRequest request,
        CancellationToken cancellationToken = default)
        => planner.CreateAsync(request, cancellationToken);

    public async Task<AuthoringRevisionCompareResult> CompareAsync(
        RevisionComparePlanRequest request,
        CancellationToken cancellationToken = default)
    {
        RevisionComparePlanResult plan = await planner.CreateAsync(request, cancellationToken).ConfigureAwait(false);
        if (!plan.IsSuccess)
        {
            return new AuthoringRevisionCompareResult(plan, null);
        }

        RevisionSourceDiffResult diff = await diffEngine.ComputeAsync(
                plan.Bundle!,
                timeProvider.GetUtcNow(),
                cancellationToken)
            .ConfigureAwait(false);
        return new AuthoringRevisionCompareResult(plan, diff);
    }
}
