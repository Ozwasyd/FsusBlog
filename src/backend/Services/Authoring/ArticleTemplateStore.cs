using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>The exact-one server authority for article template facts and immutable versions.</summary>
public interface IArticleTemplateStore
{
    Task<ArticleTemplateWriteReceipt> CreateAsync(
        CreateArticleTemplateCommand command,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateDefinition?> GetAsync(
        ArticleTemplateActor actor,
        Guid templateId,
        ArticleTemplatePermission permission = ArticleTemplatePermission.Read,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplatePage> ListAsync(
        ArticleTemplateActor actor,
        ArticleTemplateScope scope,
        ArticleTemplatePageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateVersion?> GetVersionAsync(
        ArticleTemplateActor actor,
        Guid templateId,
        Guid versionId,
        ArticleTemplatePermission permission = ArticleTemplatePermission.Read,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateVersionPage> ListVersionsAsync(
        ArticleTemplateActor actor,
        Guid templateId,
        int? afterVersionNumber,
        int limit,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateWriteReceipt> CreateVersionAsync(
        CreateArticleTemplateVersionCommand command,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateWriteReceipt> RenameAsync(
        RenameArticleTemplateCommand command,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateWriteReceipt> RetireAsync(
        RetireArticleTemplateCommand command,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateWriteReceipt> DeleteAsync(
        DeleteArticleTemplateCommand command,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateVerificationResult> VerifyAsync(
        ArticleTemplateActor actor,
        Guid templateId,
        CancellationToken cancellationToken = default);
}

public interface IArticleTemplatePermissionAuthority
{
    void EnsureAllowed(
        ArticleTemplateActor actor,
        ArticleTemplateScope scope,
        ArticleTemplatePermission permission);
}

public sealed class ArticleTemplatePermissionAuthority : IArticleTemplatePermissionAuthority
{
    public void EnsureAllowed(
        ArticleTemplateActor actor,
        ArticleTemplateScope scope,
        ArticleTemplatePermission permission)
    {
        ArticleTemplateContract.ValidateActor(actor);
        ArticleTemplateContract.ValidateScope(scope);
        if (!Enum.IsDefined(permission))
        {
            throw new ArticleTemplateAccessDeniedException();
        }

        bool hasArticleWrite = actor.Permissions.Contains(AdminPermissions.ArticleWrite);
        bool allowed = scope.Kind switch
        {
            ArticleTemplateScopeKind.Personal => hasArticleWrite
                && scope.OwnerAdminPrincipalId == actor.AdminPrincipalId,
            ArticleTemplateScopeKind.Site when permission == ArticleTemplatePermission.Manage =>
                hasArticleWrite && actor.Permissions.Contains(AdminPermissions.SystemConfig),
            ArticleTemplateScopeKind.Site => hasArticleWrite,
            _ => false
        };
        if (!allowed)
        {
            throw new ArticleTemplateAccessDeniedException();
        }
    }
}

public interface IArticleTemplateReferenceAuthority
{
    Task ValidateAsync(
        ArticleTemplateActor actor,
        ArticleTemplateScope scope,
        ArticleTemplateDefaults defaults,
        CancellationToken cancellationToken = default);
}

public interface IArticleTemplatePersistence
{
    Task<ArticleTemplateDefinition?> GetAsync(
        Guid templateId,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplatePage> ListAsync(
        ArticleTemplateScope scope,
        ArticleTemplatePageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateVersion?> GetVersionAsync(
        Guid templateId,
        Guid versionId,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateVersionPage> ListVersionsAsync(
        Guid templateId,
        int? afterVersionNumber,
        int limit,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateWriteReceipt> ExecuteAsync(
        ArticleTemplateScope scope,
        long actorAdminPrincipalId,
        Guid requestId,
        string commandDigest,
        Guid templateId,
        Func<ArticleTemplateMutationSnapshot, CancellationToken, Task<ArticleTemplateMutation>> planner,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateVerificationSnapshot?> ReadVerificationSnapshotAsync(
        Guid templateId,
        int receiptLimit,
        CancellationToken cancellationToken = default);
}

public sealed record ArticleTemplateMutationSnapshot(
    ArticleTemplateScope Scope,
    long ScopeRevision,
    IReadOnlyList<ArticleTemplateDefinition> Definitions,
    ArticleTemplateDefinition? TargetDefinition,
    IReadOnlyList<ArticleTemplateVersion> TargetVersions,
    long TargetUsageCount);

public sealed record ArticleTemplateMutation(
    long ExpectedScopeRevision,
    ArticleTemplateDefinition? PreviousDefinition,
    ArticleTemplateDefinition Definition,
    ArticleTemplateVersion? VersionToInsert,
    ArticleTemplateWriteReceipt Receipt);

public sealed record ArticleTemplateIdempotencyRecord(
    long ActorAdminPrincipalId,
    Guid RequestId,
    string CommandDigest,
    Guid ReceiptId);

public sealed record ArticleTemplateVerificationSnapshot(
    ArticleTemplateDefinition Definition,
    IReadOnlyList<ArticleTemplateVersion> Versions,
    IReadOnlyList<ArticleTemplateWriteReceipt> Receipts,
    IReadOnlyList<ArticleTemplateIdempotencyRecord> IdempotencyRecords,
    IReadOnlyList<ArticleTemplateAuditLink> AuditLinks,
    bool ReceiptLimitExceeded);

public sealed record ArticleTemplateAuditLink(
    Guid AuditReference,
    string Source,
    string Type,
    string Action,
    string? TargetType,
    string? TargetId,
    string EventInfo,
    string? ReasonCode,
    string Outcome,
    bool IsHighValue);

public sealed record ArticleTemplateVerificationViolation(string Code, string Detail);

public sealed record ArticleTemplateVerificationResult(
    bool Valid,
    IReadOnlyList<ArticleTemplateVerificationViolation> Violations);

public interface IArticleTemplateVerifier
{
    ArticleTemplateVerificationResult Verify(ArticleTemplateVerificationSnapshot snapshot);
}

public sealed class ArticleTemplateVerifier : IArticleTemplateVerifier
{
    public ArticleTemplateVerificationResult Verify(ArticleTemplateVerificationSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        var violations = new List<ArticleTemplateVerificationViolation>();
        TryValidate(
            () => ArticleTemplateContract.ValidateDefinition(snapshot.Definition),
            "definition_tamper",
            snapshot.Definition.TemplateId.ToString("D"),
            violations);

        ArticleTemplateVersion[] versions = [.. snapshot.Versions.OrderBy(static version => version.VersionNumber)];
        if (versions.Length == 0
            || versions.Length > ArticleTemplateContract.MaxVersionsPerTemplate
            || versions.Select(static version => version.VersionId).Distinct().Count() != versions.Length
            || versions.Select(static version => version.VersionNumber).Distinct().Count() != versions.Length)
        {
            violations.Add(new("version_identity_invalid", "Version identities are missing, duplicated, or over budget."));
        }
        for (int index = 0; index < versions.Length; index++)
        {
            ArticleTemplateVersion version = versions[index];
            TryValidate(
                () => ArticleTemplateContract.ValidateVersion(version),
                "version_tamper",
                version.VersionId.ToString("D"),
                violations);
            if (version.TemplateId != snapshot.Definition.TemplateId || version.VersionNumber != index + 1)
            {
                violations.Add(new("version_sequence_invalid", version.VersionId.ToString("D")));
            }
        }

        ArticleTemplateVersion? current = versions.LastOrDefault();
        if (current is null
            || current.VersionId != snapshot.Definition.CurrentVersionId
            || current.VersionNumber != snapshot.Definition.CurrentVersionNumber)
        {
            violations.Add(new("current_version_binding_invalid", snapshot.Definition.TemplateId.ToString("D")));
        }

        if (snapshot.ReceiptLimitExceeded)
        {
            violations.Add(new("receipt_budget_exceeded", "Verification history exceeded the bounded receipt budget."));
        }
        ArticleTemplateWriteReceipt[] receipts =
            [.. snapshot.Receipts.OrderBy(static receipt => receipt.TemplateRevision)];
        if (receipts.Length == 0
            || receipts.Select(static receipt => receipt.ReceiptId).Distinct().Count() != receipts.Length)
        {
            violations.Add(new("receipt_identity_invalid", "Receipt history is missing or duplicated."));
        }
        for (int index = 0; index < receipts.Length; index++)
        {
            ArticleTemplateWriteReceipt receipt = receipts[index];
            TryValidate(
                () => ArticleTemplateContract.ValidateReceipt(receipt),
                "receipt_tamper",
                receipt.ReceiptId.ToString("D"),
                violations);
            if (receipt.TemplateId != snapshot.Definition.TemplateId
                || receipt.PreviousTemplateRevision != index
                || receipt.TemplateRevision != index + 1)
            {
                violations.Add(new("receipt_revision_sequence_invalid", receipt.ReceiptId.ToString("D")));
            }
        }
        ArticleTemplateWriteReceipt? latest = receipts.LastOrDefault();
        if (latest is null
            || latest.TemplateRevision != snapshot.Definition.Revision
            || !string.Equals(latest.DefinitionDigest, snapshot.Definition.ContentDigest, StringComparison.Ordinal))
        {
            violations.Add(new("receipt_head_binding_invalid", snapshot.Definition.TemplateId.ToString("D")));
        }

        Dictionary<Guid, ArticleTemplateWriteReceipt> versionReceipts = receipts
            .Where(static receipt => receipt.VersionId.HasValue)
            .GroupBy(static receipt => receipt.VersionId!.Value)
            .Where(static group => group.Count() == 1)
            .ToDictionary(static group => group.Key, static group => group.Single());
        foreach (ArticleTemplateVersion version in versions)
        {
            if (!versionReceipts.TryGetValue(version.VersionId, out ArticleTemplateWriteReceipt? receipt)
                || receipt.VersionNumber != version.VersionNumber
                || !string.Equals(receipt.VersionDigest, version.ContentDigest, StringComparison.Ordinal)
                || !string.Equals(receipt.DefaultsDigest, version.DefaultsDigest, StringComparison.Ordinal))
            {
                violations.Add(new("version_receipt_binding_invalid", version.VersionId.ToString("D")));
            }
        }

        Dictionary<Guid, ArticleTemplateIdempotencyRecord> idempotency = snapshot.IdempotencyRecords
            .GroupBy(static record => record.ReceiptId)
            .Where(static group => group.Count() == 1)
            .ToDictionary(static group => group.Key, static group => group.Single());
        foreach (ArticleTemplateWriteReceipt receipt in receipts)
        {
            if (!idempotency.TryGetValue(receipt.ReceiptId, out ArticleTemplateIdempotencyRecord? record)
                || record.ActorAdminPrincipalId != receipt.ActorAdminPrincipalId
                || record.RequestId != receipt.RequestId
                || !string.Equals(record.CommandDigest, receipt.CommandDigest, StringComparison.Ordinal))
            {
                violations.Add(new("idempotency_receipt_binding_invalid", receipt.ReceiptId.ToString("D")));
            }
        }

        ILookup<Guid, ArticleTemplateAuditLink> auditLinks = snapshot.AuditLinks
            .ToLookup(static link => link.AuditReference);
        foreach (ArticleTemplateWriteReceipt receipt in receipts)
        {
            ArticleTemplateAuditLink[] links = [.. auditLinks[receipt.AuditReference]];
            if (links.Length == 0)
            {
                violations.Add(new("audit_link_missing", receipt.AuditReference.ToString("D")));
                continue;
            }
            if (links.Length != 1)
            {
                violations.Add(new("audit_link_duplicate", receipt.AuditReference.ToString("D")));
                continue;
            }
            ArticleTemplateAuditLink link = links[0];
            if (!string.Equals(link.Source, AuditSourceCatalog.Article, StringComparison.Ordinal)
                || !string.Equals(link.Type, AuditTypeCatalog.Business, StringComparison.Ordinal)
                || !string.Equals(link.Action, AdminPermissions.ArticleWrite, StringComparison.Ordinal)
                || !string.Equals(link.TargetType, "article-template-receipt", StringComparison.Ordinal)
                || !string.Equals(link.TargetId, receipt.AuditReference.ToString("N"), StringComparison.Ordinal)
                || !string.Equals(link.EventInfo, receipt.AuditDigest, StringComparison.Ordinal)
                || !string.Equals(link.ReasonCode, receipt.CommandKind, StringComparison.Ordinal)
                || !string.Equals(link.Outcome, AuditOutcomeCatalog.Success, StringComparison.Ordinal)
                || !link.IsHighValue)
            {
                violations.Add(new("audit_link_tamper", receipt.AuditReference.ToString("D")));
            }
        }

        return new(violations.Count == 0, Array.AsReadOnly(violations.ToArray()));
    }

    private static void TryValidate(
        Action validation,
        string code,
        string detail,
        List<ArticleTemplateVerificationViolation> violations)
    {
        try
        {
            validation();
        }
        catch (Exception exception) when (exception is ArticleTemplateValidationException)
        {
            violations.Add(new(code, detail));
        }
    }
}

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

                DateTime now = timeProvider.GetUtcNow().UtcDateTime;
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
                DateTime now = timeProvider.GetUtcNow().UtcDateTime;
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
