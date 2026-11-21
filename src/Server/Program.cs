using FsusBlog.V2.Server;

if (args is ["legacy-media", ..])
{
    Console.Error.WriteLine("V1 media migration commands have been removed.");
    Environment.ExitCode = 1;
    return;
}

var builder = WebApplication.CreateBuilder(args);
using var bootstrap = await ServerServices.ConfigureAsync(builder);
await using var app = builder.Build();
ServerPipeline.UseRuntimeEvidence(app);
using var stopLease = await ServerServices.InitializeRuntimeAsync(app, bootstrap);
ServerPipeline.UseRequestPipeline(app, bootstrap);
await ServerEndpoints.MapAsync(app, bootstrap);
await app.RunAsync();
