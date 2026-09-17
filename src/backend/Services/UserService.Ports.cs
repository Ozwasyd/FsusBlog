using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Services;

public sealed class UserAccountReader(IAccountStateProjection projection) : IUserAccountReader
{
    public async Task<UserAccountSnapshot?> GetAccountByIdAsync(int id)
    {
        AccountStateReadResult result = await projection.ReadByIdAsync(id).ConfigureAwait(false);
        return result.Outcome is AccountStateReadOutcome.Present or AccountStateReadOutcome.Deleted
            ? ToAccountSnapshot(result.Snapshot!)
            : null;
    }

    internal static UserAccountSnapshot ToAccountSnapshot(AccountStateSnapshot snapshot)
        => new(
            snapshot.AccountId,
            snapshot.Status,
            snapshot.BanReason,
            snapshot.MfaEnabled,
            snapshot.DeletedAt,
            snapshot.PublicHandle,
            snapshot.IdentityKind,
            snapshot.PasskeyEnabled,
            snapshot.RecoveryEnabled,
            snapshot.AnonymousCredentialStatus,
            snapshot.AnonymousCredentialLevel,
            snapshot.AccountSubjectHash,
            snapshot.RegistrationState);

    internal static UserAccountSnapshot ToAccountSnapshot(User user)
        => new(
            user.Id,
            user.Status,
            user.BanReason,
            user.MfaEnabled,
            user.DeletedAt,
            user.PublicHandle,
            user.IdentityKind,
            user.PasskeyEnabled,
            user.RecoveryEnabled,
            user.AnonymousCredentialStatus,
            user.AnonymousCredentialLevel,
            user.AccountSubjectHash,
            user.RegistrationState);

    internal static IdentityAccountSnapshotCoreModel ToAnonymousAccountSnapshot(UserAccountSnapshot account)
        => new(
            AccountId: account.Id,
            PublicHandle: string.IsNullOrWhiteSpace(account.PublicHandle) ? null : account.PublicHandle,
            PasskeyEnabled: account.PasskeyEnabled,
            RecoveryEnabled: account.RecoveryEnabled,
            TotpStepUpEnabled: account.MfaEnabled,
            AnonymousCredentialStatus: string.IsNullOrWhiteSpace(account.AnonymousCredentialStatus) ? null : account.AnonymousCredentialStatus,
            AnonymousCredentialLevel: string.IsNullOrWhiteSpace(account.AnonymousCredentialLevel) ? null : account.AnonymousCredentialLevel,
            IdentityKind: string.IsNullOrWhiteSpace(account.IdentityKind) ? AnonymousIdentityRuntime.AnonymousAccountKind : account.IdentityKind,
            Status: account.Status,
            BanReason: string.IsNullOrWhiteSpace(account.BanReason) ? null : account.BanReason,
            DeletedAt: account.DeletedAt);
}
