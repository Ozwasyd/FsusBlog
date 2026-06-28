using Microsoft.AspNetCore.Builder;

namespace FsusBlog.Server.Infrastructure.Policies;

public enum RestrictedAccountAction
{
    Logout,
    DeleteOwnAccount,
    RevokeOwnSession,
    RevokeOtherSessions,
    Appeal
}

public sealed class RestrictedAccountActionMetadata(RestrictedAccountAction action)
{
    public RestrictedAccountAction Action { get; } = action;
}

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
}
