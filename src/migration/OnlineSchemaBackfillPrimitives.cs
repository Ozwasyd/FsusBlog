namespace FsusBlog.Migration;

public sealed record OnlineSchemaBackfillBatchResult(
    string? ResumeToken,
    int RowsProcessed,
    bool Complete,
    long? RemainingRowsEstimate = null,
    TimeSpan? SuggestedDelay = null);

public interface IOnlineSchemaBackfillHandler
{
    string MigrationId
    {
        get;
    }

    Task<OnlineSchemaBackfillBatchResult> ExecuteBatchAsync(
        string? resumeToken,
        int batchSize,
        CancellationToken cancellationToken);

    Task<bool> VerifyAsync(CancellationToken cancellationToken);
}
