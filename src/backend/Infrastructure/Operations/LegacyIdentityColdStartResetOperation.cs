using System.Data;
using System.Globalization;
using FsusBlog.Server.Infrastructure.Cache;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Operations;

public sealed record LegacyIdentityColdStartResetResult(
    int UsersDeleted,
    int SessionsDeleted,
    int PasskeyCredentialsDeleted,
    int AccountRecoveryKeysDeleted,
    int AnonymousCredentialsDeleted,
    int AnonymousCredentialIssuanceAuditsDeleted,
    int CommentAnonymousNullifiersDeleted,
    int CommentsDeleted,
    int CommentRegionComplianceDeleted,
    int CommentModerationSignalsDeleted,
    int MessageParticipantStatesDeleted,
    int UserBoundMessagesDeleted,
    int UserBoundConversationsDeleted);

public interface ILegacyIdentityColdStartResetOperation
{
    Task<LegacyIdentityColdStartResetResult> RunFromEnvironmentAsync(CancellationToken cancellationToken = default);
}

public sealed class LegacyIdentityColdStartResetOperation(
    ISqlSugarClient db,
    ILogger<LegacyIdentityColdStartResetOperation> logger,
    IServiceProvider serviceProvider) : ILegacyIdentityColdStartResetOperation
{
    public const string ConfirmationEnvironmentVariable = "FSUSBLOG_CONFIRM_IDENTITY_RESET";
    public const string RequiredConfirmation = "DELETE_LEGACY_USERS";

    private readonly ISqlSugarClient _db = db;
    private readonly ILogger<LegacyIdentityColdStartResetOperation> _logger = logger;
    private readonly IServiceProvider _serviceProvider = serviceProvider;

    public static bool IsRequestedFromEnvironment()
        => !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(ConfirmationEnvironmentVariable));

    public async Task<LegacyIdentityColdStartResetResult> RunFromEnvironmentAsync(CancellationToken cancellationToken = default)
        => await RunAsync(Environment.GetEnvironmentVariable(ConfirmationEnvironmentVariable), cancellationToken);

    public async Task<LegacyIdentityColdStartResetResult> RunAsync(
        string? confirmation,
        CancellationToken cancellationToken = default)
    {
        ValidateConfirmation(confirmation);
        cancellationToken.ThrowIfCancellationRequested();

        LegacyIdentityColdStartResetResult? result = null;
        List<int> resetUserIds = [];
        var transaction = await _db.Ado.UseTranAsync(async () =>
        {
            await _db.Ado.ExecuteCommandAsync("""
                CREATE TEMP TABLE IF NOT EXISTS fsus_identity_reset_user_ids (
                    userid integer PRIMARY KEY
                ) ON COMMIT DROP;

                TRUNCATE TABLE fsus_identity_reset_user_ids;

                INSERT INTO fsus_identity_reset_user_ids(userid)
                SELECT id FROM sys_user;
                """);
            resetUserIds = await ReadResetUserIdsAsync(cancellationToken);

            int moderationSignalsDeleted = await DeleteAndCountAsync(
                "DELETE FROM comment_moderation_signal",
                cancellationToken);
            int regionComplianceDeleted = await DeleteAndCountAsync(
                "DELETE FROM comment_region_compliance",
                cancellationToken);
            int commentAnonymousNullifiersDeleted = await DeleteAndCountIfTableExistsAsync(
                "comment_anonymous_nullifier",
                "DELETE FROM comment_anonymous_nullifier",
                cancellationToken);
            int commentsDeleted = await DeleteAndCountAsync(
                "DELETE FROM comment",
                cancellationToken);
            int anonymousCredentialIssuanceAuditsDeleted = await DeleteAndCountIfTableExistsAsync(
                "anonymous_credential_issuance_audit",
                "DELETE FROM anonymous_credential_issuance_audit",
                cancellationToken);
            int anonymousCredentialsDeleted = await DeleteAndCountIfTableExistsAsync(
                "anonymous_credential",
                "DELETE FROM anonymous_credential",
                cancellationToken);
            int accountRecoveryKeysDeleted = await DeleteAndCountIfTableExistsAsync(
                "account_recovery_key",
                "DELETE FROM account_recovery_key",
                cancellationToken);
            int participantStatesDeleted = await DeleteAndCountAsync(
                """
                DELETE FROM msg_participant_state participant
                USING fsus_identity_reset_user_ids legacy_user
                WHERE participant.accountid = legacy_user.userid
                """,
                cancellationToken);
            int userBoundMessagesDeleted = await DeleteAndCountAsync(
                """
                DELETE FROM msg_message message
                USING fsus_identity_reset_user_ids legacy_user
                WHERE message.senderaccountid = legacy_user.userid
                """,
                cancellationToken);
            int userBoundConversationsDeleted = await DeleteAndCountAsync(
                """
                DELETE FROM msg_conversation conversation
                USING fsus_identity_reset_user_ids legacy_user
                WHERE conversation.initiatoraccountid = legacy_user.userid
                   OR conversation.createdbyaccountid = legacy_user.userid
                """,
                cancellationToken);
            int passkeyCredentialsDeleted = await DeleteAndCountAsync(
                """
                DELETE FROM passkey_credential credential
                USING fsus_identity_reset_user_ids legacy_user
                WHERE credential.account_id = legacy_user.userid
                """,
                cancellationToken);
            int sessionsDeleted = await DeleteAndCountAsync(
                """
                DELETE FROM sys_user_session session
                USING fsus_identity_reset_user_ids legacy_user
                WHERE session.userid = legacy_user.userid
                """,
                cancellationToken);
            int usersDeleted = await DeleteAndCountAsync("DELETE FROM sys_user", cancellationToken);

            result = new LegacyIdentityColdStartResetResult(
                usersDeleted,
                sessionsDeleted,
                passkeyCredentialsDeleted,
                accountRecoveryKeysDeleted,
                anonymousCredentialsDeleted,
                anonymousCredentialIssuanceAuditsDeleted,
                commentAnonymousNullifiersDeleted,
                commentsDeleted,
                regionComplianceDeleted,
                moderationSignalsDeleted,
                participantStatesDeleted,
                userBoundMessagesDeleted,
                userBoundConversationsDeleted);
        });

        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("Legacy identity cold-start reset failed.", transaction.ErrorException);
        }

        LegacyIdentityColdStartResetResult committed = result
            ?? throw new InvalidOperationException("Legacy identity cold-start reset produced no result.");
        await RemoveLegacyUserCachesAsync(resetUserIds, cancellationToken);
        _logger.LogWarning(
            "Legacy identity cold-start reset deleted users={UsersDeleted}, sessions={SessionsDeleted}, passkeys={PasskeyCredentialsDeleted}, recoveryKeys={AccountRecoveryKeysDeleted}, anonymousCredentials={AnonymousCredentialsDeleted}, credentialAudits={AnonymousCredentialIssuanceAuditsDeleted}, commentNullifiers={CommentAnonymousNullifiersDeleted}, comments={CommentsDeleted}.",
            committed.UsersDeleted,
            committed.SessionsDeleted,
            committed.PasskeyCredentialsDeleted,
            committed.AccountRecoveryKeysDeleted,
            committed.AnonymousCredentialsDeleted,
            committed.AnonymousCredentialIssuanceAuditsDeleted,
            committed.CommentAnonymousNullifiersDeleted,
            committed.CommentsDeleted);

        return committed;
    }

    private static void ValidateConfirmation(string? confirmation)
    {
        if (string.Equals(confirmation, RequiredConfirmation, StringComparison.Ordinal))
        {
            return;
        }

        throw new InvalidOperationException(
            $"{ConfirmationEnvironmentVariable} must equal {RequiredConfirmation} before legacy identity/comment reset can run.");
    }

    private async Task<int> DeleteAndCountAsync(string deleteSql, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DataTable table = await _db.Ado.GetDataTableAsync($"""
            WITH deleted AS (
                {deleteSql}
                RETURNING 1
            )
            SELECT COUNT(1)::integer FROM deleted;
            """);

        return Convert.ToInt32(table.Rows[0][0]);
    }

    private async Task<int> DeleteAndCountIfTableExistsAsync(
        string tableName,
        string deleteSql,
        CancellationToken cancellationToken)
    {
        if (!await TableExistsAsync(tableName, cancellationToken))
        {
            return 0;
        }

        return await DeleteAndCountAsync(deleteSql, cancellationToken);
    }

    private async Task<bool> TableExistsAsync(string tableName, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DataTable table = await _db.Ado.GetDataTableAsync(
            """
            SELECT EXISTS (
                SELECT 1
                FROM information_schema.tables
                WHERE table_schema = current_schema()
                  AND table_name = @TableName
            )::boolean;
            """,
            new SugarParameter("@TableName", tableName));

        return table.Rows.Count > 0 && Convert.ToBoolean(table.Rows[0][0]);
    }

    private async Task<List<int>> ReadResetUserIdsAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DataTable table = await _db.Ado.GetDataTableAsync("""
            SELECT userid
            FROM fsus_identity_reset_user_ids
            ORDER BY userid;
            """);

        var userIds = new List<int>(table.Rows.Count);
        foreach (DataRow row in table.Rows)
        {
            userIds.Add(Convert.ToInt32(row["userid"]));
        }

        return userIds;
    }

    private async Task RemoveLegacyUserCachesAsync(
        IReadOnlyList<int> userIds,
        CancellationToken cancellationToken)
    {
        if (userIds.Count == 0)
        {
            return;
        }

        IUnifiedCache? cache = _serviceProvider.GetService<IUnifiedCache>();
        if (cache is null)
        {
            _logger.LogWarning(
                "Legacy identity cold-start reset could not clear user cache entries because IUnifiedCache is not registered.");
            return;
        }

        var keys = new List<CacheKeyIdentity>(userIds.Count * 4);
        var prefixes = new List<CachePrefixIdentity>(userIds.Count * 2);
        foreach (int userId in userIds)
        {
            string identity = userId.ToString(CultureInfo.InvariantCulture);
            keys.Add(new CacheKeyIdentity(CachePolicyId.SecurityBlacklistUser, identity));
            keys.Add(new CacheKeyIdentity(CachePolicyId.SecurityBlockedUser, identity));
            keys.Add(new CacheKeyIdentity(CachePolicyId.MessageUnread, identity));
            keys.Add(new CacheKeyIdentity(CachePolicyId.MessageUnread, $"account:{identity}"));
            prefixes.Add(new CachePrefixIdentity(CachePolicyId.UserCommentCursor, $"account:{identity}:"));
            prefixes.Add(new CachePrefixIdentity(CachePolicyId.UserCommentCursorFrame, $"account:{identity}:"));
        }

        await cache.RemoveManyAsync(keys, cancellationToken);
        await cache.RemoveByPrefixManyAsync(prefixes, cancellationToken);
    }
}
