using System.Data.Common;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Infrastructure.Data;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

using SqlSugar;

namespace FsusBlog.Server.Services;

public partial class ArticleService
{
    private async Task<ArticleCanvasLinkReceipt?> ReadCanvasLinkJournalAsync(AuthoringCanvasOwner owner,
        Guid journalId, Guid requestId, CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync("""
            SELECT * FROM article_canvas_link_journal
            WHERE owner_admin_principal_id = @Principal AND site_scope = @Site
              AND (journal_id = @Journal OR request_id = @Request);
            """, new SugarParameter("@Principal", owner.AdminPrincipalId), new SugarParameter("@Site", owner.SiteScope),
            new SugarParameter("@Journal", journalId), new SugarParameter("@Request", requestId)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            return null;
        var receipt = new ArticleCanvasLinkReceipt(reader.ReadFieldValue<Guid>("request_id"),
            reader.ReadFieldValue<Guid>("journal_id"),
            reader.IsNull("parent_journal_id") ? Guid.Empty : reader.ReadFieldValue<Guid>("parent_journal_id"),
            reader.ReadInt64("owner_admin_principal_id"), reader.ReadString("site_scope"),
            reader.ReadInt32("source_article_id"), reader.ReadInt64("previous_article_revision"),
            reader.ReadInt64("article_revision"), reader.ReadInt64("original_before_revision"),
            reader.ReadInt64("original_after_revision"), (ArticleCanvasLinkMode)reader.ReadInt32("mode"),
            reader.IsNull("target_journal_id") ? Guid.Empty : reader.ReadFieldValue<Guid>("target_journal_id"),
            reader.ReadFieldValue<Guid>("canvas_id"), reader.ReadInt64("canvas_revision"),
            reader.ReadString("canvas_content_digest"), reader.ReadFieldValue<Guid>("edge_id"),
            reader.ReadInt32("target_article_id"), reader.ReadInt64("target_revision"),
            reader.ReadInt32("undo_depth"), reader.ReadInt32("redo_depth"), reader.ReadString("request_digest"),
            reader.ReadString("receipt_digest"), false);
        if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            || receipt.RequestId == Guid.Empty || receipt.JournalId == Guid.Empty
            || receipt.OwnerAdminPrincipalId != owner.AdminPrincipalId || receipt.SiteScope != owner.SiteScope
            || !Enum.IsDefined(receipt.Mode) || receipt.ArticleRevision <= 0 || receipt.PreviousArticleRevision <= 0
            || receipt.ArticleRevision == receipt.PreviousArticleRevision
            || receipt.OriginalBeforeRevision <= 0 || receipt.OriginalAfterRevision <= 0
            || receipt.UndoDepth is < 0 or > ArticleCanvasLinkContract.MaxHistoryDepth
            || receipt.RedoDepth is < 0 or > ArticleCanvasLinkContract.MaxHistoryDepth
            || !ArticleCanvasLinkContract.IsDigest(receipt.RequestDigest)
            || receipt.ReceiptDigest != ArticleCanvasLinkContract.ReceiptDigest(receipt))
        {
            throw new AuthoringCanvasValidationException("article_canvas_link_receipt_corrupt");
        }
        return receipt;
    }

    private async Task<CanvasLinkHistory> ReadCanvasLinkHistoryAsync(AuthoringCanvasOwner owner,
        int articleId, CancellationToken cancellationToken)
    {
        long revision;
        Guid lastJournal;
        Guid[] undoIds;
        Guid[] redoIds;
        string digest;
        using (DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync("""
            SELECT article_revision, last_journal_id, undo_entries, redo_entries, history_digest
            FROM article_canvas_link_history
            WHERE owner_admin_principal_id = @Principal AND site_scope = @Site AND source_article_id = @Article
            FOR UPDATE;
            """, new SugarParameter("@Principal", owner.AdminPrincipalId), new SugarParameter("@Site", owner.SiteScope),
            new SugarParameter("@Article", articleId)).ConfigureAwait(false))
        {
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                return new CanvasLinkHistory(0, Guid.Empty, [], []);
            revision = reader.ReadInt64("article_revision");
            lastJournal = reader.ReadFieldValue<Guid>("last_journal_id");
            undoIds = reader.ReadFieldValue<Guid[]>("undo_entries");
            redoIds = reader.ReadFieldValue<Guid[]>("redo_entries");
            digest = reader.ReadString("history_digest");
        }
        Guid[] allIds = [.. undoIds, .. redoIds];
        if (revision <= 0 || lastJournal == Guid.Empty || undoIds.Length > ArticleCanvasLinkContract.MaxHistoryDepth
            || redoIds.Length > ArticleCanvasLinkContract.MaxHistoryDepth || allIds.Contains(Guid.Empty)
            || allIds.Distinct().Count() != allIds.Length)
            throw new AuthoringCanvasValidationException("article_canvas_link_history_corrupt");
        async Task<List<ArticleCanvasLinkReceipt>> Entries(Guid[] ids)
        {
            var result = new List<ArticleCanvasLinkReceipt>(ids.Length);
            foreach (Guid id in ids)
            {
                ArticleCanvasLinkReceipt entry = await ReadCanvasLinkJournalAsync(owner, id, Guid.Empty, cancellationToken)
                    .ConfigureAwait(false) ?? throw new AuthoringCanvasValidationException("article_canvas_link_journal_missing");
                if (entry.SourceArticleId != articleId || entry.Mode != ArticleCanvasLinkMode.Apply
                    || entry.OriginalBeforeRevision != entry.PreviousArticleRevision || entry.OriginalAfterRevision != entry.ArticleRevision)
                    throw new AuthoringCanvasValidationException("article_canvas_link_journal_scope_mismatch");
                result.Add(entry);
            }
            return result;
        }
        List<ArticleCanvasLinkReceipt> undo = await Entries(undoIds).ConfigureAwait(false);
        List<ArticleCanvasLinkReceipt> redo = await Entries(redoIds).ConfigureAwait(false);
        ArticleCanvasLinkReceipt last = await ReadCanvasLinkJournalAsync(owner, lastJournal, Guid.Empty, cancellationToken)
            .ConfigureAwait(false) ?? throw new AuthoringCanvasValidationException("article_canvas_link_journal_missing");
        if (last.SourceArticleId != articleId || last.ArticleRevision != revision
            || last.UndoDepth != undo.Count || last.RedoDepth != redo.Count
            || digest != ArticleCanvasLinkContract.HistoryDigest(articleId, revision, lastJournal, undo, redo))
            throw new AuthoringCanvasValidationException("article_canvas_link_history_digest_mismatch");
        return new CanvasLinkHistory(revision, lastJournal, undo, redo);
    }

