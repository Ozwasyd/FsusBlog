using System.Data.Common;
using System.Globalization;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Data;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.BlockLinks;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

using SqlSugar;

namespace FsusBlog.Server.Services;

public partial class ArticleService : IArticleCanvasLinkWriter
{
    private sealed record CanvasLinkHistory(long ArticleRevision, Guid LastJournalId,
        List<ArticleCanvasLinkReceipt> Undo, List<ArticleCanvasLinkReceipt> Redo);

    async Task<ArticleCanvasLinkReceipt> IArticleCanvasLinkWriter.ConvertAsync(
        AuthoringCanvasOwner owner,
        ArticleCanvasLinkRequest request,
        CancellationToken cancellationToken)
    {
        AuthoringCanvasContract.ValidateOwner(owner);
        ArticleCanvasLinkContract.Validate(request);
        if (IsArticleVaultGroupTransaction || _db.Ado.Transaction is not null)
        {
            throw new InvalidOperationException("article_canvas_link_nested_transaction_rejected");
        }
        string requestDigest = ArticleCanvasLinkContract.RequestDigest(request);
        var fences = new HashSet<int?>();
        List<Func<Task>>? postCommit = null;
        bool committed = false;
        bool preparedForCommit = false;
        try
        {
            var result = await ExecuteForegroundWriteAsync("article-canvas-link-write", async gateCt =>
            {
                gateCt.ThrowIfCancellationRequested();
                return await _db.Ado.UseTranAsync(async () =>
                {
                    await LockCanvasLinkPrincipalAsync(owner, cancellationToken).ConfigureAwait(false);
                    await _db.Ado.ExecuteCommandAsync(
                        "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 0));",
                        new SugarParameter("@Identity", $"article-canvas-link:{owner.AdminPrincipalId}:{owner.SiteScope}:{request.RequestId}"))
                        .ConfigureAwait(false);
                    ArticleCanvasLinkReceipt? replay = await ReadCanvasLinkJournalAsync(
                        owner, Guid.Empty, request.RequestId, cancellationToken).ConfigureAwait(false);
                    if (replay is not null)
                    {
                        if (replay.SourceArticleId != request.SourceArticleId || replay.RequestDigest != requestDigest)
                        {
                            throw new AuthoringCanvasIdempotencyConflictException();
                        }
                        // Historical target/Canvas subjects need not remain live to recover a committed receipt.
                        // Current source access still qualifies the private result, without applying old revision CAS.
                        await LockCanvasLinkArticlesAsync(owner, [request.SourceArticleId], cancellationToken).ConfigureAwait(false);
                        return replay with
                        {
                            IdempotencyReplay = true
                        };
                    }
                    int[] articleIds = request.Mode == ArticleCanvasLinkMode.Apply
                        ? [request.SourceArticleId, request.TargetArticleId]
                        : [request.SourceArticleId];
                    await LockCanvasLinkArticlesAsync(owner, articleIds, cancellationToken).ConfigureAwait(false);
                    ArticleUpdateState current = await LoadArticleUpdateStateAsync(request.SourceArticleId).ConfigureAwait(false)
                        ?? throw new AuthoringCanvasAccessDeniedException();
                    if (current.CurrentRevisionId != request.ExpectedArticleRevision)
                    {
                        throw current.ToConflictException();
                    }
                    CanvasLinkHistory history = await ReadCanvasLinkHistoryAsync(
                        owner, request.SourceArticleId, cancellationToken).ConfigureAwait(false);
                    ArticleCanvasLinkReceipt? original = null;
                    string content;
                    string? summary = current.Summary;
                    if (request.Mode == ArticleCanvasLinkMode.Apply)
                    {
                        string markdown = await ResolveCanvasLinkMarkdownAsync(owner, request, cancellationToken).ConfigureAwait(false);
                        if (history.ArticleRevision != 0 && history.ArticleRevision != current.CurrentRevisionId)
                        {
                            // Normal article edits end the old undo branch; the append-only audit remains.
                            history.Undo.Clear();
                            history.Redo.Clear();
                        }
                        if (history.Undo.Count >= ArticleCanvasLinkContract.MaxHistoryDepth)
                        {
                            throw new AuthoringCanvasBudgetExceededException("article_canvas_link_history_full");
                        }
                        content = current.MarkdownContent + (current.MarkdownContent.Length == 0 ? string.Empty : "\n\n") + markdown;
                        if (content.Length > MaxContentLength)
                        {
                            throw new AuthoringCanvasBudgetExceededException("article_canvas_link_content_full");
                        }
                    }
                    else
                    {
                        List<ArticleCanvasLinkReceipt> stack = request.Mode == ArticleCanvasLinkMode.Undo ? history.Undo : history.Redo;
                        if (history.ArticleRevision != current.CurrentRevisionId || stack.Count == 0
                            || stack[^1].JournalId != request.TargetJournalId)
                        {
                            throw new AuthoringCanvasValidationException("article_canvas_link_history_stale");
                        }
                        original = stack[^1];
                        if (original.Mode != ArticleCanvasLinkMode.Apply)
                        {
                            throw new AuthoringCanvasValidationException("article_canvas_link_history_corrupt");
                        }
                        long restoredRevision = request.Mode == ArticleCanvasLinkMode.Undo
                            ? original.OriginalBeforeRevision : original.OriginalAfterRevision;
                        (content, summary) = await ReadCanvasLinkRevisionSourceAsync(request.SourceArticleId, restoredRevision, cancellationToken)
                            .ConfigureAwait(false);
                    }
                    _articleVaultGroupTransactionDepth++;
                    _articleVaultOutboxReferences = new Dictionary<int, string>();
                    _articleVaultPublicFenceScopes = fences;
                    _articleVaultPostCommitActions = new List<Func<Task>>();
                    try
                    {
                        var write = new ArticleWriteRequestCoreModel(current.Title, content, summary,
                            current.CoverImageUrl, current.CategoryId, current.TagIds, (int)current.Status,
                            current.ScheduledPublishAt, Rights: null, RightsMutation: ArticleRightsMutationMode.Preserve,
                            BaseRevisionId: current.CurrentRevisionId);
                        ArticleUpdateExecution? execution = null;
                        bool updated = await UpdateAsync(request.SourceArticleId, write, transitionKind: null,
                            force: false, rollback: null, captureExecution: value => execution = value, cancellationToken)
                            .ConfigureAwait(false);
                        if (!updated || !execution.HasValue || execution.Value.Outcome != ArticleMutationOutcome.Applied)
                        {
                            throw new InvalidOperationException("article_canvas_link_canonical_write_failed");
                        }
                        long revision = execution.Value.Version.RevisionId;
                        Guid journalId = Guid.CreateVersion7();
                        if (request.Mode == ArticleCanvasLinkMode.Apply)
                        {
                            history.Redo.Clear();
                        }
                        else if (request.Mode == ArticleCanvasLinkMode.Undo)
                        {
                            history.Undo.RemoveAt(history.Undo.Count - 1);
                            history.Redo.Add(original!);
                        }
                        else
                        {
                            history.Redo.RemoveAt(history.Redo.Count - 1);
                            history.Undo.Add(original!);
                        }
                        var receipt = new ArticleCanvasLinkReceipt(request.RequestId, journalId, history.LastJournalId,
                            owner.AdminPrincipalId, owner.SiteScope,
                            request.SourceArticleId, current.CurrentRevisionId, revision,
                            original?.OriginalBeforeRevision ?? current.CurrentRevisionId,
                            original?.OriginalAfterRevision ?? revision, request.Mode, request.TargetJournalId,
                            original?.CanvasId ?? request.CanvasId, original?.CanvasRevision ?? request.CanvasRevision,
                            original?.CanvasContentDigest ?? request.CanvasContentDigest,
                            original?.EdgeId ?? request.EdgeId, original?.TargetArticleId ?? request.TargetArticleId,
                            original?.TargetRevision ?? request.ExpectedTargetRevision,
                            history.Undo.Count + (request.Mode == ArticleCanvasLinkMode.Apply ? 1 : 0), history.Redo.Count,
                            requestDigest, string.Empty, false);
                        receipt = receipt with
                        {
                            ReceiptDigest = ArticleCanvasLinkContract.ReceiptDigest(receipt)
                        };
                        if (request.Mode == ArticleCanvasLinkMode.Apply)
                        {
                            history.Undo.Add(receipt);
                        }
                        await SaveCanvasLinkJournalAsync(owner, receipt, cancellationToken).ConfigureAwait(false);
                        await SaveCanvasLinkHistoryAsync(owner, request.SourceArticleId, revision, journalId,
                            history.Undo, history.Redo, cancellationToken).ConfigureAwait(false);
                        cancellationToken.ThrowIfCancellationRequested();
                        preparedForCommit = true;
                        return receipt;
                    }
                    finally
                    {
                        postCommit = _articleVaultPostCommitActions;
                        _articleVaultPostCommitActions = null;
                        _articleVaultPublicFenceScopes = null;
                        _articleVaultOutboxReferences = null;
                        _articleVaultGroupTransactionDepth--;
                    }
                }).ConfigureAwait(false);
            }, cancellationToken).ConfigureAwait(false);
            if (!result.IsSuccess)
            {
                if (preparedForCommit)
                    throw new ArticleCanvasLinkOutcomeUnknownException(request.RequestId,
                        result.ErrorException ?? new InvalidOperationException(result.ErrorMessage));
                throw result.ErrorException ?? new InvalidOperationException(result.ErrorMessage);
            }
            committed = true;
            await DrainArticleVaultPostCommitActionsAsync(postCommit ?? []).ConfigureAwait(false);
            return result.Data;
        }
        catch (Exception error) when (committed && error is not ArticleCanvasLinkOutcomeUnknownException)
        {
            throw new ArticleCanvasLinkOutcomeUnknownException(request.RequestId, error);
        }
        catch (ArticleCanvasLinkOutcomeUnknownException) when (!committed)
        {
            System.Data.IDbTransaction? completed = _db.Ado.Transaction;
            _db.Ado.Transaction = null;
            completed?.Dispose();
            throw;
        }
        catch (Exception error) when (preparedForCommit && !committed && error is not ArticleCanvasLinkOutcomeUnknownException)
        {
            System.Data.IDbTransaction? completed = _db.Ado.Transaction;
            _db.Ado.Transaction = null;
            completed?.Dispose();
            throw new ArticleCanvasLinkOutcomeUnknownException(request.RequestId, error);
        }
        finally
        {
            foreach (int? articleId in fences)
            {
                await RecoverAbortedPublicMutationFenceAsync(articleId,
                    committed ? "article-canvas-link-postcommit-recovery" : "article-canvas-link-aborted").ConfigureAwait(false);
            }
        }
    }

