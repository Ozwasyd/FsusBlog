using FsusBlog.Server.Infrastructure.Security;

namespace FsusBlog.Server.Interfaces;

public interface ICrawlerRiskService
{
    Task AddRiskAsync(HttpContext context, CrawlerRiskReason reason, int score, TimeSpan ttl, CancellationToken cancellationToken = default);

    Task<int> GetRiskScoreAsync(HttpContext context, CancellationToken cancellationToken = default);

    Task<bool> IsHighRiskAsync(HttpContext context, CancellationToken cancellationToken = default);

    Task ResetRiskAsync(string ip, CancellationToken cancellationToken = default);
}
