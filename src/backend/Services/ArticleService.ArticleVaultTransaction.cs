using FsusBlog.Server.Infrastructure.Execution;

namespace FsusBlog.Server.Services;

public partial class ArticleService
{
    // The historical vault-named private scope is the canonical article owner transaction.
    // Canvas conversion enters this same scope; ambient transactions alone never qualify.
    private int _articleVaultGroupTransactionDepth;
    private Dictionary<int, string>? _articleVaultOutboxReferences;
    private HashSet<int?>? _articleVaultPublicFenceScopes;
    private List<Func<Task>>? _articleVaultPostCommitActions;

    private bool IsArticleVaultGroupTransaction => _articleVaultGroupTransactionDepth > 0;

    private void EnqueueArticleVaultPostCommitAction(int? fenceArticleId, Func<Task> action)
    {
        List<Func<Task>> actions = _articleVaultPostCommitActions
            ?? throw new InvalidOperationException("article_vault_post_commit_scope_missing");
        HashSet<int?> scopes = _articleVaultPublicFenceScopes
            ?? throw new InvalidOperationException("article_vault_public_fence_scope_missing");
        actions.Add(async () =>
        {
            await action().ConfigureAwait(false);
            scopes.Remove(fenceArticleId);
        });
    }

    private static async Task DrainArticleVaultPostCommitActionsAsync(IReadOnlyList<Func<Task>> actions)
    {
        foreach (Func<Task> action in actions)
        {
            await action().ConfigureAwait(false);
        }
    }

    private async Task<bool> EstablishArticlePublicMutationFenceAsync(
        int? articleId,
        CancellationToken cancellationToken)
    {
        if (!IsArticleVaultGroupTransaction)
        {
            await _mutationFence.BeginPublicMutationFenceAsync(articleId, cancellationToken).ConfigureAwait(false);
            return true;
        }

        HashSet<int?> scopes = _articleVaultPublicFenceScopes
            ?? throw new InvalidOperationException("article_vault_public_fence_scope_missing");
        if (!scopes.Add(articleId))
        {
            return false;
        }

        try
        {
            await _mutationFence.BeginPublicMutationFenceAsync(articleId, cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch
        {
            scopes.Remove(articleId);
            throw;
        }
    }

    private async Task<ArticleMutationTransactionResult<T>> ExecuteArticleMutationTransactionAsync<T>(
        Func<Task<T>> action)
    {
        if (IsArticleVaultGroupTransaction && _db.Ado.Transaction is not null)
        {
            try
            {
                return ArticleMutationTransactionResult<T>.Succeeded(await action().ConfigureAwait(false));
            }
            catch (Exception exception)
            {
                return ArticleMutationTransactionResult<T>.Failed(exception);
            }
        }

        var transaction = await ExecuteForegroundWriteAsync(
            "article-publication-write",
            _ => _db.Ado.UseTranAsync(action),
            Ct).ConfigureAwait(false);
        return transaction.IsSuccess
            ? ArticleMutationTransactionResult<T>.Succeeded(transaction.Data)
            : ArticleMutationTransactionResult<T>.Failed(
                transaction.ErrorException ?? new InvalidOperationException(transaction.ErrorMessage));
    }

    private async Task<ArticleMutationTransactionResult> ExecuteArticleMutationTransactionAsync(
        Func<Task> action)
    {
        if (IsArticleVaultGroupTransaction && _db.Ado.Transaction is not null)
        {
            try
            {
                await action().ConfigureAwait(false);
                return ArticleMutationTransactionResult.Succeeded();
            }
            catch (Exception exception)
            {
                return ArticleMutationTransactionResult.Failed(exception);
            }
        }

        var transaction = await ExecuteForegroundWriteAsync(
            "article-publication-write",
            _ => _db.Ado.UseTranAsync(action),
            Ct).ConfigureAwait(false);
        return transaction.IsSuccess
            ? ArticleMutationTransactionResult.Succeeded()
            : ArticleMutationTransactionResult.Failed(
                transaction.ErrorException ?? new InvalidOperationException(transaction.ErrorMessage));
    }

    private Task<T> ExecuteForegroundWriteAsync<T>(
        string operation,
        Func<CancellationToken, Task<T>> action,
        CancellationToken cancellationToken)
        => _dbConcurrencyGate.ExecuteClassifiedAsync(
            DbWorkloadClass.ForegroundWrite,
            operation,
            action,
            _ => Task.FromException<T>(new TimeoutException($"db-gate-timeout:{operation}")),
            cancellationToken);

    private sealed record ArticleMutationTransactionResult<T>(
        bool IsSuccess,
        T Data,
        Exception? ErrorException,
        string ErrorMessage)
    {
        internal static ArticleMutationTransactionResult<T> Succeeded(T data)
            => new(true, data, null, string.Empty);

        internal static ArticleMutationTransactionResult<T> Failed(Exception exception)
            => new(false, default!, exception, exception.Message);
    }

    private sealed record ArticleMutationTransactionResult(
        bool IsSuccess,
        Exception? ErrorException,
        string ErrorMessage)
    {
        internal static ArticleMutationTransactionResult Succeeded()
            => new(true, null, string.Empty);

        internal static ArticleMutationTransactionResult Failed(Exception exception)
            => new(false, exception, exception.Message);
    }
}