    async Task<ArticleCanvasLinkHistoryResponse> IArticleCanvasLinkWriter.ReadHistoryAsync(
        AuthoringCanvasOwner owner, int articleId, CancellationToken cancellationToken)
    {
        AuthoringCanvasContract.ValidateOwner(owner);
        if (articleId <= 0 || _db.Ado.Transaction is not null)
        {
            throw new AuthoringCanvasValidationException("article_canvas_link_history_request_invalid");
        }
        var result = await ExecuteForegroundWriteAsync("article-canvas-link-history", async gateCt =>
        {
            gateCt.ThrowIfCancellationRequested();
            return await _db.Ado.UseTranAsync(async () =>
            {
                await LockCanvasLinkPrincipalAsync(owner, cancellationToken).ConfigureAwait(false);
                await LockCanvasLinkArticlesAsync(owner, [articleId], cancellationToken).ConfigureAwait(false);
                ArticleUpdateState current = await LoadArticleUpdateStateAsync(articleId).ConfigureAwait(false)
                    ?? throw new AuthoringCanvasAccessDeniedException();
                CanvasLinkHistory history = await ReadCanvasLinkHistoryAsync(owner, articleId, cancellationToken).ConfigureAwait(false);
                return new ArticleCanvasLinkHistoryResponse(articleId, current.CurrentRevisionId, history.ArticleRevision,
                    history.LastJournalId, history.Undo, history.Redo, ArticleCanvasLinkContract.HistoryDigest(
                        articleId, history.ArticleRevision, history.LastJournalId, history.Undo, history.Redo));
            }).ConfigureAwait(false);
        }, cancellationToken).ConfigureAwait(false);
        if (!result.IsSuccess)
        {
            throw result.ErrorException ?? new InvalidOperationException(result.ErrorMessage);
        }
        return result.Data;
    }

