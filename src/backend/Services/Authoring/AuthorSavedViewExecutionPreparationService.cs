namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Prepares a detached, revision-bound query from the unique saved-view and dependency owners.
/// Resolved means dependency preparation succeeded; it does not mean an article query ran.
/// Canonical query compilation, permission/index generations and cursors remain with their
/// query owners. This service neither evaluates article conditions nor persists result IDs.
/// </summary>
public sealed class AuthorSavedViewExecutionPreparationService(
    AuthorSavedViewApplicationFacade views,
    IAuthorSavedViewQueryValidator validator)
{
    public async Task<AuthorSavedViewExecutionPreparation> PrepareAsync(
        AuthorSavedViewExecutionPreparationRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ValidateRequest(request);
        cancellationToken.ThrowIfCancellationRequested();
        AuthorSavedView? source = await views.GetAsync(request.ViewId, cancellationToken).ConfigureAwait(false);
        if (source is null)
        {
            return Refusal(request, AuthorSavedViewPreparationStatus.NotFound, "saved_view_not_found");
        }
        AuthorSavedViewExecutionPreparationVerifier.ValidateSource(source);
        if (source.Revision != request.ExpectedViewRevision
            || !string.Equals(source.QueryDigest, request.ExpectedQueryDigest, StringComparison.Ordinal))
        {
            return Refusal(request, AuthorSavedViewPreparationStatus.Stale, "saved_view_execution_stale");
        }
        if (source.LifecycleState != AuthorSavedViewLifecycleState.Active)
        {
            return Refusal(request, AuthorSavedViewPreparationStatus.Retired, "saved_view_retired");
        }
        if (request.Limit > source.Query.PageSize)
        {
            throw new AuthorSavedViewValidationException("saved_view_execution_limit_exceeds_query");
        }

        AuthorSavedView detached = source with
        {
            Query = FreezeQuery(source.Query)
        };
        AuthorSavedViewQueryValidationResult validation = await validator.ValidateAsync(
            detached.Owner, detached.Query, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        validation = AuthorSavedViewExecutionPreparationVerifier.ValidateResolution(detached, validation, cancellationToken);

        AuthorSavedView? current = await views.GetAsync(request.ViewId, cancellationToken).ConfigureAwait(false);
        if (current is null || current.Owner != detached.Owner || current.ContentDigest != detached.ContentDigest)
        {
            return Refusal(request, AuthorSavedViewPreparationStatus.Stale, "saved_view_execution_stale");
        }
        AuthorSavedViewExecutionPreparationVerifier.ValidateSource(current);

        // Re-resolve after the awaited authority read. A changed dependency cannot certify
        // a plan prepared against an earlier catalog. Query execution must recheck again.
        AuthorSavedViewQueryValidationResult confirmation = await validator.ValidateAsync(
            detached.Owner, detached.Query, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        confirmation = AuthorSavedViewExecutionPreparationVerifier.ValidateResolution(detached, confirmation, cancellationToken);
        if (confirmation.DependencyDigest != validation.DependencyDigest)
        {
            return Refusal(request, AuthorSavedViewPreparationStatus.Stale, "saved_view_dependencies_stale");
        }

        AuthorSavedView? finalSource = await views.GetAsync(request.ViewId, cancellationToken).ConfigureAwait(false);
        if (finalSource is null || finalSource.Owner != detached.Owner || finalSource.ContentDigest != detached.ContentDigest)
        {
            return Refusal(request, AuthorSavedViewPreparationStatus.Stale, "saved_view_execution_stale");
        }
        AuthorSavedViewExecutionPreparationVerifier.ValidateSource(finalSource);

        AuthorSavedViewDependencyResolution[] dependencies = FreezeDependencies(confirmation.Resolutions);
        if (!confirmation.IsValid)
        {
            AuthorSavedViewPreparationStatus status = dependencies.Any(static dependency =>
                dependency.Status is AuthorSavedViewDependencyStatus.Unknown
                    or AuthorSavedViewDependencyStatus.DuplicateAuthority
                    or AuthorSavedViewDependencyStatus.PermissionRevoked)
                ? AuthorSavedViewPreparationStatus.Blocked
                : dependencies.Any(static dependency =>
                    dependency.Status is AuthorSavedViewDependencyStatus.MigrationRequired
                        or AuthorSavedViewDependencyStatus.TypeOrOperatorIncompatible)
                    ? AuthorSavedViewPreparationStatus.NeedsUpdate
                    : AuthorSavedViewPreparationStatus.Invalid;
            return Seal(new(request.RequestId, request.RequestSequence, status, null,
                Array.AsReadOnly(dependencies), "saved_view_dependencies_invalid", string.Empty));
        }

        var plan = new AuthorSavedViewResolvedPlan(
            detached.Owner, detached.Id, detached.Revision, detached.ContentDigest,
            FreezeQuery(confirmation.Query), confirmation.QueryDigest, confirmation.DependencyDigest,
            Array.AsReadOnly(dependencies), request.Limit, string.Empty);
        plan = plan with
        {
            ContentDigest = AuthorSavedViewExecutionPreparationVerifier.ComputePlanDigest(plan)
        };
        return Seal(new(request.RequestId, request.RequestSequence, AuthorSavedViewPreparationStatus.Resolved,
            plan, Array.AsReadOnly(dependencies), null, string.Empty));
    }

    private static void ValidateRequest(AuthorSavedViewExecutionPreparationRequest request)
    {
        if (request.ViewId == Guid.Empty || request.RequestId == Guid.Empty
            || request.ExpectedViewRevision < 1 || request.RequestSequence < 1
            || request.QuerySchemaVersion != AuthorSavedViewContract.SchemaVersion
            || request.Limit is < 1 or > AuthorSavedViewContract.MaxPageSize
            || request.ExpectedQueryDigest is null || request.ExpectedQueryDigest.Length != 64
            || request.ExpectedQueryDigest.Any(static character =>
                character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
        {
            throw new AuthorSavedViewValidationException("saved_view_execution_request_invalid");
        }
    }

    private static AuthorSavedViewQuery FreezeQuery(AuthorSavedViewQuery query)
        => query with
        {
            Conditions = Array.AsReadOnly(query.Conditions.Select(static condition => condition with
            {
                Values = Array.AsReadOnly(condition.Values.ToArray())
            }).ToArray()),
            Projection = Array.AsReadOnly(query.Projection.ToArray())
        };

    private static AuthorSavedViewDependencyResolution[] FreezeDependencies(
        IReadOnlyList<AuthorSavedViewDependencyResolution> dependencies)
        => dependencies.Select(static dependency => dependency with
        {
            Operator = dependency.Operator with
            {
                FieldKinds = Array.AsReadOnly(dependency.Operator.FieldKinds.ToArray())
            }
        }).ToArray();

    private static AuthorSavedViewExecutionPreparation Refusal(
        AuthorSavedViewExecutionPreparationRequest request,
        AuthorSavedViewPreparationStatus status,
        string reason)
        => Seal(new(request.RequestId, request.RequestSequence, status, null, [], reason, string.Empty));

    private static AuthorSavedViewExecutionPreparation Seal(AuthorSavedViewExecutionPreparation preparation)
        => preparation with
        {
            ContentDigest = AuthorSavedViewExecutionPreparationVerifier.ComputePreparationDigest(preparation)
        };
}

public sealed record AuthorSavedViewExecutionPreparationRequest(
    Guid ViewId,
    long ExpectedViewRevision,
    string ExpectedQueryDigest,
    int QuerySchemaVersion,
    int Limit,
    Guid RequestId,
    long RequestSequence);

public enum AuthorSavedViewPreparationStatus
{
    Resolved = 0,
    NotFound = 1,
    Stale = 2,
    Retired = 3,
    Invalid = 4,
    NeedsUpdate = 5,
    Blocked = 6
}

public sealed record AuthorSavedViewResolvedPlan(
    AuthorSavedViewOwner Owner,
    Guid ViewId,
    long ViewRevision,
    string ViewContentDigest,
    AuthorSavedViewQuery Query,
    string QueryDigest,
    string DependencyDigest,
    IReadOnlyList<AuthorSavedViewDependencyResolution> Dependencies,
    int Limit,
    string ContentDigest);

public sealed record AuthorSavedViewExecutionPreparation(
    Guid RequestId,
    long RequestSequence,
    AuthorSavedViewPreparationStatus Status,
    AuthorSavedViewResolvedPlan? Plan,
    IReadOnlyList<AuthorSavedViewDependencyResolution> Dependencies,
    string? ReasonCode,
    string ContentDigest);
