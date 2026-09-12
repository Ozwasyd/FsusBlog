using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>The exact-one server authority for article template facts and immutable versions.</summary>
public sealed class ArticleTemplateStore(
    IArticleTemplatePersistence persistence,
    IArticleTemplatePermissionAuthority permissionAuthority,
    IArticleTemplateReferenceAuthority referenceAuthority,
    IArticleTemplateVerifier verifier,
    TimeProvider timeProvider) : IArticleTemplateStore
{
    private const string CreateCommand = "create";
    private const string CreateVersionCommand = "new-version";
    private const string RenameCommand = "rename";
    private const string RetireCommand = "retire";
    private const string DeleteCommand = "delete";

    public async Task<ArticleTemplateWriteReceipt> CreateAsync(
        CreateArticleTemplateCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateCreateCommand(command);
        permissionAuthority.EnsureAllowed(command.Actor, command.Scope, ArticleTemplatePermission.Manage);
        string name = ArticleTemplateContract.NormalizeName(command.Name);
        string nameKey = ArticleTemplateContract.NormalizeNameKey(name);
        string? description = ArticleTemplateContract.NormalizeDescription(command.Description);
        ArticleTemplateContract.ValidateSource(command.Source);
        ArticleTemplateContract.ValidateDefaults(command.Defaults);
        string defaultsDigest = ArticleTemplateContract.ComputeDefaultsDigest(command.Defaults);
        string commandDigest = ArticleTemplateContract.ComputeCommandDigest(
            CreateCommand,
            command.Actor.AdminPrincipalId,
            (int)command.Scope.Kind,
            command.Scope.OwnerAdminPrincipalId,
            command.TemplateId,
            command.VersionId,
            command.ExpectedScopeRevision,
            name,
            description,
            command.Source.ToArray(),
            defaultsDigest);

        ArticleTemplateWriteReceipt receipt = await persistence.ExecuteAsync(
            command.Scope,
            command.Actor.AdminPrincipalId,
            command.RequestId,
            commandDigest,
            command.TemplateId,
            async (snapshot, token) =>
            {
                permissionAuthority.EnsureAllowed(command.Actor, command.Scope, ArticleTemplatePermission.Manage);
                EnsureScopeRevision(snapshot, command.ExpectedScopeRevision);
                if (snapshot.TargetDefinition is not null)
                {
                    throw new ArticleTemplateConflictException("article_template_id_conflict");
                }
                EnsureNameAvailable(snapshot.Definitions, nameKey, null);
                if (snapshot.Definitions.Count(static definition => definition.Status != ArticleTemplateStatus.Deleted)
                    >= ArticleTemplateContract.MaxTemplatesPerScope)
                {
                    throw new ArticleTemplateBudgetExceededException("article_template_scope_budget_exceeded");
                }
                await referenceAuthority.ValidateAsync(command.Actor, command.Scope, command.Defaults, token)
                    .ConfigureAwait(false);

                DateTime now = CanonicalTimestamp(timeProvider);
                ArticleTemplateVersion version = CreateVersion(
                    command.TemplateId,
                    command.VersionId,
                    1,
                    command.Actor.AdminPrincipalId,
                    now,
                    command.Source,
                    command.Defaults,
                    defaultsDigest);
                ArticleTemplateDefinition definition = CreateDefinition(
                    command.TemplateId,
                    command.Scope,
                    name,
                    nameKey,
                    description,
                    ArticleTemplateStatus.Active,
                    1,
                    version.VersionId,
                    1,
                    now,
                    now);
                ArticleTemplateWriteReceipt plannedReceipt = CreateReceipt(
                    command.RequestId,
                    command.Actor,
                    CreateCommand,
                    commandDigest,
                    definition,
                    version,
                    snapshot.ScopeRevision,
                    previousTemplateRevision: 0,
                    ArticleTemplateDeleteDisposition.NotApplicable,
                    now);
                return new(snapshot.ScopeRevision, null, definition, version, plannedReceipt);
            },
            cancellationToken).ConfigureAwait(false);
        return receipt;
    }

    public async Task<ArticleTemplateDefinition?> GetAsync(
        ArticleTemplateActor actor,
        Guid templateId,
        ArticleTemplatePermission permission = ArticleTemplatePermission.Read,
        CancellationToken cancellationToken = default)
    {
        ValidateReadIdentity(actor, templateId, permission);
        ArticleTemplateDefinition? definition = await persistence.GetAsync(templateId, cancellationToken)
            .ConfigureAwait(false);
        if (definition is null)
        {
            return null;
        }
        permissionAuthority.EnsureAllowed(actor, definition.Scope, permission);
        EnsureReadableStatus(definition, permission);
        ArticleTemplateContract.ValidateDefinition(definition);
        if (permission == ArticleTemplatePermission.Use)
        {
            ArticleTemplateVersion? current = await persistence.GetVersionAsync(
                templateId,
                definition.CurrentVersionId,
                cancellationToken).ConfigureAwait(false);
            if (current is null)
            {
                throw new ArticleTemplateIntegrityException("article_template_current_version_missing");
            }
            await referenceAuthority.ValidateAsync(actor, definition.Scope, current.Defaults, cancellationToken)
                .ConfigureAwait(false);
        }
        return definition;
    }

    public async Task<ArticleTemplatePage> ListAsync(
        ArticleTemplateActor actor,
        ArticleTemplateScope scope,
        ArticleTemplatePageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default)
    {
        ArticleTemplateContract.ValidateActor(actor);
        ArticleTemplateContract.ValidateScope(scope);
        permissionAuthority.EnsureAllowed(actor, scope, ArticleTemplatePermission.Read);
        ValidatePageLimit(limit);
        if (cursor is not null
            && (cursor.TemplateId == Guid.Empty
                || string.IsNullOrEmpty(cursor.NameKey)
                || cursor.NameKey.Length > ArticleTemplateContract.MaxNameCharacters * 2))
        {
            throw new ArticleTemplateValidationException("article_template_page_cursor_invalid");
        }
        ArticleTemplatePage page = await persistence.ListAsync(scope, cursor, limit, cancellationToken)
            .ConfigureAwait(false);
        foreach (ArticleTemplateDefinition definition in page.Items)
        {
            ArticleTemplateContract.ValidateDefinition(definition);
            if (definition.Scope != scope || definition.Status == ArticleTemplateStatus.Deleted)
            {
                throw new ArticleTemplateIntegrityException("article_template_page_scope_invalid");
            }
        }
        return page;
    }

    public async Task<ArticleTemplateVersion?> GetVersionAsync(
        ArticleTemplateActor actor,
        Guid templateId,
        Guid versionId,
        ArticleTemplatePermission permission = ArticleTemplatePermission.Read,
        CancellationToken cancellationToken = default)
    {
        ValidateReadIdentity(actor, templateId, permission);
        if (versionId == Guid.Empty)
        {
            throw new ArticleTemplateValidationException("article_template_version_id_invalid");
        }
        ArticleTemplateDefinition? definition = await persistence.GetAsync(templateId, cancellationToken)
            .ConfigureAwait(false);
        if (definition is null)
        {
            return null;
        }
        permissionAuthority.EnsureAllowed(actor, definition.Scope, permission);
        EnsureReadableStatus(definition, permission);
        ArticleTemplateVersion? version = await persistence.GetVersionAsync(templateId, versionId, cancellationToken)
            .ConfigureAwait(false);
        if (version is null)
        {
            return null;
        }
        ArticleTemplateContract.ValidateVersion(version);
        if (permission == ArticleTemplatePermission.Use)
        {
            await referenceAuthority.ValidateAsync(actor, definition.Scope, version.Defaults, cancellationToken)
                .ConfigureAwait(false);
        }
        return version;
    }

    public async Task<ArticleTemplateVersionPage> ListVersionsAsync(
        ArticleTemplateActor actor,
        Guid templateId,
        int? afterVersionNumber,
        int limit,
        CancellationToken cancellationToken = default)
    {
        ValidateReadIdentity(actor, templateId, ArticleTemplatePermission.Read);
        ValidatePageLimit(limit);
        if (afterVersionNumber is <= 0 or > ArticleTemplateContract.MaxVersionsPerTemplate)
        {
            throw new ArticleTemplateValidationException("article_template_version_cursor_invalid");
        }
        ArticleTemplateDefinition? definition = await persistence.GetAsync(templateId, cancellationToken)
            .ConfigureAwait(false);
        if (definition is null)
        {
            return new([], null);
        }
        permissionAuthority.EnsureAllowed(actor, definition.Scope, ArticleTemplatePermission.Read);
        EnsureReadableStatus(definition, ArticleTemplatePermission.Read);
        ArticleTemplateVersionPage page = await persistence.ListVersionsAsync(
            templateId,
            afterVersionNumber,
            limit,
            cancellationToken).ConfigureAwait(false);
        foreach (ArticleTemplateVersion version in page.Items)
        {
            ArticleTemplateContract.ValidateVersion(version);
            if (version.TemplateId != templateId)
            {
                throw new ArticleTemplateIntegrityException("article_template_version_page_scope_invalid");
            }
        }
        return page;
    }

    public async Task<ArticleTemplateWriteReceipt> CreateVersionAsync(
        CreateArticleTemplateVersionCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateMutationIdentity(
            command.Actor,
            command.TemplateId,
            command.VersionId,
            command.RequestId,
            command.ExpectedScopeRevision,
            command.ExpectedTemplateRevision);
        if (command.ExpectedCurrentVersionNumber is <= 0 or >= ArticleTemplateContract.MaxVersionsPerTemplate)
        {
            throw new ArticleTemplateValidationException("article_template_expected_version_invalid");
        }
        ArticleTemplateContract.ValidateSource(command.Source);
        ArticleTemplateContract.ValidateDefaults(command.Defaults);
        string defaultsDigest = ArticleTemplateContract.ComputeDefaultsDigest(command.Defaults);
        string commandDigest = ArticleTemplateContract.ComputeCommandDigest(
            CreateVersionCommand,
            command.Actor.AdminPrincipalId,
            command.TemplateId,
            command.VersionId,
            command.ExpectedScopeRevision,
            command.ExpectedTemplateRevision,
            command.ExpectedCurrentVersionNumber,
            command.Source.ToArray(),
            defaultsDigest);
        return await ExecuteExistingMutationAsync(
            command.Actor,
            command.TemplateId,
            command.RequestId,
            commandDigest,
            command.ExpectedScopeRevision,
            command.ExpectedTemplateRevision,
            CreateVersionCommand,
            cancellationToken,
            async (snapshot, definition, now, token) =>
            {
                if (definition.Status != ArticleTemplateStatus.Active)
                {
                    throw new ArticleTemplateConflictException("article_template_not_active");
                }
                if (definition.CurrentVersionNumber != command.ExpectedCurrentVersionNumber)
                {
                    throw new ArticleTemplateConflictException("article_template_version_cas_stale");
                }
                if (snapshot.TargetVersions.Count >= ArticleTemplateContract.MaxVersionsPerTemplate)
                {
                    throw new ArticleTemplateBudgetExceededException("article_template_version_budget_exceeded");
                }
                if (snapshot.TargetVersions.Any(version => version.VersionId == command.VersionId))
                {
                    throw new ArticleTemplateConflictException("article_template_version_id_conflict");
                }
                await referenceAuthority.ValidateAsync(command.Actor, definition.Scope, command.Defaults, token)
                    .ConfigureAwait(false);
                int nextVersionNumber = definition.CurrentVersionNumber + 1;
                ArticleTemplateVersion version = CreateVersion(
                    definition.TemplateId,
                    command.VersionId,
                    nextVersionNumber,
                    command.Actor.AdminPrincipalId,
                    now,
                    command.Source,
                    command.Defaults,
                    defaultsDigest);
                ArticleTemplateDefinition updated = WithDefinitionState(
                    definition,
                    definition.Name,
                    definition.NameKey,
                    definition.Description,
                    definition.Status,
                    definition.Revision + 1,
                    version.VersionId,
                    version.VersionNumber,
                    now);
                return (updated, version, ArticleTemplateDeleteDisposition.NotApplicable);
            }).ConfigureAwait(false);
    }

    public async Task<ArticleTemplateWriteReceipt> RenameAsync(
        RenameArticleTemplateCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateMutationIdentity(
            command.Actor,
            command.TemplateId,
            null,
            command.RequestId,
            command.ExpectedScopeRevision,
            command.ExpectedTemplateRevision);
        string name = ArticleTemplateContract.NormalizeName(command.Name);
        string nameKey = ArticleTemplateContract.NormalizeNameKey(name);
        string? description = ArticleTemplateContract.NormalizeDescription(command.Description);
        string commandDigest = ArticleTemplateContract.ComputeCommandDigest(
            RenameCommand,
            command.Actor.AdminPrincipalId,
            command.TemplateId,
            command.ExpectedScopeRevision,
            command.ExpectedTemplateRevision,
            name,
            description);
        return await ExecuteExistingMutationAsync(
            command.Actor,
            command.TemplateId,
            command.RequestId,
            commandDigest,
            command.ExpectedScopeRevision,
            command.ExpectedTemplateRevision,
            RenameCommand,
            cancellationToken,
            (snapshot, definition, now, _) =>
            {
                if (definition.Status == ArticleTemplateStatus.Deleted)
                {
                    throw new ArticleTemplateConflictException("article_template_deleted");
                }
                EnsureNameAvailable(snapshot.Definitions, nameKey, definition.TemplateId);
                ArticleTemplateDefinition updated = WithDefinitionState(
                    definition,
                    name,
                    nameKey,
                    description,
                    definition.Status,
                    definition.Revision + 1,
                    definition.CurrentVersionId,
                    definition.CurrentVersionNumber,
                    now);
                return Task.FromResult((updated, (ArticleTemplateVersion?)null, ArticleTemplateDeleteDisposition.NotApplicable));
            }).ConfigureAwait(false);
    }

    public Task<ArticleTemplateWriteReceipt> RetireAsync(
        RetireArticleTemplateCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateMutationIdentity(
            command.Actor,
            command.TemplateId,
            null,
            command.RequestId,
            command.ExpectedScopeRevision,
            command.ExpectedTemplateRevision);
        string commandDigest = ArticleTemplateContract.ComputeCommandDigest(
            RetireCommand,
            command.Actor.AdminPrincipalId,
            command.TemplateId,
            command.ExpectedScopeRevision,
            command.ExpectedTemplateRevision);
        return ExecuteExistingMutationAsync(
            command.Actor,
            command.TemplateId,
            command.RequestId,
            commandDigest,
            command.ExpectedScopeRevision,
            command.ExpectedTemplateRevision,
            RetireCommand,
            cancellationToken,
            (_, definition, now, _) =>
            {
                if (definition.Status != ArticleTemplateStatus.Active)
                {
                    throw new ArticleTemplateConflictException("article_template_not_active");
                }
                ArticleTemplateDefinition updated = WithDefinitionState(
                    definition,
                    definition.Name,
                    definition.NameKey,
                    definition.Description,
                    ArticleTemplateStatus.Retired,
                    definition.Revision + 1,
                    definition.CurrentVersionId,
                    definition.CurrentVersionNumber,
                    now);
                return Task.FromResult((updated, (ArticleTemplateVersion?)null, ArticleTemplateDeleteDisposition.NotApplicable));
            });
    }

    public Task<ArticleTemplateWriteReceipt> DeleteAsync(
        DeleteArticleTemplateCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateMutationIdentity(
            command.Actor,
            command.TemplateId,
            null,
            command.RequestId,
            command.ExpectedScopeRevision,
            command.ExpectedTemplateRevision);
        string commandDigest = ArticleTemplateContract.ComputeCommandDigest(
            DeleteCommand,
            command.Actor.AdminPrincipalId,
            command.TemplateId,
            command.ExpectedScopeRevision,
            command.ExpectedTemplateRevision);
        return ExecuteExistingMutationAsync(
            command.Actor,
            command.TemplateId,
            command.RequestId,
            commandDigest,
            command.ExpectedScopeRevision,
            command.ExpectedTemplateRevision,
            DeleteCommand,
            cancellationToken,
            (snapshot, definition, now, _) =>
            {
                if (definition.Status != ArticleTemplateStatus.Retired)
                {
                    throw new ArticleTemplateConflictException("article_template_delete_requires_retired");
                }
                if (snapshot.TargetUsageCount != 0)
                {
                    throw new ArticleTemplateConflictException("article_template_delete_in_use");
                }
                ArticleTemplateDefinition updated = WithDefinitionState(
                    definition,
                    definition.Name,
                    definition.NameKey,
                    definition.Description,
                    ArticleTemplateStatus.Deleted,
                    definition.Revision + 1,
                    definition.CurrentVersionId,
                    definition.CurrentVersionNumber,
                    now);
                return Task.FromResult((
                    updated,
                    (ArticleTemplateVersion?)null,
                    ArticleTemplateDeleteDisposition.TombstonedHistoryPreserved));
            });
    }

    public async Task<ArticleTemplateVerificationResult> VerifyAsync(
        ArticleTemplateActor actor,
        Guid templateId,
        CancellationToken cancellationToken = default)
    {
        ValidateReadIdentity(actor, templateId, ArticleTemplatePermission.Manage);
        ArticleTemplateDefinition? definition = await persistence.GetAsync(templateId, cancellationToken)
            .ConfigureAwait(false);
        if (definition is null)
        {
            throw new ArticleTemplateNotFoundException();
        }
        permissionAuthority.EnsureAllowed(actor, definition.Scope, ArticleTemplatePermission.Manage);
        ArticleTemplateVerificationSnapshot? snapshot = await persistence.ReadVerificationSnapshotAsync(
            templateId,
            ArticleTemplateContract.MaxVerificationReceipts,
            cancellationToken).ConfigureAwait(false);
        if (snapshot is null)
        {
            throw new ArticleTemplateNotFoundException();
        }
        ArticleTemplateVerificationResult structural = verifier.Verify(snapshot);
        var violations = structural.Violations.ToList();
        foreach (ArticleTemplateVersion version in snapshot.Versions)
        {
            try
            {
                await referenceAuthority.ValidateAsync(actor, definition.Scope, version.Defaults, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (ArticleTemplateReferenceException exception)
            {
                violations.Add(new(
                    "reference_invalid",
                    $"{version.VersionId:D}:{exception.Code}"));
            }
        }
        return new(violations.Count == 0, Array.AsReadOnly(violations.ToArray()));
    }

    private async Task<ArticleTemplateWriteReceipt> ExecuteExistingMutationAsync(
        ArticleTemplateActor actor,
        Guid templateId,
        Guid requestId,
        string commandDigest,
        long expectedScopeRevision,
        long expectedTemplateRevision,
        string commandKind,
        CancellationToken cancellationToken,
        Func<ArticleTemplateMutationSnapshot, ArticleTemplateDefinition, DateTime, CancellationToken,
            Task<(ArticleTemplateDefinition Definition, ArticleTemplateVersion? Version, ArticleTemplateDeleteDisposition DeleteDisposition)>> planner)
    {
        ArticleTemplateDefinition? preflight = await persistence.GetAsync(templateId, cancellationToken)
            .ConfigureAwait(false);
        if (preflight is null)
        {
            throw new ArticleTemplateNotFoundException();
        }
        permissionAuthority.EnsureAllowed(actor, preflight.Scope, ArticleTemplatePermission.Manage);
        ArticleTemplateWriteReceipt receipt = await persistence.ExecuteAsync(
            preflight.Scope,
            actor.AdminPrincipalId,
            requestId,
            commandDigest,
            templateId,
            async (snapshot, token) =>
            {
                ArticleTemplateDefinition definition = snapshot.TargetDefinition
                    ?? throw new ArticleTemplateNotFoundException();
                permissionAuthority.EnsureAllowed(actor, definition.Scope, ArticleTemplatePermission.Manage);
                EnsureScopeRevision(snapshot, expectedScopeRevision);
                if (definition.Revision != expectedTemplateRevision)
                {
                    throw new ArticleTemplateConflictException("article_template_revision_cas_stale");
                }
                DateTime now = CanonicalTimestamp(timeProvider);
                var planned = await planner(snapshot, definition, now, token).ConfigureAwait(false);
                ArticleTemplateVersion currentVersion = planned.Version
                    ?? snapshot.TargetVersions.SingleOrDefault(
                        version => version.VersionId == planned.Definition.CurrentVersionId)
                    ?? throw new ArticleTemplateIntegrityException("article_template_current_version_missing");
                ArticleTemplateWriteReceipt plannedReceipt = CreateReceipt(
                    requestId,
                    actor,
                    commandKind,
                    commandDigest,
                    planned.Definition,
                    currentVersion,
                    snapshot.ScopeRevision,
                    definition.Revision,
                    planned.DeleteDisposition,
                    now,
                    versionCreated: planned.Version is not null);
                return new(snapshot.ScopeRevision, definition, planned.Definition, planned.Version, plannedReceipt);
            },
            cancellationToken).ConfigureAwait(false);
        return receipt;
    }

    private static ArticleTemplateDefinition CreateDefinition(
        Guid templateId,
        ArticleTemplateScope scope,
        string name,
        string nameKey,
        string? description,
        ArticleTemplateStatus status,
        long revision,
        Guid currentVersionId,
        int currentVersionNumber,
        DateTime createdAtUtc,
        DateTime updatedAtUtc)
    {
        var definition = new ArticleTemplateDefinition(
            ArticleTemplateContract.SchemaVersion,
            templateId,
            scope,
            name,
            nameKey,
            description,
            status,
            revision,
            currentVersionId,
            currentVersionNumber,
            createdAtUtc,
            updatedAtUtc,
            string.Empty);
        definition = definition with
        {
            ContentDigest = ArticleTemplateContract.ComputeDefinitionDigest(definition)
        };
        ArticleTemplateContract.ValidateDefinition(definition);
        return definition;
    }

    private static ArticleTemplateDefinition WithDefinitionState(
        ArticleTemplateDefinition current,
        string name,
        string nameKey,
        string? description,
        ArticleTemplateStatus status,
        long revision,
        Guid currentVersionId,
        int currentVersionNumber,
        DateTime updatedAtUtc)
        => CreateDefinition(
            current.TemplateId,
            current.Scope,
            name,
            nameKey,
            description,
            status,
            revision,
            currentVersionId,
            currentVersionNumber,
            current.CreatedAtUtc,
            updatedAtUtc);

    private static ArticleTemplateVersion CreateVersion(
        Guid templateId,
        Guid versionId,
        int versionNumber,
        long actorAdminPrincipalId,
        DateTime now,
        ArticleTemplateSource source,
        ArticleTemplateDefaults defaults,
        string defaultsDigest)
    {
        var version = new ArticleTemplateVersion(
            ArticleTemplateContract.SchemaVersion,
            templateId,
            versionId,
            versionNumber,
            actorAdminPrincipalId,
            now,
            ArticleTemplateSource.FromBytes(source.AsSpan()),
            defaults,
            defaultsDigest,
            string.Empty);
        version = version with
        {
            ContentDigest = ArticleTemplateContract.ComputeVersionDigest(version)
        };
        ArticleTemplateContract.ValidateVersion(version);
        return version;
    }

    private static ArticleTemplateWriteReceipt CreateReceipt(
        Guid requestId,
        ArticleTemplateActor actor,
        string commandKind,
        string commandDigest,
        ArticleTemplateDefinition definition,
        ArticleTemplateVersion version,
        long previousScopeRevision,
        long previousTemplateRevision,
        ArticleTemplateDeleteDisposition deleteDisposition,
        DateTime now,
        bool versionCreated = true)
    {
        var receipt = new ArticleTemplateWriteReceipt(
            Guid.NewGuid(),
            requestId,
            actor.AdminPrincipalId,
            commandKind,
            commandDigest,
            definition.TemplateId,
            versionCreated ? version.VersionId : null,
            versionCreated ? version.VersionNumber : null,
            definition.Scope,
            previousScopeRevision,
            previousScopeRevision + 1,
            previousTemplateRevision,
            definition.Revision,
            ArticleTemplatePermission.Manage,
            ArticleTemplateContract.ComputePermissionDigest(actor),
            version.DefaultsDigest,
            definition.Status,
            definition.ContentDigest,
            versionCreated ? version.ContentDigest : string.Empty,
            deleteDisposition,
            now,
            Guid.NewGuid(),
            string.Empty,
            string.Empty);
        receipt = receipt with
        {
            AuditDigest = ArticleTemplateContract.ComputeAuditDigest(receipt)
        };
        receipt = receipt with
        {
            ContentDigest = ArticleTemplateContract.ComputeReceiptDigest(receipt)
        };
        ArticleTemplateContract.ValidateReceipt(receipt);
        return receipt;
    }

    private static DateTime CanonicalTimestamp(TimeProvider timeProvider)
    {
        // PostgreSQL timestamp columns persist microsecond precision; drop the sub-microsecond
        // residue so stored rows recompute byte-identical digests on read.
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        return new DateTime(now.Ticks - now.Ticks % TimeSpan.TicksPerMicrosecond, DateTimeKind.Utc);
    }

    private static void EnsureNameAvailable(
        IReadOnlyList<ArticleTemplateDefinition> definitions,
        string nameKey,
        Guid? exceptTemplateId)
    {
        if (definitions.Any(definition =>
                definition.Status != ArticleTemplateStatus.Deleted
                && definition.TemplateId != exceptTemplateId
                && string.Equals(definition.NameKey, nameKey, StringComparison.Ordinal)))
        {
            throw new ArticleTemplateConflictException("article_template_name_conflict");
        }
    }

    private static void EnsureScopeRevision(ArticleTemplateMutationSnapshot snapshot, long expectedRevision)
    {
        if (snapshot.ScopeRevision != expectedRevision)
        {
            throw new ArticleTemplateConflictException("article_template_scope_revision_cas_stale");
        }
    }

    private static void EnsureReadableStatus(
        ArticleTemplateDefinition definition,
        ArticleTemplatePermission permission)
    {
        if (definition.Status == ArticleTemplateStatus.Deleted
            || (permission == ArticleTemplatePermission.Use && definition.Status != ArticleTemplateStatus.Active))
        {
            throw new ArticleTemplateAccessDeniedException();
        }
    }

    private static void ValidateCreateCommand(CreateArticleTemplateCommand command)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArticleTemplateContract.ValidateActor(command.Actor);
        ArticleTemplateContract.ValidateScope(command.Scope);
        if (command.TemplateId == Guid.Empty
            || command.VersionId == Guid.Empty
            || command.RequestId == Guid.Empty
            || command.ExpectedScopeRevision < 0)
        {
            throw new ArticleTemplateValidationException("article_template_create_identity_invalid");
        }
    }

    private static void ValidateMutationIdentity(
        ArticleTemplateActor actor,
        Guid templateId,
        Guid? versionId,
        Guid requestId,
        long expectedScopeRevision,
        long expectedTemplateRevision)
    {
        ArticleTemplateContract.ValidateActor(actor);
        if (templateId == Guid.Empty
            || versionId == Guid.Empty
            || requestId == Guid.Empty
            || expectedScopeRevision < 0
            || expectedTemplateRevision <= 0)
        {
            throw new ArticleTemplateValidationException("article_template_command_identity_invalid");
        }
    }

    private static void ValidateReadIdentity(
        ArticleTemplateActor actor,
        Guid templateId,
        ArticleTemplatePermission permission)
    {
        ArticleTemplateContract.ValidateActor(actor);
        if (templateId == Guid.Empty || !Enum.IsDefined(permission))
        {
            throw new ArticleTemplateValidationException("article_template_read_identity_invalid");
        }
    }

    private static void ValidatePageLimit(int limit)
    {
        if (limit is <= 0 or > ArticleTemplateContract.MaxPageSize)
        {
            throw new ArticleTemplateValidationException("article_template_page_limit_invalid");
        }
    }
}

public sealed class ArticleTemplateIntegrityException(string code)
    : InvalidOperationException(code)
{
    public string Code { get; } = code;
}
