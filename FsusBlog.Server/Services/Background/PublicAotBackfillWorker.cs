using FsusBlog.Server.Infrastructure.PublicAot;

namespace FsusBlog.Server.Services.Background;

public sealed class PublicAotBackfillWorker(
    PublicAotBackfillScheduler scheduler,
    IServiceScopeFactory scopeFactory,
    ILogger<PublicAotBackfillWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (PublicAotBackfillRequest request in scheduler.ReadAllAsync(stoppingToken))
        {
            try
            {
                await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
                IPublicAotBackfillGenerator generator = scope.ServiceProvider.GetRequiredService<IPublicAotBackfillGenerator>();
                await generator.GenerateAndStoreAsync(request, stoppingToken);
                logger.LogInformation("Public AOT backfill completed: {Kind} {RouteKey}", request.Kind, request.RouteKey);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
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
}
