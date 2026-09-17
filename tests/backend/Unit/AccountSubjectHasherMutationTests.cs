using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AccountSubjectHasherMutationTests
{
    [Fact]
    public void Create_UserPrefersNormalizedPasskeyHandleAndKeepsIdentityKindInDomain()
    {
        var user = new User
        {
            Id = 42,
            IdentityKind = "  PassKey  ",
            PasskeyUserHandle = "  CREDENTIAL-123  ",
            PublicHandle = "public-fallback"
        };

        Assert.Equal(
            "1b2360bf97d38da8ad85f8bd0706e4e2d24bd6e3276e7fcc7ba0a5f6455f24ea",
            AccountSubjectHasher.Create(user));
    }

    [Fact]
    public void Create_UserFallsBackFromMissingPasskeyToPublicHandle()
    {
        var user = new User
        {
            Id = 42,
            IdentityKind = "passkey",
            PasskeyUserHandle = " ",
            PublicHandle = " CREDENTIAL-123 "
        };

        Assert.Equal(AccountSubjectHasher.Create("passkey", "credential-123"), AccountSubjectHasher.Create(user));
    }

    [Fact]
    public void Create_UserWithoutHandlesUsesStableAnonymousAccountCoordinate()
    {
        var user = new User
        {
            Id = 42,
            IdentityKind = " ",
            PasskeyUserHandle = null,
            PublicHandle = null
        };

        Assert.Equal(
            "da018bf36eb430e6e22047195bd6b6d309996e89b2390d3a25a9927fad37b720",
            AccountSubjectHasher.Create(user));
    }

    [Fact]
    public void Create_StringOverloadNormalizesBothInputsWithoutDroppingEither()
    {
        string normalized = AccountSubjectHasher.Create("passkey", "credential-123");

        Assert.Equal(
            "333598a9759d95e02ff7a9d3520933075846ad3eab8556f88446c6305d55c103",
            normalized);
        Assert.Equal(normalized, AccountSubjectHasher.Create(" passkey ", " CREDENTIAL-123 "));
        Assert.NotEqual(normalized, AccountSubjectHasher.Create(" PASSKEY ", "credential-123"));
        Assert.NotEqual(normalized, AccountSubjectHasher.Create("anonymous_account", "credential-123"));
        Assert.NotEqual(normalized, AccountSubjectHasher.Create("passkey", string.Empty));
    }

    [Fact]
    public void BuildCacheKeyKeepsNamespaceAndNormalizesValidatedHash()
    {
        Assert.Equal("account:abcdef", AccountSubjectHasher.BuildCacheKey(" ABCDEF "));
        Assert.Equal("account:", AccountSubjectHasher.BuildCacheKey(" "));
    }
}
