using System.Data.Common;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;

using SqlSugar;

namespace FsusBlog.Server.Services;

public partial class ArticleService : IArticlePropertyValueAuthority
{
    private ArticlePropertyDefinitionOwner? _pendingArticlePropertyOwner;

    async Task<ArticlePropertyValueMutationReceipt> IArticlePropertyValueAuthority.MutateAsync(
        long actorAdminPrincipalId,
        ArticlePropertyValueMutationCommand command,
        CancellationToken cancellationToken)
    {
        command = ArticlePropertyValueMutationContract.Capture(command);
        ArticlePropertyValuePersistence persistence = RequirePropertyPersistence();
        ArticlePropertyValueValidator validator = _articlePropertyValueValidator
            ?? throw new InvalidOperationException("article_property_value_validator_unavailable");
        var owner = new ArticlePropertyDefinitionOwner(command.DefinitionOwnerUserId, command.SiteScope);
        RequirePropertyTransactionEntry();
        var fences = new HashSet<int?>();
        List<Func<Task>>? postCommit = null;
        bool committed = false;
        try
        {
            var result = await ExecuteForegroundWriteAsync("article-property-values-write", async gateCt =>
            {
                gateCt.ThrowIfCancellationRequested();
                return await _db.Ado.UseTranAsync(async () =>
                {
                    ArticlePropertyDefinitionActor actor = await LockPropertyActorAsync(
                        actorAdminPrincipalId, owner, cancellationToken).ConfigureAwait(false);
                    await LockCanvasLinkArticlesAsync(new(actorAdminPrincipalId, owner.SiteScope),
                        [command.ArticleId], cancellationToken).ConfigureAwait(false);
                    await persistence.LockDefinitionOwnersAsync(command.ArticleId, owner, cancellationToken)
                        .ConfigureAwait(false);
                    await _db.Ado.ExecuteCommandAsync(
                        "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 0));",
                        new SugarParameter("@Identity", $"article-property-value-request:{actorAdminPrincipalId}:{command.RequestId:D}"))
                        .ConfigureAwait(false);
                    ArticlePropertyValueMutationReceipt? replay = await persistence.LoadReplayAsync(
                        actorAdminPrincipalId, command, cancellationToken).ConfigureAwait(false);
                    if (replay is not null)
                    {
                        return replay;
                    }
                    ArticleUpdateState current = await LoadArticleUpdateStateAsync(command.ArticleId).ConfigureAwait(false)
                        ?? throw new ArticlePropertyDefinitionAccessDeniedException();
                    if (current.CurrentRevisionId != command.ExpectedArticleRevisionId)
                    {
                        throw current.ToConflictException();
                    }
                    if (current.Status is ArticleStatus.Published or ArticleStatus.Scheduled
                        && !actor.Permissions.Contains(AdminPermissions.ArticlePublish))
                    {
                        throw new ArticlePropertyDefinitionAccessDeniedException();
                    }
                    ArticlePropertyValuePersistedSnapshot? before = await persistence.ReadCurrentAsync(
                        owner, command.ArticleId, current.CurrentRevisionId, cancellationToken).ConfigureAwait(false);
                    if ((before?.Snapshot.Coordinates.PropertyRevision ?? 0) != command.ExpectedPropertyRevision)
                    {
                        throw new ArticlePropertyDefinitionConflictException("article_property_value_revision_conflict");
                    }
                    IReadOnlyList<ArticlePropertyDefinition> definitions = await ReadPropertyDefinitionsAsync(
                        actor, owner, cancellationToken).ConfigureAwait(false);
                    IReadOnlyList<ArticlePropertyValueInput> inputs = MergePropertyInputs(command, before, definitions);
                    IReadOnlyList<ArticlePropertyValueEntry> values = await validator.ValidateAsync(
                        actor, owner, command.ArticleId, inputs, cancellationToken).ConfigureAwait(false);
                    values = PreservePropertyDefaultProvenance(command, before, values);
                    _articleVaultGroupTransactionDepth++;
                    _articleVaultOutboxReferences = new Dictionary<int, string>();
                    _articleVaultPublicFenceScopes = fences;
                    _articleVaultPostCommitActions = new List<Func<Task>>();
                    _pendingArticlePropertyOwner = owner;
                    try
                    {
                        ArticleUpdateExecution? applied = null;
                        var write = new ArticleWriteRequestCoreModel(current.Title, current.MarkdownContent,
                            current.Summary, current.CoverImageUrl, current.CategoryId, current.TagIds,
                            (int)current.Status, current.ScheduledPublishAt,
                            BaseRevisionId: current.CurrentRevisionId);
                        bool changed = await UpdateAsync(command.ArticleId, write, transitionKind: null,
                            force: true, rollback: null, captureExecution: value => applied = value,
                            cancellationToken).ConfigureAwait(false);
                        if (!changed || !applied.HasValue || applied.Value.Version.RevisionId == current.CurrentRevisionId)
                        {
                            throw new InvalidOperationException("article_property_value_article_write_failed");
                        }
                        long revisionId = applied.Value.Version.RevisionId;
                        long? publicationId = await ResolvePropertyPublicationAsync(command.ArticleId,
                            revisionId, applied.Value.Version.PublicationId, cancellationToken).ConfigureAwait(false);
                        return await persistence.SaveMutationAsync(actorAdminPrincipalId, command, before,
                            values, definitions.ToDictionary(static definition => definition.DefinitionId,
                                static definition => definition.ValueType), revisionId, publicationId,
                            cancellationToken).ConfigureAwait(false);
                    }
                    finally
                    {
                        postCommit = _articleVaultPostCommitActions;
                        _articleVaultPostCommitActions = null;
                        _articleVaultPublicFenceScopes = null;
                        _articleVaultOutboxReferences = null;
                        _pendingArticlePropertyOwner = null;
                        _articleVaultGroupTransactionDepth--;
                    }
                }).ConfigureAwait(false);
            }, cancellationToken).ConfigureAwait(false);
            if (!result.IsSuccess)
            {
                throw result.ErrorException ?? new InvalidOperationException(result.ErrorMessage);
            }
            committed = true;
            await DrainArticleVaultPostCommitActionsAsync(postCommit ?? []).ConfigureAwait(false);
            return result.Data;
        }
        finally
        {
            foreach (int? articleId in fences)
            {
                await RecoverAbortedPublicMutationFenceAsync(articleId,
                    committed ? "article-property-value-postcommit-recovery" : "article-property-value-aborted")
                    .ConfigureAwait(false);
            }
        }
    }