    private async Task LockCanvasLinkPrincipalAsync(AuthoringCanvasOwner owner, CancellationToken cancellationToken)
    {
        var principal = _httpContextAccessor.HttpContext?.User;
        if (principal?.IsAdminPrincipal() != true || !principal.TryGetAdminPrincipalId(out long principalId)
            || principalId != owner.AdminPrincipalId || string.IsNullOrWhiteSpace(principal.GetAdminSessionId()))
        {
            throw new AuthoringCanvasAccessDeniedException();
        }
        using DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync("""
            SELECT id FROM admin_principal
            WHERE id = @Principal AND status = @Active
              AND @Site = 'primary-site'
              AND (isroot OR @Permission = ANY(string_to_array(permissions, E'\n')))
            FOR SHARE;
            """, new SugarParameter("@Principal", owner.AdminPrincipalId),
            new SugarParameter("@Active", AdminPrincipalStatus.Active), new SugarParameter("@Site", owner.SiteScope),
            new SugarParameter("@Permission", AdminPermissions.ArticleWrite)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new AuthoringCanvasAccessDeniedException();
        }
    }

    private async Task LockCanvasLinkArticlesAsync(AuthoringCanvasOwner owner, int[] articleIds, CancellationToken cancellationToken)
    {
        foreach (int articleId in articleIds.Distinct().Order())
        {
            using DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync("""
                SELECT a.id FROM article a
                WHERE a.id = @Article AND a.isdeleted = false AND a.status <> @Archived AND a.status <> @Deleted
                  AND EXISTS (SELECT 1 FROM admin_principal p WHERE p.id = @Principal
                    AND (p.isroot OR EXISTS (SELECT 1 FROM article_revision r
                        WHERE r.article_id = a.id AND r.created_by_admin_principal_id = p.id)))
                FOR UPDATE OF a;
                """, new SugarParameter("@Article", articleId), new SugarParameter("@Principal", owner.AdminPrincipalId),
                new SugarParameter("@Archived", (int)ArticleStatus.Archived), new SugarParameter("@Deleted", (int)ArticleStatus.Deleted))
                .ConfigureAwait(false);
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new AuthoringCanvasAccessDeniedException();
            }
        }
    }

    private async Task<string> ResolveCanvasLinkMarkdownAsync(AuthoringCanvasOwner owner,
        ArticleCanvasLinkRequest request, CancellationToken cancellationToken)
    {
        using (DbDataReader header = (DbDataReader)await _db.Ado.GetDataReaderAsync("""
            SELECT revision, content_digest FROM authoring_canvas_document
            WHERE id = @Canvas AND owner_admin_principal_id = @Principal AND site_scope = @Site
            FOR UPDATE;
            """, new SugarParameter("@Canvas", request.CanvasId), new SugarParameter("@Principal", owner.AdminPrincipalId),
            new SugarParameter("@Site", owner.SiteScope)).ConfigureAwait(false))
        {
            if (!await header.ReadAsync(cancellationToken).ConfigureAwait(false))
                throw new AuthoringCanvasAccessDeniedException();
            if (header.ReadInt64("revision") != request.CanvasRevision || header.ReadString("content_digest") != request.CanvasContentDigest)
                throw new AuthoringCanvasValidationException("article_canvas_link_canvas_stale");
        }
        IAuthoringCanvasDocumentStore documents = _authoringCanvasDocuments
            ?? throw new InvalidOperationException("article_canvas_link_document_authority_missing");
        AuthoringCanvasVerificationResult verified = await documents.VerifyAsync(owner, request.CanvasId, cancellationToken)
            .ConfigureAwait(false);
        if (!verified.Valid || verified.Revision != request.CanvasRevision || verified.ContentDigest != request.CanvasContentDigest)
            throw new AuthoringCanvasValidationException("article_canvas_link_canvas_corrupt");
        string? label;
        Guid sourceNodeId;
        AuthoringCanvasNodeType sourceType;
        string? sourceHeading;
        string? sourceBlock;
        long? sourcePin;
        Guid targetNodeId;
        AuthoringCanvasNodeType targetType;
        string? heading;
        string? block;
        long? pinned;
        using (DbDataReader edge = (DbDataReader)await _db.Ado.GetDataReaderAsync("""
            SELECT e.label, s.target_article_id AS source_article, s.pinned_target_revision AS source_pin,
                   s.node_id AS source_node_id,
                   s.node_type = 'heading-reference' AS source_heading,
                   s.node_type = 'block-reference' AS source_block,
                   s.target_heading_identity AS source_heading_identity, s.target_block_identity AS source_block_identity,
                   t.node_id, t.node_type = 'heading-reference' AS target_heading,
                   t.node_type = 'block-reference' AS target_block, t.target_article_id AS target_article,
                   t.target_heading_identity, t.target_block_identity, t.pinned_target_revision
            FROM authoring_canvas_edge e
            JOIN authoring_canvas_node s ON s.canvas_id = e.canvas_id AND s.node_id = e.source_node_id
            JOIN authoring_canvas_node t ON t.canvas_id = e.canvas_id AND t.node_id = e.target_node_id
            WHERE e.canvas_id = @Canvas AND e.edge_id = @Edge AND e.edge_type = 'explicit-reference-note'
              AND s.node_type IN ('article-reference', 'heading-reference', 'block-reference')
              AND t.node_type IN ('article-reference', 'heading-reference', 'block-reference');
            """, new SugarParameter("@Canvas", request.CanvasId), new SugarParameter("@Edge", request.EdgeId)).ConfigureAwait(false))
        {
            if (!await edge.ReadAsync(cancellationToken).ConfigureAwait(false))
                throw new AuthoringCanvasValidationException("article_canvas_link_edge_unavailable");
            if (edge.ReadInt32("source_article") != request.SourceArticleId || edge.ReadInt32("target_article") != request.TargetArticleId
                || !edge.IsNull("source_pin") && edge.ReadInt64("source_pin") != request.ExpectedArticleRevision)
                throw new AuthoringCanvasValidationException("article_canvas_link_endpoint_mismatch");
            label = edge.IsNull("label") ? null : edge.ReadString("label");
            sourceNodeId = edge.ReadFieldValue<Guid>("source_node_id");
            sourceType = edge.ReadBoolean("source_heading") ? AuthoringCanvasNodeType.HeadingReference
                : edge.ReadBoolean("source_block") ? AuthoringCanvasNodeType.BlockReference : AuthoringCanvasNodeType.ArticleReference;
            sourceHeading = edge.IsNull("source_heading_identity") ? null : edge.ReadString("source_heading_identity");
            sourceBlock = edge.IsNull("source_block_identity") ? null : edge.ReadString("source_block_identity");
            sourcePin = edge.IsNull("source_pin") ? null : edge.ReadInt64("source_pin");
            targetNodeId = edge.ReadFieldValue<Guid>("node_id");
            targetType = edge.ReadBoolean("target_heading") ? AuthoringCanvasNodeType.HeadingReference
                : edge.ReadBoolean("target_block") ? AuthoringCanvasNodeType.BlockReference : AuthoringCanvasNodeType.ArticleReference;
            heading = edge.IsNull("target_heading_identity") ? null : edge.ReadString("target_heading_identity");
            block = edge.IsNull("target_block_identity") ? null : edge.ReadString("target_block_identity");
            pinned = edge.IsNull("pinned_target_revision") ? null : edge.ReadInt64("pinned_target_revision");
        }
        ArticleUpdateState target = await LoadArticleUpdateStateAsync(request.TargetArticleId).ConfigureAwait(false)
            ?? throw new AuthoringCanvasAccessDeniedException();
        long targetRevision = pinned ?? target.CurrentRevisionId;
        if (targetRevision != request.ExpectedTargetRevision || targetRevision != target.CurrentRevisionId)
            throw new AuthoringCanvasValidationException("article_canvas_link_target_stale");
        if (targetType != AuthoringCanvasNodeType.ArticleReference)
        {
            // The actual public route renders the immutable current publication, not authoring state.
            if (!ArticlePublication.IsPubliclyVisible(target.Status, false, target.PublishedAt, target.ScheduledPublishAt, UtcNow))
                throw new AuthoringCanvasValidationException("article_canvas_link_public_coordinate_unavailable");
            using DbDataReader publication = (DbDataReader)await _db.Ado.GetDataReaderAsync("""
                SELECT publication.article_revision_id
                FROM article article
                JOIN article_publication publication
                    ON publication.id = article.current_publication_id AND publication.article_id = article.id
                WHERE article.id = @Article;
                """, new SugarParameter("@Article", request.TargetArticleId)).ConfigureAwait(false);
            if (!await publication.ReadAsync(cancellationToken).ConfigureAwait(false)
                || publication.ReadInt64("article_revision_id") != targetRevision)
                throw new AuthoringCanvasValidationException("article_canvas_link_public_coordinate_unavailable");
        }
        string route = PublicRouteIdentityRegistry.ArticlePathPrefix + request.TargetArticleId.ToString(CultureInfo.InvariantCulture);
        if (sourceType != AuthoringCanvasNodeType.ArticleReference || targetType != AuthoringCanvasNodeType.ArticleReference)
        {
            var targets = new List<AuthoringCanvasReferenceTarget>(2);
            if (sourceType != AuthoringCanvasNodeType.ArticleReference)
                targets.Add(new AuthoringCanvasReferenceTarget(sourceNodeId, sourceType, request.SourceArticleId,
                    sourceHeading, sourceBlock, sourcePin, null));
            if (targetType != AuthoringCanvasNodeType.ArticleReference && targetNodeId != sourceNodeId)
                targets.Add(new AuthoringCanvasReferenceTarget(targetNodeId, targetType, request.TargetArticleId,
                    heading, block, pinned, null));
            IAuthoringCanvasExternalCoordinateAuthority coordinates = _authoringCanvasCoordinates
                ?? throw new InvalidOperationException("article_canvas_link_coordinate_authority_missing");
            var facts = await coordinates.ReadBatchAsync(
                new AuthoringCanvasCoordinateFactQuery(request.CanvasId, request.CanvasRevision,
                    request.CanvasContentDigest, owner, targets), cancellationToken).ConfigureAwait(false);
            foreach (AuthoringCanvasReferenceTarget endpoint in targets)
            {
                long expected = endpoint.NodeId == sourceNodeId ? request.ExpectedArticleRevision : targetRevision;
                if (!facts.TryGetValue(endpoint.NodeId, out AuthoringCanvasCoordinateFact? coordinate)
                    || coordinate.State != AuthoringCanvasReferenceCoordinateState.Current || coordinate.TargetRevision != expected)
                    throw new AuthoringCanvasValidationException("article_canvas_link_coordinate_stale");
            }
            if (targetType != AuthoringCanvasNodeType.ArticleReference)
            {
                string anchor = targetType == AuthoringCanvasNodeType.HeadingReference ? heading! : block!;
                if (!BlockAnchorId.TryCreate(anchor, out BlockAnchorId id).IsValid)
                    throw new AuthoringCanvasValidationException("article_canvas_link_anchor_invalid");
                route += BlockAnchorCodec.BuildFragment(id);
            }
        }
        string targetTitle = target.Title;
        if (pinned.HasValue)
        {
            using DbDataReader revision = (DbDataReader)await _db.Ado.GetDataReaderAsync(
                "SELECT title FROM article_revision WHERE article_id = @Article AND id = @Revision;",
                new SugarParameter("@Article", request.TargetArticleId), new SugarParameter("@Revision", pinned.Value))
                .ConfigureAwait(false);
            if (!await revision.ReadAsync(cancellationToken).ConfigureAwait(false))
                throw new AuthoringCanvasValidationException("article_canvas_link_target_revision_missing");
            targetTitle = revision.ReadString("title");
        }
        string text = string.IsNullOrWhiteSpace(label) ? targetTitle : label.Trim();
        text = text.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("[", "\\[", StringComparison.Ordinal)
            .Replace("]", "\\]", StringComparison.Ordinal).Replace('\r', ' ').Replace('\n', ' ');
        return $"[{text}]({route})";
    }

    private async Task<(string Source, string? Summary)> ReadCanvasLinkRevisionSourceAsync(int articleId, long revisionId, CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync("""
            SELECT COALESCE(b.markdown_content, r.markdown_content) AS source, r.summary
            FROM article_revision r LEFT JOIN article_revision_content_block b ON b.id = r.content_block_id
            WHERE r.article_id = @Article AND r.id = @Revision;
            """, new SugarParameter("@Article", articleId), new SugarParameter("@Revision", revisionId)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false) || reader.IsNull("source"))
            throw new AuthoringCanvasValidationException("article_canvas_link_revision_unavailable");
        return (reader.ReadString("source"), reader.IsNull("summary") ? null : reader.ReadString("summary"));
    }
}
