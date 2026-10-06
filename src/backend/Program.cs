using System.Text.Json;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.RuntimeModes;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Fixtures;

if (CurrentSchemaOwnedTargetExportCommand.IsRequested(args))
{
    using var cancellation = new CancellationTokenSource();
    ConsoleCancelEventHandler cancel = (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        cancellation.Cancel();
    };
    Console.CancelKeyPress += cancel;
    try
    {
        Environment.ExitCode = await CurrentSchemaOwnedTargetExportCommand.RunAsync(args, cancellation.Token);
    }
    catch (OperationCanceledException)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { status = "cancelled", code = "current_schema_export_cancelled" }));
        Environment.ExitCode = 130;
    }
    catch (Exception exception)
    {
        string code = exception.Message.Split(':', 2, StringSplitOptions.TrimEntries)[0];
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            status = "failed",
            code = code.StartsWith("current_schema_", StringComparison.Ordinal) ? code : "current_schema_export_failed"
        }));
        Environment.ExitCode = 1;
    }
    finally
    {
        Console.CancelKeyPress -= cancel;
    }
    return;
}

if (CurrentSchemaTestMaterializationCandidateCommandLine.IsRequested(args))
{
    try
    {
        Environment.ExitCode = await CurrentSchemaTestMaterializationCandidateCommandHost.RunAsync(
            args,
            CancellationToken.None);
    }
    catch (Exception exception) when (exception is not OperationCanceledException)
    {
        string exceptionCode = exception.Message.Split(':', 2, StringSplitOptions.TrimEntries)[0];
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            status = "failed",
            code = exceptionCode.StartsWith("current_schema_", StringComparison.Ordinal)
                ? exceptionCode
                : "current_schema_candidate_verifier_failed"
        }));
        Environment.ExitCode = 1;
    }
    return;
}

if (CurrentSchemaTestMaterializationCommandLine.IsRequested(args))
{
    try
    {
        Environment.ExitCode = await CurrentSchemaTestMaterializationCommandHost.RunAsync(
            args,
            CancellationToken.None);
    }
    catch (Exception exception) when (exception is not OperationCanceledException)
    {
        string exceptionCode = exception.Message.Split(':', 2, StringSplitOptions.TrimEntries)[0];
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            status = "failed",
            code = exceptionCode.StartsWith("current_schema_", StringComparison.Ordinal)
                ? exceptionCode
                : "current_schema_materializer_failed"
        }));
        Environment.ExitCode = 1;
    }
    return;
}

ServerCommand command;
CurrentSchemaOwnedInputsArguments? ownedInputs = null;
try
{
    if (CurrentSchemaOwnedInputsCommand.IsRequested(args))
    {
        ownedInputs = CurrentSchemaOwnedInputsCommand.Parse(args);
    }
    command = ownedInputs?.Intent ?? ServerCommandLine.Parse(args);
}
catch (InvalidOperationException exception)
{
    WriteCommandError(exception.Message, "server_command_invalid");
    Environment.ExitCode = 2;
    return;
}

using CurrentSchemaOwnedInputsCancellation? ownedInputCancellation = ownedInputs is null
    ? null
    : new CurrentSchemaOwnedInputsCancellation();
