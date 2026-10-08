using System.Text.Json;
var fd = ulong.Parse(Environment.GetEnvironmentVariable("RESERVED_FD")!);
var inode = new FileInfo($"/proc/self/fd/{fd}").LinkTarget!;
var expected = Environment.GetEnvironmentVariable("RESERVED_INODE")!;
if (inode != expected) throw new InvalidOperationException("inherited descriptor identity mismatch");
Console.WriteLine(JsonSerializer.Serialize(new { @event = "prepared", inode, pid = Environment.ProcessId }));
if (Console.ReadLine() != "activate") throw new InvalidOperationException("activation denied");
if (Environment.GetEnvironmentVariable("FAIL_STAGE") == "before") throw new InvalidOperationException("injected before activation");
var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
FsusBlog.Server.Infrastructure.Bootstrap.FsusManagedTestListener.Configure(builder);
var app = builder.Build();
var canary = Environment.GetEnvironmentVariable("CANARY")!;
app.MapGet("/canary", () => Results.Text(canary));
await app.StartAsync();
if (new FileInfo($"/proc/self/fd/{fd}").LinkTarget != expected) throw new InvalidOperationException("descriptor identity drift");
Console.WriteLine(JsonSerializer.Serialize(new { @event = "listening", inode = expected, pid = Environment.ProcessId }));
if (Environment.GetEnvironmentVariable("FAIL_STAGE") == "after") { await app.StopAsync(); Environment.Exit(42); }
await app.WaitForShutdownAsync();
