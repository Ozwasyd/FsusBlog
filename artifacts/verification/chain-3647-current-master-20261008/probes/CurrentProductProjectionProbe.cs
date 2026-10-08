using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.Server.Infrastructure.Security;

const string Subject = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static void Require(bool condition, string scenario) { if (!condition) throw new Exception(scenario); }
Require(Microsoft.Extensions.Hosting.Environments.Development == "Development" && Microsoft.Extensions.Hosting.Environments.Production == "Production", "framework environment literal equivalence");
var source = new MissingSource();
var projection = new BanStateProjection(source);
var lookup = projection.GetAsync(1, Subject).AsTask();
await source.Started.Task.WaitAsync(TimeSpan.FromSeconds(10));
Require(projection.Apply(new(Subject, BanStateProjectionStatus.Banned, "manual_ban", 7)) == BanStateProjectionApplyResult.Applied, "concurrent apply");
source.Complete.TrySetResult(null);
var result = await lookup.WaitAsync(TimeSpan.FromSeconds(10));
Require(result.Status == BanStateProjectionStatus.Banned && result.Generation == 7, "null authority result must preserve concurrent known local fact");
Require(projection.Apply(new(Subject, BanStateProjectionStatus.Normal, null, 7)) == BanStateProjectionApplyResult.FailedClosedConflict, "same generation conflict");
Require(projection.Read(Subject).Status == BanStateProjectionStatus.Unknown && projection.Read(Subject).Generation == 7, "unknown generation fence");
Require(projection.Apply(new(Subject, BanStateProjectionStatus.Normal, null, 6)) == BanStateProjectionApplyResult.RejectedStale, "stale negative control");
Require(projection.Apply(new(Subject, BanStateProjectionStatus.Normal, null, 8)) == BanStateProjectionApplyResult.Applied, "new generation recovery");
var canceledSource = new MissingSource();
var canceledProjection = new BanStateProjection(canceledSource);
using var cancel = new CancellationTokenSource();
var first = canceledProjection.GetAsync(1, Subject, cancel.Token).AsTask();
await canceledSource.Started.Task.WaitAsync(TimeSpan.FromSeconds(10));
var second = canceledProjection.GetAsync(1, Subject).AsTask();
cancel.Cancel();
bool canceled = false;
try { await first; } catch (OperationCanceledException) { canceled = true; }
Require(canceled, "waiter cancellation");
canceledSource.Complete.TrySetResult(null);
Require(!(await second).IsKnown && canceledSource.Calls == 1, "shared load survives waiter cancellation");
for (int i = 0; i < 2; i++) {
    await canceledProjection.GetAsync(1, Subject);
    Require(canceledSource.Calls == 2 + i, "completed singleflight entry cleanup/repeated loads");
}
var assembly = typeof(BanStateProjection).Assembly.Location;
Console.WriteLine(JsonSerializer.Serialize(new {
    scope = "supplementary direct product-assembly probe; fresh probe of the exact current product assembly; original test-project results are separately recorded",
    candidate = args[0],
    assembly, assemblySha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly))),
    frameworkEnvironmentValues = new { Development = Microsoft.Extensions.Hosting.Environments.Development, Production = Microsoft.Extensions.Hosting.Environments.Production },
    passed = new [] { "null authority + concurrent known update", "same generation conflict unknown fence", "stale rejection", "new generation recovery", "singleflight waiter cancellation", "shared load continuation", "completed load cleanup", "repeated missing loads" }
}, new JsonSerializerOptions { WriteIndented = true }));
sealed class MissingSource : IBanStateProjectionSource {
    public readonly TaskCompletionSource Started = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public readonly TaskCompletionSource<BanStateProjectionUpdate?> Complete = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public int Calls;
    public ValueTask<BanStateProjectionUpdate?> LoadAsync(int accountId, string accountSubjectHash, CancellationToken cancellationToken = default) {
        Interlocked.Increment(ref Calls);
        Started.TrySetResult();
        return new ValueTask<BanStateProjectionUpdate?>(Complete.Task);
    }
}
