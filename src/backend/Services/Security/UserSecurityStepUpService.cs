using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Services.Security;

public static class UserSecurityStepUpActions
{
    public const string AccountDelete = "account.delete";
    public const string PasskeyDelete = "passkey.delete";
    public const string PasskeyRename = "passkey.rename";
    public const string RecoveryKeyCreate = "recovery-key.create";
    public const string RecoveryKeyRotate = "recovery-key.rotate";

    public static bool IsCredentialMutation(string action)
        => string.Equals(action, AccountDelete, StringComparison.Ordinal)
            || string.Equals(action, PasskeyDelete, StringComparison.Ordinal)
            || string.Equals(action, PasskeyRename, StringComparison.Ordinal)
            || string.Equals(action, RecoveryKeyCreate, StringComparison.Ordinal)
            || string.Equals(action, RecoveryKeyRotate, StringComparison.Ordinal);
}

public readonly record struct UserSecurityStepUpProof(
    string? MfaProofToken = null,
    string? Password = null);

public sealed record UserSecurityStepUpRequest(
    int UserId,
    string Action,
    UserSecurityStepUpProof Proof,
    string ClientIp);

public readonly record struct UserSecurityStepUpResult(
    bool Success,
    ErrorCode ErrorCode,
    string Message,
    int StatusCode)
{
    public static UserSecurityStepUpResult Succeeded()
        => new(true, ErrorCode.None, "OK", StatusCodes.Status200OK);

    public static UserSecurityStepUpResult Rejected(ErrorCode errorCode, string message, int statusCode)
        => new(false, errorCode, message, statusCode);
}

public interface IUserSecurityStepUpService
{
    Task<UserSecurityStepUpResult> VerifyAsync(
        UserSecurityStepUpRequest request,
        CancellationToken cancellationToken = default);
}

public sealed class UserSecurityStepUpService(
    IUserAccountReader users,
    IMfaChallengeService mfaChallenges,
    IUserLoginWorkflowService loginWorkflow) : IUserSecurityStepUpService
{
    public async Task<UserSecurityStepUpResult> VerifyAsync(
        UserSecurityStepUpRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (request.UserId <= 0 || string.IsNullOrWhiteSpace(request.Action))
        {
            return UserSecurityStepUpResult.Rejected(
                ErrorCode.Unauthorized,
                "STEP_UP_PRINCIPAL_REQUIRED",
                StatusCodes.Status401Unauthorized);
        }

        string action = request.Action.Trim();
        if (!UserSecurityStepUpActions.IsCredentialMutation(action))
        {
            return UserSecurityStepUpResult.Rejected(
                ErrorCode.Forbidden,
                "STEP_UP_ACTION_UNSUPPORTED",
                StatusCodes.Status403Forbidden);
        }

        UserAccountSnapshot? account = await users.GetAccountByIdAsync(request.UserId).ConfigureAwait(false);
        if (account is null || account.Value.DeletedAt.HasValue || account.Value.Status == 2)
        {
            return UserSecurityStepUpResult.Rejected(
                ErrorCode.Unauthorized,
                "USER_NOT_FOUND",
                StatusCodes.Status401Unauthorized);
        }

        string proofToken = Normalize(request.Proof.MfaProofToken);
        if (!string.IsNullOrWhiteSpace(proofToken))
        {
            bool accepted = await mfaChallenges.ValidateAndConsumeProofTokenAsync(
                account.Value.Id,
                action,
                proofToken).ConfigureAwait(false);
            return accepted
                ? UserSecurityStepUpResult.Succeeded()
                : UserSecurityStepUpResult.Rejected(
                    ErrorCode.Forbidden,
                    "STEP_UP_PROOF_INVALID",
                    StatusCodes.Status428PreconditionRequired);
        }

        if (account.Value.MfaEnabled)
        {
            return UserSecurityStepUpResult.Rejected(
                ErrorCode.Forbidden,
                "MFA_PROOF_REQUIRED",
                StatusCodes.Status428PreconditionRequired);
        }

        if (AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled())
        {
            return UserSecurityStepUpResult.Rejected(
                ErrorCode.Forbidden,
                "ANONYMOUS_STEP_UP_PROOF_REQUIRED",
                StatusCodes.Status428PreconditionRequired);
        }

        string password = Normalize(request.Proof.Password);
        if (string.IsNullOrWhiteSpace(password))
        {
            return UserSecurityStepUpResult.Rejected(
                ErrorCode.Forbidden,
                "PASSWORD_OR_STEP_UP_PROOF_REQUIRED",
                StatusCodes.Status428PreconditionRequired);
        }

        var credentials = await loginWorkflow.ValidateCredentialsAsync(
            new LoginDto
            {
                Username = account.Value.Username,
                Password = password
            },
            request.ClientIp,
            cancellationToken).ConfigureAwait(false);
        if (!credentials.Success || credentials.User?.Id != account.Value.Id)
        {
            return UserSecurityStepUpResult.Rejected(
                ErrorCode.Forbidden,
                "PASSWORD_PROOF_INVALID",
                StatusCodes.Status403Forbidden);
        }

        return UserSecurityStepUpResult.Succeeded();
    }

    private static string Normalize(string? value)
        => (value ?? string.Empty).Trim();
}
