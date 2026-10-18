using System.Data;

using FsusBlog.Shared.Contracts.ArticleProperties;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

public sealed partial class ArticlePropertyValuePersistence
{
    /// <summary>
    /// Consumes real typed template pins after the canonical writer has inserted its initial
    /// article/revision/draft. The caller supplies current authorization and owns rollback,
    /// receipt, outbox and commit. A committed create cannot be patched through this participant.
    /// </summary>
    public async Task<ArticlePropertyValuePersistedSnapshot> SaveInitialCreateAsync(
        NpgsqlTransaction transaction,
        ArticleCreateCommand command,
        ArticleTemplateActor currentActor,
        ArticlePropertyDefinitionOwner currentOwner,
        int actualArticleId,
        long actualArticleRevisionId,
        CancellationToken cancellationToken = default)
    {
        RequireTransaction();
        ArgumentNullException.ThrowIfNull(transaction);
        ArgumentNullException.ThrowIfNull(command);
        if (!ReferenceEquals(_db.Ado.Transaction, transaction)
            || !ReferenceEquals(_db.Ado.Connection, transaction.Connection)
            || transaction.IsolationLevel != IsolationLevel.ReadCommitted)
        {
            throw Integrity("article_property_value_create_transaction_mismatch");
        }
        ValidateScope(currentOwner, actualArticleId);
        ArticleTemplateContract.ValidateActor(currentActor);
        ArticleTemplateExpansionPlan plan = RequireInitialCreatePlan(command, currentActor, currentOwner);
        cancellationToken.ThrowIfCancellationRequested();

        // Match the article owner's lock order. xmin binds this to inserts in this very
        // transaction, rather than a second transaction attaching facts after create.
        int locked = await _db.Ado.GetIntAsync(
            """
            SELECT a.id FROM article a JOIN article_revision r ON r.article_id = a.id
            WHERE a.id = @Article AND r.id = @Revision AND a.current_revision_id = r.id
              AND r.revision_no = 1 AND r.created_by_admin_principal_id = @Actor
              AND a.status = 0 AND NOT a.is_deleted AND a.current_publication_id IS NULL
              AND a.published_at IS NULL
              AND a.xmin::text::bigint = pg_current_xact_id()::text::bigint % 4294967296
              AND r.xmin::text::bigint = pg_current_xact_id()::text::bigint % 4294967296
              AND NOT EXISTS (SELECT 1 FROM article_revision other
                  WHERE other.article_id = a.id AND other.id <> r.id)
              AND EXISTS (SELECT 1 FROM article_draft d WHERE d.article_id = a.id
                  AND d.base_revision_id = r.id AND d.owner_admin_principal_id = @Actor
                  AND d.draft_key = @DraftKey AND d.status = 0 AND d.server_revision = 1
                  AND d.xmin::text::bigint = pg_current_xact_id()::text::bigint % 4294967296)
            FOR UPDATE OF a;
            """, new SugarParameter("@Article", actualArticleId), new("@Revision", actualArticleRevisionId),
            new("@Actor", currentActor.AdminPrincipalId), new("@DraftKey", $"canonical-create:{command.RequestId:N}"))
            .ConfigureAwait(false);
        if (locked != actualArticleId)
        {
            throw Integrity("article_property_value_initial_create_coordinates_invalid");
        }
        await LockDefinitionOwnersAsync(actualArticleId, currentOwner, cancellationToken).ConfigureAwait(false);
        if (await _db.Ado.GetIntAsync(
                "SELECT count(*) FROM article_property_value_head WHERE article_id = @Article;",
                new SugarParameter("@Article", actualArticleId)).ConfigureAwait(false) != 0)
        {
            throw new ArticlePropertyDefinitionConflictException("article_property_value_revision_conflict");
        }

        // Build the original read authorities on this exact client/transaction. No injected
        // planner, alternate connection or caller-supplied validated list can grant admission.
        var permissions = new ArticlePropertyDefinitionPermissionAuthority();
        var definitions = new ArticlePropertyDefinitionStore(
            new PostgresArticlePropertyDefinitionPersistence(_db, _configuration), permissions,
            new PostgresArticlePropertyDefinitionValueImpactAuthority(_db),
            new ArticlePropertyDefinitionVerifier(_configuration), _timeProvider);
        var validator = new ArticlePropertyValueValidator(definitions, permissions,
            new UnavailableArticlePropertyReferenceValueAuthority());
        var references = new PostgresArticleTemplateReferenceAuthority(_db, definitions, validator, currentOwner);
        var planner = new ArticleTemplateExpansionPlanner(new PostgresArticleTemplatePersistence(_db, _configuration),
            new ArticleTemplatePermissionAuthority(), references,
            new PostgresArticleTemplateExpansionAuthority(_db), _timeProvider);
        ArticleTemplateVerificationResult verified = await new ArticleTemplateExpansionVerifier(planner, _timeProvider)
            .VerifyAsync(plan, currentActor, currentOwner, cancellationToken).ConfigureAwait(false);
        if (!verified.Valid)
        {
            throw Integrity("article_property_value_initial_create_plan_stale");
        }
        ArticleTemplatePropertyPin[] pins = plan.Dependencies.PropertyPins.ToArray();
        IReadOnlyList<ArticlePropertyValueEntry> values = await validator.ValidateAsync(
            new ArticlePropertyDefinitionActor(currentActor.AdminPrincipalId, currentActor.Permissions), currentOwner,
            actualArticleId, pins.Select(static pin => new ArticlePropertyValueInput(pin.DefinitionId,
                pin.SchemaRevision, pin.DefinitionDigest, pin.ValidatedValue.Presence, pin.ValidatedValue.Value)).ToArray(),
            cancellationToken).ConfigureAwait(false);
        if (!values.Select(static value => value.ValueDigest)
                .SequenceEqual(pins.Select(static pin => pin.ValidatedValue.ValueDigest)))
        {
            throw Integrity("article_property_value_initial_create_values_drift");
        }
        var types = pins.ToDictionary(static pin => pin.DefinitionId, static pin => pin.ValueType);
        ArticlePropertyValueSnapshot candidate = ArticlePropertyValueValidator.BindSnapshot(
            new(currentOwner.UserId, currentOwner.SiteScope, actualArticleId, PropertyRevision: 1,
                actualArticleRevisionId), values);
        Guid factsetId = Guid.CreateVersion7();
        string factsetDigest = ComputeFactsetDigest(values, types);
        await InsertFactsetAsync(currentOwner, actualArticleId, 1, factsetId, factsetDigest, values, types,
            cancellationToken).ConfigureAwait(false);
        ArticlePropertyValuePersistedSnapshot after = await InsertSnapshotAsync(factsetId, factsetDigest,
            candidate, currentActor.AdminPrincipalId, cancellationToken).ConfigureAwait(false);
        await ReplaceHeadAsync(currentOwner, actualArticleId, expectedRevision: 0, after, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return after;
    }

    private static ArticleTemplateExpansionPlan RequireInitialCreatePlan(ArticleCreateCommand command,
        ArticleTemplateActor currentActor, ArticlePropertyDefinitionOwner currentOwner)
    {
        ArticleTemplateExpansionPlan? plan = command.Plan;
        if (command.Mode != ArticleCreateMode.Template || plan is null
            || command.Actor.AdminPrincipalId != currentActor.AdminPrincipalId
            || ArticleTemplateContract.ComputePermissionDigest(command.Actor)
                != ArticleTemplateContract.ComputePermissionDigest(currentActor)
            || plan.Dependencies.PropertyPins.Count == 0
            || plan.Dependencies.PropertyPins.Any(pin => pin.Owner != currentOwner))
        {
            throw Integrity("article_property_value_initial_create_context_invalid");
        }
        ArticleTemplateContract.ValidateDefaults(plan.Defaults);
        if (plan.DefaultsDigest != ArticleTemplateContract.ComputeDefaultsDigest(plan.Defaults)
            || plan.ContentDigest != ArticleTemplateContract.ComputeExpansionPlanDigest(plan)
            || plan.ExpandedSourceDigest != ArticleTemplateExpansionPlanner.ComputeSha256(plan.ExpandedSource)
            || !plan.Defaults.PropertyDefaults.Select(static value => value.DefinitionId)
                .SequenceEqual(plan.Dependencies.PropertyPins.Select(static pin => pin.DefinitionId)))
        {
            throw Integrity("article_property_value_initial_create_seal_mismatch");
        }
        if (plan.Defaults.RightsProfile is not null || plan.Defaults.ResponsibilityProfile is not null
            || plan.Defaults.PrepublishProfile is not null)
        {
            throw new ArticleCreateValidationException("article_create_defaults_receiver_unavailable");
        }
        return plan;
    }
}
