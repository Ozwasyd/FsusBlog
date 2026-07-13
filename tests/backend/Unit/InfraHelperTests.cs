using System.Buffers.Binary;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Services.VisitLog;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using NSubstitute;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

// ──────────────────────────────────────────────────────────────────────────────
// CacheTagExtensions
// ──────────────────────────────────────────────────────────────────────────────

public class CacheTagExtensionsTests
{
    [Theory]
    [InlineData(CacheTag.ArticleList, "ArticleList")]
    [InlineData(CacheTag.HotArticles, "HotArticles")]
    [InlineData(CacheTag.Category, "Category")]
    [InlineData(CacheTag.Tag, "Tag")]
    [InlineData(CacheTag.SystemPage, "SystemPage")]
    [InlineData(CacheTag.Seo, "Seo")]
    [InlineData(CacheTag.Stats, "Stats")]
    [InlineData(CacheTag.Aot, "Aot")]
    [InlineData(CacheTag.Comment, "Comment")]
    [InlineData(CacheTag.None, "None")]
    public void ToOutputCacheTag_ReturnsExpected(CacheTag tag, string expected)
    {
        Assert.Equal(expected, tag.ToOutputCacheTag());
    }

    [Fact]
    public void ToOutputCacheTag_UnknownValue_ReturnsNone()
    {
        var unknown = (CacheTag)999;
        Assert.Equal("None", unknown.ToOutputCacheTag());
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// AedsBinaryWriter
// ──────────────────────────────────────────────────────────────────────────────

public class AedsBinaryWriterTests
{
    [Fact]
    public void WriteFrame_ToBufferWriter_ProducesValidAedsFrame()
    {
        var encoder = Substitute.For<IAedsEncoder>();
        // Use real encoder for actual output
        var realEncoder = new AedsEncoder();
        byte[] payload = new byte[] { 0x01, 0x02 };
        using var writer = new PooledByteBufferWriter(AedsFrameHeader.Size + payload.Length);
        AedsBinaryWriter.WriteFrame(realEncoder, AedsFrameType.ArticleList, payload, writer);

        Assert.True(writer.WrittenCount >= AedsFrameHeader.Size + payload.Length);
    }

    [Fact]
    public void WriteFrame_EmptyPayload_StillWritesHeader()
    {
        var encoder = new AedsEncoder();
        using var writer = new PooledByteBufferWriter(AedsFrameHeader.Size);
        AedsBinaryWriter.WriteFrame(encoder, AedsFrameType.ArticleDetail, [], writer);
        Assert.True(writer.WrittenCount >= AedsFrameHeader.Size);
    }

    [Fact]
    public void WriteFrame_ToBufferWriter_WritesBytes()
    {
        // Use real encoder (not mock) since span can't be used with NSubstitute
        var encoder = new AedsEncoder();
        var writer = new PooledByteBufferWriter(128);
        AedsBinaryWriter.WriteFrame(encoder, AedsFrameType.ArticleList, new byte[] { 1, 2 }, writer);
        Assert.True(writer.WrittenCount >= AedsFrameHeader.Size);
    }
}

public class BinaryResultsTests
{
    [Fact]
    public async Task FromError_WritesBinaryFrameAndMappedStatusCode()
    {
        var context = new DefaultHttpContext();
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var result = BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Forbidden, "权限不足"), new AedsEncoder());
        await result.ExecuteAsync(context);

        Assert.Equal(StatusCodes.Status403Forbidden, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);
        Assert.True(body.Length > AedsFrameHeader.Size);
    }
}

