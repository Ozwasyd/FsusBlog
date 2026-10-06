using System.Data.Common;
using System.Globalization;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// PostgreSQL adapter for the exact-one PropertyDefinition authority. A per-owner advisory
/// lock serializes the owner revision, and each mutation commits the definition, options,
/// localized labels, receipt, obligations, audit link and idempotency binding together.
/// </summary>
public sealed class PostgresArticlePropertyDefinitionPersistence(
    ISqlSugarClient db,
    IConfiguration configuration) : IArticlePropertyDefinitionPersistence
{
    private readonly byte[]? _tamperKey = AuditTamperEvidence.ResolveKey(configuration);

    private const string DefinitionColumns =
        "schema_version, definition_id, owner_user_id, site_scope, machine_key, value_type, cardinality, required, "
        + "missing_behavior, null_behavior, empty_behavior, default_kind, default_scalar, default_option_ids, "
        + "default_article_ids, min_length, max_length, min_number, max_number, min_date_utc_ticks, max_date_utc_ticks, "
        + "min_items, max_items, reference_cardinality, reference_permission, allow_cross_site, allow_deleted, "
        + "allow_archived, allow_self_reference, allow_cycles, url_allowed_schemes, url_allow_relative, "
        + "url_allow_absolute, url_max_length, url_normalization, search_eligible, filterable, sortable, "
        + "display_placement, visibility_scope, status, schema_revision, created_at_utc, updated_at_utc, content_digest";

    public async Task<ArticlePropertyDefinition?> GetAsync(
        ArticlePropertyDefinitionOwner owner,
        Guid definitionId,
        CancellationToken cancellationToken = default)
    {
        ArticlePropertyDefinitionContract.ValidateOwner(owner);
        if (definitionId == Guid.Empty)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_definition_id_invalid");
        }

        return await ReadDefinitionAsync(owner, definitionId, cancellationToken).ConfigureAwait(false);
    }

    public async Task<ArticlePropertyDefinitionPage> ListAsync(
        ArticlePropertyDefinitionOwner owner,
        ArticlePropertyDefinitionPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default)
    {
        ArticlePropertyDefinitionContract.ValidateOwner(owner);
        if (limit is < 1 or > ArticlePropertyDefinitionContract.MaxPageSize)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_page_limit_invalid");
        }

        string cursorPredicate = cursor is null
            ? string.Empty
            : "AND (machine_key, definition_id) > (@CursorMachineKey, @CursorDefinitionId)";
        var parameters = DefinitionParameters(
            owner,
            new SugarParameter("@Limit", limit + 1));
        if (cursor is not null)
        {
            parameters =
            [
                .. parameters,
                new SugarParameter("@CursorMachineKey", cursor.MachineKey),
                new SugarParameter("@CursorDefinitionId", cursor.DefinitionId)
            ];
        }

        var rows = new List<DefinitionRow>(limit + 1);
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                   $"""
                   SELECT {DefinitionColumns}
                   FROM article_property_definition
                   WHERE owner_user_id = @OwnerUserId
                     AND site_scope = @SiteScope
                     AND status <> 2
                     {cursorPredicate}
                   ORDER BY machine_key, definition_id
                   LIMIT @Limit;
                   """,
                   parameters).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                rows.Add(ReadDefinitionRow(reader));
            }
        }

        // Hydrate child rows only after the parent reader is closed. Npgsql does not
        // allow another command on the same connection while a data reader is active.
        var definitions = new List<ArticlePropertyDefinition>(rows.Count);
        foreach (DefinitionRow row in rows)
        {
            definitions.Add(await HydrateDefinitionAsync(row, cancellationToken).ConfigureAwait(false));
        }

        bool hasMore = definitions.Count > limit;
        if (hasMore)
        {
            definitions.RemoveAt(definitions.Count - 1);
        }
        ArticlePropertyDefinition? last = definitions.LastOrDefault();
        long revision = await ReadOwnerRevisionAsync(owner).ConfigureAwait(false);
        return new(
            Array.AsReadOnly(definitions.ToArray()),
            hasMore && last is not null
                ? new(last.MachineKey, last.DefinitionId)
                : null,
            revision);
    }

    public async Task<ArticlePropertyDefinitionWriteReceipt> ExecuteAsync(
        ArticlePropertyDefinitionOwner owner,
        long actorAdminPrincipalId,
        Guid requestId,
        string commandDigest,
        Guid definitionId,
        ArticlePropertyDefinitionRecordedCommand command,
        Func<ArticlePropertyDefinitionMutationSnapshot, CancellationToken, Task<ArticlePropertyDefinitionMutation>> planner,
        CancellationToken cancellationToken = default)
    {
        ArticlePropertyDefinitionContract.ValidateOwner(owner);
        ArticlePropertyDefinitionContract.ValidateRequestId(requestId);
        if (actorAdminPrincipalId <= 0 || definitionId == Guid.Empty)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_execute_identity_invalid");
        }
        ArgumentNullException.ThrowIfNull(planner);
        ArticlePropertyDefinitionCommandHistory.Validate(command);
        if (command.Owner != owner || command.Actor.AdminPrincipalId != actorAdminPrincipalId
            || command.RequestId != requestId || command.DefinitionId != definitionId)
        {
            throw new ArticlePropertyDefinitionIntegrityException("article_property_history_command_identity_invalid");
        }
        if (_tamperKey is null)
        {
            throw new ArticlePropertyDefinitionIntegrityException("article_property_history_audit_key_missing");
        }

        ArticlePropertyDefinitionWriteReceipt? result = null;
        var pendingChainIds = new List<string>(1);
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            _ = await db.Ado.GetScalarAsync(
                "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2442));",
                new SugarParameter("@Identity", OwnerIdentity(owner))).ConfigureAwait(false);
            _ = await db.Ado.GetScalarAsync(
                "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2443));",
                new SugarParameter("@Identity", $"article-property-definition-id:{definitionId:D}")).ConfigureAwait(false);

            IdempotencyRow? replay = await ReadIdempotencyAsync(
                actorAdminPrincipalId,
                requestId,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                if (!string.Equals(replay.CommandDigest, commandDigest, StringComparison.Ordinal))
                {
                    throw new ArticlePropertyDefinitionConflictException("article_property_idempotency_conflict");
                }
                long storedRevision;
                using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                    "SELECT owner_revision FROM article_property_definition_receipt WHERE receipt_id = @ReceiptId;",
                    new SugarParameter("@ReceiptId", replay.ReceiptId)).ConfigureAwait(false))
                {
                    if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        throw new ArticlePropertyDefinitionIntegrityException("article_property_idempotency_receipt_missing");
                    }
                    storedRevision = reader.GetInt64(0);
                }
                ArticlePropertyDefinitionJournalEntry evidence = await ReadAuthenticatedJournalEntryAsync(
                    owner, storedRevision, cancellationToken).ConfigureAwait(false);
                ArticlePropertyDefinitionWriteReceipt stored = evidence.Receipt;
                if (stored.Owner != owner || stored.DefinitionId != definitionId
                    || stored.ReceiptId != replay.ReceiptId || stored.CommandDigest != commandDigest)
                {
                    throw new ArticlePropertyDefinitionIntegrityException("article_property_idempotency_history_invalid");
                }
                result = stored with
                {
                    IsIdempotentReplay = true
                };
                return;
            }

            ArticlePropertyDefinitionOwner? existingOwner = await ReadDefinitionOwnerAsync(
                definitionId,
                cancellationToken).ConfigureAwait(false);
            if (existingOwner.HasValue && existingOwner.Value != owner)
            {
                throw new ArticlePropertyDefinitionConflictException("article_property_definition_owner_conflict");
            }

            await EnsureOwnerAsync(owner).ConfigureAwait(false);
            long ownerRevision = await ReadOwnerRevisionAsync(owner).ConfigureAwait(false);
            HistoryHead? history = await ReadHistoryHeadAsync(owner, cancellationToken).ConfigureAwait(false);
            if (history is null)
            {
                await CreateEmptyHistoryAsync(owner, ownerRevision, cancellationToken).ConfigureAwait(false);
                string genesis = ArticlePropertyDefinitionCommandHistory.ComputeGenesisDigest(owner);
                history = new(ArticlePropertyDefinitionCommandHistory.Version, genesis, 0, genesis);
            }
            if (history.Version != ArticlePropertyDefinitionCommandHistory.Version
                || history.Revision != ownerRevision
                || history.GenesisDigest != ArticlePropertyDefinitionCommandHistory.ComputeGenesisDigest(owner))
            {
                throw new ArticlePropertyDefinitionIntegrityException("article_property_history_head_invalid");
            }
            if (ownerRevision == 0)
            {
                await EnsureEmptyHistoryStateAsync(owner, ownerRevision, cancellationToken).ConfigureAwait(false);
                if (history.HeadDigest != history.GenesisDigest)
                {
                    throw new ArticlePropertyDefinitionIntegrityException("article_property_history_empty_head_invalid");
                }
            }
            if (ownerRevision > 0)
            {
                // Authenticate the real journal head; do not turn the independent full
                // verification resource/history limit into a new mutation-history cap.
                ArticlePropertyDefinitionJournalEntry tail = await ReadAuthenticatedJournalEntryAsync(
                    owner, ownerRevision, cancellationToken).ConfigureAwait(false);
                if (tail.ContentDigest != history.HeadDigest)
                {
                    throw new ArticlePropertyDefinitionIntegrityException("article_property_history_authenticated_head_invalid");
                }
            }
            IReadOnlyList<ArticlePropertyDefinition> definitions = await ReadOwnerDefinitionsAsync(
                owner,
                cancellationToken).ConfigureAwait(false);
            ArticlePropertyDefinition? target = await ReadDefinitionAsync(
                owner,
                definitionId,
                cancellationToken).ConfigureAwait(false);
            ArticlePropertyDefinitionMutationSnapshot snapshot = new(
                owner,
                ownerRevision,
                definitions,
                target);
            ArticlePropertyDefinitionMutation mutation = await planner(snapshot, cancellationToken).ConfigureAwait(false);
            ValidateMutation(snapshot, mutation, definitionId);
            if (command.ExpectedOwnerRevision != snapshot.OwnerRevision
                || command.ExpectedSchemaRevision != (snapshot.TargetDefinition?.SchemaRevision ?? 0)
                || command.CommandKind != mutation.Receipt.CommandKind
                || mutation.Receipt.CommandDigest != commandDigest
                || mutation.Receipt.ActorAdminPrincipalId != actorAdminPrincipalId
                || mutation.Receipt.RequestId != requestId
                || mutation.Impact is null
                || mutation.Impact.AffectedValueCount is < 0
                || ArticlePropertyDefinitionContract.ComputeObligationsDigest(mutation.Impact.Obligations)
                    != ArticlePropertyDefinitionContract.ComputeObligationsDigest(mutation.Receipt.Obligations))
            {
                throw new ArticlePropertyDefinitionIntegrityException("article_property_history_mutation_invalid");
            }
            var entry = new ArticlePropertyDefinitionJournalEntry(
                ArticlePropertyDefinitionCommandHistory.Version, owner, mutation.Receipt.OwnerRevision,
                history.HeadDigest, command, mutation.Impact, mutation.Receipt, string.Empty);
            entry = entry with
            {
                ContentDigest = ArticlePropertyDefinitionCommandHistory.ComputeEntryDigest(entry)
            };

            int ownerRows = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE article_property_definition_owner
                SET revision = @OwnerRevision
                WHERE owner_user_id = @OwnerUserId
                  AND site_scope = @SiteScope
                  AND revision = @ExpectedOwnerRevision;
                """,
                new SugarParameter("@OwnerRevision", mutation.Receipt.OwnerRevision),
                new SugarParameter("@OwnerUserId", OwnerUserKey(owner)),
                new SugarParameter("@SiteScope", owner.SiteScope),
                new SugarParameter("@ExpectedOwnerRevision", mutation.ExpectedOwnerRevision))
                .ConfigureAwait(false);
            if (ownerRows != 1)
            {
                throw new ArticlePropertyDefinitionConflictException("article_property_owner_revision_cas_stale");
            }

            if (mutation.PreviousDefinition is null)
            {
                await InsertDefinitionAsync(mutation.Definition).ConfigureAwait(false);
            }
            else
            {
                await UpdateDefinitionAsync(mutation.Definition).ConfigureAwait(false);
            }
            await ReplaceDisplayNamesAsync(mutation.Definition).ConfigureAwait(false);
            await ReplaceOptionsAsync(mutation.Definition).ConfigureAwait(false);
            await InsertReceiptAsync(mutation.Receipt).ConfigureAwait(false);
            foreach ((ArticlePropertyDefinitionObligation obligation, int index) in mutation.Receipt.Obligations
                         .Select((obligation, index) => (obligation, index)))
            {
                await InsertObligationAsync(mutation.Receipt.ReceiptId, index, obligation).ConfigureAwait(false);
            }

            AuthoringSignedAuditWriter.ChainWrite auditWrite = await AuthoringSignedAuditWriter.InsertAsync(
                db,
                _tamperKey,
                BuildAuditRecord(mutation.Receipt) with
                {
                    EventInfo = ArticlePropertyDefinitionCommandHistory.ComputeAuditEventInfo(entry)
                },
                cancellationToken).ConfigureAwait(false);
            pendingChainIds.Add(auditWrite.ChainId);
            await InsertJournalEntryAsync(entry).ConfigureAwait(false);
            int historyRows = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE article_property_definition_history
                SET revision = @Sequence, head_digest = @ContentDigest
                WHERE owner_user_id = @OwnerUserId AND site_scope = @SiteScope
                  AND revision = @PreviousRevision AND head_digest = @PreviousDigest;
                """,
                DefinitionParameters(owner,
                    new SugarParameter("@Sequence", entry.Sequence),
                    new SugarParameter("@ContentDigest", entry.ContentDigest),
                    new SugarParameter("@PreviousRevision", snapshot.OwnerRevision),
                    new SugarParameter("@PreviousDigest", entry.PreviousDigest))).ConfigureAwait(false);
            if (historyRows != 1)
            {
                throw new ArticlePropertyDefinitionIntegrityException("article_property_history_head_cas_invalid");
            }
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO article_property_definition_idempotency(
                    actor_admin_principal_id, request_id, command_digest, receipt_id, created_at_utc)
                VALUES (@ActorAdminPrincipalId, @RequestId, @CommandDigest, @ReceiptId, @CreatedAtUtc);
                """,
                new SugarParameter("@ActorAdminPrincipalId", actorAdminPrincipalId),
                new SugarParameter("@RequestId", requestId),
                new SugarParameter("@CommandDigest", commandDigest),
                new SugarParameter("@ReceiptId", mutation.Receipt.ReceiptId),
                new SugarParameter("@CreatedAtUtc", mutation.Receipt.OccurredAtUtc)).ConfigureAwait(false);
            result = mutation.Receipt;
        }).ConfigureAwait(false);

        if (!transaction.IsSuccess)
        {
            if (transaction.ErrorException is not null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo
                    .Capture(transaction.ErrorException)
                    .Throw();
            }
            throw new InvalidOperationException("article_property_definition_transaction_failed");
        }
        foreach (string chainId in pendingChainIds)
        {
            AuditLogStore.InvalidateChainTail(chainId);
        }
        return result ?? throw new ArticlePropertyDefinitionIntegrityException(
            "article_property_definition_transaction_result_missing");
    }

    public async Task<ArticlePropertyDefinitionVerificationSnapshot?> ReadVerificationSnapshotAsync(
        ArticlePropertyDefinitionOwner owner,
        Guid definitionId,
        int receiptLimit,
        CancellationToken cancellationToken = default)
    {
        ArticlePropertyDefinitionContract.ValidateOwner(owner);
        if (db.Ado.Transaction is not null)
        {
            // An ambient transaction may already have taken a weaker snapshot.
            // Do not change its isolation or pretend that its earlier reads were admitted.
            throw new ArticlePropertyDefinitionIntegrityException("article_property_verification_requires_fresh_transaction");
        }
        ArticlePropertyDefinitionVerificationSnapshot? result = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            // Set isolation before the first SELECT (including the advisory lock).
            // Admission and all hydration must observe the same as-of snapshot,
            // even when an unrelated SQL writer does not take the owner lock.
            await db.Ado.ExecuteCommandAsync("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;")
                .ConfigureAwait(false);
            _ = await db.Ado.GetScalarAsync(
                "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2442));",
                new SugarParameter("@Identity", OwnerIdentity(owner))).ConfigureAwait(false);
            result = await ReadVerificationSnapshotCoreAsync(owner, definitionId, receiptLimit, cancellationToken)
                .ConfigureAwait(false);
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            if (transaction.ErrorException is not null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(transaction.ErrorException).Throw();
            }
            throw new ArticlePropertyDefinitionIntegrityException("article_property_verification_snapshot_failed");
        }
        return result;
    }

    private async Task<ArticlePropertyDefinitionVerificationSnapshot?> ReadVerificationSnapshotCoreAsync(
        ArticlePropertyDefinitionOwner owner,
        Guid definitionId,
        int receiptLimit,
        CancellationToken cancellationToken)
    {
        ArticlePropertyDefinitionContract.ValidateOwner(owner);
        if (definitionId == Guid.Empty)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_definition_id_invalid");
        }
        if (receiptLimit is < 1 or > ArticlePropertyDefinitionContract.MaxVerificationReceipts)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_receipt_limit_invalid");
        }
        await EnsureVerificationReadAdmissionAsync(owner, definitionId, receiptLimit, cancellationToken).ConfigureAwait(false);
        ArticlePropertyDefinition? definition = await ReadDefinitionAsync(owner, definitionId, cancellationToken)
            .ConfigureAwait(false);
        if (definition is null)
        {
            return null;
        }

        IReadOnlyList<ArticlePropertyDefinitionWriteReceipt> receipts = await ReadReceiptsAsync(
            definitionId,
            receiptLimit + 1,
            cancellationToken).ConfigureAwait(false);
        bool receiptLimitExceeded = receipts.Count > receiptLimit;
        var receiptList = receipts.ToList();
        if (receiptLimitExceeded)
        {
            receiptList.RemoveAt(receiptList.Count - 1);
        }
        IReadOnlyList<ArticlePropertyDefinitionIdempotencyRecord> idempotency = await ReadIdempotencyForDefinitionAsync(
            definitionId,
            receiptLimit + 1,
            cancellationToken).ConfigureAwait(false);
        IReadOnlyList<ArticlePropertyDefinitionAuditLink> auditLinks = await ReadAuditLinksAsync(
            receiptList.Select(static receipt => receipt.AuditReference),
            cancellationToken).ConfigureAwait(false);
        ArticlePropertyDefinitionReplaySnapshot? replay = await ReadReplaySnapshotAsync(owner, receiptLimit, cancellationToken)
            .ConfigureAwait(false);
        return new(
            definition,
            Array.AsReadOnly(receiptList.ToArray()),
            idempotency,
            auditLinks,
            receiptLimitExceeded || idempotency.Count > receiptLimit,
            replay);
    }

    private async Task<HistoryHead?> ReadHistoryHeadAsync(
        ArticlePropertyDefinitionOwner owner,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT history_version, genesis_digest, revision, head_digest
            FROM article_property_definition_history
            WHERE owner_user_id = @OwnerUserId AND site_scope = @SiteScope;
            """, DefinitionParameters(owner)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? new(reader.GetInt32(0), reader.GetString(1), reader.GetInt64(2), reader.GetString(3))
            : null;
    }

    private async Task CreateEmptyHistoryAsync(
        ArticlePropertyDefinitionOwner owner,
        long ownerRevision,
        CancellationToken cancellationToken)
    {
        await EnsureEmptyHistoryStateAsync(owner, ownerRevision, cancellationToken).ConfigureAwait(false);
        string genesis = ArticlePropertyDefinitionCommandHistory.ComputeGenesisDigest(owner);
        _ = await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_property_definition_history(
                owner_user_id, site_scope, history_version, genesis_digest, revision, head_digest)
            VALUES (@OwnerUserId, @SiteScope, @Version, @GenesisDigest, 0, @GenesisDigest);
            """, DefinitionParameters(owner,
                new SugarParameter("@Version", ArticlePropertyDefinitionCommandHistory.Version),
                new SugarParameter("@GenesisDigest", genesis))).ConfigureAwait(false);
    }

    private async Task EnsureEmptyHistoryStateAsync(
        ArticlePropertyDefinitionOwner owner,
        long ownerRevision,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        object occupied = await db.Ado.GetScalarAsync(
            """
            SELECT EXISTS(SELECT 1 FROM article_property_definition
                          WHERE owner_user_id = @OwnerUserId AND site_scope = @SiteScope)
                OR EXISTS(SELECT 1 FROM article_property_definition_receipt
                          WHERE owner_user_id = @OwnerUserId AND site_scope = @SiteScope)
                OR EXISTS(SELECT 1 FROM article_property_definition_command
                          WHERE owner_user_id = @OwnerUserId AND site_scope = @SiteScope);
            """, DefinitionParameters(owner)).ConfigureAwait(false);
        if (ownerRevision != 0 || Convert.ToBoolean(occupied, CultureInfo.InvariantCulture))
        {
            throw new ArticlePropertyDefinitionIntegrityException("article_property_history_unavailable");
        }
    }

    private async Task InsertJournalEntryAsync(ArticlePropertyDefinitionJournalEntry entry)
    {
        _ = await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_property_definition_command(
                owner_user_id, site_scope, sequence, history_version, command_kind,
                definition_id, receipt_id, actor_admin_principal_id, request_id,
                command_payload, affected_value_count, previous_digest, content_digest)
            VALUES (@OwnerUserId, @SiteScope, @Sequence, @Version, @CommandKind,
                @DefinitionId, @ReceiptId, @ActorId, @RequestId,
                @Payload, @AffectedCount, @PreviousDigest, @ContentDigest);
            """, DefinitionParameters(entry.Owner,
                new SugarParameter("@Sequence", entry.Sequence),
                new SugarParameter("@Version", entry.HistoryVersion),
                new SugarParameter("@CommandKind", entry.Command.CommandKind),
                new SugarParameter("@DefinitionId", entry.Command.DefinitionId),
                new SugarParameter("@ReceiptId", entry.Receipt.ReceiptId),
                new SugarParameter("@ActorId", entry.Command.Actor.AdminPrincipalId),
                new SugarParameter("@RequestId", entry.Command.RequestId),
                new SugarParameter("@Payload", ArticlePropertyDefinitionCommandHistory.Encode(entry.Command), System.Data.DbType.Binary),
                NullableInt64Parameter("@AffectedCount", entry.Impact.AffectedValueCount),
                new SugarParameter("@PreviousDigest", entry.PreviousDigest),
                new SugarParameter("@ContentDigest", entry.ContentDigest))).ConfigureAwait(false);
    }

    private async Task<ArticlePropertyDefinitionJournalEntry> ReadAuthenticatedJournalEntryAsync(
        ArticlePropertyDefinitionOwner owner,
        long sequence,
        CancellationToken cancellationToken)
    {
        SugarParameter[] parameters = DefinitionParameters(owner, new SugarParameter("@Sequence", sequence));
        using (DbDataReader admission = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            WITH selected AS (SELECT * FROM article_property_definition_command
                WHERE owner_user_id = @OwnerUserId AND site_scope = @SiteScope AND sequence = @Sequence)
            SELECT (SELECT count(*) FROM selected),
                coalesce((SELECT sum(4096::bigint + 8::bigint * octet_length(command_payload)) FROM selected), 0)
                + coalesce((SELECT sum(256::bigint + 4::bigint * octet_length(o.kind || o.reason_code))
                    FROM article_property_definition_obligation o INNER JOIN selected s ON s.receipt_id = o.receipt_id), 0);
            """, parameters).ConfigureAwait(false))
        {
            if (!await admission.ReadAsync(cancellationToken).ConfigureAwait(false) || admission.GetInt64(0) != 1
                || admission.GetDecimal(1) > ArticlePropertyDefinitionContract.MaxVerificationResourceBytes)
            {
                throw new ArticlePropertyDefinitionIntegrityException("article_property_history_entry_unavailable");
            }
        }
        JournalRow row;
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT history_version, sequence, previous_digest, command_payload, affected_value_count,
                   receipt_id, content_digest, command_kind, definition_id, actor_admin_principal_id, request_id
            FROM article_property_definition_command
            WHERE owner_user_id = @OwnerUserId AND site_scope = @SiteScope AND sequence = @Sequence;
            """, parameters).ConfigureAwait(false))
        {
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new ArticlePropertyDefinitionIntegrityException("article_property_history_entry_unavailable");
            }
            row = new(reader.GetInt32(0), reader.GetInt64(1), reader.GetString(2), reader.GetFieldValue<byte[]>(3),
                reader.IsDBNull(4) ? null : reader.GetInt64(4), reader.GetGuid(5), reader.GetString(6),
                reader.GetString(7), reader.GetGuid(8), reader.GetInt64(9), reader.GetGuid(10));
        }
        ArticlePropertyDefinitionRecordedCommand command = ArticlePropertyDefinitionCommandHistory.Decode(row.Payload);
        ArticlePropertyDefinitionWriteReceipt receipt = await ReadReceiptAsync(row.ReceiptId, cancellationToken).ConfigureAwait(false)
            ?? throw new ArticlePropertyDefinitionIntegrityException("article_property_history_receipt_missing");
        var entry = new ArticlePropertyDefinitionJournalEntry(row.Version, owner, row.Sequence, row.PreviousDigest,
            command, new(row.AffectedCount, receipt.Obligations), receipt, row.ContentDigest);
        if (command.Owner != owner || receipt.Owner != owner || command.CommandKind != row.CommandKind
            || command.DefinitionId != row.DefinitionId || command.Actor.AdminPrincipalId != row.ActorId
            || command.RequestId != row.RequestId || receipt.OwnerRevision != sequence
            || receipt.ActorAdminPrincipalId != row.ActorId || receipt.RequestId != row.RequestId
            || receipt.DefinitionId != row.DefinitionId || receipt.CommandKind != row.CommandKind
            || entry.ContentDigest != ArticlePropertyDefinitionCommandHistory.ComputeEntryDigest(entry))
        {
            throw new ArticlePropertyDefinitionIntegrityException("article_property_history_entry_binding_invalid");
        }
        const string PointSql = """
            WITH matched AS (SELECT * FROM sys_audit_log
                WHERE target_type = 'article-property-definition-receipt' AND target_id = @Reference),
            point_ids AS (
                SELECT id FROM matched
                UNION SELECT p.id FROM matched m CROSS JOIN LATERAL (
                    SELECT id FROM sys_audit_log
                    WHERE chain_id = m.chain_id AND id < m.id ORDER BY id DESC LIMIT 1) p)
            """;
        SugarParameter[] auditParameters = [new("@Reference", receipt.AuditReference.ToString("N"))];
        using (DbDataReader admission = (DbDataReader)await db.Ado.GetDataReaderAsync(
            PointSql + """
            SELECT (SELECT count(*) FROM matched), coalesce(sum(8192::bigint + 8::bigint * (
                octet_length(a.event_info) + coalesce(octet_length(a.context_json), 0)
                + coalesce(octet_length(a.context_payload), 0))), 0)
            FROM sys_audit_log a INNER JOIN point_ids p ON p.id = a.id;
            """, auditParameters).ConfigureAwait(false))
        {
            if (!await admission.ReadAsync(cancellationToken).ConfigureAwait(false) || admission.GetInt64(0) != 1
                || admission.GetDecimal(1) > ArticlePropertyDefinitionContract.MaxVerificationResourceBytes)
            {
                throw new ArticlePropertyDefinitionIntegrityException("article_property_history_audit_point_unavailable");
            }
        }
        IReadOnlyList<AuditLog> records = await ReadAuditRowsAsync(
            PointSql + "SELECT a.* FROM sys_audit_log a INNER JOIN point_ids p ON p.id = a.id ORDER BY a.id;",
            auditParameters, cancellationToken).ConfigureAwait(false);
        AuditLog[] matched = records.Where(record => record.TargetType == "article-property-definition-receipt"
            && record.TargetId == receipt.AuditReference.ToString("N")).ToArray();
        if (matched.Length != 1)
        {
            throw new ArticlePropertyDefinitionIntegrityException("article_property_history_audit_point_unavailable");
        }
        AuditLog actual = matched[0];
        AuditLog[] predecessors = records.Where(record => record.Id < actual.Id).ToArray();
        if (predecessors.Length > 1)
        {
            throw new ArticlePropertyDefinitionIntegrityException("article_property_history_audit_point_unavailable");
        }
        AuditLog? previous = predecessors.FirstOrDefault();
        if (!AuditTamperEvidence.VerifyDetailed(actual, _tamperKey, previous?.RecordHash).IsValid
            || previous is null && !string.IsNullOrEmpty(actual.PrevHash)
            || previous is not null && (previous.ChainId != actual.ChainId || !AuditTamperEvidence.Verify(previous, _tamperKey))
            || actual.EventInfo != ArticlePropertyDefinitionCommandHistory.ComputeAuditEventInfo(entry)
            || actual.ActorId != row.ActorId.ToString(CultureInfo.InvariantCulture)
            || actual.ActorType != AuditActorTypeCatalog.Admin || actual.Action != AdminPermissions.ArticleWrite
            || actual.Outcome != AuditOutcomeCatalog.Success || !actual.IsHighValue
            || actual.ReasonCode != row.CommandKind || actual.OccurredAtUtc != receipt.OccurredAtUtc)
        {
            throw new ArticlePropertyDefinitionIntegrityException("article_property_history_authenticated_entry_invalid");
        }
        return entry;
    }

    private async Task<ArticlePropertyDefinitionReplaySnapshot?> ReadReplaySnapshotAsync(
        ArticlePropertyDefinitionOwner owner,
        int limit,
        CancellationToken cancellationToken)
    {
        HistoryHead? head = await ReadHistoryHeadAsync(owner, cancellationToken).ConfigureAwait(false);
        if (head is null)
        {
            return null;
        }
        var rows = new List<JournalRow>();
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT history_version, sequence, previous_digest, command_payload,
                   affected_value_count, receipt_id, content_digest,
                   command_kind, definition_id, actor_admin_principal_id, request_id
            FROM article_property_definition_command
            WHERE owner_user_id = @OwnerUserId AND site_scope = @SiteScope
            ORDER BY sequence LIMIT @Limit;
            """, DefinitionParameters(owner, new SugarParameter("@Limit", limit + 1))).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                rows.Add(new(reader.GetInt32(0), reader.GetInt64(1), reader.GetString(2),
                    reader.GetFieldValue<byte[]>(3), reader.IsDBNull(4) ? null : reader.GetInt64(4),
                    reader.GetGuid(5), reader.GetString(6), reader.GetString(7), reader.GetGuid(8),
                    reader.GetInt64(9), reader.GetGuid(10)));
            }
        }
        bool exceeded = rows.Count > limit;
        if (exceeded)
        {
            rows.RemoveAt(rows.Count - 1);
        }
        var entries = new List<ArticlePropertyDefinitionJournalEntry>(rows.Count);
        foreach (JournalRow row in rows)
        {
            ArticlePropertyDefinitionRecordedCommand command = ArticlePropertyDefinitionCommandHistory.Decode(row.Payload);
            ArticlePropertyDefinitionWriteReceipt receipt = await ReadReceiptAsync(row.ReceiptId, cancellationToken)
                .ConfigureAwait(false)
                ?? throw new ArticlePropertyDefinitionIntegrityException("article_property_history_receipt_missing");
            if (command.Owner != owner || command.DefinitionId != row.DefinitionId
                || command.Actor.AdminPrincipalId != row.ActorId || command.RequestId != row.RequestId
                || command.CommandKind != row.CommandKind)
            {
                throw new ArticlePropertyDefinitionIntegrityException("article_property_history_row_identity_invalid");
            }
            entries.Add(new(row.Version, owner, row.Sequence, row.PreviousDigest, command,
                new(row.AffectedCount, receipt.Obligations), receipt, row.ContentDigest));
        }
        var definitionRows = new List<DefinitionRow>();
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT {DefinitionColumns} FROM article_property_definition
            WHERE owner_user_id = @OwnerUserId AND site_scope = @SiteScope
            ORDER BY definition_id LIMIT @Limit;
            """, DefinitionParameters(owner, new SugarParameter("@Limit", limit + 1))).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                definitionRows.Add(ReadDefinitionRow(reader));
            }
        }
        exceeded |= definitionRows.Count > limit;
        var definitions = new List<ArticlePropertyDefinition>(Math.Min(limit, definitionRows.Count));
        foreach (DefinitionRow row in definitionRows.Take(limit))
        {
            definitions.Add(await HydrateDefinitionAsync(row, cancellationToken).ConfigureAwait(false));
        }
        var bindings = new List<ArticlePropertyDefinitionIdempotencyRecord>();
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT i.actor_admin_principal_id, i.request_id, i.command_digest, i.receipt_id
            FROM article_property_definition_idempotency i
            INNER JOIN article_property_definition_receipt r ON r.receipt_id = i.receipt_id
            WHERE r.owner_user_id = @OwnerUserId AND r.site_scope = @SiteScope
            ORDER BY r.owner_revision LIMIT @Limit;
            """, DefinitionParameters(owner, new SugarParameter("@Limit", limit + 1))).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                bindings.Add(new(reader.GetInt64(0), reader.GetGuid(1), reader.GetString(2), reader.GetGuid(3)));
            }
        }
        exceeded |= bindings.Count > limit;
        IReadOnlyList<AuditLog> audit = await ReadReplayAuditRecordsAsync(
            entries.Select(static entry => entry.Receipt.AuditReference), limit + 1, cancellationToken).ConfigureAwait(false);
        return new(head.Version, owner, await ReadOwnerRevisionAsync(owner).ConfigureAwait(false),
            head.GenesisDigest, head.HeadDigest, Array.AsReadOnly(definitions.ToArray()),
            Array.AsReadOnly(entries.ToArray()), Array.AsReadOnly(bindings.Take(limit).ToArray()),
            Array.AsReadOnly(audit.Take(limit).ToArray()), exceeded || head.Revision != entries.Count,
            audit.Count > limit);
    }

    private async Task<IReadOnlyList<AuditLog>> ReadReplayAuditRecordsAsync(
        IEnumerable<Guid> references,
        int limit,
        CancellationToken cancellationToken)
    {
        string ids = "{" + string.Join(',', references.Distinct().Select(static id => id.ToString("N"))) + "}";
        return await ReadAuditRowsAsync(
            """
            WITH relevant AS (
                SELECT chain_id, max(id) AS last_id FROM sys_audit_log
                WHERE target_type = 'article-property-definition-receipt'
                  AND replace(target_id, '-', '') = ANY(CAST(@References AS text[]))
                GROUP BY chain_id)
            SELECT a.* FROM sys_audit_log a INNER JOIN relevant r ON r.chain_id = a.chain_id
            WHERE a.id <= r.last_id ORDER BY a.id LIMIT @Limit;
            """, [new SugarParameter("@References", ids), new SugarParameter("@Limit", limit)],
            cancellationToken).ConfigureAwait(false);
    }

    private async Task<IReadOnlyList<AuditLog>> ReadAuditRowsAsync(
        string query,
        SugarParameter[] parameters,
        CancellationToken cancellationToken)
    {
        var result = new List<AuditLog>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(query, parameters).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            result.Add(new AuditLog
            {
                Id = reader.GetInt64(reader.GetOrdinal("id")),
                Source = reader.GetString(reader.GetOrdinal("source")),
                Type = reader.GetString(reader.GetOrdinal("type")),
                OccurredAtUtc = DateTime.SpecifyKind(reader.GetDateTime(reader.GetOrdinal("occurred_at_utc")), DateTimeKind.Utc),
                ActorType = ReadNullableString(reader, "actor_type"),
                ActorId = ReadNullableString(reader, "actor_id"),
                ActorRole = ReadNullableString(reader, "actor_role"),
                Action = reader.GetString(reader.GetOrdinal("action")),
                TargetType = ReadNullableString(reader, "target_type"),
                TargetId = ReadNullableString(reader, "target_id"),
                Outcome = reader.GetString(reader.GetOrdinal("outcome")),
                Severity = reader.GetString(reader.GetOrdinal("severity")),
                IsHighValue = reader.GetBoolean(reader.GetOrdinal("is_high_value")),
                TraceId = ReadNullableString(reader, "trace_id"),
                RequestPath = ReadNullableString(reader, "request_path"),
                RequestMethod = ReadNullableString(reader, "request_method"),
                IpHash = ReadNullableString(reader, "ip_hash"),
                UserAgentHash = ReadNullableString(reader, "user_agent_hash"),
                SessionIdHash = ReadNullableString(reader, "session_id_hash"),
                DeviceFingerprintHash = ReadNullableString(reader, "device_fingerprint_hash"),
                ReasonCode = ReadNullableString(reader, "reason_code"),
                EventInfo = reader.GetString(reader.GetOrdinal("event_info")),
                ContextJson = ReadNullableString(reader, "context_json"),
                ContextPayload = reader.IsDBNull(reader.GetOrdinal("context_payload")) ? null : reader.GetFieldValue<byte[]>(reader.GetOrdinal("context_payload")),
                ChainId = ReadNullableString(reader, "chain_id"),
                PrevHash = ReadNullableString(reader, "prev_hash"),
                RecordHash = ReadNullableString(reader, "record_hash"),
                RecordMac = ReadNullableString(reader, "record_mac")
            });
        }
        return Array.AsReadOnly(result.ToArray());
    }

    private static string? ReadNullableString(DbDataReader reader, string name)
        => reader.IsDBNull(reader.GetOrdinal(name)) ? null : reader.GetString(reader.GetOrdinal(name));

    private async Task EnsureVerificationReadAdmissionAsync(
        ArticlePropertyDefinitionOwner owner,
        Guid definitionId,
        int limit,
        CancellationToken cancellationToken)
    {
        // Count and uncompressed octet lengths are calculated in SQL before any
        // payload, schema-child collection or audit row is loaded into this process.
        // Multipliers/fixed costs conservatively budget UTF-16, object/collection and
        // canonical codec copies; this is admission, not a managed-heap quota claim.
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            WITH definitions AS (
                SELECT * FROM article_property_definition
                WHERE owner_user_id = @OwnerUserId AND site_scope = @SiteScope),
            commands AS (
                SELECT * FROM article_property_definition_command
                WHERE owner_user_id = @OwnerUserId AND site_scope = @SiteScope),
            receipts AS (
                SELECT * FROM article_property_definition_receipt
                WHERE (owner_user_id = @OwnerUserId AND site_scope = @SiteScope)
                    OR definition_id = @DefinitionId
                    OR receipt_id IN (SELECT receipt_id FROM commands)),
            bindings AS (
                SELECT i.* FROM article_property_definition_idempotency i
                INNER JOIN receipts r ON r.receipt_id = i.receipt_id),
            audit_links AS (
                SELECT a.* FROM sys_audit_log a
                INNER JOIN receipts r ON replace(a.target_id, '-', '') = replace(CAST(r.audit_reference AS text), '-', '')
                WHERE a.target_type = 'article-property-definition-receipt'),
            chain_heads AS (
                SELECT chain_id, max(id) AS last_id FROM audit_links GROUP BY chain_id),
            audit_ids AS (
                SELECT id FROM audit_links
                UNION SELECT a.id FROM sys_audit_log a INNER JOIN chain_heads h ON h.chain_id = a.chain_id
                WHERE a.id <= h.last_id),
            audits AS (
                SELECT a.* FROM sys_audit_log a INNER JOIN audit_ids ids ON ids.id = a.id),
            costs AS (
                SELECT 2048::bigint + 4::bigint * octet_length(
                    machine_key || site_scope || coalesce(default_scalar, '') || default_option_ids
                    || default_article_ids || url_allowed_schemes
                    || coalesce(CAST(min_number AS text), '') || coalesce(CAST(max_number AS text), '')) AS bytes FROM definitions
                UNION ALL SELECT 256::bigint + 4::bigint * octet_length(n.locale || n.value)
                    FROM article_property_definition_display_name n INNER JOIN definitions d ON d.definition_id = n.definition_id
                UNION ALL SELECT 256::bigint + 4::bigint * octet_length(o.label)
                    FROM article_property_definition_option o INNER JOIN definitions d ON d.definition_id = o.definition_id
                UNION ALL SELECT 256::bigint + 4::bigint * octet_length(l.locale || l.value)
                    FROM article_property_definition_option_label l INNER JOIN definitions d ON d.definition_id = l.definition_id
                UNION ALL SELECT 4096::bigint + 8::bigint * octet_length(command_payload) FROM commands
                UNION ALL SELECT 2048::bigint + 4::bigint * octet_length(site_scope || command_kind || command_digest
                    || before_definition_digest || after_definition_digest || constraint_digest || options_digest
                    || policy_digest || flags_digest || audit_digest || content_digest) FROM receipts
                UNION ALL SELECT 256::bigint + 4::bigint * octet_length(o.kind || o.reason_code)
                    FROM article_property_definition_obligation o INNER JOIN receipts r ON r.receipt_id = o.receipt_id
                UNION ALL SELECT 256::bigint + 4::bigint * octet_length(command_digest) FROM bindings
                UNION ALL SELECT 2048::bigint + 4::bigint * octet_length(
                    source || type || action || outcome || severity || event_info
                    || coalesce(actor_type, '') || coalesce(actor_id, '') || coalesce(actor_role, '')
                    || coalesce(target_type, '') || coalesce(target_id, '') || coalesce(trace_id, '')
                    || coalesce(request_path, '') || coalesce(request_method, '') || coalesce(ip_hash, '')
                    || coalesce(user_agent_hash, '') || coalesce(session_id_hash, '')
                    || coalesce(device_fingerprint_hash, '') || coalesce(reason_code, '')
                    || coalesce(context_json, '') || coalesce(chain_id, '') || coalesce(prev_hash, '')
                    || coalesce(record_hash, '') || coalesce(record_mac, ''))
                    + 2::bigint * coalesce(octet_length(context_payload), 0) FROM audits)
            SELECT (SELECT count(*) FROM commands), (SELECT count(*) FROM definitions),
                   (SELECT count(*) FROM receipts), (SELECT count(*) FROM bindings),
                   (SELECT count(*) FROM audits), coalesce((SELECT sum(bytes) FROM costs), 0),
                   (SELECT count(*) FROM definitions WHERE status <> 2),
                   (SELECT count(*) FROM audit_links WHERE chain_id IS NULL
                       OR chain_id !~ '^[0-9]{8}$' OR chain_id <> to_char(occurred_at_utc, 'YYYYMMDD')),
                   (SELECT count(*) FROM receipts WHERE owner_user_id <> @OwnerUserId OR site_scope <> @SiteScope);
            """, DefinitionParameters(owner, new SugarParameter("@DefinitionId", definitionId))).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            || !CanReadVerificationEvidence(limit, Enumerable.Range(0, 5).Select(reader.GetInt64).ToArray(),
                reader.GetDecimal(5), reader.GetInt64(6), reader.GetInt64(7) != 0, reader.GetInt64(8) != 0))
        {
            throw new ArticlePropertyDefinitionBudgetExceededException("article_property_verification_resource_budget_exceeded");
        }
    }

    internal static bool CanReadVerificationEvidence(
        int limit,
        IReadOnlyList<long> counts,
        decimal resourceCost,
        long liveDefinitionCount,
        bool invalidAuditLink,
        bool foreignReceipt)
        => counts.Count == 5 && counts.All(count => count >= 0 && count <= limit)
            && resourceCost >= 0 && resourceCost <= ArticlePropertyDefinitionContract.MaxVerificationResourceBytes
            && liveDefinitionCount >= 0 && liveDefinitionCount <= ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner
            && !invalidAuditLink && !foreignReceipt;

    private async Task<ArticlePropertyDefinition?> ReadDefinitionAsync(
        ArticlePropertyDefinitionOwner owner,
        Guid definitionId,
        CancellationToken cancellationToken)
    {
        DefinitionRow? row;
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                   $"""
                   SELECT {DefinitionColumns}
                   FROM article_property_definition
                   WHERE owner_user_id = @OwnerUserId
                     AND site_scope = @SiteScope
                     AND definition_id = @DefinitionId;
                   """,
                   DefinitionParameters(
                       owner,
                       new SugarParameter("@DefinitionId", definitionId))).ConfigureAwait(false))
        {
            row = await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
                ? ReadDefinitionRow(reader)
                : null;
        }
        return row is null
            ? null
            : await HydrateDefinitionAsync(row, cancellationToken).ConfigureAwait(false);
    }

    private async Task<ArticlePropertyDefinitionOwner?> ReadDefinitionOwnerAsync(
        Guid definitionId,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT owner_user_id, site_scope
            FROM article_property_definition
            WHERE definition_id = @DefinitionId;
            """,
            new SugarParameter("@DefinitionId", definitionId)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        return new(
            reader.GetInt64(0) == 0 ? null : reader.GetInt64(0),
            reader.GetString(1));
    }

    private static DefinitionRow ReadDefinitionRow(DbDataReader reader)
    {
        ArticlePropertyDefinitionOwner owner = new(
            reader.GetInt64(reader.GetOrdinal("owner_user_id")) switch
            {
                0 => null,
                long value => value
            },
            reader.GetString(reader.GetOrdinal("site_scope")));
        return new DefinitionRow
        {
            SchemaVersion = reader.GetInt32(reader.GetOrdinal("schema_version")),
            DefinitionId = reader.GetGuid(reader.GetOrdinal("definition_id")),
            Owner = owner,
            MachineKey = reader.GetString(reader.GetOrdinal("machine_key")),
            ValueType = (ArticlePropertyValueType)reader.GetInt16(reader.GetOrdinal("value_type")),
            Cardinality = (ArticlePropertyCardinality)reader.GetInt16(reader.GetOrdinal("cardinality")),
            Required = reader.GetBoolean(reader.GetOrdinal("required")),
            MissingBehavior = (ArticlePropertyMissingBehavior)reader.GetInt16(reader.GetOrdinal("missing_behavior")),
            NullBehavior = (ArticlePropertyNullBehavior)reader.GetInt16(reader.GetOrdinal("null_behavior")),
            EmptyBehavior = (ArticlePropertyEmptyBehavior)reader.GetInt16(reader.GetOrdinal("empty_behavior")),
            DefaultKind = (ArticlePropertyDefaultKind)reader.GetInt16(reader.GetOrdinal("default_kind")),
            DefaultScalar = reader.IsDBNull(reader.GetOrdinal("default_scalar"))
                ? null
                : reader.GetString(reader.GetOrdinal("default_scalar")),
            DefaultOptionIds = reader.GetString(reader.GetOrdinal("default_option_ids")),
            DefaultArticleIds = reader.GetString(reader.GetOrdinal("default_article_ids")),
            MinLength = ReadNullableInt(reader, "min_length"),
            MaxLength = ReadNullableInt(reader, "max_length"),
            MinNumber = ReadNullableDecimal(reader, "min_number"),
            MaxNumber = ReadNullableDecimal(reader, "max_number"),
            MinDateUtc = ReadNullableUtcConstraintTicks(reader, "min_date_utc_ticks"),
            MaxDateUtc = ReadNullableUtcConstraintTicks(reader, "max_date_utc_ticks"),
            MinItems = ReadNullableInt(reader, "min_items"),
            MaxItems = ReadNullableInt(reader, "max_items"),
            ReferenceCardinality = ReadNullableShort(reader, "reference_cardinality"),
            ReferencePermission = ReadNullableShort(reader, "reference_permission"),
            AllowCrossSite = ReadNullableBool(reader, "allow_cross_site"),
            AllowDeleted = ReadNullableBool(reader, "allow_deleted"),
            AllowArchived = ReadNullableBool(reader, "allow_archived"),
            AllowSelfReference = ReadNullableBool(reader, "allow_self_reference"),
            AllowCycles = ReadNullableBool(reader, "allow_cycles"),
            UrlAllowedSchemes = reader.GetString(reader.GetOrdinal("url_allowed_schemes")),
            UrlAllowRelative = ReadNullableBool(reader, "url_allow_relative"),
            UrlAllowAbsolute = ReadNullableBool(reader, "url_allow_absolute"),
            UrlMaxLength = ReadNullableInt(reader, "url_max_length"),
            UrlNormalization = ReadNullableShort(reader, "url_normalization"),
            SearchEligible = reader.GetBoolean(reader.GetOrdinal("search_eligible")),
            Filterable = reader.GetBoolean(reader.GetOrdinal("filterable")),
            Sortable = reader.GetBoolean(reader.GetOrdinal("sortable")),
            DisplayPlacement = (ArticlePropertyDisplayPlacement)reader.GetInt16(reader.GetOrdinal("display_placement")),
            VisibilityScope = (ArticlePropertyVisibilityScope)reader.GetInt16(reader.GetOrdinal("visibility_scope")),
            Status = (ArticlePropertyDefinitionStatus)reader.GetInt16(reader.GetOrdinal("status")),
            SchemaRevision = reader.GetInt64(reader.GetOrdinal("schema_revision")),
            CreatedAtUtc = DateTime.SpecifyKind(reader.GetDateTime(reader.GetOrdinal("created_at_utc")), DateTimeKind.Utc),
            UpdatedAtUtc = DateTime.SpecifyKind(reader.GetDateTime(reader.GetOrdinal("updated_at_utc")), DateTimeKind.Utc),
            ContentDigest = reader.GetString(reader.GetOrdinal("content_digest"))
        };
    }

    private async Task<ArticlePropertyDefinition> HydrateDefinitionAsync(
        DefinitionRow row,
        CancellationToken cancellationToken)
    {
        IReadOnlyList<ArticlePropertyLocalizedName> names = await ReadDisplayNamesAsync(
            row.DefinitionId,
            cancellationToken).ConfigureAwait(false);
        IReadOnlyList<ArticlePropertyOption> options = await ReadOptionsAsync(
            row.DefinitionId,
            cancellationToken).ConfigureAwait(false);
        ArticlePropertyDefaultValue? defaultValue = ReadDefault(row);
        ArticlePropertyReferencePolicy? referencePolicy = ReadReferencePolicy(row);
        ArticlePropertyUrlPolicy? urlPolicy = ReadUrlPolicy(row);
        var definition = new ArticlePropertyDefinition(
            row.SchemaVersion,
            row.DefinitionId,
            row.Owner,
            row.MachineKey,
            names,
            row.ValueType,
            row.Cardinality,
            row.Required,
            new(
                row.MissingBehavior,
                row.NullBehavior,
                row.EmptyBehavior),
            defaultValue,
            new(
                row.MinLength,
                row.MaxLength,
                row.MinNumber,
                row.MaxNumber,
                row.MinDateUtc,
                row.MaxDateUtc,
                row.MinItems,
                row.MaxItems),
            options,
            referencePolicy,
            urlPolicy,
            row.SearchEligible,
            row.Filterable,
            row.Sortable,
            row.DisplayPlacement,
            row.VisibilityScope,
            row.Status,
            row.SchemaRevision,
            row.CreatedAtUtc,
            row.UpdatedAtUtc,
            row.ContentDigest);
        ArticlePropertyDefinitionContract.ValidateDefinition(definition);
        return definition;
    }

    private async Task<IReadOnlyList<ArticlePropertyDefinition>> ReadOwnerDefinitionsAsync(
        ArticlePropertyDefinitionOwner owner,
        CancellationToken cancellationToken)
    {
        var rows = new List<DefinitionRow>();
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                   $"""
                   SELECT {DefinitionColumns}
                   FROM article_property_definition
                   WHERE owner_user_id = @OwnerUserId
                     AND site_scope = @SiteScope
                     AND status <> 2
                   ORDER BY machine_key, definition_id
                   LIMIT @Limit;
                   """,
                   DefinitionParameters(owner,
                       new SugarParameter("@Limit", ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner + 1)))
                   .ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                rows.Add(ReadDefinitionRow(reader));
            }
        }
        if (rows.Count > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner)
        {
            throw new ArticlePropertyDefinitionBudgetExceededException("article_property_definition_budget_exceeded");
        }
        var result = new List<ArticlePropertyDefinition>(rows.Count);
        foreach (DefinitionRow row in rows)
        {
            result.Add(await HydrateDefinitionAsync(row, cancellationToken).ConfigureAwait(false));
        }
        return Array.AsReadOnly(result.ToArray());
    }

    private async Task<IReadOnlyList<ArticlePropertyLocalizedName>> ReadDisplayNamesAsync(
        Guid definitionId,
        CancellationToken cancellationToken)
    {
        var result = new List<ArticlePropertyLocalizedName>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT locale, value
            FROM article_property_definition_display_name
            WHERE definition_id = @DefinitionId
            ORDER BY locale;
            """,
            new SugarParameter("@DefinitionId", definitionId)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            result.Add(new(reader.GetString(0), reader.GetString(1)));
        }
        return Array.AsReadOnly(result.ToArray());
    }

    private async Task<IReadOnlyList<ArticlePropertyOption>> ReadOptionsAsync(
        Guid definitionId,
        CancellationToken cancellationToken)
    {
        var rows = new List<OptionRow>();
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                   """
                   SELECT option_id, label, option_order, status
                   FROM article_property_definition_option
                   WHERE definition_id = @DefinitionId
                   ORDER BY option_order, option_id;
                   """,
                   new SugarParameter("@DefinitionId", definitionId)).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                rows.Add(new(
                    reader.GetGuid(0),
                    reader.GetString(1),
                    reader.GetInt32(2),
                    (ArticlePropertyOptionStatus)reader.GetInt16(3)));
            }
        }
        var result = new List<ArticlePropertyOption>(rows.Count);
        foreach (OptionRow row in rows)
        {
            result.Add(new(
                row.OptionId,
                row.Label,
                row.Order,
                row.Status,
                await ReadOptionLabelsAsync(definitionId, row.OptionId, cancellationToken).ConfigureAwait(false)));
        }
        return Array.AsReadOnly(result.ToArray());
    }

    private async Task<IReadOnlyList<ArticlePropertyLocalizedName>> ReadOptionLabelsAsync(
        Guid definitionId,
        Guid optionId,
        CancellationToken cancellationToken)
    {
        var result = new List<ArticlePropertyLocalizedName>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT locale, value
            FROM article_property_definition_option_label
            WHERE definition_id = @DefinitionId AND option_id = @OptionId
            ORDER BY locale;
            """,
            new SugarParameter("@DefinitionId", definitionId),
            new SugarParameter("@OptionId", optionId)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            result.Add(new(reader.GetString(0), reader.GetString(1)));
        }
        return Array.AsReadOnly(result.ToArray());
    }

    private async Task<long> ReadOwnerRevisionAsync(ArticlePropertyDefinitionOwner owner)
    {
        object? value = await db.Ado.GetScalarAsync(
            """
            SELECT revision
            FROM article_property_definition_owner
            WHERE owner_user_id = @OwnerUserId AND site_scope = @SiteScope;
            """,
            new SugarParameter("@OwnerUserId", OwnerUserKey(owner)),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        return value is null or DBNull
            ? 0
            : Convert.ToInt64(value, CultureInfo.InvariantCulture);
    }

    private async Task EnsureOwnerAsync(ArticlePropertyDefinitionOwner owner)
        => await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_property_definition_owner(owner_user_id, site_scope, revision)
            VALUES (@OwnerUserId, @SiteScope, 0)
            ON CONFLICT (owner_user_id, site_scope) DO NOTHING;
            """,
            new SugarParameter("@OwnerUserId", OwnerUserKey(owner)),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);

    private async Task InsertDefinitionAsync(ArticlePropertyDefinition definition)
        => await db.Ado.ExecuteCommandAsync(
            $"""
            INSERT INTO article_property_definition({DefinitionColumns})
            VALUES (
                @SchemaVersion, @DefinitionId, @OwnerUserId, @SiteScope, @MachineKey, @ValueType, @Cardinality,
                @Required, @MissingBehavior, @NullBehavior, @EmptyBehavior, @DefaultKind, @DefaultScalar,
                @DefaultOptionIds, @DefaultArticleIds, @MinLength, @MaxLength, @MinNumber, @MaxNumber,
                @MinDateUtcTicks, @MaxDateUtcTicks, @MinItems, @MaxItems, @ReferenceCardinality, @ReferencePermission,
                @AllowCrossSite, @AllowDeleted, @AllowArchived, @AllowSelfReference, @AllowCycles,
                @UrlAllowedSchemes, @UrlAllowRelative, @UrlAllowAbsolute, @UrlMaxLength, @UrlNormalization,
                @SearchEligible, @Filterable, @Sortable, @DisplayPlacement, @VisibilityScope, @Status,
                @SchemaRevision, @CreatedAtUtc, @UpdatedAtUtc, @ContentDigest);
            """,
            DefinitionWriteParameters(definition)).ConfigureAwait(false);

    private async Task UpdateDefinitionAsync(ArticlePropertyDefinition definition)
        => await db.Ado.ExecuteCommandAsync(
            $"""
            UPDATE article_property_definition
            SET {string.Join(", ", DefinitionUpdateColumns())}
            WHERE definition_id = @DefinitionId
              AND owner_user_id = @OwnerUserId
              AND site_scope = @SiteScope;
            """,
            DefinitionWriteParameters(definition)).ConfigureAwait(false);

    private async Task ReplaceDisplayNamesAsync(ArticlePropertyDefinition definition)
    {
        await db.Ado.ExecuteCommandAsync(
            "DELETE FROM article_property_definition_display_name WHERE definition_id = @DefinitionId;",
            new SugarParameter("@DefinitionId", definition.DefinitionId)).ConfigureAwait(false);
        foreach (ArticlePropertyLocalizedName name in definition.DisplayNames)
        {
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO article_property_definition_display_name(definition_id, locale, value)
                VALUES (@DefinitionId, @Locale, @Value);
                """,
                new SugarParameter("@DefinitionId", definition.DefinitionId),
                new SugarParameter("@Locale", name.Locale),
                new SugarParameter("@Value", name.Value)).ConfigureAwait(false);
        }
    }

    private async Task ReplaceOptionsAsync(ArticlePropertyDefinition definition)
    {
        await db.Ado.ExecuteCommandAsync(
            "DELETE FROM article_property_definition_option_label WHERE definition_id = @DefinitionId;",
            new SugarParameter("@DefinitionId", definition.DefinitionId)).ConfigureAwait(false);
        await db.Ado.ExecuteCommandAsync(
            "DELETE FROM article_property_definition_option WHERE definition_id = @DefinitionId;",
            new SugarParameter("@DefinitionId", definition.DefinitionId)).ConfigureAwait(false);
        foreach (ArticlePropertyOption option in definition.Options)
        {
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO article_property_definition_option(definition_id, option_id, label, option_order, status)
                VALUES (@DefinitionId, @OptionId, @Label, @Order, @Status);
                """,
                new SugarParameter("@DefinitionId", definition.DefinitionId),
                new SugarParameter("@OptionId", option.OptionId),
                new SugarParameter("@Label", option.Label),
                new SugarParameter("@Order", option.Order),
                new SugarParameter("@Status", (short)option.Status)).ConfigureAwait(false);
            foreach (ArticlePropertyLocalizedName label in option.LocalizedLabels)
            {
                await db.Ado.ExecuteCommandAsync(
                    """
                    INSERT INTO article_property_definition_option_label(definition_id, option_id, locale, value)
                    VALUES (@DefinitionId, @OptionId, @Locale, @Value);
                    """,
                    new SugarParameter("@DefinitionId", definition.DefinitionId),
                    new SugarParameter("@OptionId", option.OptionId),
                    new SugarParameter("@Locale", label.Locale),
                    new SugarParameter("@Value", label.Value)).ConfigureAwait(false);
            }
        }
    }

    private async Task InsertReceiptAsync(ArticlePropertyDefinitionWriteReceipt receipt)
        => await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_property_definition_receipt(
                receipt_id, request_id, actor_admin_principal_id, owner_user_id, site_scope, command_kind,
                command_digest, definition_id, previous_owner_revision, owner_revision,
                previous_schema_revision, schema_revision, status, before_definition_digest,
                after_definition_digest, constraint_digest, options_digest, policy_digest, flags_digest,
                audit_reference, audit_digest, content_digest, occurred_at_utc)
            VALUES (
                @ReceiptId, @RequestId, @ActorAdminPrincipalId, @OwnerUserId, @SiteScope, @CommandKind,
                @CommandDigest, @DefinitionId, @PreviousOwnerRevision, @OwnerRevision,
                @PreviousSchemaRevision, @SchemaRevision, @Status, @BeforeDefinitionDigest,
                @AfterDefinitionDigest, @ConstraintDigest, @OptionsDigest, @PolicyDigest, @FlagsDigest,
                @AuditReference, @AuditDigest, @ContentDigest, @OccurredAtUtc);
            """,
            new SugarParameter("@ReceiptId", receipt.ReceiptId),
            new SugarParameter("@RequestId", receipt.RequestId),
            new SugarParameter("@ActorAdminPrincipalId", receipt.ActorAdminPrincipalId),
            new SugarParameter("@OwnerUserId", OwnerUserKey(receipt.Owner)),
            new SugarParameter("@SiteScope", receipt.Owner.SiteScope),
            new SugarParameter("@CommandKind", receipt.CommandKind),
            new SugarParameter("@CommandDigest", receipt.CommandDigest),
            new SugarParameter("@DefinitionId", receipt.DefinitionId),
            new SugarParameter("@PreviousOwnerRevision", receipt.PreviousOwnerRevision),
            new SugarParameter("@OwnerRevision", receipt.OwnerRevision),
            new SugarParameter("@PreviousSchemaRevision", receipt.PreviousSchemaRevision),
            new SugarParameter("@SchemaRevision", receipt.SchemaRevision),
            new SugarParameter("@Status", (short)receipt.Status),
            new SugarParameter("@BeforeDefinitionDigest", receipt.BeforeDefinitionDigest),
            new SugarParameter("@AfterDefinitionDigest", receipt.AfterDefinitionDigest),
            new SugarParameter("@ConstraintDigest", receipt.ConstraintDigest),
            new SugarParameter("@OptionsDigest", receipt.OptionsDigest),
            new SugarParameter("@PolicyDigest", receipt.PolicyDigest),
            new SugarParameter("@FlagsDigest", receipt.FlagsDigest),
            new SugarParameter("@AuditReference", receipt.AuditReference),
            new SugarParameter("@AuditDigest", receipt.AuditDigest),
            new SugarParameter("@ContentDigest", receipt.ContentDigest),
            new SugarParameter("@OccurredAtUtc", receipt.OccurredAtUtc)).ConfigureAwait(false);

    private async Task InsertObligationAsync(
        Guid receiptId,
        int index,
        ArticlePropertyDefinitionObligation obligation)
        => await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_property_definition_obligation(
                receipt_id, obligation_index, kind, affected_value_count, requires_reconciliation, reason_code)
            VALUES (@ReceiptId, @Index, @Kind, @AffectedValueCount, @RequiresReconciliation, @ReasonCode);
            """,
            new SugarParameter("@ReceiptId", receiptId),
            new SugarParameter("@Index", index),
            new SugarParameter("@Kind", obligation.Kind),
            NullableInt64Parameter("@AffectedValueCount", obligation.AffectedValueCount),
            new SugarParameter("@RequiresReconciliation", obligation.RequiresReconciliation),
            new SugarParameter("@ReasonCode", obligation.ReasonCode)).ConfigureAwait(false);

    private async Task<ArticlePropertyDefinitionWriteReceipt?> ReadReceiptAsync(
        Guid receiptId,
        CancellationToken cancellationToken)
    {
        ReceiptRow? row;
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                   """
                   SELECT receipt_id, request_id, actor_admin_principal_id, owner_user_id, site_scope, command_kind,
                          command_digest, definition_id, previous_owner_revision, owner_revision,
                          previous_schema_revision, schema_revision, status, before_definition_digest,
                          after_definition_digest, constraint_digest, options_digest, policy_digest, flags_digest,
                          audit_reference, audit_digest, content_digest, occurred_at_utc
                   FROM article_property_definition_receipt
                   WHERE receipt_id = @ReceiptId;
                   """,
                   new SugarParameter("@ReceiptId", receiptId)).ConfigureAwait(false))
        {
            row = await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
                ? ReadReceiptRow(reader)
                : null;
        }
        return row is null
            ? null
            : await HydrateReceiptAsync(row, cancellationToken).ConfigureAwait(false);
    }

    private static ReceiptRow ReadReceiptRow(DbDataReader reader)
        => new(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetInt64(2),
            reader.GetInt64(3),
            reader.GetString(4),
            reader.GetString(5),
            reader.GetString(6),
            reader.GetGuid(7),
            reader.GetInt64(8),
            reader.GetInt64(9),
            reader.GetInt64(10),
            reader.GetInt64(11),
            (ArticlePropertyDefinitionStatus)reader.GetInt16(12),
            reader.GetString(13),
            reader.GetString(14),
            reader.GetString(15),
            reader.GetString(16),
            reader.GetString(17),
            reader.GetString(18),
            reader.GetGuid(19),
            reader.GetString(20),
            reader.GetString(21),
            DateTime.SpecifyKind(reader.GetDateTime(22), DateTimeKind.Utc));

    private async Task<ArticlePropertyDefinitionWriteReceipt> HydrateReceiptAsync(
        ReceiptRow row,
        CancellationToken cancellationToken)
    {
        var obligations = new List<ArticlePropertyDefinitionObligation>();
        using (DbDataReader obligationReader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                   """
                   SELECT kind, affected_value_count, requires_reconciliation, reason_code
                   FROM article_property_definition_obligation
                   WHERE receipt_id = @ReceiptId
                   ORDER BY obligation_index;
                   """,
                   new SugarParameter("@ReceiptId", row.ReceiptId)).ConfigureAwait(false))
        {
            while (await obligationReader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                obligations.Add(new(
                    obligationReader.GetString(0),
                    obligationReader.IsDBNull(1) ? null : obligationReader.GetInt64(1),
                    obligationReader.GetBoolean(2),
                    obligationReader.GetString(3)));
            }
        }
        var receipt = new ArticlePropertyDefinitionWriteReceipt(
            row.ReceiptId,
            row.RequestId,
            row.ActorAdminPrincipalId,
            new(row.OwnerUserId == 0 ? null : row.OwnerUserId, row.SiteScope),
            row.CommandKind,
            row.CommandDigest,
            row.DefinitionId,
            row.PreviousOwnerRevision,
            row.OwnerRevision,
            row.PreviousSchemaRevision,
            row.SchemaRevision,
            row.Status,
            row.BeforeDefinitionDigest,
            row.AfterDefinitionDigest,
            row.ConstraintDigest,
            row.OptionsDigest,
            row.PolicyDigest,
            row.FlagsDigest,
            obligations,
            row.AuditReference,
            row.AuditDigest,
            row.ContentDigest,
            row.OccurredAtUtc);
        ArticlePropertyDefinitionContract.ValidateReceipt(receipt);
        return receipt;
    }

    private async Task<IReadOnlyList<ArticlePropertyDefinitionWriteReceipt>> ReadReceiptsAsync(
        Guid definitionId,
        int limit,
        CancellationToken cancellationToken)
    {
        var rows = new List<ReceiptRow>();
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                   """
                   SELECT receipt_id, request_id, actor_admin_principal_id, owner_user_id, site_scope, command_kind,
                          command_digest, definition_id, previous_owner_revision, owner_revision,
                          previous_schema_revision, schema_revision, status, before_definition_digest,
                          after_definition_digest, constraint_digest, options_digest, policy_digest, flags_digest,
                          audit_reference, audit_digest, content_digest, occurred_at_utc
                   FROM article_property_definition_receipt
                   WHERE definition_id = @DefinitionId
                   ORDER BY schema_revision
                   LIMIT @Limit;
                   """,
                   new SugarParameter("@DefinitionId", definitionId),
                   new SugarParameter("@Limit", limit)).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                rows.Add(ReadReceiptRow(reader));
            }
        }
        var result = new List<ArticlePropertyDefinitionWriteReceipt>(rows.Count);
        foreach (ReceiptRow row in rows)
        {
            result.Add(await HydrateReceiptAsync(row, cancellationToken).ConfigureAwait(false));
        }
        return Array.AsReadOnly(result.ToArray());
    }

    private async Task<IReadOnlyList<ArticlePropertyDefinitionIdempotencyRecord>> ReadIdempotencyForDefinitionAsync(
        Guid definitionId,
        int limit,
        CancellationToken cancellationToken)
    {
        var result = new List<ArticlePropertyDefinitionIdempotencyRecord>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT i.actor_admin_principal_id, i.request_id, i.command_digest, i.receipt_id
            FROM article_property_definition_idempotency i
            INNER JOIN article_property_definition_receipt r ON r.receipt_id = i.receipt_id
            WHERE r.definition_id = @DefinitionId
            ORDER BY r.schema_revision
            LIMIT @Limit;
            """,
            new SugarParameter("@DefinitionId", definitionId),
            new SugarParameter("@Limit", limit)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            result.Add(new(reader.GetInt64(0), reader.GetGuid(1), reader.GetString(2), reader.GetGuid(3)));
        }
        return Array.AsReadOnly(result.ToArray());
    }

    private async Task<IReadOnlyList<ArticlePropertyDefinitionAuditLink>> ReadAuditLinksAsync(
        IEnumerable<Guid> references,
        CancellationToken cancellationToken)
    {
        Guid[] ids = references.Distinct().ToArray();
        if (ids.Length == 0)
        {
            return [];
        }
        var result = new List<ArticlePropertyDefinitionAuditLink>();
        string auditReferences = "{" + string.Join(',', ids.Select(static id => id.ToString("N"))) + "}";
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT replace(target_id, '-', '') AS audit_reference,
                   event_info, action, target_id, outcome, is_high_value
            FROM sys_audit_log
            WHERE target_type = 'article-property-definition-receipt'
              AND replace(target_id, '-', '') = ANY(CAST(@AuditReferences AS text[]))
            ORDER BY id;
            """,
            new SugarParameter(
                "@AuditReferences",
                auditReferences)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            if (!Guid.TryParseExact(reader.GetString(0), "N", out Guid auditReference))
            {
                throw new ArticlePropertyDefinitionIntegrityException("article_property_audit_reference_invalid");
            }
            result.Add(new(
                auditReference,
                reader.GetString(1),
                reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3),
                reader.GetString(4),
                reader.GetBoolean(5)));
        }
        return Array.AsReadOnly(result.ToArray());
    }

    private async Task<IdempotencyRow?> ReadIdempotencyAsync(
        long actorAdminPrincipalId,
        Guid requestId,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT actor_admin_principal_id, request_id, command_digest, receipt_id
            FROM article_property_definition_idempotency
            WHERE actor_admin_principal_id = @ActorAdminPrincipalId AND request_id = @RequestId;
            """,
            new SugarParameter("@ActorAdminPrincipalId", actorAdminPrincipalId),
            new SugarParameter("@RequestId", requestId)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? new(reader.GetInt64(0), reader.GetGuid(1), reader.GetString(2), reader.GetGuid(3))
            : null;
    }

    private static void ValidateMutation(
        ArticlePropertyDefinitionMutationSnapshot snapshot,
        ArticlePropertyDefinitionMutation mutation,
        Guid definitionId)
    {
        ArgumentNullException.ThrowIfNull(mutation);
        if (mutation.Definition.DefinitionId != definitionId
            || mutation.Definition.Owner != snapshot.Owner
            || mutation.Receipt.Owner != snapshot.Owner
            || (mutation.PreviousDefinition is null) != (snapshot.TargetDefinition is null)
            || mutation.PreviousDefinition is not null
                && snapshot.TargetDefinition is not null
                && (mutation.PreviousDefinition.DefinitionId != snapshot.TargetDefinition.DefinitionId
                    || mutation.PreviousDefinition.Owner != snapshot.TargetDefinition.Owner
                    || mutation.PreviousDefinition.SchemaRevision != snapshot.TargetDefinition.SchemaRevision
                    || !string.Equals(
                        mutation.PreviousDefinition.ContentDigest,
                        snapshot.TargetDefinition.ContentDigest,
                        StringComparison.Ordinal)))
        {
            throw new ArticlePropertyDefinitionIntegrityException("article_property_mutation_scope_invalid");
        }
        if (mutation.ExpectedOwnerRevision != snapshot.OwnerRevision
            || mutation.Receipt.PreviousOwnerRevision != snapshot.OwnerRevision
            || mutation.Receipt.OwnerRevision != snapshot.OwnerRevision + 1
            || mutation.Receipt.DefinitionId != definitionId)
        {
            throw new ArticlePropertyDefinitionIntegrityException("article_property_mutation_revision_invalid");
        }
        ArticlePropertyDefinitionContract.ValidateDefinition(mutation.Definition);
        ArticlePropertyDefinitionContract.ValidateReceipt(mutation.Receipt);
    }

    private static AuditRecord BuildAuditRecord(ArticlePropertyDefinitionWriteReceipt receipt)
        => new(
            Source: AuditSourceCatalog.Article,
            Type: AuditTypeCatalog.Business,
            OccurredAtUtc: receipt.OccurredAtUtc,
            EventInfo: receipt.AuditDigest,
            ContextPayload: null,
            Action: AdminPermissions.ArticleWrite,
            Outcome: AuditOutcomeCatalog.Success,
            Severity: AuditSeverityCatalog.Info,
            ActorType: AuditActorTypeCatalog.Admin,
            ActorId: receipt.ActorAdminPrincipalId.ToString(CultureInfo.InvariantCulture),
            TargetType: "article-property-definition-receipt",
            TargetId: receipt.AuditReference.ToString("N"),
            IsHighValue: true,
            ReasonCode: receipt.CommandKind);

    private static SugarParameter[] DefinitionParameters(
        ArticlePropertyDefinitionOwner owner,
        params SugarParameter[] extras)
        =>
        [
            new("@OwnerUserId", OwnerUserKey(owner)),
            new("@SiteScope", owner.SiteScope),
            .. extras
        ];

    private static SugarParameter[] DefinitionWriteParameters(ArticlePropertyDefinition definition)
    {
        ArticlePropertyReferencePolicy? reference = definition.ReferencePolicy;
        ArticlePropertyUrlPolicy? url = definition.UrlPolicy;
        ArticlePropertyDefaultValue? defaultValue = definition.DefaultValue;
        return
        [
            new("@SchemaVersion", definition.SchemaVersion),
            new("@DefinitionId", definition.DefinitionId),
            new("@OwnerUserId", OwnerUserKey(definition.Owner)),
            new("@SiteScope", definition.Owner.SiteScope),
            new("@MachineKey", definition.MachineKey),
            new("@ValueType", (short)definition.ValueType),
            new("@Cardinality", (short)definition.Cardinality),
            new("@Required", definition.Required),
            new("@MissingBehavior", (short)definition.Presence.Missing),
            new("@NullBehavior", (short)definition.Presence.Null),
            new("@EmptyBehavior", (short)definition.Presence.Empty),
            new("@DefaultKind", (short)(defaultValue?.Kind ?? ArticlePropertyDefaultKind.None)),
            NullableStringParameter("@DefaultScalar", defaultValue?.Scalar),
            new("@DefaultOptionIds", defaultValue is null ? string.Empty : JoinGuids(defaultValue.OptionIds)),
            new("@DefaultArticleIds", defaultValue is null ? string.Empty : string.Join(',', defaultValue.ArticleIds)),
            NullableInt32Parameter("@MinLength", definition.Constraints.MinLength),
            NullableInt32Parameter("@MaxLength", definition.Constraints.MaxLength),
            NullableDecimalParameter("@MinNumber", definition.Constraints.MinNumber),
            NullableDecimalParameter("@MaxNumber", definition.Constraints.MaxNumber),
            NullableInt64Parameter("@MinDateUtcTicks", definition.Constraints.MinDateUtc?.Ticks),
            NullableInt64Parameter("@MaxDateUtcTicks", definition.Constraints.MaxDateUtc?.Ticks),
            NullableInt32Parameter("@MinItems", definition.Constraints.MinItems),
            NullableInt32Parameter("@MaxItems", definition.Constraints.MaxItems),
            NullableInt16Parameter("@ReferenceCardinality", reference is null ? null : (short)reference.Cardinality),
            NullableInt16Parameter("@ReferencePermission", reference is null ? null : (short)reference.Permission),
            NullableBooleanParameter("@AllowCrossSite", reference?.AllowCrossSite),
            NullableBooleanParameter("@AllowDeleted", reference?.AllowDeleted),
            NullableBooleanParameter("@AllowArchived", reference?.AllowArchived),
            NullableBooleanParameter("@AllowSelfReference", reference?.AllowSelfReference),
            NullableBooleanParameter("@AllowCycles", reference?.AllowCycles),
            new("@UrlAllowedSchemes", url is null ? string.Empty : string.Join(',', url.AllowedSchemes)),
            NullableBooleanParameter("@UrlAllowRelative", url?.AllowRelative),
            NullableBooleanParameter("@UrlAllowAbsolute", url?.AllowAbsolute),
            NullableInt32Parameter("@UrlMaxLength", url?.MaxLength),
            NullableInt16Parameter("@UrlNormalization", url is null ? null : (short)url.Normalization),
            new("@SearchEligible", definition.SearchEligible),
            new("@Filterable", definition.Filterable),
            new("@Sortable", definition.Sortable),
            new("@DisplayPlacement", (short)definition.DisplayPlacement),
            new("@VisibilityScope", (short)definition.VisibilityScope),
            new("@Status", (short)definition.Status),
            new("@SchemaRevision", definition.SchemaRevision),
            new("@CreatedAtUtc", definition.CreatedAtUtc),
            new("@UpdatedAtUtc", definition.UpdatedAtUtc),
            new("@ContentDigest", definition.ContentDigest)
        ];
    }

    private static IEnumerable<string> DefinitionUpdateColumns()
        =>
        [
            "value_type = @ValueType",
            "cardinality = @Cardinality",
            "required = @Required",
            "missing_behavior = @MissingBehavior",
            "null_behavior = @NullBehavior",
            "empty_behavior = @EmptyBehavior",
            "default_kind = @DefaultKind",
            "default_scalar = @DefaultScalar",
            "default_option_ids = @DefaultOptionIds",
            "default_article_ids = @DefaultArticleIds",
            "min_length = @MinLength",
            "max_length = @MaxLength",
            "min_number = @MinNumber",
            "max_number = @MaxNumber",
            "min_date_utc_ticks = @MinDateUtcTicks",
            "max_date_utc_ticks = @MaxDateUtcTicks",
            "min_items = @MinItems",
            "max_items = @MaxItems",
            "reference_cardinality = @ReferenceCardinality",
            "reference_permission = @ReferencePermission",
            "allow_cross_site = @AllowCrossSite",
            "allow_deleted = @AllowDeleted",
            "allow_archived = @AllowArchived",
            "allow_self_reference = @AllowSelfReference",
            "allow_cycles = @AllowCycles",
            "url_allowed_schemes = @UrlAllowedSchemes",
            "url_allow_relative = @UrlAllowRelative",
            "url_allow_absolute = @UrlAllowAbsolute",
            "url_max_length = @UrlMaxLength",
            "url_normalization = @UrlNormalization",
            "search_eligible = @SearchEligible",
            "filterable = @Filterable",
            "sortable = @Sortable",
            "display_placement = @DisplayPlacement",
            "visibility_scope = @VisibilityScope",
            "status = @Status",
            "schema_revision = @SchemaRevision",
            "updated_at_utc = @UpdatedAtUtc",
            "content_digest = @ContentDigest"
        ];

    private static ArticlePropertyDefaultValue? ReadDefault(DefinitionRow row)
    {
        ArticlePropertyDefaultKind kind = row.DefaultKind;
        if (kind == ArticlePropertyDefaultKind.None)
        {
            return null;
        }
        return new(
            kind,
            row.DefaultScalar,
            ParseGuids(row.DefaultOptionIds, "article_property_default_option_tamper"),
            ParseLongs(row.DefaultArticleIds, "article_property_default_article_tamper"));
    }

    private static ArticlePropertyReferencePolicy? ReadReferencePolicy(DefinitionRow row)
    {
        return row.ReferenceCardinality is null
            ? null
            : new(
                (ArticlePropertyCardinality)row.ReferenceCardinality.Value,
                (ArticlePropertyReferencePermission)row.ReferencePermission!.Value,
                row.AllowCrossSite!.Value,
                row.AllowDeleted!.Value,
                row.AllowArchived!.Value,
                row.AllowSelfReference!.Value,
                row.AllowCycles!.Value);
    }

    private static ArticlePropertyUrlPolicy? ReadUrlPolicy(DefinitionRow row)
    {
        return row.UrlMaxLength is null
            ? null
            : new(
                row.UrlAllowedSchemes.Split(',', StringSplitOptions.RemoveEmptyEntries),
                row.UrlAllowRelative!.Value,
                row.UrlAllowAbsolute!.Value,
                row.UrlMaxLength.Value,
                (ArticlePropertyUrlNormalization)row.UrlNormalization!.Value);
    }

    private static int? ReadNullableInt(DbDataReader reader, string name)
        => reader.IsDBNull(reader.GetOrdinal(name)) ? null : reader.GetInt32(reader.GetOrdinal(name));

    private static SugarParameter NullableStringParameter(string name, string? value)
        => new(name, (object?)value ?? DBNull.Value, System.Data.DbType.String);

    private static SugarParameter NullableInt16Parameter(string name, short? value)
        => new(name, value.HasValue ? value.Value : DBNull.Value, System.Data.DbType.Int16);

    private static SugarParameter NullableInt32Parameter(string name, int? value)
        => new(name, value.HasValue ? value.Value : DBNull.Value, System.Data.DbType.Int32);

    private static SugarParameter NullableInt64Parameter(string name, long? value)
        => new(name, value.HasValue ? value.Value : DBNull.Value, System.Data.DbType.Int64);

    private static SugarParameter NullableDecimalParameter(string name, decimal? value)
        => new(name, value.HasValue ? value.Value : DBNull.Value, System.Data.DbType.Decimal);

    private static SugarParameter NullableBooleanParameter(string name, bool? value)
        => new(name, value.HasValue ? value.Value : DBNull.Value, System.Data.DbType.Boolean);

    internal static decimal? ReadNullableDecimal(DbDataReader reader, string name)
        => reader.IsDBNull(reader.GetOrdinal(name)) ? null : reader.GetDecimal(reader.GetOrdinal(name));

    internal static DateTime? ReadNullableUtcConstraintTicks(DbDataReader reader, string name)
    {
        int ordinal = reader.GetOrdinal(name);
        if (reader.IsDBNull(ordinal))
        {
            return null;
        }
        long ticks = reader.GetInt64(ordinal);
        if (ticks < DateTime.MinValue.Ticks || ticks > DateTime.MaxValue.Ticks)
        {
            throw new ArticlePropertyDefinitionIntegrityException("article_property_date_constraint_ticks_invalid");
        }
        return new DateTime(ticks, DateTimeKind.Utc);
    }

    private static short? ReadNullableShort(DbDataReader reader, string name)
        => reader.IsDBNull(reader.GetOrdinal(name)) ? null : reader.GetInt16(reader.GetOrdinal(name));

    private static bool? ReadNullableBool(DbDataReader reader, string name)
        => reader.IsDBNull(reader.GetOrdinal(name)) ? null : reader.GetBoolean(reader.GetOrdinal(name));

    private static long OwnerUserKey(ArticlePropertyDefinitionOwner owner)
        => owner.UserId ?? 0;

    private static string OwnerIdentity(ArticlePropertyDefinitionOwner owner)
        => $"article-property-definition:{OwnerUserKey(owner)}:{owner.SiteScope}";

    private static string JoinGuids(IEnumerable<Guid> values)
        => string.Join(',', values.Select(static value => value.ToString("D")));

    private static IReadOnlyList<Guid> ParseGuids(string value, string code)
    {
        if (string.IsNullOrEmpty(value))
        {
            return [];
        }
        var result = new List<Guid>();
        foreach (string token in value.Split(',', StringSplitOptions.RemoveEmptyEntries))
        {
            if (!Guid.TryParse(token, out Guid id) || id == Guid.Empty)
            {
                throw new ArticlePropertyDefinitionIntegrityException(code);
            }
            result.Add(id);
        }
        return Array.AsReadOnly(result.ToArray());
    }

    private static IReadOnlyList<long> ParseLongs(string value, string code)
    {
        if (string.IsNullOrEmpty(value))
        {
            return [];
        }
        var result = new List<long>();
        foreach (string token in value.Split(',', StringSplitOptions.RemoveEmptyEntries))
        {
            if (!long.TryParse(token, NumberStyles.None, CultureInfo.InvariantCulture, out long id) || id <= 0)
            {
                throw new ArticlePropertyDefinitionIntegrityException(code);
            }
            result.Add(id);
        }
        return Array.AsReadOnly(result.ToArray());
    }

    private sealed class DefinitionRow
    {
        public int SchemaVersion
        {
            get; init;
        }
        public Guid DefinitionId
        {
            get; init;
        }
        public ArticlePropertyDefinitionOwner Owner
        {
            get; init;
        }
        public string MachineKey { get; init; } = string.Empty;
        public ArticlePropertyValueType ValueType
        {
            get; init;
        }
        public ArticlePropertyCardinality Cardinality
        {
            get; init;
        }
        public bool Required
        {
            get; init;
        }
        public ArticlePropertyMissingBehavior MissingBehavior
        {
            get; init;
        }
        public ArticlePropertyNullBehavior NullBehavior
        {
            get; init;
        }
        public ArticlePropertyEmptyBehavior EmptyBehavior
        {
            get; init;
        }
        public ArticlePropertyDefaultKind DefaultKind
        {
            get; init;
        }
        public string? DefaultScalar
        {
            get; init;
        }
        public string DefaultOptionIds { get; init; } = string.Empty;
        public string DefaultArticleIds { get; init; } = string.Empty;
        public int? MinLength
        {
            get; init;
        }
        public int? MaxLength
        {
            get; init;
        }
        public decimal? MinNumber
        {
            get; init;
        }
        public decimal? MaxNumber
        {
            get; init;
        }
        public DateTime? MinDateUtc
        {
            get; init;
        }
        public DateTime? MaxDateUtc
        {
            get; init;
        }
        public int? MinItems
        {
            get; init;
        }
        public int? MaxItems
        {
            get; init;
        }
        public short? ReferenceCardinality
        {
            get; init;
        }
        public short? ReferencePermission
        {
            get; init;
        }
        public bool? AllowCrossSite
        {
            get; init;
        }
        public bool? AllowDeleted
        {
            get; init;
        }
        public bool? AllowArchived
        {
            get; init;
        }
        public bool? AllowSelfReference
        {
            get; init;
        }
        public bool? AllowCycles
        {
            get; init;
        }
        public string UrlAllowedSchemes { get; init; } = string.Empty;
        public bool? UrlAllowRelative
        {
            get; init;
        }
        public bool? UrlAllowAbsolute
        {
            get; init;
        }
        public int? UrlMaxLength
        {
            get; init;
        }
        public short? UrlNormalization
        {
            get; init;
        }
        public bool SearchEligible
        {
            get; init;
        }
        public bool Filterable
        {
            get; init;
        }
        public bool Sortable
        {
            get; init;
        }
        public ArticlePropertyDisplayPlacement DisplayPlacement
        {
            get; init;
        }
        public ArticlePropertyVisibilityScope VisibilityScope
        {
            get; init;
        }
        public ArticlePropertyDefinitionStatus Status
        {
            get; init;
        }
        public long SchemaRevision
        {
            get; init;
        }
        public DateTime CreatedAtUtc
        {
            get; init;
        }
        public DateTime UpdatedAtUtc
        {
            get; init;
        }
        public string ContentDigest { get; init; } = string.Empty;
    }

    private sealed record OptionRow(
        Guid OptionId,
        string Label,
        int Order,
        ArticlePropertyOptionStatus Status);

    private sealed record ReceiptRow(
        Guid ReceiptId,
        Guid RequestId,
        long ActorAdminPrincipalId,
        long OwnerUserId,
        string SiteScope,
        string CommandKind,
        string CommandDigest,
        Guid DefinitionId,
        long PreviousOwnerRevision,
        long OwnerRevision,
        long PreviousSchemaRevision,
        long SchemaRevision,
        ArticlePropertyDefinitionStatus Status,
        string BeforeDefinitionDigest,
        string AfterDefinitionDigest,
        string ConstraintDigest,
        string OptionsDigest,
        string PolicyDigest,
        string FlagsDigest,
        Guid AuditReference,
        string AuditDigest,
        string ContentDigest,
        DateTime OccurredAtUtc);

    private sealed record IdempotencyRow(
        long ActorAdminPrincipalId,
        Guid RequestId,
        string CommandDigest,
        Guid ReceiptId);

    private sealed record HistoryHead(int Version, string GenesisDigest, long Revision, string HeadDigest);

    private sealed record JournalRow(
        int Version, long Sequence, string PreviousDigest, byte[] Payload, long? AffectedCount,
        Guid ReceiptId, string ContentDigest, string CommandKind, Guid DefinitionId, long ActorId, Guid RequestId);
}
