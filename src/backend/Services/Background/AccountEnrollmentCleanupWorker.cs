using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Services.Background;

public sealed class AccountEnrollmentCleanupWorker(
    IServiceScopeFactory scopeFactory,
    IConfiguration configuration,
    ILogger<AccountEnrollmentCleanupWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        TimeSpan interval = TimeSpan.FromMinutes(Math.Clamp(
            configuration.GetValue<int?>("AuthEnrollment:CleanupIntervalMinutes") ?? 5,
            1,
            30));
        using var timer = new PeriodicTimer(interval);
        do
        {
            try
            {
                await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
                int removed = await scope.ServiceProvider.GetRequiredService<IAccountEnrollmentService>()
                    .CleanupExpiredAsync(stoppingToken);
                if (removed > 0)
                {
                    logger.LogInformation("Cleaned {Count} expired provisional account enrollments.", removed);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                logger.LogError(exception, "Expired account enrollment cleanup failed.");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