public class BinaryRequestBinderTests
{
    [Fact]
    public async Task ReadFrameAsync_ValidFrame_ReturnsPayloadSlice()
    {
        var encoder = new AedsEncoder();
        byte[] payload = [0x10, 0x20, 0x30, 0x40];
        using var writer = new PooledByteBufferWriter(AedsFrameHeader.Size + payload.Length);
        encoder.WriteFrame(AedsFrameType.MutationId, payload, writer);

        var context = new DefaultHttpContext();
        context.Request.ContentType = "application/octet-stream";
        context.Request.ContentLength = writer.WrittenCount;
        context.Request.Body = new MemoryStream(writer.WrittenMemory.ToArray());
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var binder = new BinaryRequestBinder();
        BinaryRequestPayload result = await binder.ReadFrameAsync(
            context,
            encoder,
            AedsFrameType.MutationId,
            CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.Equal(payload, result.Payload.ToArray());
    }

    [Fact]
    public async Task ReadFrameAsync_DeclaredOversizedPayloadRejectsBeforePayloadRead()
    {
        byte[] frameHeader = new byte[AedsFrameHeader.Size];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(frameHeader.AsSpan(0, 4), AedsEncoder.Magic);
        frameHeader[4] = AedsFrameHeader.CurrentVersion;
        frameHeader[5] = AedsFrameHeader.Size;
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(frameHeader.AsSpan(8, 2), (ushort)AedsFrameType.MutationId);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(frameHeader.AsSpan(10, 4), 8 * 1024 * 1024);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(frameHeader.AsSpan(14, 2), AedsCrc16.Compute(ReadOnlySpan<byte>.Empty));

        var context = new DefaultHttpContext();
        context.Request.ContentType = "application/octet-stream";
        context.Request.ContentLength = frameHeader.Length;
        context.Request.Body = new MemoryStream(frameHeader);
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var binder = new BinaryRequestBinder();
        BinaryRequestPayload result = await binder.ReadFrameAsync(
            context,
            new AedsEncoder(),
            AedsFrameType.MutationId,
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Contains("8 MiB", result.Error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadFrameAsync_NonZeroRequestFlagsAreRejected()
    {
        byte[] frame = new AedsEncoder().Encode(AedsFrameType.MutationId, [0x01, 0x02]);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(6, 2), 1);

        var context = new DefaultHttpContext();
        context.Request.ContentType = "application/octet-stream";
        context.Request.ContentLength = frame.Length;
        context.Request.Body = new MemoryStream(frame);
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var binder = new BinaryRequestBinder();
        BinaryRequestPayload result = await binder.ReadFrameAsync(
            context,
            new AedsEncoder(),
            AedsFrameType.MutationId,
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Contains("flags", result.Error.Message, StringComparison.OrdinalIgnoreCase);
    }
}

public class BackgroundWorkflowSourceTests
{
    [Fact]
    public void ContentFilterReload_SourceUsesSerializedQueueInsteadOfWatcherTaskRun()
    {
        FieldInfo reloadQueue = Assert.IsAssignableFrom<FieldInfo>(typeof(ContentFilterService).GetField(
            "_reloadQueue",
            BindingFlags.Instance | BindingFlags.NonPublic));
        Assert.Equal(typeof(Channel<string>), reloadQueue.FieldType);
        string enqueue = RuntimeMetadataInspection.DescribeMethods(typeof(ContentFilterService), "OnFileChanged");
        string worker = RuntimeMetadataInspection.DescribeMethods(typeof(ContentFilterService), "ProcessReloadQueueAsync");
        string read = RuntimeMetadataInspection.DescribeMethods(typeof(ContentFilterService), "ReadAllLinesCoreAsync");

        Assert.Contains("ChannelWriter", enqueue, StringComparison.Ordinal);
        Assert.Contains("TryWrite", enqueue, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.Run", enqueue, StringComparison.Ordinal);
        Assert.Contains("WaitToReadAsync", worker, StringComparison.Ordinal);
        Assert.Contains("TryRead", worker, StringComparison.Ordinal);
        Assert.Contains("ReloadFromWatcherAsync", worker, StringComparison.Ordinal);
        Assert.Contains("ReadLineAsync", read, StringComparison.Ordinal);
    }

    [Fact]
    public void NotificationStreamPublish_SourceQueuesLocalFanoutAndBatchesMultiRouteBacklog()
    {
        string publisher = RuntimeMetadataInspection.DescribeType(typeof(RedisNotificationStreamPublisher));
        string backlog = RuntimeMetadataInspection.DescribeType(typeof(NotificationStreamBacklogStore));

        Assert.Contains("NotificationStreamLocalFanoutQueue", publisher, StringComparison.Ordinal);
        Assert.Contains("TryEnqueue", publisher, StringComparison.Ordinal);
        Assert.Contains("IDatabase.CreateBatch", backlog, StringComparison.Ordinal);
        Assert.Contains("Task.WhenAll", backlog, StringComparison.Ordinal);
    }

    [Fact]
    public void UploadSessionCleanup_SourceRunsInBackgroundWorker()
    {
        string fileService = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(FileService),
            "RequestUploadSessionCleanup");
        string worker = RuntimeMetadataInspection.DescribeType(typeof(UploadSessionCleanupWorker));

        Assert.DoesNotContain("CleanupExpiredSessionsAsync", fileService, StringComparison.Ordinal);
        Assert.Contains("RequestUploadSessionCleanup", fileService, StringComparison.Ordinal);
        Assert.Contains("UploadSessionCleanupWorker", worker, StringComparison.Ordinal);
        Assert.Contains("RunCleanupOnceAsync", worker, StringComparison.Ordinal);
    }

    [Fact]
    public void VisitProjectionAndPublicHot_SourceCoalesceBackgroundWork()
    {
        string projection = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleViewProjectionService),
            nameof(ArticleViewProjectionService.ApplyAsync));
        string repair = RuntimeMetadataInspection.DescribeType(typeof(ArticleViewProjectionRepairWorker));
        FieldInfo refreshInterval = Assert.IsAssignableFrom<FieldInfo>(typeof(PublicHotArtifactUpdateWorker).GetField(
            "ViewProjectionRefreshInterval",
            BindingFlags.Static | BindingFlags.NonPublic));

        Assert.Contains("IncreaseViewCountsAsync", projection, StringComparison.Ordinal);
        Assert.Equal(128, ArticleViewProjectionService.MaxPerBatchViewInvalidations);
        Assert.Contains("article-view-projection-batch", projection, StringComparison.Ordinal);
        Assert.Contains("ArticleViewProjectionRepairWorker", repair, StringComparison.Ordinal);
        Assert.Equal(TimeSpan.FromSeconds(30), refreshInterval.GetValue(null));
    }

    [Fact]
    public void ArticleViewProjectionRepairWorker_SourceUsesIncrementalWatermarkBeforeFullReconcile()
    {
        string repair = RuntimeMetadataInspection.DescribeType(typeof(ArticleViewProjectionRepairWorker));
        string reconcile = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(ArticleViewProjectionRepairWorker),
            "WHERE id > @LastVisitLogId",
            "MAX(id)");

        Assert.Contains("article_view_projection_watermark", repair, StringComparison.Ordinal);
        Assert.Contains("WHERE id > @LastVisitLogId", reconcile, StringComparison.Ordinal);
        Assert.Contains("MAX(id)", reconcile, StringComparison.Ordinal);
        Assert.Contains("COALESCE(MAX(id), 0)", repair, StringComparison.Ordinal);
        Assert.Contains("RunFullReconcileAsync", repair, StringComparison.Ordinal);
        Assert.DoesNotContain("GROUP BY article_id", reconcile, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicHotUpdateQueue_ReturnsRejectedResultWhenCapacityIsFull()
    {
        var queue = new PublicHotArtifactUpdateQueue(Options.Create(new PublicHotReadOptions
        {
            UpdateQueueCapacity = 1
        }));

        PublicHotArtifactEnqueueResult first = queue.Enqueue(1, "article-updated");
        PublicHotArtifactEnqueueResult second = queue.Enqueue(2, "article-updated");

        Assert.True(first.Accepted);
        Assert.Equal("accepted", first.Status);
        Assert.False(second.Accepted);
        Assert.Equal("queue-full-or-closed", second.Status);
        Assert.False(queue.TryEnqueue(3, "article-updated"));
    }

    [Fact]
    public async Task DataScaleScripts_EmitIsolatedArtifactRebuildEvidence()
    {
        using var fixture = DataScaleToolFixture.Create();

        ProcessResult seed = await fixture.RunAsync("seed.sh", "scale-xs");
        Assert.Equal(0, seed.ExitCode);
        using (JsonDocument seedSummary = JsonDocument.Parse(
            await File.ReadAllTextAsync(Path.Combine(fixture.OutputDirectory, "seed.json"))))
        {
            Assert.Equal("ok", seedSummary.RootElement.GetProperty("status").GetString());
        }

        string evidencePath = Path.Combine(fixture.OutputDirectory, "artifact-rebuild.json");
        using (JsonDocument seedEvidence = JsonDocument.Parse(await File.ReadAllTextAsync(evidencePath)))
        {
            Assert.Equal("probe-required", seedEvidence.RootElement.GetProperty("status").GetString());
            Assert.Equal(DataScaleToolFixture.Namespace, seedEvidence.RootElement.GetProperty("sourceFixtureNamespace").GetString());
            Assert.Equal("tools/data-scale/probe.sh scale-xs", seedEvidence.RootElement.GetProperty("rebuildCommand").GetString());
        }

        ProcessResult probe = await fixture.RunAsync("probe.sh", "scale-xs");
        Assert.Equal(0, probe.ExitCode);
        Assert.Contains("summary.json", probe.StandardOutput, StringComparison.Ordinal);
        string capturedEvidencePath = (await File.ReadAllTextAsync(fixture.ArtifactEnvironmentCapture)).Trim();
        Assert.Equal("artifact-rebuild.json", Path.GetFileName(capturedEvidencePath));
        Assert.True(File.Exists(capturedEvidencePath));
        Assert.Equal(
            await File.ReadAllTextAsync(evidencePath),
            await File.ReadAllTextAsync(capturedEvidencePath));
        Assert.Contains(
            "runtime-evidence-probe.mjs data-scale scale-xs",
            await File.ReadAllTextAsync(fixture.NodeInvocationCapture),
            StringComparison.Ordinal);
        using (JsonDocument probeEvidence = JsonDocument.Parse(await File.ReadAllTextAsync(evidencePath)))
        {
            Assert.Equal("ok", probeEvidence.RootElement.GetProperty("status").GetString());
            Assert.Equal(DataScaleToolFixture.Namespace, probeEvidence.RootElement.GetProperty("sourceFixtureNamespace").GetString());
        }

        ProcessResult empty = await fixture.RunAsync("seed.sh", "scale-xs", outputDirectory: string.Empty);
        Assert.NotEqual(0, empty.ExitCode);
        Assert.Contains("must not be empty", empty.StandardError, StringComparison.Ordinal);
        ProcessResult traversal = await fixture.RunAsync("probe.sh", "scale-xs", outputDirectory: "../escape");
        Assert.NotEqual(0, traversal.ExitCode);
        Assert.Contains("must be an absolute path", traversal.StandardError, StringComparison.Ordinal);
        ProcessResult systemPath = await fixture.RunAsync(
            "seed.sh",
            "scale-xs",
            outputDirectory: "/etc/fsusblog-data-scale-source-lock");
        Assert.NotEqual(0, systemPath.ExitCode);
        Assert.Contains("must stay under", systemPath.StandardError, StringComparison.Ordinal);

        string symlink = Path.Combine(fixture.Root, "escape-link");
        Directory.CreateSymbolicLink(symlink, "/etc");
        ProcessResult symlinkEscape = await fixture.RunAsync(
            "probe.sh",
            "scale-xs",
            outputDirectory: Path.Combine(symlink, "fsusblog-data-scale-source-lock"));
        Assert.NotEqual(0, symlinkEscape.ExitCode);
        Assert.Contains("must stay under", symlinkEscape.StandardError, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DataScaleSeed_GeneratedSqlOmitsRetiredIdentityColumns()
    {
        using var fixture = DataScaleToolFixture.Create();
        ProcessResult seed = await fixture.RunAsync("seed.sh", "scale-xs");
        Assert.Equal(0, seed.ExitCode);
        string generatedSql = await File.ReadAllTextAsync(fixture.SqlCapture);
        string[] insertBlocks = generatedSql
            .Split("INSERT INTO comment(", StringSplitOptions.RemoveEmptyEntries)
            .Skip(1)
            .Select(block => block[..block.IndexOf(')')])
            .ToArray();

        Assert.Equal(2, insertBlocks.Length);
        foreach (string columnList in insertBlocks)
        {
            Assert.DoesNotContain("user_id", columnList, StringComparison.Ordinal);
            Assert.DoesNotContain("reply_to_user_id", columnList, StringComparison.Ordinal);
            Assert.DoesNotContain("moderated_by_admin_principal_id", columnList, StringComparison.Ordinal);
            Assert.Contains("author_mode", columnList, StringComparison.Ordinal);
            Assert.Contains("reply_to_comment_id", columnList, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task RuntimeEvidenceTools_EmitAndValidateRequiredCountersAndObservability()
    {
        string tempRoot = Directory.CreateTempSubdirectory("fsus-runtime-evidence-").FullName;
        try
        {
            string bin = Path.Combine(tempRoot, "bin");
            Directory.CreateDirectory(bin);
            string docker = Path.Combine(bin, "docker");
            await File.WriteAllTextAsync(docker, RuntimeEvidenceFakeDocker);
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(docker, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }
            await File.WriteAllTextAsync(Path.Combine(tempRoot, "postgres-counter"), "100\n");
            await File.WriteAllTextAsync(Path.Combine(tempRoot, "redis-counter"), "200\n");

            using var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            int port = ((IPEndPoint)listener.LocalEndpoint).Port;
            Task server = ServeAedsProbeResponseAsync(listener, frameType: 9);
            string evidenceFile = Path.Combine(tempRoot, "backend-qps.json");
            ProcessResult collector = await RunProcessAsync(
                "node",
                [
                    BackendTestPaths.FromRoot("tools", "test", "lanes", "runtime-evidence-probe.mjs"),
                    "backend-qps",
                    "hotread",
                    evidenceFile
                ],
                new Dictionary<string, string?>
                {
                    ["PATH"] = $"{bin}:/usr/bin:/bin",
                    ["FSUSBLOG_BASE_URL"] = $"http://127.0.0.1:{port}",
                    ["FSUSBLOG_TEST_NAMESPACE"] = "source-lock-runtime-evidence",
                    ["FSUSBLOG_BACKEND_QPS_REQUESTS"] = "1",
                    ["FSUSBLOG_BACKEND_QPS_CONCURRENCY"] = "1",
                    ["FSUSBLOG_POSTGRES_CONTAINER_NAME"] = "fake-postgres",
                    ["FSUSBLOG_REDIS_CONTAINER_NAME"] = "fake-redis",
                    ["FSUSBLOG_FAKE_COUNTER_ROOT"] = tempRoot,
                    ["DOTNET_ReadyToRun"] = "0",
                    ["DOTNET_TieredPGO"] = "1"
                });
            Assert.Equal(0, collector.ExitCode);
            await server.WaitAsync(TimeSpan.FromSeconds(5));

            using JsonDocument evidence = JsonDocument.Parse(await File.ReadAllTextAsync(evidenceFile));
            JsonElement root = evidence.RootElement;
            Assert.Equal("ok", root.GetProperty("status").GetString());
            Assert.Equal("hotread", root.GetProperty("scenario").GetString());
            JsonElement counterPolicy = root.GetProperty("runtimeMeasurement").GetProperty("counterPolicy");
            Assert.Equal("ok", counterPolicy.GetProperty("status").GetString());
            Assert.True(counterPolicy.GetProperty("required").GetBoolean());
            JsonElement counters = root.GetProperty("runtimeMeasurement").GetProperty("measuredCounters");
            foreach (string counter in new[] { "dbCommands", "redisCommands", "cacheEvents", "dbGatePressure" })
            {
                Assert.Equal("ok", counters.GetProperty(counter).GetProperty("status").GetString());
            }

            JsonElement runtime = root.GetProperty("runtimeMeasurement").GetProperty("runtime");
            Assert.Equal("extended-runtime-evidence", runtime.GetProperty("observabilityLevel").GetString());
            JsonElement extended = runtime.GetProperty("extendedObservability");
            Assert.Equal("complete", extended.GetProperty("status").GetString());
            string[] requiredCategories = extended.GetProperty("requiredCategories")
                .EnumerateArray()
                .Select(static category => category.GetString()!)
                .ToArray();
            Assert.Equal(new[] { "managedRuntime", "threadOrConnection", "storageOrCacheLatency" }, requiredCategories);
            foreach (string category in requiredCategories)
            {
                Assert.Equal("ok", extended.GetProperty("categories").GetProperty(category).GetProperty("status").GetString());
            }

            string runtimeFile = Path.Combine(tempRoot, "runtime.json");
            await File.WriteAllTextAsync(runtimeFile, runtime.GetRawText());
            ProcessResult accepted = await RunProcessAsync(
                "node",
                [
                    BackendTestPaths.FromRoot("tools", "operations", "check-evidence-metrics.mjs"),
                    "--validate-runtime-probe",
                    runtimeFile
                ]);
            Assert.Equal(0, accepted.ExitCode);
            using JsonDocument validation = JsonDocument.Parse(accepted.StandardOutput);
            Assert.Equal("fsusblog.runtime-probe-validation.v1", validation.RootElement.GetProperty("schema").GetString());
            Assert.Equal("ok", validation.RootElement.GetProperty("status").GetString());

            JsonObject tampered = JsonNode.Parse(runtime.GetRawText())!.AsObject();
            tampered["extendedObservability"]!["categories"]!.AsObject().Remove("storageOrCacheLatency");
            string tamperedFile = Path.Combine(tempRoot, "runtime-tampered.json");
            await File.WriteAllTextAsync(tamperedFile, tampered.ToJsonString());
            ProcessResult rejected = await RunProcessAsync(
                "node",
                [
                    BackendTestPaths.FromRoot("tools", "operations", "check-evidence-metrics.mjs"),
                    "--validate-runtime-probe",
                    tamperedFile
                ]);
            Assert.NotEqual(0, rejected.ExitCode);
            Assert.Contains("storageOrCacheLatency", rejected.StandardError, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempRoot, recursive: true);
        }
    }

    private static async Task ServeAedsProbeResponseAsync(TcpListener listener, ushort frameType)
    {
        using TcpClient client = await listener.AcceptTcpClientAsync();
        await using NetworkStream stream = client.GetStream();
        byte[] request = new byte[4096];
        _ = await stream.ReadAsync(request);
        byte[] frame = new byte[16];
        BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(8, 2), frameType);
        byte[] headers = Encoding.ASCII.GetBytes(
            "HTTP/1.1 200 OK\r\n" +
            "Content-Type: application/octet-stream\r\n" +
            "Cache-Control: public, max-age=60\r\n" +
            $"Content-Length: {frame.Length}\r\n" +
            "Connection: close\r\n\r\n");
        await stream.WriteAsync(headers);
        await stream.WriteAsync(frame);
    }

    private static async Task<ProcessResult> RunProcessAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        IReadOnlyDictionary<string, string?>? environment = null)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            WorkingDirectory = BackendTestPaths.RepositoryRoot,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        if (environment is not null)
        {
            foreach ((string key, string? value) in environment)
            {
                startInfo.Environment[key] = value;
            }
        }

        using Process process = Process.Start(startInfo)!;
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        return new ProcessResult(process.ExitCode, await stdout, await stderr);
    }

    private sealed class DataScaleToolFixture : IDisposable
    {
        public const string Namespace = "source-lock-data-scale";

        private DataScaleToolFixture(string root)
        {
            Root = root;
            OutputDirectory = Path.Combine(root, "output");
            SqlCapture = Path.Combine(root, "seed.sql");
            NodeInvocationCapture = Path.Combine(root, "node-invocation.txt");
            ArtifactEnvironmentCapture = Path.Combine(root, "artifact-environment.txt");
            string bin = Path.Combine(root, "bin");
            Directory.CreateDirectory(bin);
            DockerPath = Path.Combine(bin, "docker");
            NodePath = Path.Combine(bin, "fake-node");
            File.WriteAllText(DockerPath, DataScaleFakeDocker);
            File.WriteAllText(NodePath, DataScaleFakeNode);
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(DockerPath, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
                File.SetUnixFileMode(NodePath, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }
        }

        public string Root { get; }
        public string OutputDirectory { get; }
        public string SqlCapture { get; }
        public string NodeInvocationCapture { get; }
        public string ArtifactEnvironmentCapture { get; }
        private string DockerPath { get; }
        private string NodePath { get; }

        public static DataScaleToolFixture Create()
            => new(Directory.CreateTempSubdirectory("fsus-data-scale-tools-").FullName);

        public Task<ProcessResult> RunAsync(string script, string tier, string? outputDirectory = null)
        {
            string selectedOutput = outputDirectory ?? OutputDirectory;
            return RunProcessAsync(
                "/bin/bash",
                [BackendTestPaths.FromRoot("tools", "data-scale", script), tier],
                new Dictionary<string, string?>
                {
                    ["PATH"] = $"{Path.GetDirectoryName(DockerPath)}:/usr/bin:/bin",
                    ["FSUSBLOG_DATA_SCALE_OUT_DIR"] = selectedOutput,
                    ["FSUSBLOG_TEST_NAMESPACE"] = Namespace,
                    ["FSUSBLOG_FAKE_PSQL_INPUT"] = SqlCapture,
                    ["FSUSBLOG_NODE"] = NodePath,
                    ["FSUSBLOG_FAKE_NODE_INVOCATION"] = NodeInvocationCapture,
                    ["FSUSBLOG_FAKE_ARTIFACT_ENVIRONMENT"] = ArtifactEnvironmentCapture
                });
        }

        public void Dispose() => Directory.Delete(Root, recursive: true);
    }

    private const string DataScaleFakeDocker = """
        #!/usr/bin/env bash
        set -euo pipefail
        if [[ "$*" == *"pg_isready"* ]]; then
          exit 0
        fi
        if [[ "$*" == *"psql"* ]]; then
          cat > "$FSUSBLOG_FAKE_PSQL_INPUT"
          printf '%s\n' '{"status":"ok","tier":"scale-xs","namespace":"source-lock-data-scale"}'
          exit 0
        fi
        exit 91
        """;

    private const string DataScaleFakeNode = """
        #!/usr/bin/env bash
        set -euo pipefail
        printf '%s\n' "$*" > "$FSUSBLOG_FAKE_NODE_INVOCATION"
        printf '%s\n' "$FSUSBLOG_DATA_SCALE_ARTIFACT_EVIDENCE" > "$FSUSBLOG_FAKE_ARTIFACT_ENVIRONMENT"
        output="${*: -1}"
        printf '%s\n' '{"status":"ok","schema":"fsusblog.data-scale-tier-summary.v1"}' > "$output"
        printf '%s\n' '{"status":"ok","sourceFixtureNamespace":"source-lock-data-scale","unsupported":[]}' > "$FSUSBLOG_DATA_SCALE_ARTIFACT_EVIDENCE"
        """;

    private const string RuntimeEvidenceFakeDocker = """
        #!/usr/bin/env bash
        set -euo pipefail
        root="${FSUSBLOG_FAKE_COUNTER_ROOT:?}"
        if [[ "$*" == *"redis-cli PING"* ]]; then
          printf 'PONG\n'
          exit 0
        fi
        if [[ "$*" == *"redis-cli INFO commandstats"* ]]; then
          value="$(cat "$root/redis-counter")"
          value=$((value + 1))
          printf '%s\n' "$value" > "$root/redis-counter"
          printf 'cmdstat_get:calls=%s,usec=1,usec_per_call=1.0\n' "$value"
          exit 0
        fi
        if [[ "$*" == *"psql"* && "$*" == *"select 1;"* ]]; then
          printf '1\n'
          exit 0
        fi
        if [[ "$*" == *"psql"* ]]; then
          value="$(cat "$root/postgres-counter")"
          value=$((value + 1))
          printf '%s\n' "$value" > "$root/postgres-counter"
          printf '%s\n' "$value"
          exit 0
        fi
        exit 92
        """;

    private sealed record ProcessResult(int ExitCode, string StandardOutput, string StandardError);
}

public class MiddlewareResultsTests
{
    [Fact]
    public async Task WriteErrorAsync_WithAedsEncoder_WritesApiErrorFrame()
    {
        var services = new ServiceCollection()
            .AddSingleton<IAedsEncoder, AedsEncoder>()
            .BuildServiceProvider();

        var context = new DefaultHttpContext
        {
            RequestServices = services
        };
        await using var body = new MemoryStream();
        context.Response.Body = body;

        await MiddlewareResults.WriteErrorAsync(
            context,
            "account is restricted and cannot perform this write action",
            423,
            "trace-1",
            "ACCOUNT_BANNED_WRITE_LOCKED");

        Assert.Equal(423, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);

        var encoder = services.GetRequiredService<IAedsEncoder>();
        var decoded = encoder.TryDecode(body.ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var errorPod));
        Assert.Equal(423, errorPod.HttpStatus);
        Assert.Equal("account is restricted and cannot perform this write action", PodUtf8Codec.FromFixed256(errorPod.Message));
        Assert.Equal("ACCOUNT_BANNED_WRITE_LOCKED", PodUtf8Codec.FromFixed256(errorPod.Details));
        Assert.Equal("trace-1", PodUtf8Codec.FromFixed64(errorPod.TraceId));
    }
}

public class ApiBinaryResponseMiddlewareTests
{
    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.RequestServices = new ServiceCollection()
            .AddSingleton<IBinaryEnvelopePolicy, BinaryEnvelopePolicy>()
            .AddSingleton<IAedsEncoder, AedsEncoder>()
            .BuildServiceProvider();
        return context;
    }

    [Fact]
    public async Task InvokeAsync_BinaryEndpointWithTextAccept_ReturnsApiErrorFrameBeforeEndpoint()
    {
        static Task Next(HttpContext context)
        {
            throw new InvalidOperationException("binary endpoint should not execute");
        }

        var context = CreateContext();
        context.Request.Path = "/api/binary/article/list/home/1/10.aeds";
        context.Request.Headers.Accept = "application/" + "json";
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var encoder = new AedsEncoder();
        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, encoder);

        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);

        var decoded = encoder.TryDecode(body.ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var errorPod));
        Assert.Equal(StatusCodes.Status406NotAcceptable, errorPod.HttpStatus);
        Assert.Equal("binary_accept_required", PodUtf8Codec.FromFixed256(errorPod.Message));
    }

    [Fact]
    public async Task InvokeAsync_BinaryEndpointWithTextBody_ReturnsApiErrorFrameBeforeEndpoint()
    {
        static Task Next(HttpContext context)
        {
            throw new InvalidOperationException("binary endpoint should not execute");
        }

        var context = CreateContext();
        context.Request.Path = "/api/binary/admin/article";
        context.Request.Method = "POST";
        context.Request.Headers.Accept = "application/octet-stream";
        context.Request.ContentType = "application/" + "json";
        context.Request.ContentLength = 2;
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var encoder = new AedsEncoder();
        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, encoder);

        Assert.Equal(StatusCodes.Status415UnsupportedMediaType, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);

        var decoded = encoder.TryDecode(body.ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var errorPod));
        Assert.Equal(StatusCodes.Status415UnsupportedMediaType, errorPod.HttpStatus);
        Assert.Equal("binary_content_type_required", PodUtf8Codec.FromFixed256(errorPod.Message));
    }

    [Fact]
    public async Task InvokeAsync_BinaryEndpointCorsPreflight_SkipsBinaryEnvelopeChecks()
    {
        static Task Next(HttpContext context)
        {
            context.Response.StatusCode = StatusCodes.Status204NoContent;
            return Task.CompletedTask;
        }

        var context = CreateContext();
        context.Request.Path = "/api/binary/system/seo";
        context.Request.Method = HttpMethods.Options;
        context.Request.Headers.Origin = "http://127.0.0.1:3000";
        context.Request.Headers.AccessControlRequestMethod = "GET";
        context.Request.Headers.Accept = "application/" + "json";
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var encoder = new AedsEncoder();
        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, encoder);

        Assert.Equal(StatusCodes.Status204NoContent, context.Response.StatusCode);
        Assert.Equal(0, body.Length);
    }

    [Theory]
    [InlineData("")]
    [InlineData("*/*")]
    [InlineData("application/octet-stream")]
    [InlineData("application/octet-stream; charset=binary")]
    [InlineData("application/json;q=1, application/octet-stream;q=0.5")]
    public async Task InvokeAsync_BinaryEndpointCompatibleAcceptVariants_RunEndpoint(string accept)
    {
        static async Task Next(HttpContext context)
        {
            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = "application/octet-stream";
            await context.Response.Body.WriteAsync(new byte[] { 0x42 });
        }

        var context = CreateContext();
        context.Request.Path = "/api/binary/system/seo";
        context.Request.Headers.Accept = accept;
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, new AedsEncoder());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal(new byte[] { 0x42 }, body.ToArray());
    }

    [Theory]
    [InlineData("application/octet-stream;q=0")]
    [InlineData("application/json, application/octet-stream;q=0")]
    public async Task InvokeAsync_BinaryEndpointQZeroRejectsBinaryAccept(string accept)
    {
        static Task Next(HttpContext context)
        {
            throw new InvalidOperationException("binary endpoint should not execute");
        }

        var context = CreateContext();
        context.Request.Path = "/api/binary/system/seo";
        context.Request.Headers.Accept = accept;
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var encoder = new AedsEncoder();
        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, encoder);

        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
        var decoded = encoder.TryDecode(body.ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
    }

    [Fact]
    public async Task InvokeAsync_BinaryEndpointWithCompatibleAccept_DoesNotWrapEndpointResponse()
    {
        Stream? endpointBody = null;
        async Task Next(HttpContext context)
        {
            endpointBody = context.Response.Body;
            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = "application/octet-stream";
            await context.Response.Body.WriteAsync(new byte[] { 0x01, 0x02, 0x03 });
        }

        var context = CreateContext();
        context.Request.Path = "/api/binary/system/seo";
        context.Request.Headers.Accept = "application/octet-stream";
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, new AedsEncoder());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);
        Assert.Equal(new byte[] { 0x01, 0x02, 0x03 }, body.ToArray());
        Assert.Same(body, endpointBody);
    }

    [Fact]
    public async Task InvokeAsync_BinaryEndpointWithEmptyAuthorizationFailure_ReturnsApiErrorFrame()
    {
        static Task Next(HttpContext context)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        }

        var context = CreateContext();
        context.Request.Path = "/api/binary/comment/me";
        context.Request.Headers.Accept = "application/octet-stream";
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var encoder = new AedsEncoder();
        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, encoder);

        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);

        var decoded = encoder.TryDecode(body.ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var errorPod));
        Assert.Equal(StatusCodes.Status401Unauthorized, errorPod.HttpStatus);
        Assert.Equal("HTTP 401", PodUtf8Codec.FromFixed256(errorPod.Message));
    }

    [Fact]
    public async Task InvokeAsync_UnmarkedApiWithBinaryAccept_DoesNotCaptureResponseBody()
    {
        Stream? endpointBody = null;
        static async Task Next(HttpContext context)
        {
            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = "text/plain; charset=utf-8";
            await context.Response.WriteAsync("ok");
        }

        async Task CaptureBodyNext(HttpContext context)
        {
            endpointBody = context.Response.Body;
            await Next(context);
        }

        var context = CreateContext();
        context.Request.Path = "/api/test";
        context.Request.Headers.Accept = "application/octet-stream";
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var middleware = new ApiBinaryResponseMiddleware(CaptureBodyNext);
        await middleware.InvokeAsync(context, new AedsEncoder());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("text/plain; charset=utf-8", context.Response.ContentType);
        Assert.Equal("ok", Encoding.UTF8.GetString(body.ToArray()));
        Assert.Same(body, endpointBody);
    }

    [Fact]
    public async Task InvokeAsync_MarkedLegacyApiWithBinaryAccept_ReturnsApiErrorFrame()
    {
        static async Task Next(HttpContext context)
        {
            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = "text/plain; charset=utf-8";
            await context.Response.WriteAsync("ok");
        }

        var context = CreateContext();
        context.Request.Path = "/api/test";
        context.Request.Headers.Accept = "application/octet-stream";
        context.SetEndpoint(new Endpoint(
            _ => Task.CompletedTask,
            new EndpointMetadataCollection(ApiBinaryResponseMiddleware.LegacyBinaryEnvelopeFallbackMetadata.Instance),
            "legacy text api"));
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var encoder = new AedsEncoder();
        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, encoder);

        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);

        var decoded = encoder.TryDecode(body.ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var errorPod));
        Assert.Equal(StatusCodes.Status406NotAcceptable, errorPod.HttpStatus);
        Assert.Equal("binary_response_required", PodUtf8Codec.FromFixed256(errorPod.Message));
    }

    [Fact]
    public async Task InvokeAsync_MarkedLegacyApiWithLargeTextResponse_ReturnsCaptureLimitApiError()
    {
        static async Task Next(HttpContext context)
        {
            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = "text/plain; charset=utf-8";
            byte[] payload = new byte[ApiBinaryResponseMiddleware.MaxCapturedResponseBytes + 1];
            await context.Response.Body.WriteAsync(payload);
        }

        var context = CreateContext();
        context.Request.Path = "/api/test";
        context.Request.Headers.Accept = "application/octet-stream";
        context.SetEndpoint(new Endpoint(
            _ => Task.CompletedTask,
            new EndpointMetadataCollection(ApiBinaryResponseMiddleware.LegacyBinaryEnvelopeFallbackMetadata.Instance),
            "legacy text api"));
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var encoder = new AedsEncoder();
        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, encoder);

        Assert.Equal(StatusCodes.Status413PayloadTooLarge, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);

        var decoded = encoder.TryDecode(body.ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var errorPod));
        Assert.Equal(StatusCodes.Status413PayloadTooLarge, errorPod.HttpStatus);
        Assert.Equal("binary_response_capture_limit_exceeded", PodUtf8Codec.FromFixed256(errorPod.Message));
    }

    [Fact]
    public void Runtime_RequiresExplicitMetadataBeforeLegacyCaptureStream()
    {
        IReadOnlyList<string> references = RuntimeMetadataInspection
            .DescribeDeclaredMemberReferencesInOrderContaining(
                typeof(ApiBinaryResponseMiddleware),
                "RequiresLegacyBinaryEnvelopeFallback",
                "PooledCaptureStream..ctor");
        int optInCheck = references.ToList().FindIndex(
            reference => reference.Contains("RequiresLegacyBinaryEnvelopeFallback", StringComparison.Ordinal));
        int capture = references.ToList().FindIndex(
            reference => reference.Contains("PooledCaptureStream..ctor", StringComparison.Ordinal));

        Assert.True(optInCheck >= 0);
        Assert.True(capture > optInCheck);
        string metadataCheck = RuntimeMetadataInspection.DescribeMethods(
            typeof(ApiBinaryResponseMiddleware),
            "RequiresLegacyBinaryEnvelopeFallback");
        Assert.Contains("LegacyBinaryEnvelopeFallbackMetadata", metadataCheck, StringComparison.Ordinal);
        Assert.Contains("GetMetadata", metadataCheck, StringComparison.Ordinal);
    }
}
