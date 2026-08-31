using System.Text.Json;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.RuntimeModes;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Fixtures;

OnlineSchemaMigrationCommand command;
try
{
    command = OnlineSchemaMigrationCommandLine.Parse(args);
}
catch (InvalidOperationException exception)
{
    WriteCommandError(exception.Message, "schema_command_invalid");
    Environment.ExitCode = 2;
    return;
}

var builder = WebApplication.CreateBuilder(command.HostArguments.ToArray());
try
{
    if (command.EnvironmentFilePath is not null)
    {
        builder.Configuration.AddInMemoryCollection(
            OnlineSchemaMigrationEnvironmentFile.Read(command.EnvironmentFilePath));
    }
}
catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidOperationException)
{
    WriteCommandError(exception.Message, "schema_env_file_invalid");
    Environment.ExitCode = 2;
    return;
}
if (command.ReleaseManifestPath is not null)
{
    builder.Configuration["FSUSBLOG_RELEASE_MANIFEST_PATH"] = command.ReleaseManifestPath;
}
if (command.Kind != OnlineSchemaMigrationCommandKind.Serve)
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
builder.Services.AddOnlineSchemaMigrationControlPlane(builder.Configuration);
// Last registration wins: Server serve verifies the unique current schema
// projection and never loads the migration catalog or executes descriptors.
builder.Services.AddScoped<ISchemaMigrationRunner, CurrentSchemaStartupVerifier>();
builder.Services.ValidateAndPublishFsusDependencyGraph();

await using var app = builder.Build();

if (command.Kind != OnlineSchemaMigrationCommandKind.Serve)
{
    await using AsyncServiceScope scope = app.Services.CreateAsyncScope();
    var commandHost = scope.ServiceProvider.GetRequiredService<OnlineSchemaMigrationCommandHost>();
    using var commandCancellation = new CancellationTokenSource();
    ConsoleCancelEventHandler cancelHandler = (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        commandCancellation.Cancel();
    };
    Console.CancelKeyPress += cancelHandler;
    try
    {
        Environment.ExitCode = await commandHost.RunAsync(command, commandCancellation.Token);
    }
    catch (OperationCanceledException)
    {
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            status = "paused",
            code = "schema_command_cancelled"
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
            || code.StartsWith("passkey_projection_", StringComparison.Ordinal)
            ? code
            : fallbackCode
    }));
}