bool ownedOutputStarted = false;
try
{
    OriginalCurrentSchemaReceipt? ownedReceipt = null;
    if (ownedInputs is not null)
    {
        CancellationToken inputCancellation = ownedInputCancellation!.Token;
        CurrentSchemaReceiptAdmission.ValidateCandidateSource(ownedInputs.Intent.SchemaCheck!.CandidateSourceRevision);
        ownedReceipt = OriginalCurrentSchemaReceipt.OpenFromInheritedDescriptor(
            ownedInputs.Intent.SchemaCheck.ReceiptPath, OriginalCurrentSchemaReceipt.InheritedDescriptor,
            ownedInputs.Intent.SchemaCheck.ArtifactSha256, ownedInputs.ReceiptObservationSha256, inputCancellation);
    }
    using var ownedReceiptLifetime = ownedReceipt;
    OriginalEnvironmentFile? ownedEnvironment = null;
    if (ownedInputs is not null)
    {
        ownedEnvironment = ServerCommandEnvironmentFile.OpenOriginalFromInheritedDescriptor(
            ownedInputs.Intent.EnvironmentFilePath!, CurrentSchemaOwnedInputsCommand.EnvironmentDescriptor,
            ownedInputs.EnvironmentArtifactSha256, ownedInputs.EnvironmentObservationSha256,
            ownedInputCancellation!.Token);
    }
    using var ownedEnvironmentLifetime = ownedEnvironment;
    ownedInputCancellation?.Token.ThrowIfCancellationRequested();
    var builder = WebApplication.CreateBuilder(command.HostArguments.ToArray());
    OriginalEnvironmentFile? environmentFile = null;
    try
    {
        if (command.EnvironmentFilePath is not null)
        {
            environmentFile = ownedInputs is null
                ? ServerCommandEnvironmentFile.OpenOriginal(command.EnvironmentFilePath)
                : ownedEnvironment ?? throw new InvalidOperationException("server_command_owned_current_schema_custody_required");
            builder.Configuration.AddInMemoryCollection(environmentFile.Values);
            environmentFile.ValidateUnchanged();
        }
    }
    catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidOperationException)
    {
        environmentFile?.Dispose();
        if (ownedInputs is not null)
        {
            ownedOutputStarted = true;
        }
        WriteCommandError(exception.Message, "server_env_file_invalid");
        Environment.ExitCode = 2;
        return;
    }
    catch when (ownedInputs is not null)
    {
        environmentFile?.Dispose();
        throw;
    }
    using var environmentFileLifetime = ownedInputs is null ? environmentFile : null;
    if (command.Kind != ServerCommandKind.Serve)
    {
        // Keep stdout as a single machine-JSON channel for rollout automation.
        builder.Configuration["Serilog:WriteTo:0:Args:standardErrorFromLevel"] = "Verbose";
    }

    builder.ConfigureFsusKestrelSingleProcessRuntime();
    TimeProvider? testBusinessTimeProvider = TestTemporalRuntimeContext.Configure(builder);
    builder.ConfigureFsusApplication(testBusinessTimeProvider);
    if (builder.Environment.IsDevelopment() &&
        builder.Configuration.GetValue<bool>(
            LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey))
    {
        builder.Services.AddScoped<IAuthFixtureSeeder, AuthFixtureSeeder>();
        builder.Services.AddScoped<IAuthFixtureLifecycleRepository,
            SqlSugarAuthFixtureLifecycleRepository>();
        builder.Services.AddScoped<IControlledWebAuthnAuthenticator, ControlledWebAuthnAuthenticator>();
        builder.Services.AddScoped<IUserSessionFixtureLoginWorkflow>(serviceProvider =>
            (IUserSessionFixtureLoginWorkflow)serviceProvider
                .GetRequiredService<IUserLoginWorkflowService>());
    }
    builder.Services.ApplyFsusRuntimeModeGates(builder.Configuration);
    builder.Services.AddScoped<ServerCommandHost>();
    builder.Services.AddScoped<CurrentSchemaReceiptCommandHost>();
    // Last registration wins: Server serve verifies the unique current schema
    // projection and never loads the migration catalog or executes descriptors.
    builder.Services.AddScoped<ISchemaMigrationRunner, CurrentSchemaStartupVerifier>();
    builder.Services.ValidateAndPublishFsusDependencyGraph();

    try
    {
        environmentFile?.ValidateUnchanged();
    }
    catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidOperationException)
    {
        if (ownedInputs is not null)
        {
            ownedOutputStarted = true;
        }
        WriteCommandError(exception.Message, "server_env_file_invalid");
        Environment.ExitCode = 2;
        return;
    }
    ownedInputCancellation?.Token.ThrowIfCancellationRequested();
    await using var app = builder.Build();

    if (command.Kind != ServerCommandKind.Serve)
    {
        await using AsyncServiceScope scope = app.Services.CreateAsyncScope();
        using var commandCancellation = ownedInputCancellation is null
            ? new CancellationTokenSource()
            : CancellationTokenSource.CreateLinkedTokenSource(ownedInputCancellation.Token);
        ConsoleCancelEventHandler cancelHandler = (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            commandCancellation.Cancel();
        };
        if (ownedInputCancellation is null)
        {
            Console.CancelKeyPress += cancelHandler;
        }
        try
        {
            try
            {
                environmentFile?.ValidateUnchanged(commandCancellation.Token);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                if (ownedInputs is not null)
                {
                    ownedOutputStarted = true;
                }
                WriteCommandError(exception.Message, "server_env_file_invalid");
                Environment.ExitCode = 2;
                return;
            }
            if (ownedInputs is not null)
            {
                if (ownedReceipt is null || environmentFile is null)
                {
                    throw new InvalidOperationException("server_command_owned_current_schema_custody_required");
                }
                CurrentSchemaOwnedInputsResult result = await CurrentSchemaOwnedInputsCommand.RunAsync(
                    ownedInputs, ownedReceipt, environmentFile, scope.ServiceProvider, commandCancellation.Token);
                if (result.ExitCode == 0)
                {
                    environmentFile.ValidateUnchanged(commandCancellation.Token);
                    ownedReceipt.ValidateUnchanged(commandCancellation.Token);
                }
                commandCancellation.Token.ThrowIfCancellationRequested();
                // Never attempt a second stdout JSON after a write or later owner cleanup fails.
                ownedOutputStarted = true;
                await Console.Out.WriteLineAsync(result.Json.AsMemory(), commandCancellation.Token);
                Environment.ExitCode = result.ExitCode;
            }
            else
            {
                Environment.ExitCode = command.Kind == ServerCommandKind.CurrentSchemaCheck
                    ? await scope.ServiceProvider.GetRequiredService<CurrentSchemaReceiptCommandHost>()
                        .RunAsync(command, commandCancellation.Token)
                    : await scope.ServiceProvider.GetRequiredService<ServerCommandHost>()
                        .RunAsync(command, commandCancellation.Token);
            }
        }
        catch (OperationCanceledException)
        {
            if (ownedInputs is null || !ownedOutputStarted)
            {
                if (ownedInputs is not null)
                {
                    ownedOutputStarted = true;
                }
                Console.WriteLine(JsonSerializer.Serialize(new
                {
                    status = "paused",
                    code = "server_command_cancelled"
                }));
            }
            else
            {
                Console.Error.WriteLine("server_command_cancelled");
            }
            Environment.ExitCode = 130;
        }
        finally
        {
            if (ownedInputCancellation is null)
            {
                Console.CancelKeyPress -= cancelHandler;
            }
        }
        return;
    }

    app.UseFsusApplicationPipeline();
    app.MapFsusApplicationRoutes();

    await app.RunAsync();
}
catch (OperationCanceledException) when (ownedInputs is not null)
{
    if (!ownedOutputStarted)
    {
        ownedOutputStarted = true;
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            status = "paused",
            code = "server_command_cancelled"
        }));
    }
    else
    {
        Console.Error.WriteLine("server_command_cancelled");
    }
    Environment.ExitCode = 130;
}
catch (Exception exception) when (ownedInputs is not null)
{
    if (!ownedOutputStarted)
    {
        ownedOutputStarted = true;
        WriteCommandError(exception.Message, "current_schema_check_failed");
    }
    else
    {
        Console.Error.WriteLine("current_schema_owned_command_cleanup_failed");
    }
    Environment.ExitCode = 1;
}

static void WriteCommandError(string message, string fallbackCode)
{
    string code = message.Split(':', 2, StringSplitOptions.TrimEntries)[0];
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        status = "failed",
        code = code.StartsWith("schema_", StringComparison.Ordinal)
            || code.StartsWith("server_command_", StringComparison.Ordinal)
            || code.StartsWith("server_env_file_", StringComparison.Ordinal)
            || code.StartsWith("passkey_projection_", StringComparison.Ordinal)
            || code.StartsWith("current_receipt_", StringComparison.Ordinal)
            || code.StartsWith("current_schema_", StringComparison.Ordinal)
            ? code
            : fallbackCode
    }));
}
