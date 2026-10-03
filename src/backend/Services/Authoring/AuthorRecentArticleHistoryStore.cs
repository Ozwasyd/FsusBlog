using System.Data.Common;
using System.Runtime.ExceptionServices;

using FsusBlog.Server.Entities;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// The durable write/read authority for recent article history. Every command, its receipt,
/// idempotency row, audit row and outbox row are committed in one transaction. No client cache
/// or browser timestamp participates in this state machine.
/// </summary>
public interface IAuthorRecentArticleHistoryStore
{
    Task<AuthorRecentArticleHistoryReceipt> RecordOpenedAsync(
        AuthorRecentArticleHistoryOwner owner,
        int articleId,
        long serverRevision,
        long expectedCollectionRevision,
        Guid requestId,
        CancellationToken cancellationToken = default);

    Task<AuthorRecentArticleHistoryReceipt> RecordEditedAsync(
        AuthorRecentArticleHistoryOwner owner,
        int articleId,
        long serverRevision,
        long expectedCollectionRevision,
        Guid requestId,
        CancellationToken cancellationToken = default);

    Task<AuthorRecentArticleHistoryReceipt> RecordActivatedAsync(
        AuthorRecentArticleHistoryOwner owner,
        int articleId,
        long serverRevision,
        long expectedCollectionRevision,
        Guid requestId,
        CancellationToken cancellationToken = default);

    Task<AuthorRecentArticleHistoryCollectionSnapshot> GetAuthoritySnapshotAsync(
        AuthorRecentArticleHistoryOwner owner,
        CancellationToken cancellationToken = default);

    Task<AuthorRecentArticleHistoryVerificationResult> VerifyAsync(
        AuthorRecentArticleHistoryOwner owner,
        CancellationToken cancellationToken = default);
}

public interface IAuthorRecentArticleHistoryMutationAuthorizer
{
    Task AuthorizeAsync(
        AuthorRecentArticleHistoryOwner owner,
        int articleId,
        CancellationToken cancellationToken = default);
}

public sealed class UnavailableAuthorRecentArticleHistoryMutationAuthorizer
    : IAuthorRecentArticleHistoryMutationAuthorizer
{
    public static UnavailableAuthorRecentArticleHistoryMutationAuthorizer Instance { get; } = new();

    private UnavailableAuthorRecentArticleHistoryMutationAuthorizer()
    {
    }

    public Task AuthorizeAsync(
        AuthorRecentArticleHistoryOwner owner,
        int articleId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        throw new AuthorRecentArticleHistoryAccessDeniedException();
    }
}

