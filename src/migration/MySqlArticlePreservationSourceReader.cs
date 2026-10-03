using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

/// <summary>
/// Explicit MySQL reader for the original supported legacy fingerprint. It consumes
/// the single article/taxonomy/Markdown mapping and budget implementation; it does not
/// infer old columns from current entities, publish artifacts or authenticate a backup.
/// </summary>
internal static class MySqlArticlePreservationSourceReader
{
    /// <summary>Reads through the original MySQL consistent-snapshot resource owner.</summary>
    /// <remarks>
    /// The original native session owns open, read-only Snapshot/RR admission and all
    /// cleanup. No capture escapes until that owner has awaited cleanup successfully.
    /// The connection string is forwarded as an original secret input, never returned
    /// as a receipt/error, and cannot select a provider or a source profile.
    /// </remarks>
    internal static async Task<ArticlePreservationSourceReadResult> ReadAsync(
        string originalConnectionString, CurrentSchemaArtifactReference originArtifact, Uri documentBase,
        ArticlePreservationLimits limits, TimeSpan readBudget, CancellationToken cancellationToken)
    {
        ArticlePreservationSourceReader.RequireReadBudget(limits, readBudget);
        ArticlePreservationSourceReader.RequireReadInputs(originArtifact, documentBase);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(readBudget);
        ArticlePreservationSourceReadResult capture = await OfflineMigrationMySqlNativeSession.ObserveOwnedReadAsync(
            originalConnectionString, (originalRead, token) => ReadBorrowedAsync(
                originalRead, originArtifact, documentBase, limits, readBudget, token), deadline.Token).ConfigureAwait(false);
        deadline.Token.ThrowIfCancellationRequested();
        return capture;
    }

    /// <summary>Consumes only the caller's original borrowed native snapshot.</summary>
    /// <remarks>
    /// The common reader requires the original run-owned context and its active
    /// read-only transaction proof before reading and at terminal revalidation.
    /// Raw driver objects, session defaults and isolation labels cannot mint this
    /// context. Full code-owned fingerprint matching remains mandatory.
    /// The caller retains connection/transaction lifetime; this method never commits,
    /// rolls back, disposes, starts a second session or changes its database identity.
    /// </remarks>
    internal static Task<ArticlePreservationSourceReadResult> ReadBorrowedAsync(
        OfflineMigrationMySqlNativeSession.OwnedReadContext originalRead, CurrentSchemaArtifactReference originArtifact,
        Uri documentBase, ArticlePreservationLimits limits, TimeSpan readBudget, CancellationToken cancellationToken)
        => ArticlePreservationSourceReader.ReadMySqlOwnedAsync(originalRead,
            new OfflineMigrationSourceObserver(), originArtifact, documentBase, limits, readBudget, cancellationToken);
}
