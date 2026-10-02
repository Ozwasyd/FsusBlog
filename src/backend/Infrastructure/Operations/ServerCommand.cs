using System.Text.Json;

using FsusBlog.Contracts.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Services.Security;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Operations;

/// <summary>Closed Server entry points; schema mutation belongs to the offline migration executable.</summary>
public enum ServerCommandKind
{
    Serve = 0,
    PasskeyProjectionCheck = 1,
    PasskeyProjectionRepair = 2,
    CurrentSchemaCheck = 3
}

/// <summary>Explicit read-only current receipt inputs; this command intent is not a receipt or migration plan.</summary>
public sealed record CurrentSchemaCheckArguments(
    string ReceiptPath,
    string ArtifactSha256,
    string CandidateSourceRevision);

/// <summary>Parsed Server intent, with maintenance inputs separate from ordinary host configuration.</summary>
public sealed record ServerCommand(
    ServerCommandKind Kind,
    string? EnvironmentFilePath,
    bool ConfirmRepair,
    IReadOnlyList<string> HostArguments,
    CurrentSchemaCheckArguments? SchemaCheck = null);

/// <summary>Rejects migration commands before Server construction while preserving ordinary host arguments.</summary>
public static class ServerCommandLine
{
    private static readonly HashSet<string> s_migrationArguments = new(StringComparer.OrdinalIgnoreCase)
    {
        "--phase", "--id", "--release", "--release-manifest", "--evidence",
        "--confirm-destructive", "--dry-run", "--check"
    };

    /// <summary>Parses serve or passkey maintenance; unknown commands and migration options fail closed.</summary>
    public static ServerCommand Parse(IReadOnlyList<string> args)
    {
        if (args.Count == 0 || args[0].StartsWith("--", StringComparison.Ordinal))
        {
            return Serve(args);
        }

        if (string.Equals(args[0], "serve", StringComparison.OrdinalIgnoreCase))
        {
            return Serve(args.Skip(1).ToArray());
        }

        if (string.Equals(args[0], "passkey-projection", StringComparison.OrdinalIgnoreCase))
        {
            return ParsePasskeyProjection(args);
        }

        if (string.Equals(args[0], "current-schema-check", StringComparison.OrdinalIgnoreCase))
        {
            return ParseCurrentSchemaCheck(args);
        }

        throw new InvalidOperationException("server_command_unknown");
    }

    private static ServerCommand Serve(IReadOnlyList<string> hostArguments)
    {
        if (hostArguments.Any(argument => s_migrationArguments.Contains(argument.Split('=', 2)[0])))
        {
            throw new InvalidOperationException("server_migration_arguments_not_supported");
        }

        return new ServerCommand(ServerCommandKind.Serve, null, false, hostArguments);
    }

    private static ServerCommand ParsePasskeyProjection(IReadOnlyList<string> args)
    {
        bool check = false;
        bool repair = false;
        bool confirmRepair = false;
        string? environmentFilePath = null;
        for (int index = 1; index < args.Count; index++)
        {
            string argument = args[index];
            switch (argument)
            {
                case "--check":
                    check = true;
                    break;
                case "--repair":
                    repair = true;
                    break;
                case "--confirm-repair":
                    confirmRepair = true;
                    break;
                case "--env-file":
                    environmentFilePath = ReadValue(args, ref index, argument);
                    break;
                default:
                    throw new InvalidOperationException($"passkey_projection_argument_unknown:{argument}");
            }
        }

        if (check == repair)
        {
            throw new InvalidOperationException("passkey_projection_mode_required");
        }

        if (check && confirmRepair)
        {
            throw new InvalidOperationException("passkey_projection_check_confirmation_conflict");
        }

        if (repair && !confirmRepair)
        {
            throw new InvalidOperationException("passkey_projection_repair_confirmation_required");
        }

        return new ServerCommand(
            repair ? ServerCommandKind.PasskeyProjectionRepair : ServerCommandKind.PasskeyProjectionCheck,
            environmentFilePath,
            confirmRepair,
            []);
    }