    async Task<ArticlePropertyValueReadModel> IArticlePropertyValueAuthority.ReadAsync(
        long actorAdminPrincipalId, ArticlePropertyDefinitionOwner owner, int articleId,
        CancellationToken cancellationToken)
    {
        ArticlePropertyValuePersistence persistence = RequirePropertyPersistence();
        RequirePropertyTransactionEntry();
        var result = await ExecuteForegroundWriteAsync("article-property-values-read", async gateCt =>
        {
            gateCt.ThrowIfCancellationRequested();
            return await _db.Ado.UseTranAsync(async () =>
            {
                ArticlePropertyDefinitionActor actor = await LockPropertyActorAsync(actorAdminPrincipalId,
                    owner, cancellationToken).ConfigureAwait(false);
                await LockCanvasLinkArticlesAsync(new(actorAdminPrincipalId, owner.SiteScope),
                    [articleId], cancellationToken).ConfigureAwait(false);
                await LockPropertyDefinitionsAsync(owner, cancellationToken).ConfigureAwait(false);
                ArticleUpdateState current = await LoadArticleUpdateStateAsync(articleId).ConfigureAwait(false)
                    ?? throw new ArticlePropertyDefinitionAccessDeniedException();
                ArticlePropertyValuePersistedSnapshot? snapshot = await persistence.ReadCurrentAsync(owner,
                    articleId, current.CurrentRevisionId, cancellationToken).ConfigureAwait(false);
                IReadOnlyList<ArticlePropertyDefinition> definitions = await ReadPropertyDefinitionsAsync(
                    actor, owner, cancellationToken,
                    snapshot?.Snapshot.Values.Select(static value => value.DefinitionId)).ConfigureAwait(false);
                IReadOnlyList<ArticlePropertyValueReconciliation> reconciliation = await ReconcilePropertyValuesAsync(
                    actor, owner, articleId, snapshot, definitions, cancellationToken).ConfigureAwait(false);
                return new ArticlePropertyValueReadModel(articleId, current.CurrentRevisionId,
                    snapshot?.Snapshot.Coordinates.PropertyRevision ?? 0, snapshot, definitions, reconciliation);
            }).ConfigureAwait(false);
        }, cancellationToken).ConfigureAwait(false);
        if (!result.IsSuccess)
        {
            throw result.ErrorException ?? new InvalidOperationException(result.ErrorMessage);
        }
        return result.Data;
    }

