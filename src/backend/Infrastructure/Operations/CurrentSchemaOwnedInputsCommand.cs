using System.Text.Json;

using SqlSugar;

using FsusBlog.Contracts.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Infrastructure.Operations;

/// <summary>Explicit inherited-file IO selection; parsed comparison data is never a parent execution grant.</summary>
internal sealed record CurrentSchemaOwnedInputsArguments(
    ServerCommand Intent,
    string EnvironmentArtifactSha256,
    string EnvironmentObservationSha256,
    string ReceiptObservationSha256);

/// <summary>Machine output data awaiting the sole Program channel; no execution or qualification authority.</summary>
internal sealed record CurrentSchemaOwnedInputsResult(int ExitCode, string Json);

/// <summary>Consumes only fixed original env FD4 and receipt FD5, retaining the ordinary Server configuration owner.</summary>
internal static class CurrentSchemaOwnedInputsCommand
{
    internal const int EnvironmentDescriptor = 4;
    internal const string Name = "current-schema-check-owned-inputs";

    internal static bool IsRequested(IReadOnlyList<string> args)
        => args.Count > 0 && args[0] == Name;

    internal static CurrentSchemaOwnedInputsArguments Parse(IReadOnlyList<string> args)
    {
        if (!IsRequested(args))
        {
            throw new InvalidOperationException("server_command_owned_current_schema_intent_invalid");
        }
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int index = 1; index < args.Count; index++)
        {
            string argument = args[index];
            if (argument is not ("--receipt" or "--receipt-sha256" or "--candidate-source-revision" or "--env-file"
                or "--env-sha256" or "--env-epoch-sha256" or "--receipt-epoch-sha256"))
            {
                throw new InvalidOperationException("server_command_owned_current_schema_argument_unknown");
            }
            if (++index >= args.Count || args[index].StartsWith("--", StringComparison.Ordinal))
            {
                throw new InvalidOperationException("server_command_owned_current_schema_value_missing");
            }
            string value = args[index];
            if (string.IsNullOrWhiteSpace(value) || value != value.Trim() || value.Any(char.IsControl)
                || !values.TryAdd(argument, value))
            {
                throw new InvalidOperationException("server_command_owned_current_schema_argument_invalid");
            }
        }
        if (values.Count != 7)
        {
            throw new InvalidOperationException("server_command_owned_current_schema_inputs_required");
        }
        ServerCommand intent = ServerCommandLine.Parse([
            "current-schema-check",
            "--receipt", values["--receipt"],
            "--receipt-sha256", values["--receipt-sha256"],
            "--candidate-source-revision", values["--candidate-source-revision"],
            "--env-file", values["--env-file"]
        ]);
        CurrentSchemaReceiptCodec.RequireDigest(values["--env-sha256"]);
        CurrentSchemaReceiptCodec.RequireDigest(values["--env-epoch-sha256"]);
        CurrentSchemaReceiptCodec.RequireDigest(values["--receipt-epoch-sha256"]);
        return new CurrentSchemaOwnedInputsArguments(intent, values["--env-sha256"],
            values["--env-epoch-sha256"], values["--receipt-epoch-sha256"]);
    }

    internal static async Task<CurrentSchemaOwnedInputsResult> RunAsync(
        CurrentSchemaOwnedInputsArguments inputs,
        OriginalCurrentSchemaReceipt original,
        OriginalEnvironmentFile environment,
        IServiceProvider scopedServices,
        CancellationToken cancellationToken)
    {
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            ServerCommand intent = inputs.Intent;
            if (intent.Kind != ServerCommandKind.CurrentSchemaCheck || intent.SchemaCheck is not { } schema
                || intent.ConfirmRepair || intent.HostArguments.Count != 0
                || original.CanonicalPath != schema.ReceiptPath || original.ArtifactSha256 != schema.ArtifactSha256
                || original.ObservationSha256 != inputs.ReceiptObservationSha256
                || environment.CanonicalPath != intent.EnvironmentFilePath
                || environment.ArtifactSha256 != inputs.EnvironmentArtifactSha256
                || environment.ObservationSha256 != inputs.EnvironmentObservationSha256)
            {
                throw new InvalidOperationException("server_command_owned_current_schema_custody_mismatch");
            }
            environment.ValidateUnchanged(cancellationToken);
            original.ValidateUnchanged(cancellationToken);
            CurrentSchemaAdmissionResult result = await CurrentSchemaReceiptAdmission.VerifyOriginalHeldReceiptAsync(
                original, schema.CandidateSourceRevision,
                scopedServices.GetRequiredService<ISqlSugarClient>(),
                scopedServices.GetRequiredService<ISchemaModelInspector>(), cancellationToken).ConfigureAwait(false);
            // A changed environment across the real DB await must fail before success publication.
            environment.ValidateUnchanged(cancellationToken);
            original.ValidateUnchanged(cancellationToken);
            using JsonDocument receipt = JsonDocument.Parse(CurrentSchemaReceiptCodec.Serialize(result.Receipt));
            string json = JsonSerializer.Serialize(new
            {
                status = receipt.RootElement.GetProperty("status").GetString(),
                candidateSourceRevision = result.CandidateSourceRevision,
                artifactSha256 = result.ArtifactSha256,
                target = receipt.RootElement.GetProperty("target"),
                database = receipt.RootElement.GetProperty("database"),
                actualSchemaDigest = receipt.RootElement.GetProperty("actualSchemaDigest").GetString(),
                inputMode = "original-inherited-files",
                inputObservations = new
                {
                    environmentArtifactSha256 = environment.ArtifactSha256,
                    environmentObservationSha256 = environment.ObservationSha256,
                    receiptObservationSha256 = original.ObservationSha256
                }
            });
            environment.ValidateUnchanged(cancellationToken);
            original.ValidateUnchanged(cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            return new CurrentSchemaOwnedInputsResult(0, json);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            string code = exception.Message.Split(':', 2, StringSplitOptions.TrimEntries)[0];
            string json = JsonSerializer.Serialize(new
            {
                status = "failed",
                code = code.StartsWith("current_receipt_", StringComparison.Ordinal)
                    || code.StartsWith("current_schema_", StringComparison.Ordinal)
                    || code.StartsWith("server_command_", StringComparison.Ordinal)
                    || code.StartsWith("server_env_file_", StringComparison.Ordinal)
                    ? code
                    : "current_schema_check_failed"
            });
            return new CurrentSchemaOwnedInputsResult(1, json);
        }
    }
}

/// <summary>Owns cancellation from the first inherited-file read through the final readonly command.</summary>
internal sealed class CurrentSchemaOwnedInputsCancellation : IDisposable
{
    private readonly CancellationTokenSource _source = new();
    private readonly ConsoleCancelEventHandler _handler;

    internal CancellationToken Token => _source.Token;

    internal CurrentSchemaOwnedInputsCancellation()
    {
        _handler = (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            _source.Cancel();
        };
        Console.CancelKeyPress += _handler;
    }

    public void Dispose()
    {
        Console.CancelKeyPress -= _handler;
        _source.Dispose();
    }
}
