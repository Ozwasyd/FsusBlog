using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

var builder = WebApplication.CreateBuilder(args);
builder.ConfigureFsusApplication();

var app = builder.Build();

app.UseFsusPublicHotReadFastPath();
app.UseFsusApplicationPipeline();
app.MapFsusApplicationRoutes();

app.Run();
