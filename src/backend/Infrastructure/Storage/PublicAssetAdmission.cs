using System.Threading.RateLimiting;

using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Infrastructure.Storage;

/// <summary>Owns the in-memory per-client limiter for one application instance.</summary>
public sealed class PublicAssetAdmission : IDisposable
{
    private readonly PartitionedRateLimiter<HttpContext> _limiter;

    public PublicAssetAdmission(PublicAssetDeliveryPolicy policy)
    {
        _limiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
            RateLimitPartition.GetFixedWindowLimiter(context.GetClientIp(), _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = policy.PermitLimit,
                Window = TimeSpan.FromSeconds(policy.WindowSeconds),
                QueueLimit = 0,
                AutoReplenishment = true
            }));
    }

    public ValueTask<RateLimitLease> AcquireAsync(HttpContext context)
        => _limiter.AcquireAsync(context, 1, context.RequestAborted);

    public void Dispose() => _limiter.Dispose();
}
