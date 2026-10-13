using System.Globalization;
using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Binds definition metadata to the authenticated request through the original definition
/// store. A current projection fact describes the definition only, never article values or
/// query/index readiness. No SavedView-to-typed-operator mapping authority exists here.
/// </summary>
public sealed class ArticlePropertySavedViewDependencyProvider(
    IArticlePropertyDefinitionStore store,
    IHttpContextAccessor httpContextAccessor,
    IConfiguration configuration) : IAuthorSavedViewDependencyProvider
{
    public ValueTask<AuthorSavedViewDependencyFact?> ResolveConditionAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewCondition condition,
        CancellationToken cancellationToken = default)
        => ResolveAsync(owner, condition.Field, condition.OperatorId, ResolutionKind.Condition, cancellationToken);

    public ValueTask<AuthorSavedViewDependencyFact?> ResolveSortAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewSort sort,
        CancellationToken cancellationToken = default)
        => ResolveAsync(owner, sort.Field, "sort", ResolutionKind.Sort, cancellationToken);

    public ValueTask<AuthorSavedViewDependencyFact?> ResolveProjectionAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewFieldReference field,
        CancellationToken cancellationToken = default)
        => ResolveAsync(owner, field, "projection", ResolutionKind.Projection, cancellationToken);

    private async ValueTask<AuthorSavedViewDependencyFact?> ResolveAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewFieldReference field,
        string operation,
        ResolutionKind kind,
        CancellationToken cancellationToken)
    {
        if (field.Kind != AuthorSavedViewFieldKind.Property)
        {
            return null;
        }
        AuthorSavedViewContract.ValidateOwner(owner);
        cancellationToken.ThrowIfCancellationRequested();
        RequestBinding? binding = BindRequest(owner);
        if (binding is null)
        {
            return Fact(field, operation, AuthorSavedViewDependencyStatus.PermissionRevoked);
        }

        // Accept only the stable ID's exact default representation under the registered prefix.
        // Do not resolve machine keys, labels, alternate UUID spellings or owner-qualified aliases.
        const string Prefix = "property:";
        if (!field.Identity.StartsWith(Prefix, StringComparison.Ordinal)
            || !Guid.TryParseExact(field.Identity.AsSpan(Prefix.Length), "D", out Guid definitionId)
            || definitionId == Guid.Empty
            || !string.Equals(field.Identity, $"{Prefix}{definitionId:D}", StringComparison.Ordinal))
        {
            return Fact(field, operation, AuthorSavedViewDependencyStatus.Unknown);
        }

        ArticlePropertyDefinitionOwner userOwner = ArticlePropertyDefinitionOwner.User(
            binding.Actor.AdminPrincipalId, owner.SiteScope);
        ArticlePropertyDefinitionOwner siteOwner = ArticlePropertyDefinitionOwner.Site(owner.SiteScope);
        try
        {
            // At most four point reads, restricted to the actual request user and site. Recheck
            // both owners to refuse collisions and observed schema/owner drift across awaits.
            ArticlePropertyDefinition? user = await ReadAsync(userOwner).ConfigureAwait(false);
            ArticlePropertyDefinition? site = await ReadAsync(siteOwner).ConfigureAwait(false);
            ArticlePropertyDefinition? userAgain = await ReadAsync(userOwner).ConfigureAwait(false);
            ArticlePropertyDefinition? siteAgain = await ReadAsync(siteOwner).ConfigureAwait(false);
            if (!RequestMatches(owner, binding))
            {
                return Fact(field, operation, AuthorSavedViewDependencyStatus.PermissionRevoked);
            }
            if (!SameDefinition(user, userAgain) || !SameDefinition(site, siteAgain))
            {
                return Fact(field, operation, AuthorSavedViewDependencyStatus.MigrationRequired);
            }
            if (user is not null && site is not null)
            {
                return Fact(field, operation, AuthorSavedViewDependencyStatus.DuplicateAuthority);
            }
            ArticlePropertyDefinition? definition = user ?? site;
            if (definition is null)
            {
                // The store filters deleted definitions; null cannot establish deletion.
                return Fact(field, operation, AuthorSavedViewDependencyStatus.Unknown);
            }
            string revision = $"property:{definition.SchemaRevision.ToString(CultureInfo.InvariantCulture)}:{definition.ContentDigest}";
            AuthorSavedViewDependencyStatus status;
            if (definition.Status == ArticlePropertyDefinitionStatus.Deprecated)
            {
                status = AuthorSavedViewDependencyStatus.Retired;
            }
            else if (definition.Status != ArticlePropertyDefinitionStatus.Active)
            {
                status = AuthorSavedViewDependencyStatus.Unknown;
            }
            else if (kind == ResolutionKind.Projection)
            {
                status = AuthorSavedViewDependencyStatus.Current;
            }
            else if ((kind == ResolutionKind.Sort && !definition.Sortable)
                || (kind == ResolutionKind.Condition && !definition.Filterable))
            {
                status = AuthorSavedViewDependencyStatus.TypeOrOperatorIncompatible;
            }
            else
            {
                // Definition flags and typed Operators do not prove index support or a mapping
                // for property.equals/any-of (including presence queries and property sorts).
                status = AuthorSavedViewDependencyStatus.MigrationRequired;
            }
            return Fact(field, operation, status, revision);
        }
        catch (ArticlePropertyDefinitionAccessDeniedException)
        {
            return Fact(field, operation, AuthorSavedViewDependencyStatus.PermissionRevoked);
        }

        async Task<ArticlePropertyDefinition?> ReadAsync(ArticlePropertyDefinitionOwner definitionOwner)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!RequestMatches(owner, binding))
            {
                throw new ArticlePropertyDefinitionAccessDeniedException();
            }
            ArticlePropertyDefinition? definition = await store.GetAsync(
                binding.Actor, definitionOwner, definitionId, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (!RequestMatches(owner, binding))
            {
                throw new ArticlePropertyDefinitionAccessDeniedException();
            }
            if (definition is not null)
            {
                ArticlePropertyDefinitionContract.ValidateDefinition(definition);
                if (definition.Owner != definitionOwner || definition.DefinitionId != definitionId)
                {
                    throw new ArticlePropertyDefinitionIntegrityException("article_property_definition_identity_mismatch");
                }
            }
            return definition;
        }
    }

    private RequestBinding? BindRequest(AuthorSavedViewOwner owner)
    {
        HttpContext? context = httpContextAccessor.HttpContext;
        ClaimsPrincipal? principal = context?.User;
        string? sessionId = principal.GetAdminSessionId();
        if (context is null || principal?.Identity?.IsAuthenticated != true
            || !principal.IsAdminPrincipal()
            || !principal.TryGetAdminPrincipalId(out long principalId)
            || principalId != owner.AdminPrincipalId
            || string.IsNullOrWhiteSpace(sessionId)
            || !string.Equals(owner.SiteScope,
                SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(configuration), StringComparison.Ordinal))
        {
            return null;
        }
        string[] permissions = principal.Claims
            .Where(static claim => claim.Type == AdminPermissions.PermissionClaimType)
            .Select(static claim => claim.Value)
            .Where(principal.HasAdminPermission)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        return new(context, principal, sessionId, new ArticlePropertyDefinitionActor(principalId, permissions));
    }

    private bool RequestMatches(AuthorSavedViewOwner owner, RequestBinding expected)
    {
        RequestBinding? actual = BindRequest(owner);
        return actual is not null
            && ReferenceEquals(actual.Context, expected.Context)
            && ReferenceEquals(actual.Principal, expected.Principal)
            && string.Equals(actual.SessionId, expected.SessionId, StringComparison.Ordinal)
            && actual.Actor.Permissions.SetEquals(expected.Actor.Permissions);
    }

    private static bool SameDefinition(ArticlePropertyDefinition? first, ArticlePropertyDefinition? second)
        => first is null ? second is null : second is not null
            && first.DefinitionId == second.DefinitionId && first.Owner == second.Owner
            && first.SchemaRevision == second.SchemaRevision
            && string.Equals(first.ContentDigest, second.ContentDigest, StringComparison.Ordinal);

    private static AuthorSavedViewDependencyFact Fact(
        AuthorSavedViewFieldReference field,
        string operation,
        AuthorSavedViewDependencyStatus status,
        string revision = "unavailable")
        => new(field, operation, status, revision, []);

    private sealed record RequestBinding(
        HttpContext Context,
        ClaimsPrincipal Principal,
        string SessionId,
        ArticlePropertyDefinitionActor Actor);

    private enum ResolutionKind
    {
        Condition,
        Sort,
        Projection
    }
}
