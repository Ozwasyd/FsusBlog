using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Security;
using Microsoft.AspNetCore.Http;
using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class UserSecurityStepUpServiceTests
{
    [Fact]
    public async Task MfaEnabledAccount_RequiresActionBoundOneTimeProof()
    {
        IUserAccountReader users = Substitute.For<IUserAccountReader>();
        IMfaChallengeService mfa = Substitute.For<IMfaChallengeService>();
        users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: true));
        mfa.ValidateAndConsumeProofTokenAsync(42, "subject-42", UserSecurityStepUpActions.PasskeyDelete, "proof-1")
            .Returns(true, false);
        var service = new UserSecurityStepUpService(users, mfa);

        UserSecurityStepUpResult first = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.PasskeyDelete,
            new UserSecurityStepUpProof(MfaProofToken: "proof-1"),
            "203.0.113.10"));
        UserSecurityStepUpResult replay = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.PasskeyDelete,
            new UserSecurityStepUpProof(MfaProofToken: "proof-1"),
            "203.0.113.10"));
        UserSecurityStepUpResult wrongAction = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.RecoveryKeyCreate,
            new UserSecurityStepUpProof(MfaProofToken: "proof-1"),
            "203.0.113.10"));

        Assert.True(first.Success);
        Assert.False(replay.Success);
        Assert.False(wrongAction.Success);
        await mfa.Received(2).ValidateAndConsumeProofTokenAsync(42, "subject-42", UserSecurityStepUpActions.PasskeyDelete, "proof-1");
        await mfa.Received(1).ValidateAndConsumeProofTokenAsync(42, "subject-42", UserSecurityStepUpActions.RecoveryKeyCreate, "proof-1");
    }

    [Fact]
    public void AccountDelete_IsCredentialMutationAction()
    {
        Assert.True(UserSecurityStepUpActions.IsCredentialMutation(UserSecurityStepUpActions.AccountDelete));
    }

    [Fact]
    public void UserSecurityStepUpRequest_UsesAccountIdAndFriendlyNameUpdateAction()
    {
        Assert.NotNull(typeof(UserSecurityStepUpRequest).GetProperty("AccountId"));
        Assert.Null(typeof(UserSecurityStepUpRequest).GetProperty("UserId"));
        Assert.Equal("passkey.credential-name.update", UserSecurityStepUpActions.PasskeyCredentialNameUpdate);
        Assert.True(UserSecurityStepUpActions.IsCredentialMutation(UserSecurityStepUpActions.PasskeyCredentialNameUpdate));
    }

    [Fact]
    public async Task MfaEnabledAccount_DoesNotAcceptPasswordFallback()
    {
        IUserAccountReader users = Substitute.For<IUserAccountReader>();
        IMfaChallengeService mfa = Substitute.For<IMfaChallengeService>();
        users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: true));
        var service = new UserSecurityStepUpService(users, mfa);

        UserSecurityStepUpResult result = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.RecoveryKeyRotate,
            new UserSecurityStepUpProof(),
            "203.0.113.10"));

        Assert.False(result.Success);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, result.StatusCode);
        Assert.Equal("MFA_PROOF_REQUIRED", result.Message);
    }

    [Fact]
    public async Task NonMfaAccount_StillRequiresAnonymousStepUpProof()
    {
        IUserAccountReader users = Substitute.For<IUserAccountReader>();
        IMfaChallengeService mfa = Substitute.For<IMfaChallengeService>();
        users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: false));
        var service = new UserSecurityStepUpService(users, mfa);

        UserSecurityStepUpResult result = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.PasskeyCredentialNameUpdate,
            new UserSecurityStepUpProof(),
            "203.0.113.10"));

        Assert.False(result.Success);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, result.StatusCode);
        Assert.Equal("ANONYMOUS_STEP_UP_PROOF_REQUIRED", result.Message);
        await mfa.DidNotReceiveWithAnyArgs().ValidateAndConsumeProofTokenAsync(default, default!, default!);
    }

    [Fact]
    public async Task PasswordProof_IsNotAcceptedAsAnonymousStepUp()
    {
        IUserAccountReader users = Substitute.For<IUserAccountReader>();
        IMfaChallengeService mfa = Substitute.For<IMfaChallengeService>();
        users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: false));
        var service = new UserSecurityStepUpService(users, mfa);

        UserSecurityStepUpResult result = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.RecoveryKeyCreate,
            new UserSecurityStepUpProof(),
            "203.0.113.10"));

        Assert.False(result.Success);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, result.StatusCode);
        Assert.Equal("ANONYMOUS_STEP_UP_PROOF_REQUIRED", result.Message);
        await mfa.DidNotReceiveWithAnyArgs().ValidateAndConsumeProofTokenAsync(default, default!, default!);
    }

    [Fact]
    public async Task MissingDeletedOrBannedAccount_FailsClosedWithoutCheckingProofs()
    {
        IUserAccountReader users = Substitute.For<IUserAccountReader>();
        IMfaChallengeService mfa = Substitute.For<IMfaChallengeService>();
        var service = new UserSecurityStepUpService(users, mfa);

        users.GetAccountByIdAsync(42).Returns((UserAccountSnapshot?)null);
        UserSecurityStepUpResult missing = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.PasskeyDelete,
            new UserSecurityStepUpProof(MfaProofToken: "proof-1"),
            "203.0.113.10"));

        users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: false, deletedAt: DateTime.UtcNow));
        UserSecurityStepUpResult deleted = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.RecoveryKeyCreate,
            new UserSecurityStepUpProof(MfaProofToken: "proof-1"),
            "203.0.113.10"));

        users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: false, status: 2));
        UserSecurityStepUpResult banned = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.RecoveryKeyRotate,
            new UserSecurityStepUpProof(MfaProofToken: "proof-1"),
            "203.0.113.10"));

        Assert.False(missing.Success);
        Assert.False(deleted.Success);
        Assert.False(banned.Success);
        Assert.Equal(StatusCodes.Status401Unauthorized, missing.StatusCode);
        Assert.Equal(StatusCodes.Status401Unauthorized, deleted.StatusCode);
        Assert.Equal(StatusCodes.Status401Unauthorized, banned.StatusCode);
        await mfa.DidNotReceiveWithAnyArgs().ValidateAndConsumeProofTokenAsync(default, default!, default!);
    }

    private static UserAccountSnapshot CreateUser(
        bool mfaEnabled,
        int status = 0,
        DateTime? deletedAt = null)
        => new(
            Id: 42,
            Status: status,
            BanReason: null,
            MfaEnabled: mfaEnabled,
            DeletedAt: deletedAt,
            PublicHandle: null,
            IdentityKind: AnonymousIdentityRuntime.AnonymousAccountKind,
            PasskeyEnabled: true,
            RecoveryEnabled: true,
            AccountSubjectHash: "subject-42");
}
