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

        await db.Ado.ExecuteCommandAsync("""
            INSERT INTO sys_user(
                id, username, password, role, status, createtime, mfaenabled,
                mfasecretencrypted, mfapendingsecretencrypted, mfarecoverycodeshash
            )
            VALUES (
                42, 'legacy-admin', 'legacy-password-hash', 'admin', 0,
                TIMESTAMP '2024-01-01 00:00:00', true,
                'legacy-secret', 'legacy-pending-secret', 'legacy-recovery-hash'
            );

            INSERT INTO sys_user_session(
                sessionid, userid, refreshtokenhash, devicefingerprint, lastip, useragent,
                createdat, idleexpiresat, absoluteexpiresat, mfaverified, rememberme
            )
            VALUES (
                'legacy-session', 42, 'legacy-refresh-hash', 'legacy-device',
                '127.0.0.1', 'legacy-agent', TIMESTAMP '2024-01-01 00:00:00',
                TIMESTAMP '2024-01-08 00:00:00', TIMESTAMP '2024-02-01 00:00:00',
                true, true
            );

            INSERT INTO passkey_credential(
                id, userid, credentialid, publickey, signcount, devicefriendlyname,
                aaguid, backupeligible, backupstate, createdat
            )
            VALUES (
                7, 42, 'legacy-credential', 'legacy-public-key', 5,
                'legacy-device', '00000000-0000-0000-0000-000000000000',
                true, true, TIMESTAMP '2024-01-01 00:00:00'
            );

            INSERT INTO account_recovery_key(
                id, user_id, key_hash, key_version, created_at, used_at, revoked_at
            )
            VALUES (
                11, 42, 'legacy-recovery-key-hash', 1,
                TIMESTAMP '2024-01-01 00:00:00', NULL, NULL
            );

            INSERT INTO anonymous_credential(
                id, user_id, commitment_hash, credential_type, credential_level,
                status, issued_at_utc, revoked_at_utc, metadata_json
            )
            VALUES (
                12, 42, 'legacy-credential-commitment', 'account_bound', 'basic',
                'active', TIMESTAMP '2024-01-01 00:00:00', NULL, '{}'
            );

            INSERT INTO anonymous_credential_issuance_audit(
                id, subject_hash, epoch, status, created_at_utc, trace_id
            )
            VALUES (
                13, '1111111111111111111111111111111111111111111111111111111111111111',
                20260620, 'issued', TIMESTAMP '2024-01-01 00:00:00', 'legacy-trace'
            );

            INSERT INTO comment(
                id, article_id, content, create_time, user_id, parent_id, root_id,
                reply_to_user_id, reply_to_comment_id, depth, is_deleted, moderation_status,
                author_mode, public_handle, anonymous_display_name, anonymous_display_language,
                moderation_subject_hash, credential_level, reputation_bucket, account_age_bucket
            )
            VALUES
                (
                    1001, 9, 'legacy root', TIMESTAMP '2024-01-02 00:00:00', 42, NULL, NULL, NULL, NULL, 0, false, 1,
                    'public', 'legacy-admin', 'legacy admin', 'en', 'legacy-subject-root', 'basic', 'legacy', 'known'
                ),
                (
                    1002, 9, 'legacy reply', TIMESTAMP '2024-01-02 00:01:00', 42, 1001, 1001, 42, 1001, 1, false, 1,
                    'public', 'legacy-admin', 'legacy admin', 'en', 'legacy-subject-reply', 'basic', 'legacy', 'known'
                );

            INSERT INTO comment_anonymous_nullifier(
                id, nullifier_hash, scope, use_count, first_comment_id, last_comment_id,
                blocked, block_reason, created_at_utc, updated_at_utc
            )
            VALUES (
                14, 'legacy-nullifier', 'article:9', 2, 1001, 1002,
                false, NULL, TIMESTAMP '2024-01-02 00:00:00', TIMESTAMP '2024-01-02 00:01:00'
            );

            INSERT INTO comment_region_compliance(
                id, comment_id, submit_region, submit_region_confidence, region_provider,
                policy_version, can_publish, requires_manual_review, hide_until_reviewed,
                blocked_regions, risk_labels, created_at_utc, updated_at_utc
            )
            VALUES (
                2001, 1001, 'UNKNOWN', 0, 'fixture', 'legacy', true, false, false,
                '', '', TIMESTAMP '2024-01-02 00:00:00', TIMESTAMP '2024-01-02 00:00:00'
            );

            INSERT INTO comment_moderation_signal(
                id, comment_id, provider, model, contract_version, label, severity,
                confidence, needs_second_round, latency_ms, status, created_at_utc
            )
            VALUES (
                3001, 1001, 'fixture', 'legacy', 'v1', 'ok', 'low',
                0.1, false, 3, 'ok', TIMESTAMP '2024-01-02 00:00:00'
            );

            INSERT INTO msg_conversation(
                id, subject, initiatoraccountid, status, issystemsource, createdbytype,
                createdbyaccountid, createdat, updatedat, lastmessageat
            )
            VALUES (
                4001, 'legacy conversation', 42, 0, false, 0, 42,
                TIMESTAMP '2024-01-03 00:00:00',
                TIMESTAMP '2024-01-03 00:00:00',
                TIMESTAMP '2024-01-03 00:00:00'
            );

            INSERT INTO msg_message(
                id, conversationid, sendertype, senderaccountid, body, isinternalnote, createdat
            )
            VALUES (
                4002, 4001, 0, 42, 'legacy message', false,
                TIMESTAMP '2024-01-03 00:01:00'
            );

            INSERT INTO msg_participant_state(
                conversationid, accountid, unreadcount, muted, updatedat
            )
            VALUES (4001, 42, 1, false, TIMESTAMP '2024-01-03 00:02:00');
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
