using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Interfaces;
using System.Globalization;

namespace FsusBlog.Server.Services.Security;

public static class UserSecurityStepUpActions
{
    public const string AccountDelete = "account.delete";
    public const string PasskeyRegister = "passkey.register";
    public const string PasskeyDelete = "passkey.delete";
    public const string PasskeyCredentialNameUpdate = "passkey.credential-name.update";
    public const string RecoveryKeyCreate = "recovery-key.create";
    public const string RecoveryKeyRotate = "recovery-key.rotate";

    public static bool IsCredentialMutation(string action)
        => string.Equals(action, AccountDelete, StringComparison.Ordinal)
            || string.Equals(action, PasskeyRegister, StringComparison.Ordinal)
            || string.Equals(action, PasskeyDelete, StringComparison.Ordinal)
            || string.Equals(action, PasskeyCredentialNameUpdate, StringComparison.Ordinal)
            || string.Equals(action, RecoveryKeyCreate, StringComparison.Ordinal)
            || string.Equals(action, RecoveryKeyRotate, StringComparison.Ordinal);
}

public readonly record struct UserSecurityStepUpProof(
    string? MfaProofToken = null);

public sealed record UserSecurityStepUpRequest(
    int AccountId,
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
    IMfaChallengeService mfaChallenges) : IUserSecurityStepUpService
{
    public async Task<UserSecurityStepUpResult> VerifyAsync(
        UserSecurityStepUpRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (request.AccountId <= 0 || string.IsNullOrWhiteSpace(request.Action))
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

        UserAccountSnapshot? account = await users.GetAccountByIdAsync(request.AccountId).ConfigureAwait(false);
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
                ResolveAccountSubjectHash(account.Value),
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

        return UserSecurityStepUpResult.Rejected(
            ErrorCode.Forbidden,
            "ANONYMOUS_STEP_UP_PROOF_REQUIRED",
            StatusCodes.Status428PreconditionRequired);
    }

    private static string Normalize(string? value)
        => (value ?? string.Empty).Trim();

    private static string ResolveAccountSubjectHash(UserAccountSnapshot account)
        => string.IsNullOrWhiteSpace(account.AccountSubjectHash)
            ? AccountSubjectHasher.Create(
                string.IsNullOrWhiteSpace(account.IdentityKind)
                    ? AnonymousIdentityRuntime.AnonymousAccountKind
                    : account.IdentityKind.Trim(),
                string.Concat("legacy-account:", account.Id.ToString(CultureInfo.InvariantCulture)))
            : account.AccountSubjectHash.Trim().ToLowerInvariant();
}
