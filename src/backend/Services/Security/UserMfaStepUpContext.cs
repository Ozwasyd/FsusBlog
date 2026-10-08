using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Interfaces;

namespace FsusBlog.Server.Services.Security;

/// <summary>Identifies the current action authorized by a session-bound MFA proof.</summary>
public enum UserMfaManagementAction
{
    Setup,
    SetupRebind,
    Disable,
    RecoveryCodesRegenerate
}

/// <summary>Owns the exact proof actions consumed by ordinary-account MFA management.</summary>
public static class UserMfaManagementActions
{
    /// <summary>Maps only the closed current action catalog; unknown actions fail closed.</summary>
    public static bool TryGetProofAction(UserMfaManagementAction action, out string proofAction)
    {
        proofAction = action switch
        {
            UserMfaManagementAction.Setup => "mfa_setup",
            UserMfaManagementAction.SetupRebind => "mfa_setup_rebind",
            UserMfaManagementAction.Disable => "mfa_disable",
            UserMfaManagementAction.RecoveryCodesRegenerate => "mfa_recovery_regenerate",
            _ => string.Empty
        };
        return proofAction.Length > 0;
    }
}

/// <summary>Retains only the account, session and action after the original proof owner accepts and consumes a proof.</summary>
public readonly struct UserMfaStepUpContext
{
    private UserMfaStepUpContext(int accountId, string sessionId, UserMfaManagementAction action)
    {
        AccountId = accountId;
        SessionId = sessionId;
        Action = action;
    }

    public int AccountId
    {
        get;
    }

    public string SessionId
    {
        get;
    }

    public UserMfaManagementAction Action
    {
        get;
    }

    /// <summary>Creates a context only after consuming the exact account-, session- and action-bound proof.</summary>
    public static async Task<UserMfaStepUpContext?> VerifyAsync(
        UserAccountSnapshot account,
        string sessionId,
        UserMfaManagementAction action,
        string proofToken,
        IMfaChallengeService mfaChallenges)
    {
        ArgumentNullException.ThrowIfNull(mfaChallenges);
        if (account.Id <= 0 || account.DeletedAt.HasValue || account.Status == 2
            || !AccountRegistrationStates.IsActive(account.RegistrationState)
            || !string.Equals(account.IdentityKind, AnonymousIdentityRuntime.AnonymousAccountKind, StringComparison.Ordinal)
            || string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(proofToken)
            || !AccountSubjectHashRequirement.TryResolve(account.AccountSubjectHash, out string accountSubjectHash)
            || !UserMfaManagementActions.TryGetProofAction(action, out string proofAction))
        {
            return null;
        }

        bool accepted = await mfaChallenges.ValidateAndConsumeProofTokenAsync(
            account.Id, accountSubjectHash, sessionId, proofAction, proofToken).ConfigureAwait(false);
        return accepted ? new UserMfaStepUpContext(account.Id, sessionId, action) : null;
    }

    /// <summary>Rejects a context issued for a different account or MFA mutation.</summary>
    public bool IsValidFor(int accountId, UserMfaManagementAction action)
        => AccountId > 0 && !string.IsNullOrWhiteSpace(SessionId) && AccountId == accountId && Action == action;
}
