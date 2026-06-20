using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
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
        IUserLoginWorkflowService login = Substitute.For<IUserLoginWorkflowService>();
        users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: true));
        mfa.ValidateAndConsumeProofTokenAsync(42, UserSecurityStepUpActions.PasskeyDelete, "proof-1")
            .Returns(true, false);
        var service = new UserSecurityStepUpService(users, mfa, login);

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
        await mfa.Received(2).ValidateAndConsumeProofTokenAsync(42, UserSecurityStepUpActions.PasskeyDelete, "proof-1");
        await mfa.Received(1).ValidateAndConsumeProofTokenAsync(42, UserSecurityStepUpActions.RecoveryKeyCreate, "proof-1");
        await login.DidNotReceiveWithAnyArgs().ValidateCredentialsAsync(default!, default!, default);
    }

    [Fact]
    public void AccountDelete_IsCredentialMutationAction()
    {
        Assert.True(UserSecurityStepUpActions.IsCredentialMutation(UserSecurityStepUpActions.AccountDelete));
    }

    [Fact]
    public async Task MfaEnabledAccount_DoesNotAcceptPasswordFallback()
    {
        IUserAccountReader users = Substitute.For<IUserAccountReader>();
        IMfaChallengeService mfa = Substitute.For<IMfaChallengeService>();
        IUserLoginWorkflowService login = Substitute.For<IUserLoginWorkflowService>();
        users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: true));
        var service = new UserSecurityStepUpService(users, mfa, login);

        UserSecurityStepUpResult result = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.RecoveryKeyRotate,
            new UserSecurityStepUpProof(Password: "correct-password"),
            "203.0.113.10"));

        Assert.False(result.Success);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, result.StatusCode);
        Assert.Equal("MFA_PROOF_REQUIRED", result.Message);
        await login.DidNotReceiveWithAnyArgs().ValidateCredentialsAsync(default!, default!, default);
    }

    [Fact]
    public async Task LegacyNonMfaAccount_AcceptsPasswordProof()
    {
        IUserAccountReader users = Substitute.For<IUserAccountReader>();
        IMfaChallengeService mfa = Substitute.For<IMfaChallengeService>();
        IUserLoginWorkflowService login = Substitute.For<IUserLoginWorkflowService>();
        users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: false, username: "alice"));
        login.ValidateCredentialsAsync(
                Arg.Is<LoginDto>(dto => dto.Username == "alice" && dto.Password == "correct-password"),
                "203.0.113.10",
                Arg.Any<CancellationToken>())
            .Returns((true, "ok", CreateUser(mfaEnabled: false, username: "alice")));
        var service = new UserSecurityStepUpService(users, mfa, login);

        UserSecurityStepUpResult result = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.PasskeyRename,
            new UserSecurityStepUpProof(Password: "correct-password"),
            "203.0.113.10"));

        Assert.True(result.Success);
        await mfa.DidNotReceiveWithAnyArgs().ValidateAndConsumeProofTokenAsync(default, default!, default!);
    }

    [Fact]
    public async Task AnonymousIdentityMode_DisablesLegacyPasswordFallback()
    {
        string? previous = Environment.GetEnvironmentVariable(AnonymousIdentityRuntime.ModeEnvironmentVariable);
        Environment.SetEnvironmentVariable(AnonymousIdentityRuntime.ModeEnvironmentVariable, "1");
        try
        {
            IUserAccountReader users = Substitute.For<IUserAccountReader>();
            IMfaChallengeService mfa = Substitute.For<IMfaChallengeService>();
            IUserLoginWorkflowService login = Substitute.For<IUserLoginWorkflowService>();
            users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: false, username: "alice"));
            var service = new UserSecurityStepUpService(users, mfa, login);

            UserSecurityStepUpResult result = await service.VerifyAsync(new UserSecurityStepUpRequest(
                42,
                UserSecurityStepUpActions.RecoveryKeyCreate,
                new UserSecurityStepUpProof(Password: "correct-password"),
                "203.0.113.10"));

            Assert.False(result.Success);
            Assert.Equal(StatusCodes.Status428PreconditionRequired, result.StatusCode);
            Assert.Equal("ANONYMOUS_STEP_UP_PROOF_REQUIRED", result.Message);
            await login.DidNotReceiveWithAnyArgs().ValidateCredentialsAsync(default!, default!, default);
        }
        finally
        {
            Environment.SetEnvironmentVariable(AnonymousIdentityRuntime.ModeEnvironmentVariable, previous);
        }
    }

    [Fact]
    public async Task MissingDeletedOrBannedAccount_FailsClosedWithoutCheckingProofs()
    {
        IUserAccountReader users = Substitute.For<IUserAccountReader>();
        IMfaChallengeService mfa = Substitute.For<IMfaChallengeService>();
        IUserLoginWorkflowService login = Substitute.For<IUserLoginWorkflowService>();
        var service = new UserSecurityStepUpService(users, mfa, login);

        users.GetAccountByIdAsync(42).Returns((UserAccountSnapshot?)null);
        UserSecurityStepUpResult missing = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.PasskeyDelete,
            new UserSecurityStepUpProof(MfaProofToken: "proof-1", Password: "password"),
            "203.0.113.10"));

        users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: false, deletedAt: DateTime.UtcNow));
        UserSecurityStepUpResult deleted = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.RecoveryKeyCreate,
            new UserSecurityStepUpProof(MfaProofToken: "proof-1", Password: "password"),
            "203.0.113.10"));

        users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: false, status: 2));
        UserSecurityStepUpResult banned = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.RecoveryKeyRotate,
            new UserSecurityStepUpProof(MfaProofToken: "proof-1", Password: "password"),
            "203.0.113.10"));

        Assert.False(missing.Success);
        Assert.False(deleted.Success);
        Assert.False(banned.Success);
        Assert.Equal(StatusCodes.Status401Unauthorized, missing.StatusCode);
        Assert.Equal(StatusCodes.Status401Unauthorized, deleted.StatusCode);
        Assert.Equal(StatusCodes.Status401Unauthorized, banned.StatusCode);
        await mfa.DidNotReceiveWithAnyArgs().ValidateAndConsumeProofTokenAsync(default, default!, default!);
        await login.DidNotReceiveWithAnyArgs().ValidateCredentialsAsync(default!, default!, default);
    }

    private static UserAccountSnapshot CreateUser(
        bool mfaEnabled,
        string username = "alice",
        int status = 0,
        DateTime? deletedAt = null)
        => new(
            Id: 42,
            Username: username,
            Role: "guest",
            Status: status,
            BanReason: null,
            MfaEnabled: mfaEnabled,
            DeletedAt: deletedAt,
            PublicHandle: null,
            IdentityKind: AnonymousIdentityRuntime.AnonymousAccountKind,
            PasskeyEnabled: true,
            RecoveryEnabled: true);
}