public sealed class AuthorRecentArticleHistoryStore(
    ISqlSugarClient db,
    TimeProvider timeProvider,
    IAuthorRecentArticleHistoryMutationAuthorizer? mutationAuthorizer = null)
    : IAuthorRecentArticleHistoryStore
{
    private readonly IAuthorRecentArticleHistoryMutationAuthorizer _mutationAuthorizer =
        mutationAuthorizer ?? UnavailableAuthorRecentArticleHistoryMutationAuthorizer.Instance;

    public Task<AuthorRecentArticleHistoryReceipt> RecordOpenedAsync(
        AuthorRecentArticleHistoryOwner owner,
        int articleId,
        long serverRevision,
        long expectedCollectionRevision,
        Guid requestId,
        CancellationToken cancellationToken = default)
        => RecordAsync(
            new AuthorRecentArticleHistoryCommand(
                owner,
                articleId,
                serverRevision,
                expectedCollectionRevision,
                requestId,
                AuthorRecentArticleHistoryCommandKind.Open),
            cancellationToken);

    public Task<AuthorRecentArticleHistoryReceipt> RecordEditedAsync(
        AuthorRecentArticleHistoryOwner owner,
        int articleId,
        long serverRevision,
        long expectedCollectionRevision,
        Guid requestId,
        CancellationToken cancellationToken = default)
        => RecordAsync(
            new AuthorRecentArticleHistoryCommand(
                owner,
                articleId,
                serverRevision,
                expectedCollectionRevision,
                requestId,
                AuthorRecentArticleHistoryCommandKind.Edit),
            cancellationToken);

    public Task<AuthorRecentArticleHistoryReceipt> RecordActivatedAsync(
        AuthorRecentArticleHistoryOwner owner,
        int articleId,
        long serverRevision,
        long expectedCollectionRevision,
        Guid requestId,
        CancellationToken cancellationToken = default)
        => RecordAsync(
            new AuthorRecentArticleHistoryCommand(
                owner,
                articleId,
                serverRevision,
                expectedCollectionRevision,
                requestId,
                AuthorRecentArticleHistoryCommandKind.Activate),
            cancellationToken);

    public async Task<AuthorRecentArticleHistoryCollectionSnapshot> GetAuthoritySnapshotAsync(
        AuthorRecentArticleHistoryOwner owner,
        CancellationToken cancellationToken = default)
    {
        AuthorRecentArticleHistoryContract.ValidateOwner(owner);
        cancellationToken.ThrowIfCancellationRequested();
        CollectionRow? collection = await ReadCollectionAsync(owner, cancellationToken).ConfigureAwait(false);
        List<AuthorRecentArticleHistoryEntry> entries = await ReadEntriesAsync(owner, cancellationToken)
            .ConfigureAwait(false);
        if (collection is null)
        {
            if (entries.Count != 0)
            {
                throw new AuthorRecentArticleHistoryTamperDetectedException("collection_missing");
            }
            return EmptySnapshot(owner);
        }

        AuthorRecentArticleHistoryCollectionSnapshot snapshot = BuildSnapshot(owner, collection, entries);
        if (!AuthorRecentArticleHistoryContract.TryValidateSnapshot(snapshot, out IReadOnlyList<string> reasons))
        {
            throw new AuthorRecentArticleHistoryTamperDetectedException(string.Join(',', reasons));
        }
        return snapshot;
    }

    public async Task<AuthorRecentArticleHistoryVerificationResult> VerifyAsync(
        AuthorRecentArticleHistoryOwner owner,
        CancellationToken cancellationToken = default)
    {
        AuthorRecentArticleHistoryContract.ValidateOwner(owner);
        var reasons = new List<string>();
        AuthorRecentArticleHistoryCollectionSnapshot snapshot;
        try
        {
            snapshot = await GetAuthoritySnapshotAsync(owner, cancellationToken).ConfigureAwait(false);
        }
        catch (AuthorRecentArticleHistoryTamperDetectedException exception)
        {
            return new(false, [exception.Reason], 0, 0, string.Empty);
        }

        IReadOnlyList<ReceiptRow> receipts = await ReadReceiptRowsAsync(owner, cancellationToken)
            .ConfigureAwait(false);
        long expectedRevision = 0;
        DateTime? previousAcceptedAtUtc = null;
        var requestIds = new HashSet<Guid>();
        var reconstructedEntries = new List<AuthorRecentArticleHistoryEntry>();
        ReceiptRow[] orderedReceipts = receipts
            .OrderBy(static receipt => receipt.Revision)
            .ThenBy(static receipt => receipt.ReceiptId)
            .ToArray();
        foreach (ReceiptRow receipt in orderedReceipts)
        {
            reasons.AddRange(ValidateReceiptRow(receipt, owner));
            if (!requestIds.Add(receipt.RequestId))
            {
                reasons.Add($"request_duplicate:{receipt.RequestId:D}");
            }
            if (receipt.Status != "applied"
                || receipt.PreviousRevision != expectedRevision
                || receipt.Revision != expectedRevision + 1)
            {
                reasons.Add($"revision_chain_invalid:{receipt.RequestId:D}");
            }
            expectedRevision = Math.Max(expectedRevision, receipt.Revision);
            if (receipt.AcceptedAtUtc.Ticks % 10 != 0
                || (previousAcceptedAtUtc.HasValue
                    && receipt.AcceptedAtUtc <= previousAcceptedAtUtc.Value))
            {
                reasons.Add($"receipt_fact_order_invalid:{receipt.RequestId:D}");
            }
            previousAcceptedAtUtc = receipt.AcceptedAtUtc;
            ReplayReceipt(receipt, owner, reconstructedEntries, reasons);
        }

        if (expectedRevision != snapshot.Revision)
        {
            reasons.Add("receipt_terminal_revision_mismatch");
        }
        if (receipts.Count == 0)
        {
            if (snapshot.Revision != 0
                || snapshot.ChangedAtUtc != DateTime.SpecifyKind(DateTime.MinValue, DateTimeKind.Utc))
            {
                reasons.Add("empty_collection_coordinate_mismatch");
            }
        }
        else if (orderedReceipts[^1].AcceptedAtUtc != snapshot.ChangedAtUtc)
        {
            reasons.Add("collection_timestamp_mismatch");
        }
        if (!reconstructedEntries
                .OrderBy(static entry => entry.ArticleId)
                .SequenceEqual(snapshot.Entries.OrderBy(static entry => entry.ArticleId)))
        {
            reasons.Add("receipt_projection_mismatch");
        }
        return new(
            reasons.Count == 0,
            reasons,
            snapshot.Revision,
            snapshot.ItemCount,
            snapshot.ContentDigest);
    }

    private static void ReplayReceipt(
        ReceiptRow receipt,
        AuthorRecentArticleHistoryOwner owner,
        List<AuthorRecentArticleHistoryEntry> reconstructedEntries,
        List<string> reasons)
    {
        try
        {
            int existingIndex = reconstructedEntries.FindIndex(
                candidate => candidate.ArticleId == receipt.ArticleId);
            AuthorRecentArticleHistoryEntry? previous = existingIndex < 0
                ? null
                : reconstructedEntries[existingIndex];
            if (previous is not null && previous.ServerRevision > receipt.ServerRevision)
            {
                reasons.Add($"receipt_server_revision_descended:{receipt.RequestId:D}");
                return;
            }
            DateTime? opened = previous?.LastOpenedAtUtc;
            DateTime? edited = previous?.LastEditedAtUtc;
            DateTime? activated = previous?.LastActivatedAtUtc;
            // Replay the actual writer transition, not the receipt's self-declared history.
            // An evicted article has no retained predecessor, just as in RecordAsync.
            switch (receipt.CommandKind)
            {
                case "open":
                    opened = MaxTimestamp(opened, receipt.AcceptedAtUtc);
                    break;
                case "edit":
                    edited = MaxTimestamp(edited, receipt.AcceptedAtUtc);
                    break;
                case "activate":
                    activated = MaxTimestamp(activated, receipt.AcceptedAtUtc);
                    break;
                default:
                    reasons.Add($"receipt_command_invalid:{receipt.RequestId:D}");
                    return;
            }
            if (opened != receipt.LastOpenedAtUtc
                || edited != receipt.LastEditedAtUtc
                || activated != receipt.LastActivatedAtUtc)
            {
                reasons.Add($"receipt_fact_transition_invalid:{receipt.RequestId:D}");
                return;
            }
            var entry = new AuthorRecentArticleHistoryEntry(
                receipt.ArticleId,
                receipt.ServerRevision,
                opened,
                edited,
                activated,
                receipt.CommandKind,
                receipt.Revision,
                AuthorRecentArticleHistoryContract.HashText("pending"));
            entry = entry with
            {
                ContentDigest = AuthorRecentArticleHistoryContract.ComputeEntryDigest(owner, entry)
            };
            if (existingIndex < 0)
            {
                reconstructedEntries.Add(entry);
            }
            else
            {
                reconstructedEntries[existingIndex] = entry;
            }
            foreach (AuthorRecentArticleHistoryEntry evicted in reconstructedEntries
                .OrderBy(RecentArticleHistoryOrdering.LatestFactAtUtc)
                .ThenBy(static candidate => candidate.ArticleId)
                .Take(Math.Max(
                    0,
                    reconstructedEntries.Count
                        - AuthorRecentArticleHistoryContract.MaxEntriesPerOwner))
                .ToArray())
            {
                reconstructedEntries.RemoveAll(
                    candidate => candidate.ArticleId == evicted.ArticleId);
            }
            string expectedDigest = AuthorRecentArticleHistoryContract.ComputeCollectionDigest(
                owner,
                receipt.Revision,
                reconstructedEntries);
            if (!string.Equals(expectedDigest, receipt.ContentDigest, StringComparison.Ordinal))
            {
                reasons.Add($"receipt_projection_digest_mismatch:{receipt.RequestId:D}");
            }
        }
        catch (AuthorRecentArticleHistoryValidationException exception)
        {
            reasons.Add($"receipt_projection_invalid:{receipt.RequestId:D}:{exception.Code}");
        }
    }

    private async Task<AuthorRecentArticleHistoryReceipt> RecordAsync(
        AuthorRecentArticleHistoryCommand command,
        CancellationToken cancellationToken)
    {
        AuthorRecentArticleHistoryContract.ValidateCommand(command);
        string commandDigest = AuthorRecentArticleHistoryContract.ComputeCommandDigest(command);
        AuthorRecentArticleHistoryReceipt? receipt = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            await AcquireOwnerLockAsync(command.Owner).ConfigureAwait(false);
            await _mutationAuthorizer.AuthorizeAsync(
                command.Owner,
                command.ArticleId,
                cancellationToken).ConfigureAwait(false);

            AuthorRecentArticleHistoryReceipt? replay = await TryReadReplayAsync(
                command.Owner,
                command.RequestId,
                commandDigest,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                receipt = replay with
                {
                    IdempotentReplay = true
                };
                return;
            }

            await RequirePrincipalExistsAsync(command.Owner.AdminPrincipalId).ConfigureAwait(false);
            ArticleRow article = await RequireCurrentArticleAsync(
                command.ArticleId,
                command.ServerRevision,
                cancellationToken).ConfigureAwait(false);
            CollectionRow? collection = await ReadCollectionAsync(
                command.Owner,
                cancellationToken,
                forUpdate: true).ConfigureAwait(false);
            List<AuthorRecentArticleHistoryEntry> entries = await ReadEntriesAsync(
                command.Owner,
                cancellationToken,
                forUpdate: true).ConfigureAwait(false);
            long previousRevision = collection?.Revision ?? 0;
            if (collection is null && entries.Count != 0)
            {
                throw new AuthorRecentArticleHistoryTamperDetectedException("collection_missing");
            }
            if (collection is not null)
            {
                AuthorRecentArticleHistoryCollectionSnapshot current = BuildSnapshot(command.Owner, collection, entries);
                if (!AuthorRecentArticleHistoryContract.TryValidateSnapshot(current, out IReadOnlyList<string> reasons))
                {
                    throw new AuthorRecentArticleHistoryTamperDetectedException(string.Join(',', reasons));
                }
            }
            if (command.ExpectedCollectionRevision != previousRevision)
            {
                throw new AuthorRecentArticleHistoryRevisionConflictException(
                    command.ExpectedCollectionRevision,
                    previousRevision);
            }

            AuthorRecentArticleHistoryEntry? existing = entries.SingleOrDefault(
                entry => entry.ArticleId == command.ArticleId);
            if (existing is not null && existing.ServerRevision > article.CurrentRevisionId)
            {
                throw new AuthorRecentArticleHistoryTamperDetectedException("entry_server_revision_descended");
            }

            DateTime now = NextFactTimestamp(collection?.ChangedAtUtc, UtcNow);
            DateTime? opened = existing?.LastOpenedAtUtc;
            DateTime? edited = existing?.LastEditedAtUtc;
            DateTime? activated = existing?.LastActivatedAtUtc;
            switch (command.CommandKind)
            {
                case AuthorRecentArticleHistoryCommandKind.Open:
                    opened = MaxTimestamp(opened, now);
                    break;
                case AuthorRecentArticleHistoryCommandKind.Edit:
                    edited = MaxTimestamp(edited, now);
                    break;
                case AuthorRecentArticleHistoryCommandKind.Activate:
                    activated = MaxTimestamp(activated, now);
                    break;
                default:
                    throw new AuthorRecentArticleHistoryValidationException("author_recent_history_command_invalid");
            }

            long revision = checked(previousRevision + 1);
            var nextEntry = new AuthorRecentArticleHistoryEntry(
                command.ArticleId,
                article.CurrentRevisionId,
                opened,
                edited,
                activated,
                AuthorRecentArticleHistoryContract.CommandName(command.CommandKind),
                revision,
                string.Empty);
            nextEntry = nextEntry with
            {
                ContentDigest = AuthorRecentArticleHistoryContract.ComputeEntryDigest(command.Owner, nextEntry with
                {
                    ContentDigest = AuthorRecentArticleHistoryContract.HashText("pending")
                })
            };
            if (collection is null)
            {
                await InsertInitialCollectionAsync(command.Owner, now).ConfigureAwait(false);
            }
            await UpsertEntryAsync(command.Owner, nextEntry).ConfigureAwait(false);
            if (existing is null)
            {
                entries.Add(nextEntry);
            }
            else
            {
                entries[entries.FindIndex(entry => entry.ArticleId == command.ArticleId)] = nextEntry;
            }

            foreach (AuthorRecentArticleHistoryEntry evicted in entries
                .OrderBy(RecentArticleHistoryOrdering.LatestFactAtUtc)
                .ThenBy(static entry => entry.ArticleId)
                .Take(Math.Max(0, entries.Count - AuthorRecentArticleHistoryContract.MaxEntriesPerOwner))
                .ToArray())
            {
                await DeleteEntryAsync(command.Owner, evicted.ArticleId).ConfigureAwait(false);
                entries.RemoveAll(entry => entry.ArticleId == evicted.ArticleId);
            }

            string contentDigest = AuthorRecentArticleHistoryContract.ComputeCollectionDigest(
                command.Owner,
                revision,
                entries);
            await UpsertCollectionAsync(
                command.Owner,
                previousRevision,
                revision,
                entries.Count,
                contentDigest,
                now).ConfigureAwait(false);

            Guid receiptId = Guid.CreateVersion7();
            string projectionReference = $"author-recent-history:{command.Owner.AdminPrincipalId}:{command.Owner.SiteScope}:r{revision}";
            string cacheReference = $"server-read-model:{command.Owner.AdminPrincipalId}:{command.Owner.SiteScope}:{contentDigest}";
            string auditReference = $"author-recent-history-audit:{receiptId:D}";
            string outboxReference = $"author-recent-history-outbox:{receiptId:D}";
            var persistedReceipt = new AuthorRecentArticleHistoryReceipt(
                receiptId,
                command.Owner,
                command.RequestId,
                command.ArticleId,
                article.CurrentRevisionId,
                previousRevision,
                revision,
                AuthorRecentArticleHistoryContract.CommandName(command.CommandKind),
                "applied",
                now,
                nextEntry.LastOpenedAtUtc,
                nextEntry.LastEditedAtUtc,
                nextEntry.LastActivatedAtUtc,
                projectionReference,
                cacheReference,
                auditReference,
                outboxReference,
                commandDigest,
                contentDigest,
                false,
                string.Empty);
            persistedReceipt = persistedReceipt with
            {
                ReceiptDigest = AuthorRecentArticleHistoryContract.ComputeReceiptDigest(persistedReceipt)
            };
            await InsertReceiptAsync(persistedReceipt).ConfigureAwait(false);
            await InsertIdempotencyAsync(persistedReceipt).ConfigureAwait(false);
            await InsertOutboxAsync(persistedReceipt).ConfigureAwait(false);
            await InsertAuditAsync(persistedReceipt).ConfigureAwait(false);
            receipt = persistedReceipt;
            cancellationToken.ThrowIfCancellationRequested();
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            if (transaction.ErrorException is not null)
            {
                ExceptionDispatchInfo.Capture(transaction.ErrorException).Throw();
            }
            throw new InvalidOperationException("author_recent_history_transaction_failed");
        }
        return receipt ?? throw new InvalidOperationException("author_recent_history_receipt_missing");
    }

    private async Task<AuthorRecentArticleHistoryReceipt?> TryReadReplayAsync(
        AuthorRecentArticleHistoryOwner owner,
        Guid requestId,
        string commandDigest,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT i.request_id,
                   i.command_digest AS idempotency_command_digest,
                   i.receipt_id AS idempotency_receipt_id,
                   i.created_at_utc AS idempotency_created_at_utc,
                   r.receipt_id,
                   r.owner_admin_principal_id,
                   r.site_scope,
                   r.article_id,
                   r.server_revision,
                   r.previous_revision,
                   r.revision,
                   r.command_kind,
                   r.status,
                   r.accepted_at_utc,
                   r.last_opened_at_utc,
                   r.last_edited_at_utc,
                   r.last_activated_at_utc,
                   r.projection_reference,
                   r.cache_reference,
                   r.audit_reference,
                   r.outbox_reference,
                   r.command_digest,
                   r.content_digest,
                   r.receipt_digest,
                   EXISTS(SELECT 1 FROM author_recent_history_outbox o
                          WHERE o.outbox_reference = r.outbox_reference
                            AND o.receipt_id = r.receipt_id
                            AND o.owner_admin_principal_id = r.owner_admin_principal_id
                            AND o.site_scope = r.site_scope
                            AND o.request_id = r.request_id
                            AND o.revision = r.revision
                            AND o.payload_digest = r.content_digest
                            AND o.status = 'committed'
                            AND o.created_at_utc = r.accepted_at_utc) AS has_outbox,
                   EXISTS(SELECT 1 FROM author_recent_history_audit a
                          WHERE a.audit_reference = r.audit_reference
                            AND a.receipt_id = r.receipt_id
                            AND a.owner_admin_principal_id = r.owner_admin_principal_id
                            AND a.site_scope = r.site_scope
                            AND a.request_id = r.request_id
                            AND a.article_id = r.article_id
                            AND a.server_revision = r.server_revision
                            AND a.command_kind = r.command_kind
                            AND a.command_digest = r.command_digest
                            AND a.content_digest = r.content_digest
                            AND a.occurred_at_utc = r.accepted_at_utc) AS has_audit
            FROM author_recent_history_idempotency i
            LEFT JOIN author_recent_history_receipt r
              ON r.receipt_id = i.receipt_id
            WHERE i.owner_admin_principal_id = @OwnerAdminPrincipalId
              AND i.site_scope = @SiteScope
              AND i.request_id = @RequestId;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@RequestId", requestId)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        string storedDigest = reader.GetString(reader.GetOrdinal("idempotency_command_digest"));
        if (!string.Equals(storedDigest, commandDigest, StringComparison.Ordinal))
        {
            throw new AuthorRecentArticleHistoryIdempotencyConflictException();
        }
        if (reader.IsDBNull(reader.GetOrdinal("receipt_id")))
        {
            throw new AuthorRecentArticleHistoryTamperDetectedException("idempotency_receipt_missing");
        }
        ReceiptRow row = ReadReceipt(
            reader,
            idempotencyCommandDigest: storedDigest,
            reader.GetBoolean(reader.GetOrdinal("has_outbox")),
            reader.GetBoolean(reader.GetOrdinal("has_audit")));
        IReadOnlyList<string> reasons = ValidateReceiptRow(row, owner, commandDigest);
        if (reasons.Count != 0)
        {
            throw new AuthorRecentArticleHistoryTamperDetectedException(string.Join(',', reasons));
        }
        return ToReceipt(row, idempotentReplay: false);
    }

    private async Task RequirePrincipalExistsAsync(long adminPrincipalId)
    {
        object? result = await db.Ado.GetScalarAsync(
            "SELECT 1 FROM admin_principal WHERE id = @AdminPrincipalId LIMIT 1;",
            new SugarParameter("@AdminPrincipalId", adminPrincipalId)).ConfigureAwait(false);
        if (result is null || result == DBNull.Value)
        {
            throw new AuthorRecentArticleHistoryAccessDeniedException();
        }
    }

    private async Task<ArticleRow> RequireCurrentArticleAsync(
        int articleId,
        long serverRevision,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, status, isdeleted, current_revision_id
            FROM article
            WHERE id = @ArticleId
            FOR SHARE;
            """,
            new SugarParameter("@ArticleId", articleId)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            || reader.GetBoolean(reader.GetOrdinal("isdeleted")))
        {
            throw new AuthorRecentArticleHistoryAccessDeniedException();
        }
        ArticleStatus status = (ArticleStatus)reader.GetInt32(reader.GetOrdinal("status"));
        if (status is ArticleStatus.Archived or ArticleStatus.Deleted)
        {
            throw new AuthorRecentArticleHistoryAccessDeniedException();
        }
        int revisionOrdinal = reader.GetOrdinal("current_revision_id");
        if (reader.IsDBNull(revisionOrdinal))
        {
            throw new AuthorRecentArticleHistoryRevisionConflictException(serverRevision, 0);
        }
        long currentRevisionId = reader.GetInt64(revisionOrdinal);
        if (currentRevisionId != serverRevision)
        {
            throw new AuthorRecentArticleHistoryRevisionConflictException(serverRevision, currentRevisionId);
        }
        return new ArticleRow(reader.GetInt32(reader.GetOrdinal("id")), currentRevisionId);
    }

    private async Task<CollectionRow?> ReadCollectionAsync(
        AuthorRecentArticleHistoryOwner owner,
        CancellationToken cancellationToken,
        bool forUpdate = false)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT schema_version, revision, item_count, changed_at_utc, content_digest
            FROM author_recent_history_collection
            WHERE owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope
            {(forUpdate ? "FOR UPDATE" : string.Empty)};
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        return new CollectionRow(
            reader.GetInt32(reader.GetOrdinal("schema_version")),
            reader.GetInt64(reader.GetOrdinal("revision")),
            reader.GetInt32(reader.GetOrdinal("item_count")),
            Utc(reader.GetDateTime(reader.GetOrdinal("changed_at_utc"))),
            reader.GetString(reader.GetOrdinal("content_digest")));
    }

    private async Task<List<AuthorRecentArticleHistoryEntry>> ReadEntriesAsync(
        AuthorRecentArticleHistoryOwner owner,
        CancellationToken cancellationToken,
        bool forUpdate = false)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT article_id, server_revision, last_opened_at_utc, last_edited_at_utc,
                   last_activated_at_utc, last_command, entry_revision, content_digest
            FROM author_recent_history_entry
            WHERE owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope
            ORDER BY article_id
            {(forUpdate ? "FOR UPDATE" : string.Empty)};
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        var entries = new List<AuthorRecentArticleHistoryEntry>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            entries.Add(new AuthorRecentArticleHistoryEntry(
                reader.GetInt32(reader.GetOrdinal("article_id")),
                reader.GetInt64(reader.GetOrdinal("server_revision")),
                ReadNullableTimestamp(reader, "last_opened_at_utc"),
                ReadNullableTimestamp(reader, "last_edited_at_utc"),
                ReadNullableTimestamp(reader, "last_activated_at_utc"),
                reader.GetString(reader.GetOrdinal("last_command")),
                reader.GetInt64(reader.GetOrdinal("entry_revision")),
                reader.GetString(reader.GetOrdinal("content_digest"))));
        }
        return entries;
    }

    private async Task UpsertEntryAsync(
        AuthorRecentArticleHistoryOwner owner,
        AuthorRecentArticleHistoryEntry entry)
        => await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO author_recent_history_entry(
                owner_admin_principal_id, site_scope, article_id, server_revision,
                last_opened_at_utc, last_edited_at_utc, last_activated_at_utc,
                last_command, entry_revision, content_digest)
            VALUES(
                @OwnerAdminPrincipalId, @SiteScope, @ArticleId, @ServerRevision,
                @LastOpenedAtUtc, @LastEditedAtUtc, @LastActivatedAtUtc,
                @LastCommand, @EntryRevision, @ContentDigest)
            ON CONFLICT (owner_admin_principal_id, site_scope, article_id)
            DO UPDATE SET
                server_revision = EXCLUDED.server_revision,
                last_opened_at_utc = EXCLUDED.last_opened_at_utc,
                last_edited_at_utc = EXCLUDED.last_edited_at_utc,
                last_activated_at_utc = EXCLUDED.last_activated_at_utc,
                last_command = EXCLUDED.last_command,
                entry_revision = EXCLUDED.entry_revision,
                content_digest = EXCLUDED.content_digest;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@ArticleId", entry.ArticleId),
            new SugarParameter("@ServerRevision", entry.ServerRevision),
            TimestampParameter("@LastOpenedAtUtc", entry.LastOpenedAtUtc),
            TimestampParameter("@LastEditedAtUtc", entry.LastEditedAtUtc),
            TimestampParameter("@LastActivatedAtUtc", entry.LastActivatedAtUtc),
            new SugarParameter("@LastCommand", entry.LastCommand),
            new SugarParameter("@EntryRevision", entry.EntryRevision),
            new SugarParameter("@ContentDigest", entry.ContentDigest)).ConfigureAwait(false);

    private async Task InsertInitialCollectionAsync(
        AuthorRecentArticleHistoryOwner owner,
        DateTime changedAtUtc)
        => await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO author_recent_history_collection(
                owner_admin_principal_id, site_scope, schema_version, revision,
                item_count, changed_at_utc, content_digest)
            VALUES(@OwnerAdminPrincipalId, @SiteScope, @SchemaVersion, 0,
                   0, @ChangedAtUtc, @ContentDigest);
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@SchemaVersion", AuthorRecentArticleHistoryContract.SchemaVersion),
            new SugarParameter("@ChangedAtUtc", changedAtUtc),
            new SugarParameter(
                "@ContentDigest",
                AuthorRecentArticleHistoryContract.ComputeCollectionDigest(owner, 0, [])))
            .ConfigureAwait(false);

    private async Task DeleteEntryAsync(AuthorRecentArticleHistoryOwner owner, int articleId)
        => await db.Ado.ExecuteCommandAsync(
            """
            DELETE FROM author_recent_history_entry
            WHERE owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope
              AND article_id = @ArticleId;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@ArticleId", articleId)).ConfigureAwait(false);

    private async Task UpsertCollectionAsync(
        AuthorRecentArticleHistoryOwner owner,
        long previousRevision,
        long revision,
        int itemCount,
        string contentDigest,
        DateTime changedAtUtc)
    {
        int affected = await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO author_recent_history_collection(
                owner_admin_principal_id, site_scope, schema_version, revision,
                item_count, changed_at_utc, content_digest)
            VALUES(@OwnerAdminPrincipalId, @SiteScope, @SchemaVersion, @Revision,
                   @ItemCount, @ChangedAtUtc, @ContentDigest)
            ON CONFLICT (owner_admin_principal_id, site_scope)
            DO UPDATE SET
                revision = EXCLUDED.revision,
                item_count = EXCLUDED.item_count,
                changed_at_utc = EXCLUDED.changed_at_utc,
                content_digest = EXCLUDED.content_digest
            WHERE author_recent_history_collection.revision = @PreviousRevision;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@SchemaVersion", AuthorRecentArticleHistoryContract.SchemaVersion),
            new SugarParameter("@Revision", revision),
            new SugarParameter("@PreviousRevision", previousRevision),
            new SugarParameter("@ItemCount", itemCount),
            new SugarParameter("@ChangedAtUtc", changedAtUtc),
            new SugarParameter("@ContentDigest", contentDigest)).ConfigureAwait(false);
        if (affected != 1)
        {
            throw new AuthorRecentArticleHistoryRevisionConflictException(previousRevision, revision);
        }
    }

    private async Task InsertReceiptAsync(AuthorRecentArticleHistoryReceipt receipt)
        => await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO author_recent_history_receipt(
                receipt_id, owner_admin_principal_id, site_scope, request_id, article_id,
                server_revision, previous_revision, revision, command_kind, status,
                accepted_at_utc, last_opened_at_utc, last_edited_at_utc,
                last_activated_at_utc, projection_reference, cache_reference,
                audit_reference, outbox_reference, command_digest, content_digest,
                receipt_digest)
            VALUES(@ReceiptId, @OwnerAdminPrincipalId, @SiteScope, @RequestId, @ArticleId,
                   @ServerRevision, @PreviousRevision, @Revision, @CommandKind, @Status,
                   @AcceptedAtUtc, @LastOpenedAtUtc, @LastEditedAtUtc,
                   @LastActivatedAtUtc, @ProjectionReference, @CacheReference,
                   @AuditReference, @OutboxReference, @CommandDigest, @ContentDigest,
                   @ReceiptDigest);
            """,
            ReceiptParameters(receipt)).ConfigureAwait(false);

    private async Task InsertIdempotencyAsync(AuthorRecentArticleHistoryReceipt receipt)
        => await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO author_recent_history_idempotency(
                owner_admin_principal_id, site_scope, request_id, receipt_id,
                command_digest, created_at_utc)
            VALUES(@OwnerAdminPrincipalId, @SiteScope, @RequestId, @ReceiptId,
                   @CommandDigest, @AcceptedAtUtc);
            """,
            new SugarParameter("@OwnerAdminPrincipalId", receipt.Owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", receipt.Owner.SiteScope),
            new SugarParameter("@RequestId", receipt.RequestId),
            new SugarParameter("@ReceiptId", receipt.ReceiptId),
            new SugarParameter("@CommandDigest", receipt.CommandDigest),
            new SugarParameter("@AcceptedAtUtc", receipt.AcceptedAtUtc)).ConfigureAwait(false);

    private async Task InsertOutboxAsync(AuthorRecentArticleHistoryReceipt receipt)
        => await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO author_recent_history_outbox(
                outbox_reference, owner_admin_principal_id, site_scope, receipt_id,
                request_id, revision, payload_digest, status, created_at_utc)
            VALUES(@OutboxReference, @OwnerAdminPrincipalId, @SiteScope, @ReceiptId,
                   @RequestId, @Revision, @PayloadDigest, 'committed', @AcceptedAtUtc);
            """,
            new SugarParameter("@OutboxReference", receipt.OutboxReference),
            new SugarParameter("@OwnerAdminPrincipalId", receipt.Owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", receipt.Owner.SiteScope),
            new SugarParameter("@ReceiptId", receipt.ReceiptId),
            new SugarParameter("@RequestId", receipt.RequestId),
            new SugarParameter("@Revision", receipt.Revision),
            new SugarParameter("@PayloadDigest", receipt.ContentDigest),
            new SugarParameter("@AcceptedAtUtc", receipt.AcceptedAtUtc)).ConfigureAwait(false);

    private async Task InsertAuditAsync(AuthorRecentArticleHistoryReceipt receipt)
        => await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO author_recent_history_audit(
                audit_reference, owner_admin_principal_id, site_scope, receipt_id,
                request_id, article_id, server_revision, command_kind, command_digest,
                content_digest, occurred_at_utc)
            VALUES(@AuditReference, @OwnerAdminPrincipalId, @SiteScope, @ReceiptId,
                   @RequestId, @ArticleId, @ServerRevision, @CommandKind, @CommandDigest,
                   @ContentDigest, @AcceptedAtUtc);
            """,
            new SugarParameter("@AuditReference", receipt.AuditReference),
            new SugarParameter("@OwnerAdminPrincipalId", receipt.Owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", receipt.Owner.SiteScope),
            new SugarParameter("@ReceiptId", receipt.ReceiptId),
            new SugarParameter("@RequestId", receipt.RequestId),
            new SugarParameter("@ArticleId", receipt.ArticleId),
            new SugarParameter("@ServerRevision", receipt.ServerRevision),
            new SugarParameter("@CommandKind", receipt.CommandKind),
            new SugarParameter("@CommandDigest", receipt.CommandDigest),
            new SugarParameter("@ContentDigest", receipt.ContentDigest),
            new SugarParameter("@AcceptedAtUtc", receipt.AcceptedAtUtc)).ConfigureAwait(false);

    private async Task<IReadOnlyList<ReceiptRow>> ReadReceiptRowsAsync(
        AuthorRecentArticleHistoryOwner owner,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT r.receipt_id, r.owner_admin_principal_id, r.site_scope, r.request_id,
                   r.article_id, r.server_revision, r.previous_revision, r.revision,
                   r.command_kind, r.status, r.accepted_at_utc,
                   r.last_opened_at_utc, r.last_edited_at_utc, r.last_activated_at_utc,
                   r.projection_reference,
                   r.cache_reference, r.audit_reference, r.outbox_reference,
                   r.command_digest, r.content_digest, r.receipt_digest,
                   i.receipt_id AS idempotency_receipt_id,
                   i.command_digest AS idempotency_command_digest,
                   i.created_at_utc AS idempotency_created_at_utc,
                   EXISTS(SELECT 1 FROM author_recent_history_outbox o
                          WHERE o.outbox_reference = r.outbox_reference
                            AND o.receipt_id = r.receipt_id
                            AND o.owner_admin_principal_id = r.owner_admin_principal_id
                            AND o.site_scope = r.site_scope
                            AND o.request_id = r.request_id
                            AND o.revision = r.revision
                            AND o.payload_digest = r.content_digest
                            AND o.status = 'committed'
                            AND o.created_at_utc = r.accepted_at_utc) AS has_outbox,
                   EXISTS(SELECT 1 FROM author_recent_history_audit a
                          WHERE a.audit_reference = r.audit_reference
                            AND a.receipt_id = r.receipt_id
                            AND a.owner_admin_principal_id = r.owner_admin_principal_id
                            AND a.site_scope = r.site_scope
                            AND a.request_id = r.request_id
                            AND a.article_id = r.article_id
                            AND a.server_revision = r.server_revision
                            AND a.command_kind = r.command_kind
                            AND a.command_digest = r.command_digest
                            AND a.content_digest = r.content_digest
                            AND a.occurred_at_utc = r.accepted_at_utc) AS has_audit
            FROM author_recent_history_receipt r
            LEFT JOIN author_recent_history_idempotency i
              ON i.owner_admin_principal_id = r.owner_admin_principal_id
             AND i.site_scope = r.site_scope
             AND i.request_id = r.request_id
            WHERE r.owner_admin_principal_id = @OwnerAdminPrincipalId
              AND r.site_scope = @SiteScope
            ORDER BY r.revision, r.receipt_id;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        var result = new List<ReceiptRow>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            result.Add(ReadReceipt(
                reader,
                reader.IsDBNull(reader.GetOrdinal("idempotency_command_digest"))
                    ? string.Empty
                    : reader.GetString(reader.GetOrdinal("idempotency_command_digest")),
                !reader.IsDBNull(reader.GetOrdinal("has_outbox")) && reader.GetBoolean(reader.GetOrdinal("has_outbox")),
                !reader.IsDBNull(reader.GetOrdinal("has_audit")) && reader.GetBoolean(reader.GetOrdinal("has_audit"))));
        }
        return result;
    }

    private static ReceiptRow ReadReceipt(
        DbDataReader reader,
        string idempotencyCommandDigest,
        bool hasOutbox,
        bool hasAudit)
        => new(
            reader.GetGuid(reader.GetOrdinal("receipt_id")),
            new AuthorRecentArticleHistoryOwner(
                reader.GetInt64(reader.GetOrdinal("owner_admin_principal_id")),
                reader.GetString(reader.GetOrdinal("site_scope"))),
            reader.GetGuid(reader.GetOrdinal("request_id")),
            reader.GetInt32(reader.GetOrdinal("article_id")),
            reader.GetInt64(reader.GetOrdinal("server_revision")),
            reader.GetInt64(reader.GetOrdinal("previous_revision")),
            reader.GetInt64(reader.GetOrdinal("revision")),
            reader.GetString(reader.GetOrdinal("command_kind")),
            reader.GetString(reader.GetOrdinal("status")),
            Utc(reader.GetDateTime(reader.GetOrdinal("accepted_at_utc"))),
            ReadNullableTimestamp(reader, "last_opened_at_utc"),
            ReadNullableTimestamp(reader, "last_edited_at_utc"),
            ReadNullableTimestamp(reader, "last_activated_at_utc"),
            reader.GetString(reader.GetOrdinal("projection_reference")),
            reader.GetString(reader.GetOrdinal("cache_reference")),
            reader.GetString(reader.GetOrdinal("audit_reference")),
            reader.GetString(reader.GetOrdinal("outbox_reference")),
            reader.GetString(reader.GetOrdinal("command_digest")),
            reader.GetString(reader.GetOrdinal("content_digest")),
            reader.GetString(reader.GetOrdinal("receipt_digest")),
            reader.IsDBNull(reader.GetOrdinal("idempotency_receipt_id"))
                ? Guid.Empty
                : reader.GetGuid(reader.GetOrdinal("idempotency_receipt_id")),
            idempotencyCommandDigest,
            reader.IsDBNull(reader.GetOrdinal("idempotency_created_at_utc"))
                ? null
                : Utc(reader.GetDateTime(reader.GetOrdinal("idempotency_created_at_utc"))),
            hasOutbox,
            hasAudit);

    private static IReadOnlyList<string> ValidateReceiptRow(
        ReceiptRow receipt,
        AuthorRecentArticleHistoryOwner expectedOwner,
        string? expectedCommandDigest = null)
    {
        var reasons = new List<string>();
        try
        {
            AuthorRecentArticleHistoryContract.ValidateOwner(receipt.Owner);
            AuthorRecentArticleHistoryContract.ValidateRequestId(receipt.RequestId);
            AuthorRecentArticleHistoryContract.ValidateRequestId(receipt.ReceiptId);
            AuthorRecentArticleHistoryContract.ValidateArticleId(receipt.ArticleId);
            AuthorRecentArticleHistoryContract.ValidateServerRevision(receipt.ServerRevision);
            AuthorRecentArticleHistoryContract.ValidateExpectedRevision(receipt.PreviousRevision);
            AuthorRecentArticleHistoryContract.ValidateExpectedRevision(receipt.Revision);
            AuthorRecentArticleHistoryContract.ValidateDigest(receipt.CommandDigest);
            AuthorRecentArticleHistoryContract.ValidateDigest(receipt.ContentDigest);
            if (!AuthorRecentArticleHistoryContract.TryParseCommandName(
                    receipt.CommandKind,
                    out AuthorRecentArticleHistoryCommandKind commandKind))
            {
                reasons.Add($"receipt_command_invalid:{receipt.RequestId:D}");
            }
            else
            {
                string reconstructedCommandDigest =
                    AuthorRecentArticleHistoryContract.ComputeCommandDigest(
                        new AuthorRecentArticleHistoryCommand(
                            receipt.Owner,
                            receipt.ArticleId,
                            receipt.ServerRevision,
                            receipt.PreviousRevision,
                            receipt.RequestId,
                            commandKind));
                if (!string.Equals(
                        reconstructedCommandDigest,
                        receipt.CommandDigest,
                        StringComparison.Ordinal))
                {
                    reasons.Add($"command_digest_mismatch:{receipt.RequestId:D}");
                }
                DateTime? commandTimestamp = commandKind switch
                {
                    AuthorRecentArticleHistoryCommandKind.Open => receipt.LastOpenedAtUtc,
                    AuthorRecentArticleHistoryCommandKind.Edit => receipt.LastEditedAtUtc,
                    AuthorRecentArticleHistoryCommandKind.Activate => receipt.LastActivatedAtUtc,
                    _ => null
                };
                if (commandTimestamp != receipt.AcceptedAtUtc
                    || receipt.LastOpenedAtUtc > receipt.AcceptedAtUtc
                    || receipt.LastEditedAtUtc > receipt.AcceptedAtUtc
                    || receipt.LastActivatedAtUtc > receipt.AcceptedAtUtc)
                {
                    reasons.Add($"receipt_timestamp_mismatch:{receipt.RequestId:D}");
                }
            }

            string expectedReceiptDigest = AuthorRecentArticleHistoryContract.ComputeReceiptDigest(
                ToReceipt(receipt, idempotentReplay: false));
            if (!string.Equals(expectedReceiptDigest, receipt.ReceiptDigest, StringComparison.Ordinal))
            {
                reasons.Add($"receipt_digest_mismatch:{receipt.RequestId:D}");
            }
        }
        catch (AuthorRecentArticleHistoryValidationException exception)
        {
            reasons.Add($"receipt_invalid:{receipt.RequestId:D}:{exception.Code}");
        }

        if (receipt.Owner != expectedOwner)
        {
            reasons.Add($"receipt_owner_mismatch:{receipt.RequestId:D}");
        }
        if (receipt.Status != "applied"
            || receipt.Revision != receipt.PreviousRevision + 1)
        {
            reasons.Add($"receipt_revision_invalid:{receipt.RequestId:D}");
        }
        if (expectedCommandDigest is not null
            && !string.Equals(expectedCommandDigest, receipt.CommandDigest, StringComparison.Ordinal))
        {
            reasons.Add($"idempotency_command_mismatch:{receipt.RequestId:D}");
        }
        if (receipt.IdempotencyReceiptId != receipt.ReceiptId
            || !string.Equals(
                receipt.IdempotencyCommandDigest,
                receipt.CommandDigest,
                StringComparison.Ordinal)
            || receipt.IdempotencyCreatedAtUtc != receipt.AcceptedAtUtc)
        {
            reasons.Add($"idempotency_mismatch:{receipt.RequestId:D}");
        }
        if (!string.Equals(
                receipt.ProjectionReference,
                $"author-recent-history:{receipt.Owner.AdminPrincipalId}:{receipt.Owner.SiteScope}:r{receipt.Revision}",
                StringComparison.Ordinal)
            || !string.Equals(
                receipt.CacheReference,
                $"server-read-model:{receipt.Owner.AdminPrincipalId}:{receipt.Owner.SiteScope}:{receipt.ContentDigest}",
                StringComparison.Ordinal)
            || !string.Equals(
                receipt.AuditReference,
                $"author-recent-history-audit:{receipt.ReceiptId:D}",
                StringComparison.Ordinal)
            || !string.Equals(
                receipt.OutboxReference,
                $"author-recent-history-outbox:{receipt.ReceiptId:D}",
                StringComparison.Ordinal))
        {
            reasons.Add($"receipt_reference_mismatch:{receipt.RequestId:D}");
        }
        if (!receipt.HasOutbox || !receipt.HasAudit)
        {
            reasons.Add($"durable_side_effect_missing:{receipt.RequestId:D}");
        }
        return reasons;
    }

    private async Task AcquireOwnerLockAsync(AuthorRecentArticleHistoryOwner owner)
        => _ = await db.Ado.GetScalarAsync(
            "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 0));",
            new SugarParameter(
                "@Identity",
                $"author-recent-history:{owner.AdminPrincipalId}:{owner.SiteScope}"))
            .ConfigureAwait(false);

    private AuthorRecentArticleHistoryCollectionSnapshot BuildSnapshot(
        AuthorRecentArticleHistoryOwner owner,
        CollectionRow collection,
        IReadOnlyList<AuthorRecentArticleHistoryEntry> entries)
        => new(
            owner,
            collection.SchemaVersion,
            collection.Revision,
            collection.ItemCount,
            [.. entries],
            collection.ChangedAtUtc,
            collection.ContentDigest);

    private static AuthorRecentArticleHistoryCollectionSnapshot EmptySnapshot(
        AuthorRecentArticleHistoryOwner owner)
    {
        string digest = AuthorRecentArticleHistoryContract.ComputeCollectionDigest(owner, 0, []);
        return new(
            owner,
            AuthorRecentArticleHistoryContract.SchemaVersion,
            0,
            0,
            [],
            DateTime.SpecifyKind(DateTime.MinValue, DateTimeKind.Utc),
            digest);
    }

    private static AuthorRecentArticleHistoryReceipt ToReceipt(ReceiptRow row, bool idempotentReplay)
        => new(
            row.ReceiptId,
            row.Owner,
            row.RequestId,
            row.ArticleId,
            row.ServerRevision,
            row.PreviousRevision,
            row.Revision,
            row.CommandKind,
            row.Status,
            row.AcceptedAtUtc,
            row.LastOpenedAtUtc,
            row.LastEditedAtUtc,
            row.LastActivatedAtUtc,
            row.ProjectionReference,
            row.CacheReference,
            row.AuditReference,
            row.OutboxReference,
            row.CommandDigest,
            row.ContentDigest,
            idempotentReplay,
            row.ReceiptDigest);

    private static SugarParameter[] ReceiptParameters(AuthorRecentArticleHistoryReceipt receipt)
        =>
        [
            new("@ReceiptId", receipt.ReceiptId),
            new("@OwnerAdminPrincipalId", receipt.Owner.AdminPrincipalId),
            new("@SiteScope", receipt.Owner.SiteScope),
            new("@RequestId", receipt.RequestId),
            new("@ArticleId", receipt.ArticleId),
            new("@ServerRevision", receipt.ServerRevision),
            new("@PreviousRevision", receipt.PreviousRevision),
            new("@Revision", receipt.Revision),
            new("@CommandKind", receipt.CommandKind),
            new("@Status", receipt.Status),
            new("@AcceptedAtUtc", receipt.AcceptedAtUtc),
            TimestampParameter("@LastOpenedAtUtc", receipt.LastOpenedAtUtc),
            TimestampParameter("@LastEditedAtUtc", receipt.LastEditedAtUtc),
            TimestampParameter("@LastActivatedAtUtc", receipt.LastActivatedAtUtc),
            new("@ProjectionReference", receipt.ProjectionReference),
            new("@CacheReference", receipt.CacheReference),
            new("@AuditReference", receipt.AuditReference),
            new("@OutboxReference", receipt.OutboxReference),
            new("@CommandDigest", receipt.CommandDigest),
            new("@ContentDigest", receipt.ContentDigest),
            new("@ReceiptDigest", receipt.ReceiptDigest)
        ];

    private DateTime UtcNow
    {
        get
        {
            DateTime value = Utc(timeProvider.GetUtcNow().UtcDateTime);
            // PostgreSQL timestamp stores microseconds. Canonicalize before hashing so a
            // persisted timestamp and its receipt/entry digest cannot differ by sub-microsecond
            // DateTime ticks after a round trip.
            return new DateTime(value.Ticks - (value.Ticks % 10), DateTimeKind.Utc);
        }
    }

    private static DateTime MaxTimestamp(DateTime? current, DateTime candidate)
        => !current.HasValue || candidate > current.Value ? candidate : current.Value;

    private static DateTime NextFactTimestamp(DateTime? current, DateTime candidate)
    {
        if (!current.HasValue || candidate > current.Value)
        {
            return candidate;
        }
        if (current.Value.Ticks > DateTime.MaxValue.Ticks - 10)
        {
            throw new InvalidOperationException("author_recent_history_timestamp_exhausted");
        }
        return new DateTime(current.Value.Ticks + 10, DateTimeKind.Utc);
    }

    private static SugarParameter TimestampParameter(string name, DateTime? value)
        => new(name, value.HasValue ? value.Value : DBNull.Value)
        {
            DbType = System.Data.DbType.DateTime
        };

    private static DateTime? ReadNullableTimestamp(DbDataReader reader, string name)
        => reader.IsDBNull(reader.GetOrdinal(name))
            ? null
            : Utc(reader.GetDateTime(reader.GetOrdinal(name)));

    private static DateTime Utc(DateTime value)
        => value.Kind == DateTimeKind.Utc
            ? value
            : DateTime.SpecifyKind(value, DateTimeKind.Utc);

    private sealed record CollectionRow(
        int SchemaVersion,
        long Revision,
        int ItemCount,
        DateTime ChangedAtUtc,
        string ContentDigest);

    private sealed record ArticleRow(int ArticleId, long CurrentRevisionId);

    private sealed record ReceiptRow(
        Guid ReceiptId,
        AuthorRecentArticleHistoryOwner Owner,
        Guid RequestId,
        int ArticleId,
        long ServerRevision,
        long PreviousRevision,
        long Revision,
        string CommandKind,
        string Status,
        DateTime AcceptedAtUtc,
        DateTime? LastOpenedAtUtc,
        DateTime? LastEditedAtUtc,
        DateTime? LastActivatedAtUtc,
        string ProjectionReference,
        string CacheReference,
        string AuditReference,
        string OutboxReference,
        string CommandDigest,
        string ContentDigest,
        string ReceiptDigest,
        Guid IdempotencyReceiptId,
        string IdempotencyCommandDigest,
        DateTime? IdempotencyCreatedAtUtc,
        bool HasOutbox,
        bool HasAudit);
}
