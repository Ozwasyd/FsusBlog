using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Testing;

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
            await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
            IHttpContextAccessor httpContextAccessor = scope.ServiceProvider.GetRequiredService<IHttpContextAccessor>();
            HttpContext? previousContext = httpContextAccessor.HttpContext;
            try
            {
                if (!string.IsNullOrWhiteSpace(request.TestSessionId))
                {
                    var context = new DefaultHttpContext
                    {
                        RequestServices = scope.ServiceProvider
                    };
                    context.Request.Headers[HttpTestSessionKeyScope.HeaderName] = request.TestSessionId;
                    httpContextAccessor.HttpContext = context;
                }

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
                httpContextAccessor.HttpContext = previousContext;
                scheduler.Complete(request);
            }
        }
    }
}
