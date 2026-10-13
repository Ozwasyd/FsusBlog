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
try
{
    command = ServerCommandLine.Parse(args);
}
catch (InvalidOperationException exception)
{
    WriteCommandError(exception.Message, "server_command_invalid");
    Environment.ExitCode = 2;
    return;
}

var builder = WebApplication.CreateBuilder(command.HostArguments.ToArray());
try
{
    if (command.EnvironmentFilePath is not null)
    {
        builder.Configuration.AddInMemoryCollection(
            ServerCommandEnvironmentFile.Read(command.EnvironmentFilePath));
    }
}
catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidOperationException)
{
    WriteCommandError(exception.Message, "server_env_file_invalid");
    Environment.ExitCode = 2;
    return;
}
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

await using var app = builder.Build();

if (command.Kind != ServerCommandKind.Serve)
{
    await using AsyncServiceScope scope = app.Services.CreateAsyncScope();
    using var commandCancellation = new CancellationTokenSource();
    ConsoleCancelEventHandler cancelHandler = (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        commandCancellation.Cancel();
    };
    Console.CancelKeyPress += cancelHandler;
    try
    {
        Environment.ExitCode = command.Kind == ServerCommandKind.CurrentSchemaCheck
            ? await scope.ServiceProvider.GetRequiredService<CurrentSchemaReceiptCommandHost>()
                .RunAsync(command, commandCancellation.Token)
            : await scope.ServiceProvider.GetRequiredService<ServerCommandHost>()
                .RunAsync(command, commandCancellation.Token);
    }
    catch (OperationCanceledException)
    {
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            status = "paused",
            code = "server_command_cancelled"
        }));
        Environment.ExitCode = 130;
    }
    finally
    {
        Console.CancelKeyPress -= cancelHandler;
    }
    return;
}

app.UseFsusApplicationPipeline();
app.MapFsusApplicationRoutes();

await app.RunAsync();

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