    private static ServerCommand ParseCurrentSchemaCheck(IReadOnlyList<string> args)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int index = 1; index < args.Count; index++)
        {
            string argument = args[index];
            if (argument is not ("--receipt" or "--receipt-sha256" or "--candidate-source-revision" or "--env-file"))
            {
                throw new InvalidOperationException("server_command_current_schema_argument_unknown");
            }
            if (++index >= args.Count || args[index].StartsWith("--", StringComparison.Ordinal))
            {
                throw new InvalidOperationException("server_command_current_schema_value_missing");
            }
            string value = args[index];
            if (string.IsNullOrWhiteSpace(value) || value != value.Trim() || value.Any(char.IsControl)
                || !values.TryAdd(argument, value))
            {
                throw new InvalidOperationException("server_command_current_schema_argument_invalid");
            }
        }
        if (values.Count != 4)
        {
            throw new InvalidOperationException("server_command_current_schema_inputs_required");
        }
        if (!Path.IsPathFullyQualified(values["--receipt"]) || !Path.IsPathFullyQualified(values["--env-file"]))
        {
            throw new InvalidOperationException("server_command_current_schema_absolute_path_required");
        }
        CurrentSchemaReceiptCodec.RequireDigest(values["--receipt-sha256"]);
        string source = values["--candidate-source-revision"];
        if (source.Length != 40 || source == new string('0', 40)
            || source.Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
        {
            throw new InvalidOperationException("server_command_current_schema_source_invalid");
        }
        return new ServerCommand(
            ServerCommandKind.CurrentSchemaCheck,
            values["--env-file"],
            false,
            [],
            new CurrentSchemaCheckArguments(values["--receipt"], values["--receipt-sha256"], source));
    }

    private static string ReadValue(IReadOnlyList<string> args, ref int index, string argument)
    {
        if (++index >= args.Count || args[index].StartsWith("--", StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"server_command_value_missing:{argument}");
        }

        return args[index].Trim();
    }
}

/// <summary>Executes only explicit passkey maintenance; it has no schema migration dependency.</summary>
public sealed class ServerCommandHost(
    IPasskeyProjectionConsistencyService passkeyProjection,
    ILogger<ServerCommandHost> logger)
{
    private static readonly JsonSerializerOptions s_machineJsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>Returns zero only for a consistent projection and never executes an unconfirmed repair.</summary>
    public async Task<int> RunAsync(ServerCommand command, CancellationToken cancellationToken)
    {
        try
        {
            if (command.Kind is not (ServerCommandKind.PasskeyProjectionCheck or ServerCommandKind.PasskeyProjectionRepair))
            {
                throw new InvalidOperationException("server_command_not_executable");
            }

            bool repair = command.Kind == ServerCommandKind.PasskeyProjectionRepair;
            if (repair && !command.ConfirmRepair)
            {
                throw new InvalidOperationException("passkey_projection_repair_confirmation_required");
            }

            PasskeyProjectionConsistencyReport projection = repair
                ? await passkeyProjection.RepairAsync(cancellationToken).ConfigureAwait(false)
                : await passkeyProjection.CheckAsync(cancellationToken).ConfigureAwait(false);
            logger.LogInformation(
                "Passkey projection {Mode} completed. DriftedAccountCount={DriftedAccountCount} RepairedAccountCount={RepairedAccountCount} RemainingDriftedAccountCount={RemainingDriftedAccountCount}",
                repair ? "repair" : "check",
                projection.DriftedAccounts,
                projection.RepairedAccounts,
                projection.RemainingDriftedAccounts);
            await WriteJsonAsync(new
            {
                status = projection.IsConsistent ? "ok" : "drift",
                mode = repair ? "repair" : "check",
                driftedAccounts = projection.DriftedAccounts,
                repairedAccounts = projection.RepairedAccounts,
                remainingDriftedAccounts = projection.RemainingDriftedAccounts
            }, cancellationToken).ConfigureAwait(false);
            return projection.IsConsistent ? 0 : 1;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogError(exception, "Maintenance command failed closed.");
            string code = exception.Message.Split(':', 2, StringSplitOptions.TrimEntries)[0];
            await WriteJsonAsync(new
            {
                status = "failed",
                code = code.StartsWith("passkey_projection_", StringComparison.Ordinal)
                    || code.StartsWith("server_command_", StringComparison.Ordinal)
                    ? code
                    : "server_command_failed"
            }, cancellationToken).ConfigureAwait(false);
            return 1;
        }
    }

    private static async Task WriteJsonAsync<T>(T value, CancellationToken cancellationToken)
    {
        string json = JsonSerializer.Serialize(value, s_machineJsonOptions);
        await Console.Out.WriteLineAsync(json.AsMemory(), cancellationToken).ConfigureAwait(false);
    }
}

