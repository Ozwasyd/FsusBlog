using FsusBlog.Migration;

namespace FsusBlog.Migration.Definitions;

internal static class BanStateProjectionMigrationDefinitions
{
    internal const string MigrationId = "20260913-pre-ban-state-generation";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add the monotonic account revision used by the bounded ban-state projection.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_user", "ban_state_generation", "bigint NOT NULL DEFAULT 1"),
                new RawSqlStep(
                    """
                    UPDATE sys_user
                    SET ban_state_generation = 1
                    WHERE ban_state_generation IS NULL OR ban_state_generation < 1;
                    """)
            ]);
}
