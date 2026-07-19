using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class PasskeySignalMigrationDefinitions
{
    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            "20260720-pre-passkey-signal-version",
            "Add the account-scoped revision used to reject stale WebAuthn Signal API snapshots.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_user", "passkey_signal_version", "bigint NOT NULL DEFAULT 0")
            ]);
}