/// <summary>Invokes the sole fresh current-schema observer without issuing migration writes or publishing readiness.</summary>
public sealed class CurrentSchemaReceiptCommandHost(
    ISqlSugarClient db,
    ISchemaModelInspector inspector,
    ILogger<CurrentSchemaReceiptCommandHost> logger)
{
    private static readonly JsonSerializerOptions s_machineJsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>Returns zero only after explicit artifact, actual candidate assembly and fresh database observation agree.</summary>
    public async Task<int> RunAsync(ServerCommand command, CancellationToken cancellationToken)
    {
        try
        {
            if (command.Kind != ServerCommandKind.CurrentSchemaCheck || command.SchemaCheck is not { } inputs
                || command.ConfirmRepair || command.HostArguments.Count != 0
                || command.EnvironmentFilePath is null || !Path.IsPathFullyQualified(command.EnvironmentFilePath))
            {
                throw new InvalidOperationException("server_command_current_schema_intent_invalid");
            }
            CurrentSchemaAdmissionResult result = await CurrentSchemaReceiptAdmission.VerifyAsync(
                inputs.ReceiptPath, inputs.ArtifactSha256, inputs.CandidateSourceRevision,
                db, inspector, cancellationToken).ConfigureAwait(false);
            using JsonDocument receipt = JsonDocument.Parse(CurrentSchemaReceiptCodec.Serialize(result.Receipt));
            await WriteJsonAsync(new
            {
                status = receipt.RootElement.GetProperty("status").GetString(),
                candidateSourceRevision = result.CandidateSourceRevision,
                artifactSha256 = result.ArtifactSha256,
                target = receipt.RootElement.GetProperty("target"),
                database = receipt.RootElement.GetProperty("database"),
                actualSchemaDigest = receipt.RootElement.GetProperty("actualSchemaDigest").GetString()
            }, cancellationToken).ConfigureAwait(false);
            return 0;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogError(exception, "Read-only current-schema admission failed closed.");
            string code = exception.Message.Split(':', 2, StringSplitOptions.TrimEntries)[0];
            await WriteJsonAsync(new
            {
                status = "failed",
                code = code.StartsWith("current_receipt_", StringComparison.Ordinal)
                    || code.StartsWith("current_schema_", StringComparison.Ordinal)
                    || code.StartsWith("server_command_", StringComparison.Ordinal)
                    ? code
                    : "current_schema_check_failed"
            }, cancellationToken).ConfigureAwait(false);
            return 1;
        }
    }

    private static async Task WriteJsonAsync<T>(T value, CancellationToken cancellationToken)
    {
        string json = JsonSerializer.Serialize(value, s_machineJsonOptions);
        await Console.Out.WriteLineAsync(json.AsMemory(), cancellationToken).ConfigureAwait(false);
    }
}

/// <summary>Reads configuration literals without executing or interpolating environment-file contents.</summary>
public static class ServerCommandEnvironmentFile
{
    /// <summary>Maps double underscores to configuration separators and rejects malformed or duplicate keys.</summary>
    public static IReadOnlyDictionary<string, string?> Read(string path)
    {
        var values = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (string rawLine in File.ReadLines(path))
        {
            string line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith('#'))
            {
                continue;
            }

            if (line.StartsWith("export ", StringComparison.Ordinal))
            {
                line = line[7..].TrimStart();
            }

            int separator = line.IndexOf('=');
            if (separator <= 0)
            {
                throw new InvalidOperationException("server_env_file_line_invalid");
            }

            string key = line[..separator].Trim();
            if (key.Length == 0
                || !key.All(static character => char.IsAsciiLetterOrDigit(character)
                    || character is '_' or ':' or '-'))
            {
                throw new InvalidOperationException("server_env_file_key_invalid");
            }

            string value = line[(separator + 1)..].Trim();
            if (value.Length >= 2
                && ((value[0] == '"' && value[^1] == '"')
                    || (value[0] == '\'' && value[^1] == '\'')))
            {
                value = value[1..^1];
            }

            string configurationKey = key.Replace("__", ":", StringComparison.Ordinal);
            if (!values.TryAdd(configurationKey, value))
            {
                throw new InvalidOperationException("server_env_file_key_duplicate");
            }
        }

        return values;
    }
}
