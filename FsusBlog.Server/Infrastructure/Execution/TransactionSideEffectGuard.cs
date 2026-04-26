namespace FsusBlog.Server.Infrastructure.Execution;

internal static class TransactionSideEffectGuard
{
    public static bool CanPublishAfterCommit<TTransactionResult>(TTransactionResult transactionResult, ILogger logger, string operation)
    {
        if (transactionResult is null)
        {
            logger.LogError("Transaction result missing before side-effects: {Operation}", operation);
            return false;
        }

        Type type = transactionResult.GetType();
        if (type.GetProperty("IsSuccess")?.GetValue(transactionResult) is not bool isSuccess)
        {
            logger.LogError("Transaction result shape invalid before side-effects: {Operation}", operation);
            return false;
        }

        if (isSuccess)
        {
            return true;
        }

        Exception? errorException = type.GetProperty("ErrorException")?.GetValue(transactionResult) as Exception;
        string? errorMessage = type.GetProperty("ErrorMessage")?.GetValue(transactionResult) as string;
        if (errorException is not null)
        {
            logger.LogError(errorException, "Transaction rolled back before side-effects: {Operation}", operation);
        }
        else
        {
            logger.LogError("Transaction rolled back before side-effects: {Operation} | Error={Error}", operation, errorMessage ?? "unknown");
        }

        return false;
    }
}
