using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Operations;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using SqlSugar;

namespace FsusBlog.Server.Tests;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollection))]
public sealed class LegacyIdentityColdStartResetIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task RunAsync_FailsBeforeDeletingRows_WhenConfirmationIsMissing()
    {
        string databaseName = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(databaseName);
        await SeedLegacyIdentityRowsAsync(connectionString);

        await using ServiceProvider provider = BuildProvider(connectionString);
        await using AsyncServiceScope scope = provider.CreateAsyncScope();
        var operation = scope.ServiceProvider.GetRequiredService<LegacyIdentityColdStartResetOperation>();

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(
            async () => await operation.RunAsync(null, CancellationToken.None));

        Assert.Contains("FSUSBLOG_CONFIRM_IDENTITY_RESET", exception.Message, StringComparison.Ordinal);
        Assert.Equal(1, await CountRowsAsync(connectionString, "sys_user"));
        Assert.Equal(1, await CountRowsAsync(connectionString, "sys_user_session"));
        Assert.Equal(1, await CountRowsAsync(connectionString, "passkey_credential"));
        Assert.Equal(1, await CountRowsAsync(connectionString, "account_recovery_key"));
        Assert.Equal(1, await CountRowsAsync(connectionString, "anonymous_credential"));
        Assert.Equal(1, await CountRowsAsync(connectionString, "anonymous_credential_issuance_audit"));
        Assert.Equal(1, await CountRowsAsync(connectionString, "comment_anonymous_nullifier"));
        Assert.Equal(2, await CountRowsAsync(connectionString, "comment"));
        Assert.Equal(1, await CountRowsAsync(connectionString, "comment_region_compliance"));
        Assert.Equal(1, await CountRowsAsync(connectionString, "comment_moderation_signal"));
        Assert.Equal(1, await CountRowsAsync(connectionString, "msg_participant_state"));
    }

    [Fact]
    public async Task RunAsync_DeletesLegacyIdentityCommentsAndUserBoundMessages_WhenConfirmationMatches()
    {
        string databaseName = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(databaseName);
        await SeedLegacyIdentityRowsAsync(connectionString);

        await using ServiceProvider provider = BuildProvider(connectionString);
        await using AsyncServiceScope scope = provider.CreateAsyncScope();
        var operation = scope.ServiceProvider.GetRequiredService<LegacyIdentityColdStartResetOperation>();

        LegacyIdentityColdStartResetResult result = await operation.RunAsync(
            LegacyIdentityColdStartResetOperation.RequiredConfirmation,
            CancellationToken.None);

        Assert.Equal(1, result.UsersDeleted);
        Assert.Equal(1, result.SessionsDeleted);
        Assert.Equal(1, result.PasskeyCredentialsDeleted);
        Assert.Equal(1, result.AccountRecoveryKeysDeleted);
        Assert.Equal(1, result.AnonymousCredentialsDeleted);
        Assert.Equal(1, result.AnonymousCredentialIssuanceAuditsDeleted);
        Assert.Equal(1, result.CommentAnonymousNullifiersDeleted);
        Assert.Equal(2, result.CommentsDeleted);
        Assert.Equal(1, result.CommentRegionComplianceDeleted);
        Assert.Equal(1, result.CommentModerationSignalsDeleted);
        Assert.Equal(1, result.MessageParticipantStatesDeleted);
        Assert.Equal(1, result.UserBoundMessagesDeleted);
        Assert.Equal(1, result.UserBoundConversationsDeleted);

        Assert.Equal(0, await CountRowsAsync(connectionString, "sys_user"));
        Assert.Equal(0, await CountRowsAsync(connectionString, "sys_user_session"));
        Assert.Equal(0, await CountRowsAsync(connectionString, "passkey_credential"));
        Assert.Equal(0, await CountRowsAsync(connectionString, "account_recovery_key"));
        Assert.Equal(0, await CountRowsAsync(connectionString, "anonymous_credential"));
        Assert.Equal(0, await CountRowsAsync(connectionString, "anonymous_credential_issuance_audit"));
        Assert.Equal(0, await CountRowsAsync(connectionString, "comment_anonymous_nullifier"));
        Assert.Equal(0, await CountRowsAsync(connectionString, "comment"));
        Assert.Equal(0, await CountRowsAsync(connectionString, "comment_region_compliance"));
        Assert.Equal(0, await CountRowsAsync(connectionString, "comment_moderation_signal"));
        Assert.Equal(0, await CountRowsAsync(connectionString, "msg_participant_state"));
        Assert.Equal(0, await CountRowsAsync(connectionString, "msg_message"));
        Assert.Equal(0, await CountRowsAsync(connectionString, "msg_conversation"));

        Assert.True(await fixture.TableExistsAsync(connectionString, "sys_user"));
        Assert.True(await fixture.TableExistsAsync(connectionString, "sys_user_session"));
        Assert.True(await fixture.TableExistsAsync(connectionString, "passkey_credential"));
        Assert.True(await fixture.TableExistsAsync(connectionString, "account_recovery_key"));
        Assert.True(await fixture.TableExistsAsync(connectionString, "anonymous_credential"));
        Assert.True(await fixture.TableExistsAsync(connectionString, "anonymous_credential_issuance_audit"));
        Assert.True(await fixture.TableExistsAsync(connectionString, "comment_anonymous_nullifier"));
        Assert.True(await fixture.TableExistsAsync(connectionString, "comment"));
        Assert.True(await fixture.TableExistsAsync(connectionString, "comment_region_compliance"));
        Assert.True(await fixture.TableExistsAsync(connectionString, "comment_moderation_signal"));
    }

    private async Task<int> CountRowsAsync(string connectionString, string tableName)
        => await fixture.QueryScalarAsync<int>(connectionString, $"SELECT COUNT(1) FROM {tableName};");

    private static async Task SeedLegacyIdentityRowsAsync(string connectionString)
    {
        await using ServiceProvider provider = BuildProvider(connectionString);
        await using AsyncServiceScope scope = provider.CreateAsyncScope();
        ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        db.DbMaintenance.CreateDatabase();
        db.CodeFirst.InitTables(
        [
            typeof(FsusBlog.Server.Entities.User),
            typeof(FsusBlog.Server.Entities.UserSession),
            typeof(FsusBlog.Server.Entities.PasskeyCredential),
            typeof(FsusBlog.Server.Entities.RecoveryKeyCredential),
            typeof(FsusBlog.Server.Entities.AnonymousCredential),
            typeof(FsusBlog.Server.Entities.AnonymousCredentialIssuanceAudit),
            typeof(FsusBlog.Server.Entities.CommentAnonymousNullifier),
            typeof(FsusBlog.Server.Entities.Comment),
            typeof(FsusBlog.Server.Entities.CommentRegionCompliance),
            typeof(FsusBlog.Server.Entities.CommentModerationSignal),
            typeof(FsusBlog.Server.Entities.MessageConversation),
            typeof(FsusBlog.Server.Entities.ConversationMessage),
            typeof(FsusBlog.Server.Entities.ConversationParticipantState)
        ]);

        int baseId = Random.Shared.Next(100_000, int.MaxValue - 10_000);
        int userId = baseId;
        int passkeyId = baseId + 1;
        int recoveryKeyId = baseId + 2;
        int credentialId = baseId + 3;
        int auditId = baseId + 4;
        int rootCommentId = baseId + 100;
        int replyCommentId = baseId + 101;
        int nullifierId = baseId + 200;
        int regionComplianceId = baseId + 300;
        int moderationSignalId = baseId + 400;
        int conversationId = baseId + 500;
        int messageId = baseId + 501;
        string suffix = Guid.NewGuid().ToString("N")[..12];
        string emptyMetadataJson = "{}";

        await db.Ado.ExecuteCommandAsync($"""
            INSERT INTO sys_user(
                id, public_handle, identity_kind, passkey_enabled, passkey_user_handle,
                recovery_enabled, privacy_initialized_at, anonymous_credential_level,
                anonymous_credential_status, status, createtime, mfaenabled, riskflags
            )
            VALUES (
                {userId}, 'cold-start-{suffix}', 'anonymous_account', true, 'cold-start-passkey-{suffix}',
                true, TIMESTAMP '2024-01-01 00:00:00', 'basic',
                'active', 0, TIMESTAMP '2024-01-01 00:00:00', true, 0
            );

            INSERT INTO sys_user_session(
                sessionid, userid, refreshtokenhash, devicefingerprint, lastip, useragent,
                createdat, idleexpiresat, absoluteexpiresat, mfaverified, rememberme
            )
            VALUES (
                'cold-start-session-{suffix}', {userId}, 'cold-start-refresh-{suffix}', 'cold-start-device-{suffix}',
                '127.0.0.1', 'cold-start-agent', TIMESTAMP '2024-01-01 00:00:00',
                TIMESTAMP '2024-01-08 00:00:00', TIMESTAMP '2024-02-01 00:00:00',
                true, true
            );

            INSERT INTO passkey_credential(
                id, account_id, credentialid, publickey, signcount, devicefriendlyname,
                aaguid, backupeligible, backupstate, createdat
            )
            VALUES (
                {passkeyId}, {userId}, 'cold-start-credential-{suffix}', 'cold-start-public-key-{suffix}', 5,
                'cold-start-device-{suffix}', '00000000-0000-0000-0000-000000000000',
                true, true, TIMESTAMP '2024-01-01 00:00:00'
            );

            INSERT INTO account_recovery_key(
                id, account_id, key_hash, key_version, created_at, used_at, revoked_at
            )
            VALUES (
                {recoveryKeyId}, {userId}, 'cold-start-recovery-key-hash-{suffix}', 1,
                TIMESTAMP '2024-01-01 00:00:00', NULL, NULL
            );

            INSERT INTO anonymous_credential(
                id, account_id, account_binding_hash, credential_type, credential_level,
                status, issued_at_utc, revoked_at_utc, metadata_json
            )
            VALUES (
                {credentialId}, {userId}, 'cold-start-account-binding-{suffix}', 'account_bound', 'basic',
                'active', TIMESTAMP '2024-01-01 00:00:00', NULL, '{emptyMetadataJson}'
            );

            INSERT INTO anonymous_credential_issuance_audit(
                id, subject_hash, epoch, status, created_at_utc, trace_id
            )
            VALUES (
                {auditId}, '1111111111111111111111111111111111111111111111111111111111111111',
                20260620, 'issued', TIMESTAMP '2024-01-01 00:00:00', 'cold-start-trace-{suffix}'
            );

            INSERT INTO comment(
                id, article_id, content, create_time, user_id, parent_id, root_id,
                reply_to_user_id, reply_to_comment_id, depth, is_deleted, moderation_status,
                author_mode, public_handle, anonymous_display_name, anonymous_display_language,
                moderation_subject_hash, credential_level, reputation_bucket, account_age_bucket
            )
            VALUES
                (
                    {rootCommentId}, 9, 'cold-start root', TIMESTAMP '2024-01-02 00:00:00', {userId}, NULL, NULL, NULL, NULL, 0, false, 1,
                    'public', 'cold-start-{suffix}', 'cold start admin', 'en', 'cold-start-subject-root-{suffix}', 'basic', 'cold-start', 'known'
                ),
                (
                    {replyCommentId}, 9, 'cold-start reply', TIMESTAMP '2024-01-02 00:01:00', {userId}, {rootCommentId}, {rootCommentId}, {userId}, {rootCommentId}, 1, false, 1,
                    'public', 'cold-start-{suffix}', 'cold start admin', 'en', 'cold-start-subject-reply-{suffix}', 'basic', 'cold-start', 'known'
                );

            INSERT INTO comment_anonymous_nullifier(
                id, nullifier_hash, scope, use_count, first_comment_id, last_comment_id,
                blocked, block_reason, created_at_utc, updated_at_utc
            )
            VALUES (
                {nullifierId}, 'cold-start-nullifier-{suffix}', 'article:9', 2, {rootCommentId}, {replyCommentId},
                false, NULL, TIMESTAMP '2024-01-02 00:00:00', TIMESTAMP '2024-01-02 00:01:00'
            );

            INSERT INTO comment_region_compliance(
                id, comment_id, submit_region, submit_region_confidence, region_provider,
                policy_version, can_publish, requires_manual_review, hide_until_reviewed,
                blocked_regions, risk_labels, created_at_utc, updated_at_utc
            )
            VALUES (
                {regionComplianceId}, {rootCommentId}, 'UNKNOWN', 0, 'fixture', 'cold-start', true, false, false,
                '', '', TIMESTAMP '2024-01-02 00:00:00', TIMESTAMP '2024-01-02 00:00:00'
            );

            INSERT INTO comment_moderation_signal(
                id, comment_id, provider, model, contract_version, label, severity,
                confidence, needs_second_round, latency_ms, status, created_at_utc
            )
            VALUES (
                {moderationSignalId}, {rootCommentId}, 'fixture', 'cold-start', 'v1', 'ok', 'low',
                0.1, false, 3, 'ok', TIMESTAMP '2024-01-02 00:00:00'
            );

            INSERT INTO msg_conversation(
                id, subject, initiatoraccountid, status, issystemsource, createdbytype,
                createdbyaccountid, createdat, updatedat, lastmessageat
            )
            VALUES (
                {conversationId}, 'cold-start conversation', {userId}, 0, false, 0, {userId},
                TIMESTAMP '2024-01-03 00:00:00',
                TIMESTAMP '2024-01-03 00:00:00',
                TIMESTAMP '2024-01-03 00:00:00'
            );

            INSERT INTO msg_message(
                id, conversationid, sendertype, senderaccountid, body, isinternalnote, createdat
            )
            VALUES (
                {messageId}, {conversationId}, 0, {userId}, 'cold-start message', false,
                TIMESTAMP '2024-01-03 00:01:00'
            );

            INSERT INTO msg_participant_state(
                conversationid, accountid, unreadcount, muted, updatedat
            )
            VALUES ({conversationId}, {userId}, 1, false, TIMESTAMP '2024-01-03 00:02:00');
            """);
    }

    private static ServiceProvider BuildProvider(string connectionString)
    {
        var services = new ServiceCollection();
        services.AddLogging(builder => builder.ClearProviders());
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder()
            .AddInMemoryCollection(
            [
                KeyValuePair.Create<string, string?>("ConnectionStrings:DefaultConnection", connectionString)
            ])
            .Build());
        services.AddSqlSugar();
        services.AddScoped<LegacyIdentityColdStartResetOperation>();

        return services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateOnBuild = true,
            ValidateScopes = true
        });
    }
}
