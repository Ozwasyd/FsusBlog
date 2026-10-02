using System.Globalization;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

internal sealed record OfflineMigrationCommandOptions(
    OfflineMigrationPhase Phase,
    string? MigrationId,
    string? ReleaseManifestPath,
    string? EnvironmentFilePath,
    string? EvidencePath,
    bool ConfirmDestructive,
    bool DryRun);

internal sealed record OfflineMigrationPlanCommandOptions(
    CurrentSchemaDatabaseIdentity ExpectedDatabase,
    string EnvironmentFilePath,
    string BackupPackagePath,
    string BackupManifestPath,
    string RestoreDrillPath,
    string RestoreEnvironmentFilePath,
    string PlanOutputPath);

internal sealed record OfflineMigrationSourceCommandOptions(
    CurrentSchemaProviderKind Provider,
    string EnvironmentFilePath,
    bool CaptureSession,
    string? DumpOutputPath,
    int TimeoutSeconds);

internal static class OfflineMigrationCommandLine
{
    internal static OfflineMigrationSourceCommandOptions ParseSourceObservation(IReadOnlyList<string> args)
    {
        if (args.Count == 0 || args[0] != "observe-source")
        {
            throw new InvalidOperationException("schema_source_observation_command_required");
        }

        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        bool captureSession = false;
        for (int index = 1; index < args.Count; index++)
        {
            string argument = args[index];
            if (argument == "--capture-session")
            {
                if (captureSession)
                {
                    throw new InvalidOperationException("schema_source_capture_duplicate");
                }

                captureSession = true;
                continue;
            }

            if (argument is not ("--provider" or "--env-file" or "--dump-output" or "--timeout-seconds"))
            {
                throw new InvalidOperationException($"schema_source_observation_argument_unknown:{argument}");
            }

            string value = ReadValue(args, ref index, argument);
            if (argument == "--timeout-seconds" && value != args[index])
            {
                throw new InvalidOperationException("schema_source_observation_timeout_invalid");
            }

            if (string.IsNullOrWhiteSpace(value) || value.Any(char.IsControl) || !values.TryAdd(argument, value))
            {
                throw new InvalidOperationException($"schema_source_observation_argument_invalid_or_duplicate:{argument}");
            }
        }

        if (!values.TryGetValue("--provider", out string? providerValue)
            || !values.TryGetValue("--env-file", out string? environmentFile))
        {
            throw new InvalidOperationException("schema_source_observation_provider_and_environment_required");
        }

        if (!values.TryGetValue("--timeout-seconds", out string? timeoutValue))
        {
            throw new InvalidOperationException("schema_source_observation_timeout_required");
        }

        // This is the Int32 millisecond timer representation, not a migration budget default
        // or a new universal test ceiling. The original invocation owns the finite budget.
        if (timeoutValue.Length is 0 or > 7 || timeoutValue[0] == '0'
            || timeoutValue.Any(character => character is < '0' or > '9')
            || !int.TryParse(timeoutValue, NumberStyles.None, CultureInfo.InvariantCulture, out int timeoutSeconds)
            || timeoutSeconds > int.MaxValue / 1000)
        {
            throw new InvalidOperationException("schema_source_observation_timeout_invalid");
        }

        CurrentSchemaProviderKind provider = providerValue switch
        {
            "postgresql" => CurrentSchemaProviderKind.PostgreSql,
            "mysql" => CurrentSchemaProviderKind.MySql,
            "sqlite" => CurrentSchemaProviderKind.Sqlite,
            _ => throw new InvalidOperationException("schema_source_observation_provider_unknown")
        };
        values.TryGetValue("--dump-output", out string? dumpOutput);
        if (captureSession && (provider != CurrentSchemaProviderKind.PostgreSql
            || dumpOutput is null || !Path.IsPathFullyQualified(dumpOutput)))
        {
            throw new InvalidOperationException("schema_source_capture_provider_or_dump_path_invalid");
        }

        if (!captureSession && dumpOutput is not null)
        {
            throw new InvalidOperationException("schema_source_dump_path_only_for_capture");
        }

        return new(provider, environmentFile, captureSession, dumpOutput, timeoutSeconds);
    }

    internal static OfflineMigrationPlanCommandOptions ParsePlan(IReadOnlyList<string> args)
    {
        if (args.Count == 0 || args[0] != "plan")
        {
            throw new InvalidOperationException("schema_plan_command_required");
        }

        string[] allowed = ["--provider", "--instance-id", "--database-id", "--env-file", "--backup-package",
            "--backup-manifest", "--restore-drill", "--restore-env-file", "--output"];
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int index = 1; index < args.Count; index++)
        {
            string argument = args[index];
            if (!allowed.Contains(argument, StringComparer.Ordinal))
            {
                throw new InvalidOperationException($"schema_plan_argument_unknown:{argument}");
            }

            string value = ReadValue(args, ref index, argument);
            if (string.IsNullOrWhiteSpace(value) || value.Any(char.IsControl) || !values.TryAdd(argument, value))
            {
                throw new InvalidOperationException($"schema_plan_argument_invalid_or_duplicate:{argument}");
            }
        }

        foreach (string argument in allowed)
        {
            if (!values.ContainsKey(argument))
            {
                throw new InvalidOperationException($"schema_plan_argument_required:{argument}");
            }
        }

        CurrentSchemaProviderKind provider = values["--provider"] switch
        {
            "postgresql" => CurrentSchemaProviderKind.PostgreSql,
            "mysql" => CurrentSchemaProviderKind.MySql,
            "sqlite" => CurrentSchemaProviderKind.Sqlite,
            _ => throw new InvalidOperationException("schema_plan_provider_unknown")
        };
        return new(new(provider, values["--instance-id"], values["--database-id"]), values["--env-file"],
            values["--backup-package"], values["--backup-manifest"], values["--restore-drill"],
            values["--restore-env-file"], values["--output"]);
    }

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
