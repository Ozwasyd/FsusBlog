using Microsoft.AspNetCore.Builder;

namespace FsusBlog.Server.Infrastructure.Policies;

public sealed class BannedUserWriteBypassMetadata
{
    public static readonly BannedUserWriteBypassMetadata Instance = new();

    private BannedUserWriteBypassMetadata()
    {
    }
}

public sealed class NoStoreResponseMetadata
{
    public static readonly NoStoreResponseMetadata Instance = new();

    private NoStoreResponseMetadata()
    {
    }
}

public static class EndpointPolicyMetadataExtensions
{
    public static TBuilder AllowBannedUserWrite<TBuilder>(this TBuilder builder)
        where TBuilder : IEndpointConventionBuilder
    {
        builder.WithMetadata(BannedUserWriteBypassMetadata.Instance);
        return builder;
    }

    public static TBuilder RequireNoStoreResponse<TBuilder>(this TBuilder builder)
        where TBuilder : IEndpointConventionBuilder
    {
        builder.WithMetadata(NoStoreResponseMetadata.Instance);
        return builder;
    }
}
