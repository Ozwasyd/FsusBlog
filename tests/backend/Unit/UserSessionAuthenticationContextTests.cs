using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Tests.Unit;

public sealed class UserSessionAuthenticationContextTests
{
    [Theory]
    [InlineData("passkey", "webauthn_uv")]
    [InlineData("passkey", "mfa")]
    [InlineData("enrollment", "webauthn_uv")]
    public void CurrentProducerContext_RoundTripsExactSessionProvenance(string method, string strength)
    {
        var context = new UserSessionAuthenticationContext(method, strength, DateTime.UnixEpoch, 17);
        Assert.True(context.IsValid());
        var session = new UserSession
        {
            AuthenticationMethod = method,
            AuthenticationStrength = strength,
            AuthenticatedAtUtc = context.AuthenticatedAtUtc,
            AuthenticatedCredentialRowId = context.CredentialRowId,
            DurationPolicy = context.DurationPolicy,
            SessionMode = context.SessionMode
        };
        Assert.True(UserSessionAuthenticationContext.TryFromSession(session, out var restored));
        Assert.Equal(context, restored);
        Assert.True(UserSessionAuthenticationContract.IsCoarseMfa(method, strength, 17));
    }

    [Theory]
    [InlineData("other", "webauthn_uv", 17)]
    [InlineData("passkey", "legacy_verified", 17)]
    [InlineData("passkey", "legacy_unverified", 17)]
    [InlineData("passkey", "recovery", 17)]
    [InlineData("passkey", "webauthn_uv", null)]
    [InlineData("passkey", "webauthn_uv", 0)]
    [InlineData("enrollment", "mfa", 17)]
    [InlineData("recovery_key", "recovery", 17)]
    public void UnsupportedContext_IsNeverRepairedOrUpgradedFromMfaBoolean(string method, string strength, int? credentialRowId)
    {
        var context = new UserSessionAuthenticationContext(method, strength, DateTime.UnixEpoch, credentialRowId);
        Assert.False(context.IsValid());
        Assert.False(UserSessionAuthenticationContract.IsCoarseMfa(method, strength, credentialRowId));
        var session = new UserSession
        {
            AuthenticationMethod = method,
            AuthenticationStrength = strength,
            AuthenticatedAtUtc = DateTime.UnixEpoch,
            AuthenticatedCredentialRowId = credentialRowId,
            MfaVerified = true
        };
        Assert.False(UserSessionAuthenticationContext.TryFromSession(session, out var restored));
        Assert.Equal(default, restored);
    }

    [Fact]
    public void MissingProducerContextAndUnknownProjectionValues_FailClosed()
    {
        Assert.False(default(UserSessionAuthenticationContext).IsValid());
        var valid = new UserSessionAuthenticationContext("passkey", "webauthn_uv", DateTime.UnixEpoch, 17);
        Assert.False((valid with { AuthenticatedAtUtc = default }).IsValid());
        Assert.False((valid with { DurationPolicy = "unknown" }).IsValid());
        Assert.False((valid with { SessionMode = (UserSessionMode)99 }).IsValid());
    }
}
