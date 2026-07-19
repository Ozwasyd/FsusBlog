namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class UserSessionMultiDeviceMigrationDefinitions
{
    internal const string MigrationId = "20260719-post-user-session-multi-device";

    internal static ISchemaMigrationDescriptor BuildUserSessionMultiDeviceMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Allow bounded multi-device account sessions and index active-session admission order.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new DropIndexStep("ux_user_session_one_active_per_user"),
                new CreateIndexStep(
                    "idx_user_session_active_recency",
                    "CREATE INDEX IF NOT EXISTS idx_user_session_active_recency ON sys_user_session(userid, lastseenat DESC NULLS LAST, createdat DESC, sessionid DESC) WHERE revokedat IS NULL;")
            ]);
}
