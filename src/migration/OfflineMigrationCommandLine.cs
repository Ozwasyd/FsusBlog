namespace FsusBlog.Migration;

internal sealed record OfflineMigrationCommandOptions(
    OfflineMigrationPhase Phase,
    string? MigrationId,
    string? ReleaseManifestPath,
    string? EnvironmentFilePath,
    string? EvidencePath,
    bool ConfirmDestructive,
    bool DryRun);

internal static class OfflineMigrationCommandLine
{
    public static OfflineMigrationCommandOptions Parse(IReadOnlyList<string> args)
    {
        if (args.Count == 0
            || !string.Equals(args[0], "migrate", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                args.Count == 0
                    ? "schema_command_unknown"
                    : $"schema_command_unknown:{args[0]}");
        }

        string? phase = null;
        string? migrationId = null;
        string? releaseManifestPath = null;
        string? environmentFilePath = null;
        string? evidencePath = null;
        bool confirmDestructive = false;
        bool dryRun = false;
        for (int index = 1; index < args.Count; index++)
        {
            string argument = args[index];
            switch (argument)
            {
                case "--phase":
                    phase = ReadValue(args, ref index, argument);
                    break;
                case "--id":
                    migrationId = ReadValue(args, ref index, argument);
                    break;
                case "--release-manifest":
                    releaseManifestPath = ReadValue(args, ref index, argument);
                    break;
                case "--env-file":
                    environmentFilePath = ReadValue(args, ref index, argument);
                    break;
                case "--evidence":
                    evidencePath = ReadValue(args, ref index, argument);
                    break;
                case "--confirm-destructive":
                    confirmDestructive = true;
                    break;
                case "--dry-run":
                    dryRun = true;
                    break;
                default:
                    throw new InvalidOperationException($"schema_command_argument_unknown:{argument}");
            }
        }

        OfflineMigrationPhase parsedPhase = phase?.ToLowerInvariant() switch
        {
            "expand" => OfflineMigrationPhase.Expand,
            "backfill" or "backfill-resume" => OfflineMigrationPhase.Backfill,
            "contract" => OfflineMigrationPhase.Contract,
            _ => throw new InvalidOperationException("schema_migrate_phase_required")
        };
        if (parsedPhase == OfflineMigrationPhase.Backfill && string.IsNullOrWhiteSpace(migrationId))
        {
            throw new InvalidOperationException("schema_backfill_id_required");
        }

        if (parsedPhase != OfflineMigrationPhase.Backfill && migrationId is not null)
        {
            throw new InvalidOperationException("schema_migrate_id_only_for_backfill");
        }

        if (parsedPhase == OfflineMigrationPhase.Contract
            && (string.IsNullOrWhiteSpace(evidencePath) || (!dryRun && !confirmDestructive)))
        {
            throw new InvalidOperationException("schema_contract_evidence_and_confirmation_required");
        }

        return new OfflineMigrationCommandOptions(
            parsedPhase,
            migrationId,
            releaseManifestPath,
            environmentFilePath,
            evidencePath,
            confirmDestructive,
            dryRun);
    }

    private static string ReadValue(IReadOnlyList<string> args, ref int index, string argument)
    {
        if (++index >= args.Count || args[index].StartsWith("--", StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"schema_command_value_missing:{argument}");
        }

        return args[index].Trim();
    }
}
