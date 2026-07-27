namespace FsusBlog.Server.Infrastructure.PublicAot;

internal sealed class PublicAotArtifactRecoveryService(
    PublicAotFileShellCache cache,
    ILogger<PublicAotArtifactRecoveryService> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await cache.RecoverArtifactTransactionsAsync(cancellationToken).ConfigureAwait(false);
        logger.LogInformation("public-aot-artifact-recovery-complete");
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
