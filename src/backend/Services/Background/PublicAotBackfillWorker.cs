using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Services.Background;

public sealed class PublicAotBackfillWorker(
    PublicAotBackfillScheduler scheduler,
    IServiceScopeFactory scopeFactory,
    IConfiguration configuration,
    ILogger<PublicAotBackfillWorker> logger) : BackgroundService
{
    private readonly int _backfillConcurrency = NormalizeBackfillConcurrency(
        configuration.GetValue<int?>("PublicAot:BackfillConcurrency") ?? 1);

    internal int BackfillConcurrency => _backfillConcurrency;

    internal static int NormalizeBackfillConcurrency(int value)
        => Math.Clamp(value, 1, 8);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        Task[] workers = Enumerable.Range(0, _backfillConcurrency)
            .Select(_ => RunBackfillLoopAsync(stoppingToken))
            .ToArray();

        await Task.WhenAll(workers);
    }

    private async Task RunBackfillLoopAsync(CancellationToken stoppingToken)
    {
        await foreach (PublicAotBackfillRequest request in scheduler.ReadAllAsync(stoppingToken))
        {
            await ProcessRequestAsync(request, stoppingToken);
        }
    }

    private async Task ProcessRequestAsync(PublicAotBackfillRequest request, CancellationToken stoppingToken)
    {
        await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
        ITestSessionKeyScope testSessionKeyScope = scope.ServiceProvider.GetRequiredService<ITestSessionKeyScope>();
        using IDisposable testSessionScope = testSessionKeyScope.BeginScope(request.TestSessionId);
        try
        {
            IPublicAotBackfillGenerator generator = scope.ServiceProvider.GetRequiredService<IPublicAotBackfillGenerator>();
            await generator.GenerateAndStoreAsync(request, stoppingToken);
            logger.LogInformation("Public AOT backfill completed: {Kind} {RouteKey}", request.Kind, request.RouteKey);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Public AOT backfill failed: {Kind} {RouteKey}", request.Kind, request.RouteKey);
        }
        finally
        {
            scheduler.Complete(request);
        }
    }
}
