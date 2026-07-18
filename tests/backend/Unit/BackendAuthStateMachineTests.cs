namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "SecurityStateMachine")]
public sealed class BackendAuthStateMachineTests
{
    private static readonly IReadOnlyDictionary<(AuthState State, AuthEvent Event), AuthState> s_transitions =
        new Dictionary<(AuthState, AuthEvent), AuthState>
        {
            [(AuthState.Guest, AuthEvent.IssuePowChallenge)] = AuthState.PowChallengeIssued,
            [(AuthState.PowChallengeIssued, AuthEvent.SubmitValidPassword)] = AuthState.PasswordSubmitted,
            [(AuthState.PasswordSubmitted, AuthEvent.RequireMfa)] = AuthState.MfaRequired,
            [(AuthState.PasswordSubmitted, AuthEvent.CompleteLogin)] = AuthState.Authenticated,
            [(AuthState.MfaRequired, AuthEvent.VerifyTotp)] = AuthState.MfaVerified,
            [(AuthState.MfaRequired, AuthEvent.UseRecoveryCode)] = AuthState.MfaVerified,
            [(AuthState.MfaVerified, AuthEvent.CompleteLogin)] = AuthState.Authenticated,
            [(AuthState.Authenticated, AuthEvent.Refresh)] = AuthState.Refreshed,
            [(AuthState.Refreshed, AuthEvent.Refresh)] = AuthState.Refreshed,
            [(AuthState.Authenticated, AuthEvent.Logout)] = AuthState.LoggedOut,
            [(AuthState.Refreshed, AuthEvent.Logout)] = AuthState.LoggedOut,
            [(AuthState.Authenticated, AuthEvent.Revoke)] = AuthState.Revoked,
            [(AuthState.Refreshed, AuthEvent.Revoke)] = AuthState.Revoked,
            [(AuthState.Authenticated, AuthEvent.Expire)] = AuthState.Expired,
            [(AuthState.Refreshed, AuthEvent.Expire)] = AuthState.Expired
        };

    [Fact]
    public void LoginWithMfa_RequiresPartialAuthBeforeFullSession()
    {
        AuthState state = AuthState.Guest;

        state = Apply(state, AuthEvent.IssuePowChallenge);
        state = Apply(state, AuthEvent.SubmitValidPassword);
        state = Apply(state, AuthEvent.RequireMfa);

        Assert.Equal(AuthState.MfaRequired, state);
        Assert.False(CanAccessSensitiveEndpoint(state));

        state = Apply(state, AuthEvent.VerifyTotp);
        state = Apply(state, AuthEvent.CompleteLogin);

        Assert.Equal(AuthState.Authenticated, state);
        Assert.True(CanAccessSensitiveEndpoint(state));
    }

    [Fact]
    public void IllegalTransitions_AreRejected()
    {
        Assert.Throws<InvalidOperationException>(() => Apply(AuthState.Guest, AuthEvent.Refresh));
        Assert.Throws<InvalidOperationException>(() => Apply(AuthState.MfaRequired, AuthEvent.Refresh));
        Assert.Throws<InvalidOperationException>(() => Apply(AuthState.Revoked, AuthEvent.Refresh));
        Assert.Throws<InvalidOperationException>(() => Apply(AuthState.LoggedOut, AuthEvent.CompleteLogin));
        Assert.Throws<InvalidOperationException>(() => Apply(AuthState.Expired, AuthEvent.Refresh));
    }

    [Fact]
    public void RecoveryCode_CanMoveMfaForwardOnlyOnce()
    {
        var recoveryCode = new OneTimeSecret();
        AuthState first = Apply(AuthState.MfaRequired, recoveryCode.Consume() ? AuthEvent.UseRecoveryCode : AuthEvent.InvalidProof);

        Assert.Equal(AuthState.MfaVerified, first);
        Assert.False(recoveryCode.Consume());
        Assert.Throws<InvalidOperationException>(() => Apply(AuthState.MfaRequired, AuthEvent.InvalidProof));
    }

    [Theory]
    [InlineData(AccountState.Active, true)]
    [InlineData(AccountState.Banned, false)]
    [InlineData(AccountState.Deleted, false)]
    public void BannedAndDeletedUsers_HaveNoWriteBoundary(AccountState accountState, bool expectedCanWrite)
    {
        Assert.Equal(expectedCanWrite, CanWrite(accountState));
    }

    [Theory]
    [InlineData(AuthState.Authenticated, true)]
    [InlineData(AuthState.Refreshed, true)]
    [InlineData(AuthState.MfaRequired, false)]
    [InlineData(AuthState.Revoked, false)]
    [InlineData(AuthState.LoggedOut, false)]
    [InlineData(AuthState.Expired, false)]
    public void SensitiveEndpointAccess_IsBoundToLiveFullSession(AuthState state, bool expected)
    {
        Assert.Equal(expected, CanAccessSensitiveEndpoint(state));
    }

    private static AuthState Apply(AuthState state, AuthEvent authEvent)
        => s_transitions.TryGetValue((state, authEvent), out AuthState next)
            ? next
            : throw new InvalidOperationException($"Illegal auth transition: {state} -> {authEvent}");

    private static bool CanAccessSensitiveEndpoint(AuthState state)
        => state is AuthState.Authenticated or AuthState.Refreshed;

    private static bool CanWrite(AccountState state)
        => state == AccountState.Active;

    private sealed class OneTimeSecret
    {
        private int _consumed;

        public bool Consume()
            => Interlocked.CompareExchange(ref _consumed, 1, 0) == 0;
    }

    public enum AuthState
    {
        Guest,
        PowChallengeIssued,
        PasswordSubmitted,
        MfaRequired,
        MfaVerified,
        Authenticated,
        Refreshed,
        Revoked,
        LoggedOut,
        Expired
    }

    private enum AuthEvent
    {
        IssuePowChallenge,
        SubmitValidPassword,
        RequireMfa,
        VerifyTotp,
        UseRecoveryCode,
        InvalidProof,
        CompleteLogin,
        Refresh,
        Logout,
        Revoke,
        Expire
    }

    public enum AccountState
    {
        Active,
        Banned,
        Deleted
    }
}
