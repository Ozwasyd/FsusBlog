namespace FsusBlog.V2.Server;

internal static class ImmediateConcurrencyLimits
{
    internal static void AddImmediateConcurrency(this RateLimiterOptions options, string policy, int permits) =>
        options.AddConcurrencyLimiter(policy, limiter =>
        {
            limiter.PermitLimit = permits;
            limiter.QueueLimit = 0;
        });
}
