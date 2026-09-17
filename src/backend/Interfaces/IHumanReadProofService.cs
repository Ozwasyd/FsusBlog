using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces;

public interface IHumanReadProofService
{
    ValueTask<HumanReadChallengeResponse?> CreateChallengeAsync(HttpContext context, HumanReadChallengeRequest request, CancellationToken cancellationToken = default);

    ValueTask<HumanReadSubmitResponse> SubmitAsync(HttpContext context, HumanReadSubmitRequest request, CancellationToken cancellationToken = default);
}
