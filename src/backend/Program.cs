using System.Text.Json;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.SchemaMigration;

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
builder.ConfigureFsusApplication();
builder.Services.AddOnlineSchemaMigrationControlPlane(builder.Configuration);
if (command.Kind == OnlineSchemaMigrationCommandKind.Serve && builder.Environment.IsProduction())
{
    // Last registration wins for LifecycleHostedBootstrapService: production
    // serve performs a read-only N/N-1 compatibility check, never migration.
    builder.Services.AddScoped<ISchemaMigrationRunner, ServeSchemaCompatibilityRunner>();
}
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
        code = code.StartsWith("schema_", StringComparison.Ordinal) ? code : fallbackCode
    }));
}
