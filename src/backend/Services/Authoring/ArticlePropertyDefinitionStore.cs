using System.Globalization;

using FsusBlog.Server.Infrastructure.Auth;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Exact-one server authority for PropertyDefinition facts. It owns schema CAS, identity,
/// closed type validation, lifecycle transitions, receipts, and idempotent command shape;
/// article property values and search projections are deliberately outside this class.
/// </summary>
public sealed class ArticlePropertyDefinitionStore(
    IArticlePropertyDefinitionPersistence persistence,
    IArticlePropertyDefinitionPermissionAuthority permissionAuthority,
    IArticlePropertyDefinitionImpactAuthority impactAuthority,
    ArticlePropertyDefinitionVerifier verifier,
    TimeProvider timeProvider) : IArticlePropertyDefinitionStore
{
    private const string CreateCommand = "create";
    private const string UpdateCommand = "change-settings";
    private const string RenameCommand = "rename";
    private const string DeprecateCommand = "deprecate";
    private const string DeleteCommand = "delete";

    public async Task<ArticlePropertyDefinitionWriteReceipt> CreateAsync(
        CreateArticlePropertyDefinitionCommand command,
        CancellationToken cancellationToken = default)
    {
        ArticlePropertyDefinitionRecordedCommand recorded = ArticlePropertyDefinitionCommandHistory.Capture(command);
        command = recorded.Create!;
        ValidateCreateCommand(command);
        permissionAuthority.EnsureAllowed(command.Actor, command.Owner, manage: true);
        ArticlePropertyDefinition normalized = BuildDefinition(
            command.Owner,
            command.DefinitionId,
            machineKey: command.MachineKey,
            command.DisplayNames,
            command.ValueType,
            command.Cardinality,
            command.Required,
            command.Presence,
            command.DefaultValue,
            command.Constraints,
            command.Options,
            command.ReferencePolicy,
            command.UrlPolicy,
            command.SearchEligible,
            command.Filterable,
            command.Sortable,
            command.DisplayPlacement,
            command.VisibilityScope,
            ArticlePropertyDefinitionStatus.Active,
            schemaRevision: 1,
            DateTime.MinValue,
            DateTime.MinValue);
        ArticlePropertyDefinitionContract.ValidateDefinitionShapeForCommand(
            normalized.ValueType,
            normalized.Cardinality,
            normalized.Required,
            normalized.Presence,
            normalized.DefaultValue,
            normalized.Constraints,
            normalized.Options,
            normalized.ReferencePolicy,
            normalized.UrlPolicy,
            normalized.SearchEligible,
            normalized.Filterable,
            normalized.Sortable,
            normalized.DisplayPlacement,
            normalized.VisibilityScope);
        string commandDigest = ComputeCreateCommandDigest(command, normalized);

        return await persistence.ExecuteAsync(
            command.Owner,
            command.Actor.AdminPrincipalId,
            command.RequestId,
            commandDigest,
            command.DefinitionId,
            recorded,
            async (snapshot, token) =>
            {
                permissionAuthority.EnsureAllowed(command.Actor, command.Owner, manage: true);
                EnsureOwnerRevision(snapshot, command.ExpectedOwnerRevision);
                if (snapshot.TargetDefinition is not null)
                {
                    throw new ArticlePropertyDefinitionConflictException("article_property_definition_id_conflict");
                }
                EnsureMachineKeyAvailable(snapshot.Definitions, normalized.MachineKey, null);
                if (snapshot.Definitions.Count(static item => item.Status != ArticlePropertyDefinitionStatus.Deleted)
                    >= ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner)
                {
                    throw new ArticlePropertyDefinitionBudgetExceededException("article_property_definition_budget_exceeded");
                }

                DateTime now = UtcNow();
                ArticlePropertyDefinition definition = normalized with
                {
                    CreatedAtUtc = now,
                    UpdatedAtUtc = now
                };
                definition = WithDigest(definition);
                ArticlePropertyDefinitionImpact impact = await impactAuthority.GetImpactAsync(
                    command.Owner,
                    null,
                    definition,
                    CreateCommand,
                    token).ConfigureAwait(false);
                return new(
                    snapshot.OwnerRevision,
                    null,
                    definition,
                    CreateReceipt(
                        command.RequestId,
                        command.Actor,
                        commandDigest,
                        CreateCommand,
                        definition,
                        null,
                        snapshot.OwnerRevision,
                        impact.Obligations,
                        now),
                    impact);
            },
            cancellationToken).ConfigureAwait(false);
    }

    public async Task<ArticlePropertyDefinition?> GetAsync(
        ArticlePropertyDefinitionActor actor,
        ArticlePropertyDefinitionOwner owner,
        Guid definitionId,
        CancellationToken cancellationToken = default)
    {
        ValidateReadIdentity(actor, owner, definitionId);
        permissionAuthority.EnsureAllowed(actor, owner, manage: false);
        ArticlePropertyDefinition? definition = await persistence.GetAsync(owner, definitionId, cancellationToken)
            .ConfigureAwait(false);
        if (definition is null)
        {
            return null;
        }
        ArticlePropertyDefinitionContract.ValidateDefinition(definition);
        if (definition.Owner != owner)
        {
            throw new ArticlePropertyDefinitionIntegrityException("article_property_definition_owner_mismatch");
        }
        return definition.Status == ArticlePropertyDefinitionStatus.Deleted ? null : definition;
    }

    public async Task<IReadOnlyList<ArticlePropertyDefinition>> GetManyAsync(
        ArticlePropertyDefinitionActor actor,
        ArticlePropertyDefinitionOwner owner,
        IReadOnlyList<Guid> definitionIds,
        CancellationToken cancellationToken = default)
    {
        permissionAuthority.EnsureAllowed(actor, owner, manage: false);
        Guid[] ids = ArticlePropertyDefinitionBatchRead.HoldIds(definitionIds);
        cancellationToken.ThrowIfCancellationRequested();
        if (ids.Length == 0)
        {
            return Array.Empty<ArticlePropertyDefinition>();
        }
        IReadOnlyList<ArticlePropertyDefinition> definitions = await persistence.GetManyAsync(owner, ids, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        var requested = ids.ToHashSet();
        var observed = new HashSet<Guid>();
        foreach (ArticlePropertyDefinition definition in definitions)
        {
            ArticlePropertyDefinitionContract.ValidateDefinition(definition);
            if (definition.Owner != owner || !requested.Contains(definition.DefinitionId)
                || !observed.Add(definition.DefinitionId))
            {
                throw new ArticlePropertyDefinitionIntegrityException("article_property_definition_batch_mismatch");
            }
        }
        return Array.AsReadOnly(definitions.OrderBy(static definition => definition.DefinitionId).ToArray());
    }

    public async Task<ArticlePropertyDefinitionPage> ListAsync(
        ArticlePropertyDefinitionActor actor,
        ArticlePropertyDefinitionOwner owner,
        ArticlePropertyDefinitionPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default)
    {
        ArticlePropertyDefinitionContract.ValidateActor(actor);
        ArticlePropertyDefinitionContract.ValidateOwner(owner);
        permissionAuthority.EnsureAllowed(actor, owner, manage: false);
        ValidatePageLimit(limit);
        if (cursor is not null
            && (string.IsNullOrWhiteSpace(cursor.MachineKey)
                || cursor.MachineKey != ArticlePropertyDefinitionContract.NormalizeMachineKey(cursor.MachineKey)
                || cursor.DefinitionId == Guid.Empty))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_page_cursor_invalid");
        }

        ArticlePropertyDefinitionPage page = await persistence.ListAsync(owner, cursor, limit, cancellationToken)
            .ConfigureAwait(false);
        foreach (ArticlePropertyDefinition definition in page.Items)
        {
            ArticlePropertyDefinitionContract.ValidateDefinition(definition);
            if (definition.Owner != owner || definition.Status == ArticlePropertyDefinitionStatus.Deleted)
            {
                throw new ArticlePropertyDefinitionIntegrityException("article_property_page_owner_invalid");
            }
        }
        return page;
    }

    public Task<ArticlePropertyDefinitionWriteReceipt> UpdateAsync(
        UpdateArticlePropertyDefinitionCommand command,
        CancellationToken cancellationToken = default)
    {
        ArticlePropertyDefinitionRecordedCommand recorded = ArticlePropertyDefinitionCommandHistory.Capture(command);
        command = recorded.Update!;
        ValidateMutationIdentity(
            command.Actor,
            command.Owner,
            command.DefinitionId,
            command.RequestId,
            command.ExpectedOwnerRevision,
            command.ExpectedSchemaRevision);
        ArticlePropertyDefinitionContract.ValidateDefinitionShapeForCommand(
            command.ValueType,
            command.Cardinality,
            command.Required,
            command.Presence,
            command.DefaultValue,
            command.Constraints,
            command.Options,
            command.ReferencePolicy,
            command.UrlPolicy,
            command.SearchEligible,
            command.Filterable,
            command.Sortable,
            command.DisplayPlacement,
            command.VisibilityScope);
        string commandDigest = ArticlePropertyDefinitionContract.ComputeCommandDigest(
            UpdateCommand,
            command.Actor.AdminPrincipalId,
            command.Owner.UserId,
            command.Owner.SiteScope,
            command.DefinitionId,
            command.ExpectedOwnerRevision,
            command.ExpectedSchemaRevision,
            (int)command.ValueType,
            (int)command.Cardinality,
            command.Required,
            (int)command.Presence.Missing,
            (int)command.Presence.Null,
            (int)command.Presence.Empty,
            ArticlePropertyDefinitionContract.ComputeDefaultDigest(command.DefaultValue),
            ArticlePropertyDefinitionContract.ComputeConstraintDigest(command.Constraints),
            ArticlePropertyDefinitionContract.ComputeOptionsDigest(command.Options),
            ArticlePropertyDefinitionContract.ComputePolicyDigest(command.ReferencePolicy, command.UrlPolicy),
            command.SearchEligible,
            command.Filterable,
            command.Sortable,
            (int)command.DisplayPlacement,
            (int)command.VisibilityScope);
        return ExecuteExistingAsync(
            command.Actor,
            command.DefinitionId,
            command.RequestId,
            commandDigest,
            command.ExpectedOwnerRevision,
            command.ExpectedSchemaRevision,
            UpdateCommand,
            recorded,
            cancellationToken,
            command.Owner,
            async (snapshot, before, now, token) =>
            {
                if (before.Status == ArticlePropertyDefinitionStatus.Deleted)
                {
                    throw new ArticlePropertyDefinitionConflictException("article_property_definition_deleted");
                }
                if (before.ValueType != command.ValueType)
                {
                    throw new ArticlePropertyDefinitionConflictException(
                        "article_property_type_change_requires_new_definition");
                }
                ArticlePropertyDefinition after = BuildDefinition(
                    before.Owner,
                    before.DefinitionId,
                    before.MachineKey,
                    before.DisplayNames,
                    command.ValueType,
                    command.Cardinality,
                    command.Required,
                    command.Presence,
                    command.DefaultValue,
                    command.Constraints,
                    command.Options,
                    command.ReferencePolicy,
                    command.UrlPolicy,
                    command.SearchEligible,
                    command.Filterable,
                    command.Sortable,
                    command.DisplayPlacement,
                    command.VisibilityScope,
                    before.Status,
                    before.SchemaRevision + 1,
                    before.CreatedAtUtc,
                    now);
                after = WithDigest(after);
                EnsureOptionLifecycle(before.Options, after.Options);
                ArticlePropertyDefinitionImpact impact = await impactAuthority.GetImpactAsync(
                    before.Owner,
                    before,
                    after,
                    UpdateCommand,
                    token).ConfigureAwait(false);
                return (after, CreateReceipt(
                    command.RequestId,
                    command.Actor,
                    commandDigest,
                    UpdateCommand,
                    after,
                    before,
                    snapshot.OwnerRevision,
                    impact.Obligations,
                    now), impact);
            });
    }

    public Task<ArticlePropertyDefinitionWriteReceipt> RenameAsync(
        RenameArticlePropertyDefinitionCommand command,
        CancellationToken cancellationToken = default)
    {
        ArticlePropertyDefinitionRecordedCommand recorded = ArticlePropertyDefinitionCommandHistory.Capture(command);
        command = recorded.Rename!;
        ValidateMutationIdentity(
            command.Actor,
            command.Owner,
            command.DefinitionId,
            command.RequestId,
            command.ExpectedOwnerRevision,
            command.ExpectedSchemaRevision);
        IReadOnlyList<ArticlePropertyLocalizedName> names = ArticlePropertyDefinitionContract.NormalizeDisplayNames(command.DisplayNames);
        string commandDigest = ArticlePropertyDefinitionContract.ComputeCommandDigest(
            RenameCommand,
            command.Actor.AdminPrincipalId,
            command.Owner.UserId,
            command.Owner.SiteScope,
            command.DefinitionId,
            command.ExpectedOwnerRevision,
            command.ExpectedSchemaRevision,
            ArticlePropertyDefinitionContract.ComputeDisplayNamesDigest(names));
        return ExecuteExistingAsync(
            command.Actor,
            command.DefinitionId,
            command.RequestId,
            commandDigest,
            command.ExpectedOwnerRevision,
            command.ExpectedSchemaRevision,
            RenameCommand,
            recorded,
            cancellationToken,
            command.Owner,
            async (snapshot, before, now, token) =>
            {
                if (before.Status == ArticlePropertyDefinitionStatus.Deleted)
                {
                    throw new ArticlePropertyDefinitionConflictException("article_property_definition_deleted");
                }
                ArticlePropertyDefinition after = WithDigest(before with
                {
                    DisplayNames = names,
                    SchemaRevision = before.SchemaRevision + 1,
                    UpdatedAtUtc = now
                });
                ArticlePropertyDefinitionImpact impact = await impactAuthority.GetImpactAsync(
                    before.Owner,
                    before,
                    after,
                    RenameCommand,
                    token).ConfigureAwait(false);
                return (after, CreateReceipt(
                    command.RequestId,
                    command.Actor,
                    commandDigest,
                    RenameCommand,
                    after,
                    before,
                    snapshot.OwnerRevision,
                    impact.Obligations,
                    now), impact);
            });
    }

    public Task<ArticlePropertyDefinitionWriteReceipt> DeprecateAsync(
        DeprecateArticlePropertyDefinitionCommand command,
        CancellationToken cancellationToken = default)
    {
        ArticlePropertyDefinitionRecordedCommand recorded = ArticlePropertyDefinitionCommandHistory.Capture(command);
        command = recorded.Deprecate!;
        ValidateMutationIdentity(
            command.Actor,
            command.Owner,
            command.DefinitionId,
            command.RequestId,
            command.ExpectedOwnerRevision,
            command.ExpectedSchemaRevision);
        string commandDigest = ArticlePropertyDefinitionContract.ComputeCommandDigest(
            DeprecateCommand,
            command.Actor.AdminPrincipalId,
            command.Owner.UserId,
            command.Owner.SiteScope,
            command.DefinitionId,
            command.ExpectedOwnerRevision,
            command.ExpectedSchemaRevision);
        return ExecuteExistingAsync(
            command.Actor,
            command.DefinitionId,
            command.RequestId,
            commandDigest,
            command.ExpectedOwnerRevision,
            command.ExpectedSchemaRevision,
            DeprecateCommand,
            recorded,
            cancellationToken,
            command.Owner,
            async (snapshot, before, now, token) =>
            {
                if (before.Status != ArticlePropertyDefinitionStatus.Active)
                {
                    throw new ArticlePropertyDefinitionConflictException("article_property_definition_not_active");
                }
                ArticlePropertyDefinition after = WithDigest(before with
                {
                    Status = ArticlePropertyDefinitionStatus.Deprecated,
                    SchemaRevision = before.SchemaRevision + 1,
                    UpdatedAtUtc = now
                });
                ArticlePropertyDefinitionImpact impact = await impactAuthority.GetImpactAsync(
                    before.Owner,
                    before,
                    after,
                    DeprecateCommand,
                    token).ConfigureAwait(false);
                return (after, CreateReceipt(
                    command.RequestId,
                    command.Actor,
                    commandDigest,
                    DeprecateCommand,
                    after,
                    before,
                    snapshot.OwnerRevision,
                    impact.Obligations,
                    now), impact);
            });
    }

    public Task<ArticlePropertyDefinitionWriteReceipt> DeleteAsync(
        DeleteArticlePropertyDefinitionCommand command,
        CancellationToken cancellationToken = default)
    {
        ArticlePropertyDefinitionRecordedCommand recorded = ArticlePropertyDefinitionCommandHistory.Capture(command);
        command = recorded.Delete!;
        ValidateMutationIdentity(
            command.Actor,
            command.Owner,
            command.DefinitionId,
            command.RequestId,
            command.ExpectedOwnerRevision,
            command.ExpectedSchemaRevision);
        string commandDigest = ArticlePropertyDefinitionContract.ComputeCommandDigest(
            DeleteCommand,
            command.Actor.AdminPrincipalId,
            command.Owner.UserId,
            command.Owner.SiteScope,
            command.DefinitionId,
            command.ExpectedOwnerRevision,
            command.ExpectedSchemaRevision);
        return ExecuteExistingAsync(
            command.Actor,
            command.DefinitionId,
            command.RequestId,
            commandDigest,
            command.ExpectedOwnerRevision,
            command.ExpectedSchemaRevision,
            DeleteCommand,
            recorded,
            cancellationToken,
            command.Owner,
            async (snapshot, before, now, token) =>
            {
                if (before.Status != ArticlePropertyDefinitionStatus.Deprecated)
                {
                    throw new ArticlePropertyDefinitionConflictException("article_property_delete_requires_deprecated");
                }
                ArticlePropertyDefinition after = WithDigest(before with
                {
                    Status = ArticlePropertyDefinitionStatus.Deleted,
                    SchemaRevision = before.SchemaRevision + 1,
                    UpdatedAtUtc = now
                });
                ArticlePropertyDefinitionImpact impact = await impactAuthority.GetImpactAsync(
                    before.Owner,
                    before,
                    after,
                    DeleteCommand,
                    token).ConfigureAwait(false);
                if (impact.AffectedValueCount is null)
                {
                    throw new ArticlePropertyDefinitionConflictException("article_property_delete_impact_unknown");
                }
                return (after, CreateReceipt(
                    command.RequestId,
                    command.Actor,
                    commandDigest,
                    DeleteCommand,
                    after,
                    before,
                    snapshot.OwnerRevision,
                    impact.Obligations,
                    now), impact);
            });
    }

    public async Task<ArticlePropertyDefinitionVerificationResult> VerifyAsync(
        ArticlePropertyDefinitionActor actor,
        ArticlePropertyDefinitionOwner owner,
        Guid definitionId,
        CancellationToken cancellationToken = default)
    {
        ValidateReadIdentity(actor, owner, definitionId);
        permissionAuthority.EnsureAllowed(actor, owner, manage: true);
        try
        {
            ArticlePropertyDefinitionVerificationSnapshot snapshot = await persistence.ReadVerificationSnapshotAsync(
                owner,
                definitionId,
                ArticlePropertyDefinitionContract.MaxVerificationReceipts,
                cancellationToken).ConfigureAwait(false)
                ?? throw new ArticlePropertyDefinitionNotFoundException();
            return verifier.Verify(snapshot);
        }
        catch (ArticlePropertyDefinitionBudgetExceededException exception)
            when (exception.Code == "article_property_verification_resource_budget_exceeded")
        {
            return new(false, [new("verification_resource_budget_exceeded", "owner replay evidence cannot be read completely within the resource budget")]);
        }
    }

    private async Task<ArticlePropertyDefinitionWriteReceipt> ExecuteExistingAsync(
        ArticlePropertyDefinitionActor actor,
        Guid definitionId,
        Guid requestId,
        string commandDigest,
        long expectedOwnerRevision,
        long expectedSchemaRevision,
        string commandKind,
        ArticlePropertyDefinitionRecordedCommand recorded,
        CancellationToken cancellationToken,
        ArticlePropertyDefinitionOwner owner,
        Func<ArticlePropertyDefinitionMutationSnapshot, ArticlePropertyDefinition, DateTime, CancellationToken,
            Task<(ArticlePropertyDefinition Definition, ArticlePropertyDefinitionWriteReceipt Receipt,
                ArticlePropertyDefinitionImpact Impact)>> planner)
    {
        ArticlePropertyDefinitionContract.ValidateOwner(owner);
        permissionAuthority.EnsureAllowed(actor, owner, manage: true);
        return await persistence.ExecuteAsync(
            owner,
            actor.AdminPrincipalId,
            requestId,
            commandDigest,
            definitionId,
            recorded,
            async (snapshot, token) =>
            {
                ArticlePropertyDefinition? target = snapshot.TargetDefinition;
                if (target is null)
                {
                    throw new ArticlePropertyDefinitionNotFoundException();
                }
                if (target.Owner != owner)
                {
                    throw new ArticlePropertyDefinitionIntegrityException("article_property_definition_owner_mismatch");
                }
                permissionAuthority.EnsureAllowed(actor, target.Owner, manage: true);
                EnsureOwnerRevision(snapshot, expectedOwnerRevision);
                if (target.SchemaRevision != expectedSchemaRevision)
                {
                    throw new ArticlePropertyDefinitionConflictException("article_property_schema_revision_cas_stale");
                }
                DateTime now = UtcNow();
                (ArticlePropertyDefinition definition, ArticlePropertyDefinitionWriteReceipt receipt,
                    ArticlePropertyDefinitionImpact impact) =
                    await planner(snapshot, target, now, token).ConfigureAwait(false);
                return new(snapshot.OwnerRevision, target, definition, receipt, impact);
            },
            cancellationToken).ConfigureAwait(false);
    }

    private ArticlePropertyDefinition BuildDefinition(
        ArticlePropertyDefinitionOwner owner,
        Guid definitionId,
        string machineKey,
        IReadOnlyList<ArticlePropertyLocalizedName> displayNames,
        ArticlePropertyValueType valueType,
        ArticlePropertyCardinality cardinality,
        bool required,
        ArticlePropertyPresencePolicy presence,
        ArticlePropertyDefaultValue? defaultValue,
        ArticlePropertyConstraints constraints,
        IReadOnlyList<ArticlePropertyOption> options,
        ArticlePropertyReferencePolicy? referencePolicy,
        ArticlePropertyUrlPolicy? urlPolicy,
        bool searchEligible,
        bool filterable,
        bool sortable,
        ArticlePropertyDisplayPlacement displayPlacement,
        ArticlePropertyVisibilityScope visibilityScope,
        ArticlePropertyDefinitionStatus status,
        long schemaRevision,
        DateTime createdAtUtc,
        DateTime updatedAtUtc)
    {
        ArticlePropertyDefinitionContract.ValidateCommandPayloadShape(
            presence,
            defaultValue,
            constraints,
            options,
            urlPolicy);
        if (valueType == ArticlePropertyValueType.Url && urlPolicy is null)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_url_policy_missing");
        }
        string normalizedMachineKey = ArticlePropertyDefinitionContract.NormalizeMachineKey(machineKey);
        IReadOnlyList<ArticlePropertyLocalizedName> normalizedNames =
            ArticlePropertyDefinitionContract.NormalizeDisplayNames(displayNames);
        IReadOnlyList<ArticlePropertyOption> normalizedOptions = NormalizeOptions(options);
        ArticlePropertyDefaultValue? normalizedDefault = NormalizeDefault(defaultValue, valueType, urlPolicy);
        ArticlePropertyUrlPolicy? normalizedUrlPolicy = NormalizeUrlPolicy(urlPolicy);
        var definition = new ArticlePropertyDefinition(
            ArticlePropertyDefinitionContract.SchemaVersion,
            definitionId,
            owner,
            normalizedMachineKey,
            normalizedNames,
            valueType,
            cardinality,
            required,
            presence,
            normalizedDefault,
            constraints,
            normalizedOptions,
            referencePolicy,
            normalizedUrlPolicy,
            searchEligible,
            filterable,
            sortable,
            displayPlacement,
            visibilityScope,
            status,
            schemaRevision,
            createdAtUtc,
            updatedAtUtc,
            string.Empty);
        if (createdAtUtc != DateTime.MinValue)
        {
            definition = definition with
            {
                ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition)
            };
            ArticlePropertyDefinitionContract.ValidateDefinition(definition);
        }
        return definition;
    }

    private static IReadOnlyList<ArticlePropertyOption> NormalizeOptions(IReadOnlyList<ArticlePropertyOption> options)
    {
        ArgumentNullException.ThrowIfNull(options);
        return Array.AsReadOnly(options
            .Select(option =>
            {
                ArgumentNullException.ThrowIfNull(option);
                string label = option.Label
                    ?? throw new ArticlePropertyDefinitionValidationException("article_property_option_label_invalid");
                return option with
                {
                    Label = label.Trim().Normalize(System.Text.NormalizationForm.FormC),
                    LocalizedLabels = ArticlePropertyDefinitionContract.NormalizeDisplayNames(option.LocalizedLabels.Count == 0
                        ? [new ArticlePropertyLocalizedName("en", label)]
                        : option.LocalizedLabels)
                };
            })
            .OrderBy(static option => option.Order)
            .ThenBy(static option => option.OptionId)
            .ToArray());
    }

    private static ArticlePropertyUrlPolicy? NormalizeUrlPolicy(ArticlePropertyUrlPolicy? policy)
        => policy is null
            ? null
            : policy with
            {
                AllowedSchemes = policy.AllowedSchemes
                    .Select(static scheme => scheme.Trim().ToLowerInvariant())
                    .Distinct(StringComparer.Ordinal)
                    .Order(StringComparer.Ordinal)
                    .ToArray()
            };

    private static ArticlePropertyDefaultValue? NormalizeDefault(
        ArticlePropertyDefaultValue? value,
        ArticlePropertyValueType valueType,
        ArticlePropertyUrlPolicy? urlPolicy)
    {
        if (value is null || value.Kind == ArticlePropertyDefaultKind.None)
        {
            return null;
        }
        if (value.Kind == ArticlePropertyDefaultKind.Scalar && value.Scalar is not null)
        {
            string scalar = valueType == ArticlePropertyValueType.Url
                ? ArticlePropertyDefinitionContract.NormalizeUrl(value.Scalar, urlPolicy!)
                : ArticlePropertyDefinitionContract.NormalizeScalar(valueType, value.Scalar);
            return new(ArticlePropertyDefaultKind.Scalar, scalar);
        }
        return value with
        {
            OptionIds = value.OptionIds.Order().ToArray(),
            ArticleIds = value.ArticleIds.Order().ToArray()
        };
    }

    private ArticlePropertyDefinition WithDigest(ArticlePropertyDefinition definition)
        => definition with
        {
            ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition)
        };

    private ArticlePropertyDefinitionWriteReceipt CreateReceipt(
        Guid requestId,
        ArticlePropertyDefinitionActor actor,
        string commandDigest,
        string commandKind,
        ArticlePropertyDefinition after,
        ArticlePropertyDefinition? before,
        long previousOwnerRevision,
        IReadOnlyList<ArticlePropertyDefinitionObligation> obligations,
        DateTime now)
    {
        Guid auditReference = Guid.CreateVersion7();
        var receipt = new ArticlePropertyDefinitionWriteReceipt(
            Guid.CreateVersion7(),
            requestId,
            actor.AdminPrincipalId,
            after.Owner,
            commandKind,
            commandDigest,
            after.DefinitionId,
            previousOwnerRevision,
            previousOwnerRevision + 1,
            before?.SchemaRevision ?? 0,
            after.SchemaRevision,
            after.Status,
            before?.ContentDigest ?? ArticlePropertyDefinitionContract.ComputeCommandDigest("absent", after.DefinitionId),
            after.ContentDigest,
            ArticlePropertyDefinitionContract.ComputeConstraintDigest(after.Constraints),
            ArticlePropertyDefinitionContract.ComputeOptionsDigest(after.Options),
            ArticlePropertyDefinitionContract.ComputePolicyDigest(after.ReferencePolicy, after.UrlPolicy),
            ArticlePropertyDefinitionContract.ComputeFlagsDigest(after),
            obligations,
            auditReference,
            string.Empty,
            string.Empty,
            now);
        receipt = receipt with
        {
            AuditDigest = ArticlePropertyDefinitionContract.ComputeReceiptAuditDigest(receipt)
        };
        return receipt with
        {
            ContentDigest = ArticlePropertyDefinitionContract.ComputeReceiptDigest(receipt)
        };
    }

    private static string ComputeCreateCommandDigest(
        CreateArticlePropertyDefinitionCommand command,
        ArticlePropertyDefinition normalized)
        => ArticlePropertyDefinitionContract.ComputeCommandDigest(
            CreateCommand,
            command.Actor.AdminPrincipalId,
            command.Owner.UserId,
            command.Owner.SiteScope,
            command.DefinitionId,
            command.ExpectedOwnerRevision,
            normalized.MachineKey,
            ArticlePropertyDefinitionContract.ComputeDisplayNamesDigest(normalized.DisplayNames),
            (int)normalized.ValueType,
            (int)normalized.Cardinality,
            normalized.Required,
            (int)normalized.Presence.Missing,
            (int)normalized.Presence.Null,
            (int)normalized.Presence.Empty,
            ArticlePropertyDefinitionContract.ComputeDefaultDigest(normalized.DefaultValue),
            ArticlePropertyDefinitionContract.ComputeConstraintDigest(normalized.Constraints),
            ArticlePropertyDefinitionContract.ComputeOptionsDigest(normalized.Options),
            ArticlePropertyDefinitionContract.ComputePolicyDigest(normalized.ReferencePolicy, normalized.UrlPolicy),
            normalized.SearchEligible,
            normalized.Filterable,
            normalized.Sortable,
            (int)normalized.DisplayPlacement,
            (int)normalized.VisibilityScope);

    private static void ValidateCreateCommand(CreateArticlePropertyDefinitionCommand command)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArticlePropertyDefinitionContract.ValidateActor(command.Actor);
        ArticlePropertyDefinitionContract.ValidateOwner(command.Owner);
        ArticlePropertyDefinitionContract.ValidateRequestId(command.RequestId);
        if (command.DefinitionId == Guid.Empty)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_definition_id_invalid");
        }
        ArticlePropertyDefinitionContract.ValidateExpectedRevision(
            command.ExpectedOwnerRevision,
            "article_property_expected_owner_revision_invalid");
    }

    private static void ValidateMutationIdentity(
        ArticlePropertyDefinitionActor actor,
        ArticlePropertyDefinitionOwner owner,
        Guid definitionId,
        Guid requestId,
        long expectedOwnerRevision,
        long expectedSchemaRevision)
    {
        ArticlePropertyDefinitionContract.ValidateActor(actor);
        ArticlePropertyDefinitionContract.ValidateOwner(owner);
        ArticlePropertyDefinitionContract.ValidateRequestId(requestId);
        if (definitionId == Guid.Empty)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_definition_id_invalid");
        }
        ArticlePropertyDefinitionContract.ValidateExpectedRevision(
            expectedOwnerRevision,
            "article_property_expected_owner_revision_invalid");
        if (expectedSchemaRevision <= 0)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_expected_schema_revision_invalid");
        }
    }

    private static void ValidateReadIdentity(
        ArticlePropertyDefinitionActor actor,
        ArticlePropertyDefinitionOwner owner,
        Guid definitionId)
    {
        ArticlePropertyDefinitionContract.ValidateActor(actor);
        ArticlePropertyDefinitionContract.ValidateOwner(owner);
        if (definitionId == Guid.Empty)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_definition_id_invalid");
        }
    }

    private static void ValidatePageLimit(int limit)
    {
        if (limit is < 1 or > ArticlePropertyDefinitionContract.MaxPageSize)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_page_limit_invalid");
        }
    }

    private static void EnsureOwnerRevision(
        ArticlePropertyDefinitionMutationSnapshot snapshot,
        long expectedRevision)
    {
        if (snapshot.OwnerRevision != expectedRevision)
        {
            throw new ArticlePropertyDefinitionConflictException("article_property_owner_revision_cas_stale");
        }
    }

    private static void EnsureMachineKeyAvailable(
        IReadOnlyList<ArticlePropertyDefinition> definitions,
        string machineKey,
        Guid? exceptDefinitionId)
    {
        if (definitions.Any(definition => definition.Status != ArticlePropertyDefinitionStatus.Deleted
            && definition.DefinitionId != exceptDefinitionId
            && string.Equals(definition.MachineKey, machineKey, StringComparison.Ordinal)))
        {
            throw new ArticlePropertyDefinitionConflictException("article_property_machine_key_conflict");
        }
    }

    private static void EnsureOptionLifecycle(
        IReadOnlyList<ArticlePropertyOption> before,
        IReadOnlyList<ArticlePropertyOption> after)
    {
        var nextById = after.ToDictionary(static option => option.OptionId);
        foreach (ArticlePropertyOption previous in before)
        {
            if (!nextById.TryGetValue(previous.OptionId, out ArticlePropertyOption? next))
            {
                throw new ArticlePropertyDefinitionConflictException(
                    "article_property_option_removal_requires_explicit_delete");
            }
            if (previous.Status == ArticlePropertyOptionStatus.Deleted
                && (next.Status != ArticlePropertyOptionStatus.Deleted
                    || !string.Equals(previous.Label, next.Label, StringComparison.Ordinal)
                    || previous.Order != next.Order
                    || !previous.LocalizedLabels.SequenceEqual(next.LocalizedLabels)))
            {
                throw new ArticlePropertyDefinitionConflictException("article_property_option_deleted_immutable");
            }
            if (previous.Status == ArticlePropertyOptionStatus.Deprecated
                && next.Status == ArticlePropertyOptionStatus.Active)
            {
                throw new ArticlePropertyDefinitionConflictException("article_property_option_reactivation_forbidden");
            }
        }
    }

    private DateTime UtcNow()
    {
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        long ticks = now.Ticks - (now.Ticks % TimeSpan.TicksPerMicrosecond);
        return new DateTime(ticks, DateTimeKind.Utc);
    }
}
