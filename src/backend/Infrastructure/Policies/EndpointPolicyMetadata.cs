using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Infrastructure.Policies;

public enum RestrictedAccountAction
{
    ViewSelf,
    ViewRestriction,
    ViewSessions,
    Logout,
    DeleteOwnAccount,
    RevokeOwnSession,
    RevokeOtherSessions,
    Appeal,
    SecurityStepUp,
    RefreshSession
}

public sealed class RestrictedAccountActionMetadata(RestrictedAccountAction action)
{
    public RestrictedAccountAction Action { get; } = action;
}

/// <summary>Controls whether browser binary requests participate in cookie credentials.</summary>
public enum BinaryCredentialPolicy
{
    Include,
    Omit
}

/// <summary>Publishes an endpoint credential decision for the compiled route descriptor.</summary>
public sealed record BinaryCredentialPolicyMetadata(BinaryCredentialPolicy Policy);

public sealed class NoStoreResponseMetadata
{
    public static readonly NoStoreResponseMetadata Instance = new();

    private NoStoreResponseMetadata()
    {
    }
}

public sealed class ForceAccountStateRefreshMetadata
{
    public static readonly ForceAccountStateRefreshMetadata Instance = new();

    private ForceAccountStateRefreshMetadata()
    {
    }
}

public sealed record EndpointFilterBoundaryMetadata(Type FilterType);

public sealed record AdminSensitiveStepUpMetadata(
    string Action,
    string ProofHeader,
    bool AdminPrincipalBranchOnly)
{
    public const string DefaultAction = "admin-sensitive";
    public const string DefaultProofHeader = "X-Fsus-Mfa-Proof";

    public static readonly AdminSensitiveStepUpMetadata Instance = new(
        DefaultAction,
        DefaultProofHeader,
        AdminPrincipalBranchOnly: false);

    public static readonly AdminSensitiveStepUpMetadata AdminPrincipalBranchInstance = new(
        DefaultAction,
        DefaultProofHeader,
        AdminPrincipalBranchOnly: true);
}

public static class EndpointPolicyMetadataExtensions
{
    public static TBuilder AllowRestrictedAccountAction<TBuilder>(this TBuilder builder, RestrictedAccountAction action)
        where TBuilder : IEndpointConventionBuilder
    {
        builder.WithMetadata(new RestrictedAccountActionMetadata(action));
        return builder;
    }

    public static TBuilder RequireNoStoreResponse<TBuilder>(this TBuilder builder)
        where TBuilder : IEndpointConventionBuilder
    {
        builder.WithMetadata(NoStoreResponseMetadata.Instance);
        return builder;
    }

    public static TBuilder ForceAccountStateRefresh<TBuilder>(this TBuilder builder)
        where TBuilder : IEndpointConventionBuilder
    {
        builder.WithMetadata(ForceAccountStateRefreshMetadata.Instance);
        return builder;
    }

    public static RouteHandlerBuilder AddEndpointFilterWithMetadata<TFilter>(this RouteHandlerBuilder builder)
        where TFilter : class, IEndpointFilter
    {
        builder.WithMetadata(new EndpointFilterBoundaryMetadata(typeof(TFilter)));
        return builder.AddEndpointFilter<TFilter>();
    }

    public static RouteGroupBuilder AddEndpointFilterWithMetadata<TFilter>(this RouteGroupBuilder builder)
        where TFilter : class, IEndpointFilter
    {
        builder.WithMetadata(new EndpointFilterBoundaryMetadata(typeof(TFilter)));
        return builder.AddEndpointFilter<TFilter>();
    }

    public static RouteHandlerBuilder WithAdminSensitiveStepUp(
        this RouteHandlerBuilder builder,
        bool adminPrincipalBranchOnly = false)
        => builder.WithMetadata(
            adminPrincipalBranchOnly
                ? AdminSensitiveStepUpMetadata.AdminPrincipalBranchInstance
                : AdminSensitiveStepUpMetadata.Instance);
}
