using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.Auth;

internal interface IHumanReadProofEndpointAdapter
{
    ValueTask<HumanReadChallengeResponse?> CreateChallengeAsync(
        HttpContext context,
        HumanReadChallengeRequest request,
        CancellationToken cancellationToken);

    ValueTask<HumanReadSubmitResponse> SubmitAsync(
        HttpContext context,
        HumanReadSubmitRequest request,
        CancellationToken cancellationToken);
}

internal sealed class HumanReadProofEndpointAdapter(IHumanReadProofService proofService) : IHumanReadProofEndpointAdapter
{
    public ValueTask<HumanReadChallengeResponse?> CreateChallengeAsync(
        HttpContext context,
        HumanReadChallengeRequest request,
        CancellationToken cancellationToken)
        => proofService.CreateChallengeAsync(context, request, cancellationToken);

    public ValueTask<HumanReadSubmitResponse> SubmitAsync(
        HttpContext context,
        HumanReadSubmitRequest request,
        CancellationToken cancellationToken)
        => proofService.SubmitAsync(context, request, cancellationToken);
}
