using System.Text.Json;
var allocatorMode = Environment.GetEnvironmentVariable("FSUSBLOG_ADAPTER_ALLOCATOR_MODE") == "1";
var fd = ulong.Parse(Environment.GetEnvironmentVariable(allocatorMode ? "FSUSBLOG_RUNTIME_LISTEN_FD" : "RESERVED_FD")!);
var inode = new FileInfo($"/proc/self/fd/{fd}").LinkTarget!;
var expected = Environment.GetEnvironmentVariable(allocatorMode ? "FSUSBLOG_RUNTIME_LISTEN_SOCKET" : "RESERVED_INODE")!;
if (inode != expected) throw new InvalidOperationException("inherited descriptor identity mismatch");
Console.WriteLine(JsonSerializer.Serialize(new { @event = "prepared", inode, pid = Environment.ProcessId }));
if (Environment.GetEnvironmentVariable("FSUSBLOG_ADAPTER_ALLOCATOR_MODE") != "1" && Console.ReadLine() != "activate") throw new InvalidOperationException("activation denied");
if (Environment.GetEnvironmentVariable("FAIL_STAGE") == "before") throw new InvalidOperationException("injected before activation");
var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
FsusBlog.Server.Infrastructure.Bootstrap.FsusManagedTestListener.Configure(builder);
var app = builder.Build();
var canary = Environment.GetEnvironmentVariable("CANARY")!;
app.MapGet("/canary", () => Results.Text(canary));
await app.StartAsync();
if (new FileInfo($"/proc/self/fd/{fd}").LinkTarget != expected) throw new InvalidOperationException("descriptor identity drift");
Console.WriteLine(JsonSerializer.Serialize(new { @event = "listening", inode = expected, pid = Environment.ProcessId,
    binding = new { runId = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_RUN_ID"), @namespace = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_NAMESPACE"),
        leaseId = Environment.GetEnvironmentVariable("FSUSBLOG_RUNTIME_PORT_LEASE_ID"), attemptId = Environment.GetEnvironmentVariable("FSUSBLOG_RUNTIME_LISTEN_ATTEMPT_ID") } }));
if (Environment.GetEnvironmentVariable("FAIL_STAGE") == "after") { await app.StopAsync(); Environment.Exit(42); }
await app.WaitForShutdownAsync();