    private async Task SaveCanvasLinkJournalAsync(AuthoringCanvasOwner owner,
        ArticleCanvasLinkReceipt receipt, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await _db.Ado.ExecuteCommandAsync("""
            INSERT INTO article_canvas_link_journal(
                journal_id, owner_admin_principal_id, site_scope, source_article_id, request_id, mode,
                target_journal_id, parent_journal_id, previous_article_revision, article_revision,
                original_before_revision, original_after_revision, canvas_id, canvas_revision,
                canvas_content_digest, edge_id, target_article_id, target_revision, undo_depth, redo_depth,
                request_digest, receipt_digest, created_at_utc)
            VALUES (@Journal, @Principal, @Site, @Source, @Request, @Mode, @TargetJournal, @ParentJournal,
                @Previous, @Revision, @OriginalBefore, @OriginalAfter, @Canvas, @CanvasRevision,
                @CanvasDigest, @Edge, @TargetArticle, @TargetRevision, @UndoDepth, @RedoDepth,
                @RequestDigest, @ReceiptDigest, @CreatedAt);
            """, new SugarParameter("@Journal", receipt.JournalId), new SugarParameter("@Principal", owner.AdminPrincipalId),
            new SugarParameter("@Site", owner.SiteScope), new SugarParameter("@Source", receipt.SourceArticleId),
            new SugarParameter("@Request", receipt.RequestId), new SugarParameter("@Mode", (short)receipt.Mode),
            new SugarParameter("@TargetJournal", receipt.TargetJournalId == Guid.Empty ? DBNull.Value : receipt.TargetJournalId, System.Data.DbType.Guid),
            new SugarParameter("@ParentJournal", receipt.ParentJournalId == Guid.Empty ? DBNull.Value : receipt.ParentJournalId, System.Data.DbType.Guid),
            new SugarParameter("@Previous", receipt.PreviousArticleRevision), new SugarParameter("@Revision", receipt.ArticleRevision),
            new SugarParameter("@OriginalBefore", receipt.OriginalBeforeRevision), new SugarParameter("@OriginalAfter", receipt.OriginalAfterRevision),
            new SugarParameter("@Canvas", receipt.CanvasId), new SugarParameter("@CanvasRevision", receipt.CanvasRevision),
            new SugarParameter("@CanvasDigest", receipt.CanvasContentDigest), new SugarParameter("@Edge", receipt.EdgeId),
            new SugarParameter("@TargetArticle", receipt.TargetArticleId), new SugarParameter("@TargetRevision", receipt.TargetRevision),
            new SugarParameter("@UndoDepth", receipt.UndoDepth), new SugarParameter("@RedoDepth", receipt.RedoDepth),
            new SugarParameter("@RequestDigest", receipt.RequestDigest), new SugarParameter("@ReceiptDigest", receipt.ReceiptDigest),
            new SugarParameter("@CreatedAt", UtcNow)).ConfigureAwait(false);
    }

    private async Task SaveCanvasLinkHistoryAsync(AuthoringCanvasOwner owner, int articleId,
        long articleRevision, Guid journalId, IReadOnlyList<ArticleCanvasLinkReceipt> undo,
        IReadOnlyList<ArticleCanvasLinkReceipt> redo, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string digest = ArticleCanvasLinkContract.HistoryDigest(articleId, articleRevision, journalId, undo, redo);
        await _db.Ado.ExecuteCommandAsync("""
            INSERT INTO article_canvas_link_history(owner_admin_principal_id, site_scope, source_article_id,
                article_revision, last_journal_id, undo_entries, redo_entries, history_digest)
            VALUES (@Principal, @Site, @Article, @Revision, @Journal, @Undo, @Redo, @Digest)
            ON CONFLICT (owner_admin_principal_id, site_scope, source_article_id)
            DO UPDATE SET article_revision = EXCLUDED.article_revision, last_journal_id = EXCLUDED.last_journal_id,
                undo_entries = EXCLUDED.undo_entries, redo_entries = EXCLUDED.redo_entries, history_digest = EXCLUDED.history_digest;
            """, new SugarParameter("@Principal", owner.AdminPrincipalId), new SugarParameter("@Site", owner.SiteScope),
            new SugarParameter("@Article", articleId), new SugarParameter("@Revision", articleRevision),
            new SugarParameter("@Journal", journalId),
            new SugarParameter("@Undo", undo.Select(static value => value.JournalId).ToArray()) { IsArray = true },
            new SugarParameter("@Redo", redo.Select(static value => value.JournalId).ToArray()) { IsArray = true }, new SugarParameter("@Digest", digest))
            .ConfigureAwait(false);
    }
}
