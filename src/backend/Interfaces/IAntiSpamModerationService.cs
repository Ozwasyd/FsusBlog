using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Interfaces;

public interface IAntiSpamModerationScorer
{
    string ProviderName { get; }
    string ModelName { get; }
    string ContractVersion { get; }
    Task<AntiSpamModerationResult> ScoreAsync(AntiSpamModerationRequest request, CancellationToken cancellationToken);
}

public interface IAntiSpamModerationService
{
    Task<AntiSpamModerationResult?> ScoreCommentAsync(AntiSpamCommentModerationContext context, CancellationToken cancellationToken = default);
}

public interface ICommentModerationDispositionPolicy
{
    CommentModerationDisposition Decide(
        Comment comment,
        RegionModerationDecision regionDecision,
        AntiSpamModerationResult modelResult);
}
