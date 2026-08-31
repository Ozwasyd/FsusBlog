using FsusBlog.Migration;

namespace FsusBlog.Migration.Definitions;

internal static class PasskeySignalMigrationDefinitions
{
    internal const string MigrationId = "20260720-pre-passkey-signal-version";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add the account-scoped revision used to reject stale WebAuthn Signal API snapshots.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_user", "passkey_signal_version", "bigint NOT NULL DEFAULT 0")
            ]);
}
