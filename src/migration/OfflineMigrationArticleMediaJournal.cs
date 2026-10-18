using System.Data;
using System.Data.Common;

namespace FsusBlog.Migration;

// No second store or transaction. This adapter can only consume the original
// durably accepted preparation and append publication on the graph transaction.
// Publication becomes durable together with the original Core graph commit.
internal sealed class OfflineMigrationArticleMediaJournal : IArticleMediaPreservationJournal
{
    private readonly OfflineMigrationApplyJournalVerifier _staged;
    private readonly OfflineMigrationApplyJournalEntry _prepared;
    private readonly DbConnection _connection;
    private readonly DbTransaction _transaction;
    private readonly int _attempt;
    private readonly OfflineMigrationApplyNativeSession.OwnedReadContext? _originalWrite;

    internal OfflineMigrationArticleMediaJournal(OfflineMigrationApplyJournalVerifier committed,
        OfflineMigrationApplyJournalVerifier staged, DbConnection connection, DbTransaction transaction, int attempt,
        OfflineMigrationApplyNativeSession.OwnedReadContext? originalWrite = null)
    {
        _prepared = committed.PendingMedia ?? throw new InvalidOperationException("offline_apply_media_preparation_missing");
        if (_prepared.State != OfflineMigrationApplyJournalState.MediaPrepared || _prepared.Media?.GenerationIdentity is not null
            || !ReferenceEquals(staged.PendingMedia, _prepared) || transaction.Connection != connection
            || connection.State != ConnectionState.Open
            || transaction.IsolationLevel is not (IsolationLevel.RepeatableRead or IsolationLevel.Serializable))
            throw new InvalidOperationException("offline_apply_media_original_transaction_required");
        _staged = staged;
        _connection = connection;
        _transaction = transaction;
        _attempt = attempt;
        if (originalWrite is not null && (!ReferenceEquals(originalWrite.OriginalConnection, connection)
            || !ReferenceEquals(originalWrite.OriginalTransaction, transaction)))
            throw new InvalidOperationException("offline_apply_media_original_transaction_required");
        _originalWrite = originalWrite;
    }

    internal async Task<OfflineMigrationApplyNativeSession.OwnedReadContext> RequireOriginalWriteAsync(CancellationToken token)
    {
        var context = _originalWrite ?? throw new InvalidOperationException("offline_apply_media_original_write_scope_required");
        await context.RequireBoundaryAsync(token).ConfigureAwait(false);
        if (!ReferenceEquals(context.OriginalConnection, _connection) || !ReferenceEquals(context.OriginalTransaction, _transaction))
            throw new InvalidOperationException("offline_apply_media_original_transaction_required");
        return context;
    }

    public Task<ArticleMediaJournalState> RequirePreparedAsync(ArticleMediaBinding binding, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        RequireBinding(binding);
        return Task.FromResult(_staged.PendingMedia!.State == OfflineMigrationApplyJournalState.MediaPrepared
            ? ArticleMediaJournalState.Prepared : ArticleMediaJournalState.MediaPublished);
    }

    public async Task RecordPublishedAsync(ArticleMediaPublication publication, ArticleMediaJournalState expected,
        CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        RequireBinding(publication.Binding);
        if (expected != ArticleMediaJournalState.Prepared || _staged.PendingMedia?.State != OfflineMigrationApplyJournalState.MediaPrepared)
            throw new InvalidOperationException("offline_apply_media_publication_cas_invalid");
        OfflineMigrationApplyJournalEntry entry = _prepared with
        {
            Sequence = _staged.Last!.Sequence + 1,
            Attempt = _attempt,
            State = OfflineMigrationApplyJournalState.MediaPublished,
            PreviousDigest = _staged.Last.ContentDigest,
            ContentDigest = string.Empty,
            RecordedAt = DateTimeOffset.UtcNow,
            Media = _prepared.Media! with { GenerationIdentity = publication.GenerationIdentity }
        };
        entry = entry with { ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeEntryDigest(entry) };
        // Validate in a fork before appending; only the original DB append's
        // successful parent-unique insert advances the transaction-local chain.
        OfflineMigrationApplyJournalVerifier next = _staged.Fork();
        next.Accept(entry);
        await OfflineMigrationStateStore.AppendApplyJournalAsync(_connection, _transaction, entry, token).ConfigureAwait(false);
        _staged.Accept(entry);
    }

    internal OfflineMigrationMediaJournalEvidence RequirePublished()
    {
        if (_staged.PendingMedia?.State != OfflineMigrationApplyJournalState.MediaPublished
            || _staged.PendingMedia.Media?.GenerationIdentity is null)
            throw new InvalidOperationException("offline_apply_media_not_published");
        return _staged.PendingMedia.Media;
    }

    private void RequireBinding(ArticleMediaBinding binding)
    {
        if (binding != _prepared.Media!.Binding || _staged.PendingMedia?.Media?.Binding != binding
            || _staged.PendingMedia.Media.InvocationId != _prepared.InvocationId)
            throw new InvalidOperationException("offline_apply_media_binding_changed");
    }
}