    private ArticlePropertyValuePersistence RequirePropertyPersistence()
        => _articlePropertyValues ?? throw new InvalidOperationException("article_property_value_persistence_unavailable");

    private void RequirePropertyTransactionEntry()
    {
        if (IsArticleVaultGroupTransaction || _db.Ado.Transaction is not null)
        {
            throw new InvalidOperationException("article_property_value_nested_transaction_rejected");
        }
    }

    private async Task<ArticlePropertyDefinitionActor> LockPropertyActorAsync(
        long actorAdminPrincipalId, ArticlePropertyDefinitionOwner owner, CancellationToken cancellationToken)
    {
        ArticlePropertyDefinitionContract.ValidateOwner(owner);
        var claims = _httpContextAccessor.HttpContext?.User;
        if (actorAdminPrincipalId <= 0 || claims?.IsAdminPrincipal() != true
            || !claims.TryGetAdminPrincipalId(out long principalId) || principalId != actorAdminPrincipalId
            || string.IsNullOrWhiteSpace(claims.GetAdminSessionId()) || owner.SiteScope != "primary-site")
        {
            throw new ArticlePropertyDefinitionAccessDeniedException();
        }
        using DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync("""
            SELECT isroot, permissions FROM admin_principal
            WHERE id = @Principal AND status = @Active FOR SHARE;
            """, new SugarParameter("@Principal", actorAdminPrincipalId),
            new SugarParameter("@Active", AdminPrincipalStatus.Active)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new ArticlePropertyDefinitionAccessDeniedException();
        }
        string[] permissions = reader.GetBoolean(0) ? AdminPermissions.All : reader.GetString(1).Split('\n', StringSplitOptions.RemoveEmptyEntries);
        var actor = new ArticlePropertyDefinitionActor(actorAdminPrincipalId, permissions);
        new ArticlePropertyDefinitionPermissionAuthority().EnsureAllowed(actor, owner, manage: false);
        return actor;
    }

    private Task LockPropertyDefinitionsAsync(ArticlePropertyDefinitionOwner owner, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return _db.Ado.ExecuteCommandAsync("SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2442));",
            new SugarParameter("@Identity", $"article-property-definition:{owner.UserId ?? 0}:{owner.SiteScope}"));
    }

