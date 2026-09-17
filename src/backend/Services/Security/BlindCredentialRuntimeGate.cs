using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Services.Security;

public sealed class BlindCredentialRuntimeOptions
{
    public const string SectionName = "AnonymousCredentialIssuer:BlindRsa";

    public bool Enabled
    {
        get; set;
    }
    public int TimeoutMs { get; set; } = 2_000;
    public int MinimumResponseMilliseconds { get; set; } = 2_500;
}

public interface IBlindCredentialRuntimeGate
{
    bool IsEnabled
    {
        get;
    }
    TimeSpan GetEnvelopeDelay(TimeSpan elapsed);
}

/// <summary>
/// Reload-aware emergency gate for blind issuance. Disabling the configuration
/// section stops metadata publication and rejects requests before private-key use.
/// </summary>
public sealed class BlindCredentialRuntimeGate(
    IOptionsMonitor<BlindCredentialRuntimeOptions> options) : IBlindCredentialRuntimeGate
{
    public bool IsEnabled => options.CurrentValue.Enabled;

    public TimeSpan GetEnvelopeDelay(TimeSpan elapsed) =>
        CalculateEnvelopeDelay(elapsed, options.CurrentValue);

    internal static TimeSpan CalculateEnvelopeDelay(
        TimeSpan elapsed,
        BlindCredentialRuntimeOptions options)
    {
        int timeoutMs = Math.Clamp(options.TimeoutMs, 100, 30_000);
        int bucketMs = Math.Clamp(
            Math.Max(options.MinimumResponseMilliseconds, timeoutMs + 100),
            100,
            30_000);
        long elapsedMs = Math.Max(0, (long)Math.Ceiling(elapsed.TotalMilliseconds));
        long bucketCount = Math.Max(1, (elapsedMs + bucketMs - 1) / bucketMs);
        long targetMs = bucketCount * bucketMs;
        return TimeSpan.FromMilliseconds(Math.Max(0, targetMs - elapsed.TotalMilliseconds));
    }
}
