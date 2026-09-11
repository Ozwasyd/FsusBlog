using System.Data.Common;
using System.Globalization;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// PostgreSQL adapter for the exact-one article-template authority. All mutations take a
/// scope advisory lock and atomically persist CAS state, immutable versions, receipt,
/// signed audit link, and idempotency binding.
/// </summary>
public sealed partial class PostgresArticleTemplatePersistence(
    ISqlSugarClient db,
    IConfiguration configuration)
    : IArticleTemplatePersistence
{
    private readonly byte[]? _tamperKey = AuditTamperEvidence.ResolveKey(configuration);

    private const string DefinitionColumns =
        "schema_version, template_id, scope_kind, owner_admin_principal_id, name, name_key, "
        + "description, status, revision, current_version_id, current_version_number, "
        + "created_at_utc, updated_at_utc, content_digest";

    private const string ReceiptColumns =
        "receipt_id, request_id, actor_admin_principal_id, command_kind, command_digest, "
        + "template_id, version_id, version_number, scope_kind, owner_admin_principal_id, "
        + "previous_scope_revision, scope_revision, previous_template_revision, template_revision, "
        + "permission, permission_digest, defaults_digest, status, definition_digest, version_digest, "
        + "delete_disposition, occurred_at_utc, audit_reference, audit_digest, content_digest";

    public async Task<ArticleTemplateDefinition?> GetAsync(
        Guid templateId,
        CancellationToken cancellationToken = default)
    {
        if (templateId == Guid.Empty)
        {
            throw new ArticleTemplateValidationException("article_template_id_invalid");
        }
        return await ReadDefinitionAsync(templateId, cancellationToken).ConfigureAwait(false);
    }

    public async Task<ArticleTemplatePage> ListAsync(
        ArticleTemplateScope scope,
        ArticleTemplatePageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default)
    {
        ArticleTemplateContract.ValidateScope(scope);
        long ownerKey = ScopeOwnerKey(scope);
        string cursorPredicate = cursor is null
            ? string.Empty
            : "AND (name_key, template_id) > (@CursorNameKey, @CursorTemplateId)";
        var parameters = new List<SugarParameter>
        {
            new("@ScopeKind", (short)scope.Kind),
            new("@OwnerAdminPrincipalId", ownerKey),
            new("@Limit", limit + 1)
        };
        if (cursor is not null)
        {
            parameters.Add(new("@CursorNameKey", cursor.NameKey));
            parameters.Add(new("@CursorTemplateId", cursor.TemplateId));
        }

        var definitions = new List<ArticleTemplateDefinition>(limit + 1);
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT {DefinitionColumns}
            FROM article_template_definition
            WHERE scope_kind = @ScopeKind
              AND owner_admin_principal_id = @OwnerAdminPrincipalId
              AND status <> 2
              {cursorPredicate}
            ORDER BY name_key, template_id
            LIMIT @Limit;
            """,
            parameters.ToArray()).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                definitions.Add(ReadDefinition(reader));
            }
        }

        bool hasMore = definitions.Count > limit;
        if (hasMore)
        {
            definitions.RemoveAt(definitions.Count - 1);
        }
        ArticleTemplateDefinition? last = definitions.LastOrDefault();
        long scopeRevision = await ReadScopeRevisionAsync(scope).ConfigureAwait(false);
        return new(
            Array.AsReadOnly(definitions.ToArray()),
            hasMore && last is not null ? new(last.NameKey, last.TemplateId) : null,
            scopeRevision);
    }

    public async Task<ArticleTemplateVersion?> GetVersionAsync(
        Guid templateId,
        Guid versionId,
        CancellationToken cancellationToken = default)
    {
        if (templateId == Guid.Empty || versionId == Guid.Empty)
        {
            throw new ArticleTemplateValidationException("article_template_version_id_invalid");
        }
        IReadOnlyList<ArticleTemplateVersion> versions = await ReadVersionsAsync(
            templateId,
            "AND version_id = @VersionId",
            [new("@VersionId", versionId)],
            limit: 1,
            cancellationToken).ConfigureAwait(false);
        return versions.SingleOrDefault();
    }

    public async Task<ArticleTemplateVersionPage> ListVersionsAsync(
        Guid templateId,
        int? afterVersionNumber,
        int limit,
        CancellationToken cancellationToken = default)
    {
        string cursorPredicate = afterVersionNumber.HasValue
            ? "AND version_number < @AfterVersionNumber"
            : string.Empty;
        var parameters = new List<SugarParameter>();
        if (afterVersionNumber.HasValue)
        {
            parameters.Add(new("@AfterVersionNumber", afterVersionNumber.Value));
        }
        IReadOnlyList<ArticleTemplateVersion> read = await ReadVersionsAsync(
            templateId,
            cursorPredicate,
            parameters,
            limit + 1,
            cancellationToken).ConfigureAwait(false);
        var versions = read.ToList();
        bool hasMore = versions.Count > limit;
        if (hasMore)
        {
            versions.RemoveAt(versions.Count - 1);
        }
        return new(
            Array.AsReadOnly(versions.ToArray()),
            hasMore ? versions[^1].VersionNumber : null);
    }

    public async Task<ArticleTemplateWriteReceipt> ExecuteAsync(
        ArticleTemplateScope scope,
        long actorAdminPrincipalId,
        Guid requestId,
        string commandDigest,
        Guid templateId,
        Func<ArticleTemplateMutationSnapshot, CancellationToken, Task<ArticleTemplateMutation>> planner,
        CancellationToken cancellationToken = default)
    {
        ArticleTemplateContract.ValidateScope(scope);
        ArgumentNullException.ThrowIfNull(planner);
        ArticleTemplateWriteReceipt? result = null;
        var pendingChainIds = new List<string>(1);
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            _ = await db.Ado.GetScalarAsync(
                "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2360));",
                new SugarParameter("@Identity", $"article-template:{(short)scope.Kind}:{ScopeOwnerKey(scope)}"))
                .ConfigureAwait(false);

            IdempotencyLookup? replay = await ReadIdempotencyAsync(
                actorAdminPrincipalId,
                requestId,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                if (!string.Equals(replay.CommandDigest, commandDigest, StringComparison.Ordinal))
                {
                    throw new ArticleTemplateConflictException("article_template_idempotency_conflict");
                }
                ArticleTemplateWriteReceipt stored = await ReadReceiptAsync(
                    replay.ReceiptId,
                    cancellationToken).ConfigureAwait(false)
                    ?? throw new ArticleTemplateIntegrityException("article_template_idempotency_receipt_missing");
                result = stored with
                {
                    IsIdempotentReplay = true
                };
                return;
            }

            await EnsureScopeAsync(scope).ConfigureAwait(false);
            long scopeRevision = await ReadScopeRevisionAsync(scope).ConfigureAwait(false);
            IReadOnlyList<ArticleTemplateDefinition> definitions = await ReadScopeDefinitionsAsync(
                scope,
                cancellationToken).ConfigureAwait(false);
            ArticleTemplateDefinition? target = await ReadDefinitionAsync(templateId, cancellationToken)
                .ConfigureAwait(false);
            IReadOnlyList<ArticleTemplateVersion> versions = target is null
                ? []
                : await ReadVersionsAsync(
                    templateId,
                    string.Empty,
                    [],
                    ArticleTemplateContract.MaxVersionsPerTemplate + 1,
                    cancellationToken).ConfigureAwait(false);
            long usageCount = target is null
                ? 0
                : await ReadUsageCountAsync(templateId).ConfigureAwait(false);
            var snapshot = new ArticleTemplateMutationSnapshot(
                scope,
                scopeRevision,
                definitions,
                target,
                versions,
                usageCount);
            ArticleTemplateMutation mutation = await planner(snapshot, cancellationToken).ConfigureAwait(false);
            ValidateMutation(snapshot, mutation, templateId);

            int scopeRows = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE article_template_scope
                SET revision = @ScopeRevision
                WHERE scope_kind = @ScopeKind
                  AND owner_admin_principal_id = @OwnerAdminPrincipalId
                  AND revision = @ExpectedScopeRevision;
                """,
                new SugarParameter("@ScopeRevision", mutation.Receipt.ScopeRevision),
                new SugarParameter("@ScopeKind", (short)scope.Kind),
                new SugarParameter("@OwnerAdminPrincipalId", ScopeOwnerKey(scope)),
                new SugarParameter("@ExpectedScopeRevision", mutation.ExpectedScopeRevision))
                .ConfigureAwait(false);
            if (scopeRows != 1)
            {
                throw new ArticleTemplateConflictException("article_template_scope_revision_cas_stale");
            }

            if (mutation.PreviousDefinition is null)
            {
                await InsertDefinitionAsync(mutation.Definition).ConfigureAwait(false);
            }
            else
            {
                await UpdateDefinitionAsync(mutation.PreviousDefinition, mutation.Definition)
                    .ConfigureAwait(false);
            }
            if (mutation.VersionToInsert is not null)
            {
                await InsertVersionAsync(mutation.VersionToInsert).ConfigureAwait(false);
            }
            await InsertReceiptAsync(mutation.Receipt).ConfigureAwait(false);
            AuthoringSignedAuditWriter.ChainWrite auditWrite = await AuthoringSignedAuditWriter
                .InsertAsync(db, _tamperKey, BuildReceiptAuditRecord(mutation.Receipt), cancellationToken)
                .ConfigureAwait(false);
            pendingChainIds.Add(auditWrite.ChainId);
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO article_template_idempotency(
                    actor_admin_principal_id, request_id, command_digest, receipt_id, created_at_utc)
                VALUES (@ActorAdminPrincipalId, @RequestId, @CommandDigest, @ReceiptId, @CreatedAtUtc);
                """,
                new SugarParameter("@ActorAdminPrincipalId", actorAdminPrincipalId),
                new SugarParameter("@RequestId", requestId),
                new SugarParameter("@CommandDigest", commandDigest),
                new SugarParameter("@ReceiptId", mutation.Receipt.ReceiptId),
                new SugarParameter("@CreatedAtUtc", mutation.Receipt.OccurredAtUtc))
                .ConfigureAwait(false);
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
            throw new InvalidOperationException("article_template_transaction_failed");
        }
        foreach (string chainId in pendingChainIds)
        {
            AuditLogStore.InvalidateChainTail(chainId);
        }
        return result ?? throw new ArticleTemplateIntegrityException("article_template_transaction_result_missing");
    }

    private static AuditRecord BuildReceiptAuditRecord(ArticleTemplateWriteReceipt receipt)
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
            TargetType: "article-template-receipt",
            TargetId: receipt.AuditReference.ToString("N"),
            IsHighValue: true,
            ReasonCode: receipt.CommandKind);

    public async Task<ArticleTemplateVerificationSnapshot?> ReadVerificationSnapshotAsync(
        Guid templateId,
        int receiptLimit,
        CancellationToken cancellationToken = default)
    {
        ArticleTemplateVerificationSnapshot? result = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            ArticleTemplateDefinition? definition = await ReadDefinitionAsync(templateId, cancellationToken)
                .ConfigureAwait(false);
            if (definition is null)
            {
                return;
            }
            _ = await db.Ado.GetScalarAsync(
                "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2360));",
                new SugarParameter(
                    "@Identity",
                    $"article-template:{(short)definition.Scope.Kind}:{ScopeOwnerKey(definition.Scope)}"))
                .ConfigureAwait(false);
            definition = await ReadDefinitionAsync(templateId, cancellationToken).ConfigureAwait(false)
                ?? throw new ArticleTemplateIntegrityException("article_template_definition_missing_during_verify");
            IReadOnlyList<ArticleTemplateVersion> versions = await ReadVersionsAsync(
                templateId,
                string.Empty,
                [],
                ArticleTemplateContract.MaxVersionsPerTemplate + 1,
                cancellationToken).ConfigureAwait(false);
            List<ArticleTemplateWriteReceipt> receipts = await ReadReceiptsAsync(
                templateId,
                receiptLimit + 1,
                cancellationToken).ConfigureAwait(false);
            bool receiptLimitExceeded = receipts.Count > receiptLimit;
            if (receiptLimitExceeded)
            {
                receipts.RemoveAt(receipts.Count - 1);
            }
            IReadOnlyList<ArticleTemplateIdempotencyRecord> idempotency = await ReadIdempotencyForTemplateAsync(
                templateId,
                receiptLimit + 1,
                cancellationToken).ConfigureAwait(false);
            IReadOnlyList<ArticleTemplateAuditLink> auditLinks = await ReadAuditLinksAsync(
                receipts.Select(static receipt => receipt.AuditReference),
                cancellationToken).ConfigureAwait(false);
            result = new(
                definition,
                versions,
                Array.AsReadOnly(receipts.ToArray()),
                idempotency,
                auditLinks,
                receiptLimitExceeded || idempotency.Count > receiptLimit);
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            if (transaction.ErrorException is not null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo
                    .Capture(transaction.ErrorException)
                    .Throw();
            }
            throw new InvalidOperationException("article_template_verification_read_failed");
        }
        return result;
    }

}
