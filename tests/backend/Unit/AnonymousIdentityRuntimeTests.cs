namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousIdentityRuntimeTests
{
    [Theory]
    [InlineData(AnonymousIdentityRuntime.AnonymousAccountKind, CurrentIdentityKind.AnonymousAccount)]
    [InlineData(AnonymousIdentityRuntime.AdminPrincipalKind, CurrentIdentityKind.AdminPrincipal)]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public void CurrentIdentityKind_PreservesExactWireValue(string value, CurrentIdentityKind expected)
    {
        Assert.True(AnonymousIdentityRuntime.TryParse(value, out CurrentIdentityKind actual));
        Assert.Equal(expected, actual);
        Assert.Equal(value, AnonymousIdentityRuntime.ToWireValue(actual));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("admin")]
    [InlineData("user")]
    [InlineData("Anonymous_Account")]
    [InlineData(" anonymous_account ")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "current-identity-kind-rejects-legacy-and-unknown-values")]
    public void CurrentIdentityKind_RejectsLegacyOrRepairedValues(string? value)
    {
        Assert.False(AnonymousIdentityRuntime.TryParse(value, out CurrentIdentityKind kind));
        Assert.Throws<ArgumentOutOfRangeException>(() => AnonymousIdentityRuntime.ToWireValue(kind));
    }

    [Theory]
    [InlineData(AccountRegistrationStates.Provisional, AccountRegistrationState.Provisional)]
    [InlineData(AccountRegistrationStates.Active, AccountRegistrationState.Active)]
    [InlineData(AccountRegistrationStates.Suspended, AccountRegistrationState.Suspended)]
    [InlineData(AccountRegistrationStates.Closed, AccountRegistrationState.Closed)]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public void CurrentRegistrationState_PreservesExactWireValue(string value, AccountRegistrationState expected)
    {
        Assert.True(AccountRegistrationStates.TryParse(value, out AccountRegistrationState actual));
        Assert.Equal(expected, actual);
        Assert.Equal(value, AccountRegistrationStates.ToWireValue(actual));
        Assert.Equal(expected == AccountRegistrationState.Active, AccountRegistrationStates.IsActive(value));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("registered")]
    [InlineData("Active")]
    [InlineData(" active ")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "current-registration-state-rejects-legacy-and-unknown-values")]
    public void CurrentRegistrationState_RejectsLegacyOrRepairedValues(string? value)
    {
        Assert.False(AccountRegistrationStates.TryParse(value, out AccountRegistrationState state));
        Assert.False(AccountRegistrationStates.IsActive(value));
        Assert.Throws<ArgumentOutOfRangeException>(() => AccountRegistrationStates.ToWireValue(state));
    }
}
