using System.Data.Common;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;

using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public class BlacklistService(
    IUnifiedCache cache,
    ISqlSugarClient db) : IBlacklistService
{
    private const int MaxBanReasonLength = 256;
    private const string BanReasonCode = "manual_ban";
    private const int UserStatusNormal = 0;
    private const int UserStatusBanned = 1;
    private const int UserStatusDeleted = 2;

    /// <summary>
    /// 将用户加入黑名单
    /// </summary>
    public async Task BanUserAsync(int userId, string? reason)
    {
        var finalReason = NormalizeReason(reason);
        int updated = await db.Updateable<User>()
            .SetColumns(u => u.Status == UserStatusBanned)
            .SetColumns(u => u.BanReason == finalReason)
            .Where(u => u.Id == userId && u.Status != UserStatusDeleted && u.DeletedAt == null)
            .ExecuteCommandAsync();
        if (updated <= 0)
        {
            return;
        }

        BlacklistCacheRow? row = await LoadBanStateRowAsync(userId).ConfigureAwait(false);
        if (row is not null)
        {
            await PublishBanStateAsync(row, allowOverwrite: true).ConfigureAwait(false);
        }

        await AccountSnapshotCacheInvalidator.BumpVersionAsync(cache, userId).ConfigureAwait(false);
    }

    /// <summary>
    /// 从黑名单移除 (解封)
    /// </summary>
    public async Task UnbanUserAsync(int userId)
    {
        int updated = await db.Updateable<User>()
            .SetColumns(u => u.Status == UserStatusNormal)
            .SetColumns(u => u.BanReason == null)
            .Where(u => u.Id == userId && u.DeletedAt == null)
            .ExecuteCommandAsync();
        if (updated <= 0)
        {
            return;
        }

        BlacklistCacheRow? row = await LoadBanStateRowAsync(userId).ConfigureAwait(false);
        if (row is not null)
        {
            await PublishBanStateAsync(row, allowOverwrite: true).ConfigureAwait(false);
        }

        await AccountSnapshotCacheInvalidator.BumpVersionAsync(cache, userId).ConfigureAwait(false);
    }

    public async Task<BanStateSnapshot> GetBanStateAsync(int accountId, string accountSubjectHash)
    {
        string requiredAccountSubjectHash = AccountSubjectHashRequirement.Require(
            accountSubjectHash,
            "blacklist-read");
        string cacheKey = BuildAccountSubjectCacheKey(requiredAccountSubjectHash);
        string? cached = await cache.GetStringAsync(CachePolicyId.SecurityBlacklistUser, cacheKey);
        if (TryDecodeCacheValue(cached, out BanStateSnapshot cachedSnapshot, out _))
        {
            return cachedSnapshot;
        }
        if (!string.IsNullOrWhiteSpace(cached))
        {
            await cache.RemoveAsync(CachePolicyId.SecurityBlacklistUser, cacheKey).ConfigureAwait(false);
        }

        BlacklistCacheRow? row = await LoadBanStateRowAsync(accountId).ConfigureAwait(false);
        if (row is null)
        {
            return new BanStateSnapshot(false, null, null);
        }
        if (!string.Equals(row.CacheKey, cacheKey, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Blacklist account subject does not match the physical account projection.");
        }

        var snapshot = ToSnapshot(row.Status, row.BanReason);
        bool warmed = await PublishBanStateAsync(row, allowOverwrite: false).ConfigureAwait(false);
        if (!warmed)
        {
            string? current = await cache.GetStringAsync(CachePolicyId.SecurityBlacklistUser, cacheKey).ConfigureAwait(false);
            if (TryDecodeCacheValue(current, out BanStateSnapshot currentSnapshot, out _))
            {
                return currentSnapshot;
            }
        }

        return snapshot;
    }

    internal static string BuildAccountSubjectCacheKey(string accountSubjectHash)
        => AccountSubjectHasher.BuildCacheKey(accountSubjectHash);

    internal static string EncodeCacheValueForTests(int status, string? reason, string rowVersion)
        => EncodeCacheValue(status, reason, rowVersion);

    internal static bool TryDecodeCacheValueForTests(string? value, out BanStateSnapshot snapshot, out string rowVersion)
        => TryDecodeCacheValue(value, out snapshot, out rowVersion);

    private async Task<bool> PublishBanStateAsync(BlacklistCacheRow row, bool allowOverwrite)
    {
        string value = EncodeCacheValue(row.Status, row.BanReason, row.RowVersion);
        return await cache.TrySetVersionedStringAsync(
                CachePolicyId.SecurityBlacklistUser,
                row.CacheKey,
                value,
                row.RowVersion,
                allowOverwrite)
            .ConfigureAwait(false);
    }

    private async Task<BlacklistCacheRow?> LoadBanStateRowAsync(int accountId)
    {
        User? user = await db.Queryable<User>().InSingleAsync(accountId).ConfigureAwait(false);
        if (user is null)
        {
            return null;
        }

        if (!string.IsNullOrWhiteSpace(user.RowVersion))
        {
            return BlacklistCacheRow.FromUser(user, user.RowVersion);
        }

        return await LoadBanStateRowRawAsync(accountId).ConfigureAwait(false);
    }

    private async Task<BlacklistCacheRow?> LoadBanStateRowRawAsync(int accountId)
    {
        await using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id,
                   account_subject_hash,
                   status,
                   banreason,
                   xmin::text AS row_version
            FROM sys_user
            WHERE id = @AccountId;
            """,
            new SugarParameter("@AccountId", accountId));
        if (!await reader.ReadAsync())
        {
            return null;
        }

        var user = new User
        {
            Id = reader.ReadInt32("id"),
            AccountSubjectHash = reader.IsNull("account_subject_hash") ? null : reader.ReadString("account_subject_hash"),
            Status = reader.ReadInt32("status"),
            BanReason = reader.IsNull("banreason") ? null : reader.ReadString("banreason"),
            RowVersion = reader.ReadString("row_version")
        };
        return BlacklistCacheRow.FromUser(user, user.RowVersion);
    }

    private static string EncodeCacheValue(int status, string? reason, string rowVersion)
    {
        if (string.IsNullOrWhiteSpace(rowVersion))
        {
            throw new ArgumentException("Blacklist cache row version must be non-empty.", nameof(rowVersion));
        }

        string normalizedReason = status == UserStatusBanned ? NormalizeReason(reason) : string.Empty;
        return string.Concat("v1|", rowVersion.Trim(), '|', status.ToString(System.Globalization.CultureInfo.InvariantCulture), '|', Base64UrlEncode(normalizedReason));
    }

    private static bool TryDecodeCacheValue(string? value, out BanStateSnapshot snapshot, out string rowVersion)
    {
        snapshot = default;
        rowVersion = string.Empty;
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        string[] parts = value.Split('|', 4);
        if (parts.Length != 4 ||
            !string.Equals(parts[0], "v1", StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(parts[1]) ||
            !int.TryParse(parts[2], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out int status))
        {
            return false;
        }

        string reason;
        try
        {
            reason = Base64UrlDecode(parts[3]);
        }
        catch (FormatException)
        {
            return false;
        }

        rowVersion = parts[1];
        snapshot = ToSnapshot(status, reason);
        return status is UserStatusNormal or UserStatusBanned or UserStatusDeleted;
    }

    private static BanStateSnapshot ToSnapshot(int status, string? reason)
    {
        if (status != UserStatusBanned)
        {
            return new BanStateSnapshot(false, null, null);
        }

        return new BanStateSnapshot(true, BanReasonCode, NormalizeReason(reason));
    }

    private static string Base64UrlEncode(string value)
        => Convert.ToBase64String(Encoding.UTF8.GetBytes(value))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');

    private static string Base64UrlDecode(string value)
    {
        string normalized = value.Replace('-', '+').Replace('_', '/');
        normalized = normalized.PadRight((normalized.Length + 3) / 4 * 4, '=');
        return Encoding.UTF8.GetString(Convert.FromBase64String(normalized));
    }

    private static string NormalizeReason(string? reason)
    {
        if (string.IsNullOrWhiteSpace(reason))
        {
            return "账号异常，已被系统封禁";
        }

        var value = reason.Trim();
        return value.Length > MaxBanReasonLength ? value[..MaxBanReasonLength] : value;
    }

    private sealed record class BlacklistCacheRow(int Status, string? BanReason, string RowVersion, string CacheKey)
    {
        public static BlacklistCacheRow FromUser(User user, string rowVersion)
            => new(
                user.Status,
                user.BanReason,
                rowVersion,
                BuildAccountSubjectCacheKey(
                    AccountSubjectHashRequirement.Require(user.AccountSubjectHash, "blacklist-cache-row")));
    }
}
