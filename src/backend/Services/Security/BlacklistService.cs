using System.Data.Common;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;

using SqlSugar;

namespace FsusBlog.Server.Services.Security;

/// <summary>
/// Owns authoritative Ban/Unban mutations and exposes the bounded process-local
/// projection. It deliberately has no Redis/cache-string dependency.
/// </summary>
public sealed class BlacklistService(
    ISqlSugarClient db,
    IAccountStateProjectionMutationPublisher accountStates,
    BanStateProjection projection,
    IBanStateProjectionObligationCoordinator obligations) : IBlacklistService
{
    private const int MaxBanReasonLength = 256;

    public Task BanUserAsync(int userId, string? reason)
        => MutateAsync(userId, BanStateProjectionFacts.BannedStatus, NormalizeReason(reason));

    public Task UnbanUserAsync(int userId)
        => MutateAsync(userId, BanStateProjectionFacts.NormalStatus, null);

    public async Task<BanStateSnapshot> GetBanStateAsync(int accountId, string accountSubjectHash)
    {
        string subjectHash = AccountSubjectHashRequirement.Require(accountSubjectHash, "blacklist-read");
        BanStateProjectionLookup lookup = await projection
            .GetAsync(accountId, subjectHash)
            .ConfigureAwait(false);
        return lookup.Status switch
        {
            BanStateProjectionStatus.Normal => new BanStateSnapshot(false, null, null, true, false, lookup.Generation),
            BanStateProjectionStatus.Banned => new BanStateSnapshot(
                true,
                lookup.ReasonCode,
                "账号异常，已被系统封禁",
                true,
                false,
                lookup.Generation),
            BanStateProjectionStatus.Deleted => new BanStateSnapshot(false, null, null, true, true, lookup.Generation),
            _ => new BanStateSnapshot(false, null, null, false, false, lookup.Generation)
        };
    }

    private async Task MutateAsync(int userId, int status, string? reason)
    {
        BanStateProjectionUpdate? update = null;
        DistributedInvalidationEvent? invalidation = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            {
                using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                    """
                    UPDATE sys_user
                    SET status = @Status,
                        banreason = @BanReason,
                        ban_state_generation = ban_state_generation + 1
                    WHERE id = @AccountId
                      AND status <> 2
                      AND deleted_at IS NULL
                      AND (status IS DISTINCT FROM @Status OR banreason IS DISTINCT FROM @BanReason)
                    RETURNING account_subject_hash, status, ban_state_generation;
                    """,
                    new SugarParameter("@AccountId", userId),
                    new SugarParameter("@Status", status),
                    new SugarParameter("@BanReason", reason));
                if (!await reader.ReadAsync().ConfigureAwait(false))
                {
                    return;
                }
                if (reader.IsNull("account_subject_hash"))
                {
                    throw new InvalidOperationException("ban state projection identity is missing");
                }

                update = BanStateProjectionFacts.Create(
                    reader.ReadString("account_subject_hash"),
                    reader.ReadInt32("status"),
                    reader.ReadInt64("ban_state_generation"));
            }
            invalidation = await obligations.PrepareAsync([update.Value]).ConfigureAwait(false);
        });
        if (!transaction.IsSuccess)
        {
            throw transaction.ErrorException ?? new InvalidOperationException("ban state mutation transaction failed");
        }
        if (update is null)
        {
            return;
        }

        await obligations.ApplyLocalAndPublishPreparedAsync(invalidation, [update.Value]).ConfigureAwait(false);
        await accountStates.ProjectCommittedMutationAsync(userId).ConfigureAwait(false);
    }

    private static string NormalizeReason(string? reason)
    {
        if (string.IsNullOrWhiteSpace(reason))
        {
            return "账号异常，已被系统封禁";
        }

        string value = reason.Trim();
        return value.Length > MaxBanReasonLength ? value[..MaxBanReasonLength] : value;
    }
}
