using FsusBlog.Server.Infrastructure.Bootstrap;

var builder = WebApplication.CreateBuilder(args);
builder.ConfigureFsusKestrelSingleProcessRuntime();
builder.ConfigureFsusApplication();

var app = builder.Build();

app.UseFsusApplicationPipeline();
app.MapFsusApplicationRoutes();

app.Run();