    private async Task<IReadOnlyList<ArticlePropertyDefinition>> ReadPropertyDefinitionsAsync(
        ArticlePropertyDefinitionActor actor, ArticlePropertyDefinitionOwner owner, CancellationToken cancellationToken,
        IEnumerable<Guid>? historicalDefinitionIds = null)
    {
        IArticlePropertyDefinitionStore store = _articlePropertyDefinitions
            ?? throw new InvalidOperationException("article_property_definition_authority_unavailable");
        var ids = new List<Guid>();
        using (DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync("""
            SELECT definition_id FROM article_property_definition
            WHERE owner_user_id = @Owner AND site_scope = @Site AND status <> 2 ORDER BY definition_id LIMIT 1001;
            """, new SugarParameter("@Owner", owner.UserId ?? 0),
            new SugarParameter("@Site", owner.SiteScope)).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                ids.Add(reader.GetGuid(0));
            }
        }
        Guid[] allIds = ids.Concat(historicalDefinitionIds ?? []).Distinct().Order().ToArray();
        if (allIds.Length > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner)
        {
            throw new ArticlePropertyDefinitionBudgetExceededException("article_property_value_definition_budget_exceeded");
        }
        return await store.GetManyAsync(actor, owner, allIds, cancellationToken).ConfigureAwait(false);
    }

    private static IReadOnlyList<ArticlePropertyValueInput> MergePropertyInputs(
        ArticlePropertyValueMutationCommand command, ArticlePropertyValuePersistedSnapshot? before,
        IReadOnlyList<ArticlePropertyDefinition> definitions)
    {
        var current = (before?.Snapshot.Values ?? []).ToDictionary(static value => value.DefinitionId,
            static value => new ArticlePropertyValueInput(value.DefinitionId, value.DefinitionSchemaRevision,
                value.DefinitionDigest, value.Presence, value.Value));
        var merged = command.Mode == ArticlePropertyValueMutationMode.Replace
            ? new Dictionary<Guid, ArticlePropertyValueInput>() : new Dictionary<Guid, ArticlePropertyValueInput>(current);
        foreach (ArticlePropertyValueChange change in command.Changes)
        {
            bool present = current.TryGetValue(change.Input.DefinitionId, out ArticlePropertyValueInput? old)
                && old.Presence != ArticlePropertyValuePresence.Missing;
            if (change.Kind == ArticlePropertyValueChangeKind.Create && present
                || change.Kind is ArticlePropertyValueChangeKind.Update or ArticlePropertyValueChangeKind.Remove && !present)
            {
                throw new ArticlePropertyDefinitionConflictException("article_property_value_change_conflict");
            }
            merged[change.Input.DefinitionId] = change.Input;
        }
        // Omitted required/default fields still pass through the real definition validator.
        foreach (ArticlePropertyDefinition definition in definitions.Where(static definition =>
            definition.Status == ArticlePropertyDefinitionStatus.Active))
        {
            merged.TryAdd(definition.DefinitionId, new(definition.DefinitionId, definition.SchemaRevision,
                definition.ContentDigest, ArticlePropertyValuePresence.Missing, null));
        }
        return Array.AsReadOnly(merged.Values.OrderBy(static value => value.DefinitionId).ToArray());
    }

    private static IReadOnlyList<ArticlePropertyValueEntry> PreservePropertyDefaultProvenance(
        ArticlePropertyValueMutationCommand command, ArticlePropertyValuePersistedSnapshot? before,
        IReadOnlyList<ArticlePropertyValueEntry> values)
    {
        if (command.Mode != ArticlePropertyValueMutationMode.Patch || before is null)
        {
            return values;
        }
        var changed = command.Changes.Select(static change => change.Input.DefinitionId).ToHashSet();
        var defaults = before.Snapshot.Values.Where(value => value.DefaultApplied && !changed.Contains(value.DefinitionId))
            .ToDictionary(static value => value.DefinitionId);
        return Array.AsReadOnly(values.Select(value => defaults.ContainsKey(value.DefinitionId)
            ? value with
            {
                DefaultApplied = true,
                ValueDigest = ArticlePropertyValueDigest.ComputeValue(new(value.DefinitionId,
                    value.DefinitionSchemaRevision, value.DefinitionDigest, value.Presence, value.Value), true)
            } : value).ToArray());
    }

    private static Task<IReadOnlyList<ArticlePropertyValueReconciliation>> ReconcilePropertyValuesAsync(
        ArticlePropertyDefinitionActor actor, ArticlePropertyDefinitionOwner owner, int articleId,
        ArticlePropertyValuePersistedSnapshot? snapshot, IReadOnlyList<ArticlePropertyDefinition> definitions,
        CancellationToken cancellationToken)
    {
        var byId = definitions.ToDictionary(static definition => definition.DefinitionId);
        var result = new List<ArticlePropertyValueReconciliation>();
        foreach (ArticlePropertyValueEntry value in snapshot?.Snapshot.Values ?? [])
        {
            ArticlePropertyValueReconciliationStatus status;
            string reason;
            if (!byId.TryGetValue(value.DefinitionId, out ArticlePropertyDefinition? definition))
            {
                status = ArticlePropertyValueReconciliationStatus.DefinitionUnavailable;
                reason = "article_property_definition_unavailable";
            }
            else if (definition.Status != ArticlePropertyDefinitionStatus.Active)
            {
                status = ArticlePropertyValueReconciliationStatus.DefinitionInactive;
                reason = "article_property_definition_inactive";
            }
            else if (definition.SchemaRevision != value.DefinitionSchemaRevision || definition.ContentDigest != value.DefinitionDigest)
            {
                status = ArticlePropertyValueReconciliationStatus.DefinitionChanged;
                reason = "article_property_definition_changed";
            }
            else
            {
                // The persisted scalar candidate was authenticated above. Nonempty references
                // still require a live permission/lifecycle authority; never return target metadata.
                status = value.Value is ArticlePropertyArticleReferenceValue references && references.ArticleIds.Count > 0
                    ? ArticlePropertyValueReconciliationStatus.ReferenceAuthorityUnavailable
                    : ArticlePropertyValueReconciliationStatus.Current;
                reason = status == ArticlePropertyValueReconciliationStatus.Current
                    ? "article_property_value_current" : "article_property_reference_authority_unavailable";
            }
            result.Add(new(value.DefinitionId, status, reason));
        }
        var stored = (snapshot?.Snapshot.Values ?? []).Select(static value => value.DefinitionId).ToHashSet();
        foreach (ArticlePropertyDefinition definition in definitions.Where(definition =>
            definition.Status == ArticlePropertyDefinitionStatus.Active && !stored.Contains(definition.DefinitionId)))
        {
            if (definition.Required || definition.Presence.Missing == ArticlePropertyMissingBehavior.ApplyDefault)
            {
                result.Add(new(definition.DefinitionId, definition.Required
                    ? ArticlePropertyValueReconciliationStatus.RequiredValueMissing
                    : ArticlePropertyValueReconciliationStatus.DefaultPending,
                    definition.Required ? "article_property_value_required_missing" : "article_property_value_default_pending"));
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult<IReadOnlyList<ArticlePropertyValueReconciliation>>(result.AsReadOnly());
    }

    private async Task<long?> ResolvePropertyPublicationAsync(
        int articleId, long revisionId, long? publicationId, CancellationToken cancellationToken)
    {
        if (publicationId is not > 0)
        {
            return null;
        }
        using DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync("""
            SELECT id FROM article_publication
            WHERE id = @Publication AND article_id = @Article AND article_revision_id = @Revision;
            """, new SugarParameter("@Publication", publicationId.Value),
            new SugarParameter("@Article", articleId), new SugarParameter("@Revision", revisionId)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false) ? publicationId : null;
    }

    private async Task CarryForwardPropertyValuesAsync(int articleId, long revisionId, long? publicationId,
        long? rollbackSourceRevision, CancellationToken cancellationToken)
    {
        if (_articlePropertyValues is null)
        {
            return;
        }
        // Existing service construction remains source-compatible; production DI always supplies
        // the sole participant. No root can accept property writes without it.
        object? any = await _db.Ado.GetScalarAsync(
            "SELECT EXISTS (SELECT 1 FROM article_property_value_head WHERE article_id = @Article);",
            new SugarParameter("@Article", articleId)).ConfigureAwait(false);
        if (any is not true)
        {
            return;
        }
        var claims = _httpContextAccessor.HttpContext?.User;
        if (claims is null || !claims.TryGetAdminPrincipalId(out long actorId))
        {
            throw new ArticlePropertyDefinitionAccessDeniedException();
        }
        long? actualPublication = await ResolvePropertyPublicationAsync(articleId, revisionId,
            publicationId, cancellationToken).ConfigureAwait(false);
        await _articlePropertyValues.CarryForwardAsync(articleId, revisionId, actualPublication, actorId,
            rollbackSourceRevision, cancellationToken: cancellationToken, excludedOwner: _pendingArticlePropertyOwner)
            .ConfigureAwait(false);
    }
}
