using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Core.Common;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using SqlSugar;

namespace FsusBlog.Server.Tests.TestInfrastructure;

/// <summary>Owns one actual database and filesystem case; never substitutes a storage or upload authority.</summary>
internal sealed class AssetUploadLifecycleTestFixture : IAsyncDisposable
{
    private readonly ServiceProvider _services;
    private readonly string _ownerMarker;
    private readonly string _ownerIdentity = Guid.NewGuid().ToString("N");
    private readonly List<object> _steps = [];
    private bool _completed;

    private AssetUploadLifecycleTestFixture(SqlSugarClient db, string root, byte[] bytes, string scenario)
    {
        Db = db;
        Root = root;
        Bytes = bytes;
        Scenario = scenario;
        Paths = ReleaseStorageTestPaths.Create(root);
        _ownerMarker = Path.Combine(root, "case-owner");
        File.WriteAllText(_ownerMarker, _ownerIdentity);
        _services = new ServiceCollection().AddSingleton<ISqlSugarClient>(db).BuildServiceProvider();
        Service = new FileService(Paths, NullLogger<FileService>.Instance, _services.GetRequiredService<IServiceScopeFactory>());
    }

    public SqlSugarClient Db
    {
        get;
    }
    public string Root
    {
        get;
    }
    public byte[] Bytes
    {
        get;
    }
    public string Scenario
    {
        get;
    }
    public ReleaseStoragePaths Paths
    {
        get;
    }
    public FileService Service
    {
        get;
    }
    public UploadInitDto Session { get; private set; } = null!;
    public UploadSessionAccess Access => new(Session.UploadId, 7, Session.UploadToken);
    public string Sha256 => Hash(Bytes);
    public Guid AssetGuid => Guid.ParseExact(Session.UploadId, "N");
    public string WorkingFile => Path.Combine(Paths.UploadSessionRoot, Session.UploadId, "upload.tmp");
    public string PublicFile => Path.Combine(Paths.PublicAssetRoot, "illustration", Session.UploadId + ".png");

    public static async Task RunAsync(
        PostgresSchemaMigrationFixture postgres,
        string scenario,
        Func<AssetUploadLifecycleTestFixture, Task> execute,
        byte[]? bytes = null)
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(postgres);
        PostgresSqlSugarTestClient.InitTables(db, typeof(ContentAsset), typeof(ContentAssetReference), typeof(ContentAssetCleanupQueueItem));
        string root = Path.Combine(Path.GetTempPath(), "fsus-upload-2077-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        await using var fixture = new AssetUploadLifecycleTestFixture(db, root, bytes ?? CreatePng(), scenario);
        try
        {
            fixture.ValidateContractRoots();
            var initialized = await fixture.Service.InitUploadSessionAsync(7, new UploadInitRequestDto
            {
                FileName = "original.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = fixture.Bytes.Length,
                ChunkSize = 64 * 1024,
                Sha256 = fixture.Sha256
            });
            Assert.True(initialized.IsSuccess, initialized.Error.Message);
            fixture.Session = initialized.Value!;
            await fixture.RecordAsync("initialized");
            await execute(fixture);
            await fixture.FinishAsync(null);
        }
        catch (Exception exception)
        {
            await fixture.FinishAsync(exception);
            throw;
        }
    }

    public async Task<Result<UploadPartAckDto>> UploadAsync(
        int part,
        byte[]? replacement = null,
        long? offset = null,
        string? digest = null,
        UploadSessionAccess? access = null,
        CancellationToken cancellationToken = default)
    {
        int start = part * Session.ChunkSize;
        byte[] bytes = replacement ?? Bytes.AsSpan(start, Math.Min(Session.ChunkSize, Bytes.Length - start)).ToArray();
        using var stream = new MemoryStream(bytes);
        var form = new FormFile(stream, 0, bytes.Length, "part", "chunk");
        return await Service.UploadPartAsync(access ?? Access, part, offset ?? start, form, digest ?? Hash(bytes), cancellationToken);
    }

    public async Task UploadAllAsync(IEnumerable<int>? order = null)
    {
        foreach (int part in order ?? Enumerable.Range(0, Session.TotalParts))
        {
            var result = await UploadAsync(part);
            Assert.True(result.IsSuccess, result.Error.Message);
        }
        await RecordAsync("all-parts-acknowledged");
    }

    public async Task AssertUnpublishedAsync()
    {
        Assert.False(File.Exists(PublicFile));
        Assert.Equal(0, await Db.Queryable<ContentAsset>().CountAsync());
        Assert.Empty(Directory.EnumerateFiles(Paths.PublicAssetRoot, "*", SearchOption.AllDirectories));
        if (Directory.Exists(Paths.UploadCommitRoot))
            Assert.Empty(Directory.EnumerateFiles(Paths.UploadCommitRoot, "*", SearchOption.AllDirectories));
    }

    public async Task AssertCommittedAsync()
    {
        Assert.Equal(Bytes, await File.ReadAllBytesAsync(PublicFile));
        ContentAsset row = Assert.Single(await Db.Queryable<ContentAsset>().ToListAsync());
        Assert.Equal(AssetGuid, row.AssetId);
        Assert.Equal("illustration/" + Session.UploadId + ".png", row.StorageKey);
        Assert.Equal(7L, row.OwnerAdminPrincipalId);
        Assert.Equal(Sha256, row.Sha256);
        Assert.Equal(Bytes.Length, row.SizeBytes);
        Assert.Equal(ContentAssetStates.Active, row.State);
        Assert.Single(Directory.EnumerateFiles(Paths.PublicAssetRoot, "*", SearchOption.AllDirectories));
        Assert.Empty(Directory.EnumerateFiles(Paths.UploadCommitRoot, "*", SearchOption.AllDirectories));
        var observed = await Service.ObserveCommittedUploadAsync(Access, Sha256);
        Assert.True(observed.IsSuccess, observed.Error.Message);
        Assert.Equal(AssetGuid, observed.Value!.Asset.Id.Value);
        Assert.Equal(Sha256, observed.Value.Asset.Sha256);
        var status = await Service.GetUploadStatusAsync(Access);
        Assert.Equal("completed", status.Value!.Status);
        await RecordAsync("exact-one-committed");
    }

    public async Task RecordAsync(string phase)
    {
        var status = await Service.GetUploadStatusAsync(Access);
        _steps.Add(new
        {
            phase,
            status = status.IsSuccess ? status.Value!.Status : status.Error.Message,
            uploadedBytes = status.Value?.UploadedBytes,
            acknowledgedParts = status.Value?.UploadedPartCount,
            sessionFiles = Snapshot(Path.Combine(Paths.UploadSessionRoot, Session.UploadId)),
            commitFiles = Snapshot(Paths.UploadCommitRoot),
            publicFiles = Snapshot(Paths.PublicAssetRoot),
            ledger = await Db.Queryable<ContentAsset>().ToListAsync(),
            referenceRows = await Db.Queryable<ContentAssetReference>().CountAsync()
        });
    }

    private void ValidateContractRoots()
    {
        using var document = JsonDocument.Parse(File.ReadAllBytes(BackendTestPaths.FromRoot("config", "security", "asset-security-contract.json")));
        foreach (var root in document.RootElement.GetProperty("roots").EnumerateArray())
        {
            string property = root.GetProperty("property").GetString()!;
            string path = (string)typeof(ReleaseStoragePaths).GetProperty(property)!.GetValue(Paths)!;
            Assert.StartsWith(Root + Path.DirectorySeparatorChar, path);
        }
    }

    private async Task FinishAsync(Exception? failure)
    {
        if (_completed)
            return;
        _completed = true;
        if (Session is not null)
            await RecordAsync(failure is null ? "passed-postcondition" : "failed-postcondition");
        await _services.DisposeAsync();
        Db.Dispose();
        bool removed = false;
        if (failure is null)
        {
            Assert.Equal(_ownerIdentity, File.ReadAllText(_ownerMarker));
            Directory.Delete(Root, recursive: true);
            removed = !Directory.Exists(Root);
            Assert.True(removed);
        }
        string repository = BackendTestPaths.RepositoryRoot;
        string commit = Git(repository, "rev-parse", "HEAD").Trim();
        string[] sources = ["src/backend/Services/FileService.cs", "src/backend/Services/FileService.UploadIntegrity.cs", "tests/backend/Unit/AssetUploadLifecycleAcceptanceTests.cs", "tests/backend/Unit/TestInfrastructure/AssetUploadLifecycleTestFixture.cs"];
        string patch = Git(repository, ["diff", "HEAD", "--", .. sources]);
        string sourceStatus = Git(repository, ["status", "--porcelain", "--", .. sources]);
        string artifactRoot = Environment.GetEnvironmentVariable("FSUSBLOG_UPLOAD_LIFECYCLE_ARTIFACTS")
            ?? Path.Combine(Path.GetTempPath(), "fsus-upload-2077-evidence");
        Directory.CreateDirectory(artifactRoot);
        var evidence = new
        {
            schema = "fsusblog.asset-upload-lifecycle-subresult.v1",
            qualification = false,
            scenario = Scenario,
            runIdentity = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_RUN_ID"),
            processId = Environment.ProcessId,
            recordedAtUtc = DateTimeOffset.UtcNow,
            sourceCommit = commit,
            dirtySourcePatchSha256 = Hash(System.Text.Encoding.UTF8.GetBytes(patch)),
            dirtySource = sourceStatus.Length != 0,
            sourceFilesSha256 = sources.ToDictionary(path => path, path => Hash(File.ReadAllBytes(Path.Combine(repository, path)))),
            contractSha256 = Hash(File.ReadAllBytes(Path.Combine(repository, "config/security/asset-security-contract.json"))),
            policySha256 = Hash(File.ReadAllBytes(Path.Combine(repository, "config/security/public-asset-delivery.json"))),
            sourceContentSha256 = Sha256,
            originalUploadLimit = FileService.MaxUploadBytes,
            actualChunkBytes = Session?.ChunkSize,
            uploadId = Session?.UploadId,
            passed = failure is null,
            failureType = failure?.GetType().Name,
            failureMessage = failure?.Message,
            steps = _steps,
            ownedRoot = Root,
            teardownRemovedOwnedRoot = removed,
            retainedFailureRoot = failure is null ? null : Root,
            acceptanceLimits = new[] { "2074-and-1779-prerequisite-qualification", "HTTP-and-gateway-nonexposure", "cross-process-crash-and-cross-volume", "Windows-junctions-and-full-platform-matrix" }
        };
        string json = JsonSerializer.Serialize(evidence, new JsonSerializerOptions { WriteIndented = true });
        if (Session is not null)
            Assert.DoesNotContain(Session.UploadToken, json);
        await File.WriteAllTextAsync(Path.Combine(artifactRoot, Scenario + "." + _ownerIdentity + ".json"), json);
    }

    public async ValueTask DisposeAsync()
    {
        if (!_completed)
        {
            await _services.DisposeAsync();
            Db.Dispose();
        }
    }

    private static object[] Snapshot(string root)
        => !Directory.Exists(root) ? [] : Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Order(StringComparer.Ordinal).Select(file => (object)new
            {
                relativePath = Path.GetRelativePath(root, file),
                bytes = new FileInfo(file).Length,
                sha256 = Hash(File.ReadAllBytes(file))
            }).ToArray();

    private static string Git(string repository, params string[] arguments)
    {
        var start = new ProcessStartInfo("git") { WorkingDirectory = repository, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (string argument in arguments)
            start.ArgumentList.Add(argument);
        using var process = Process.Start(start)!;
        string output = process.StandardOutput.ReadToEnd();
        string error = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, error);
        return output;
    }

    public static string Hash(ReadOnlySpan<byte> bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    public static byte[] CreatePng(bool multipart = true)
    {
        if (!multipart)
            return Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB14AAAAASUVORK5CYII=");
        using var image = new MemoryStream();
        image.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
        byte[] header = new byte[13];
        BinaryPrimitives.WriteInt32BigEndian(header, 1024);
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(4), 64);
        header[8] = 8;
        header[9] = 2;
        Chunk(image, "IHDR"u8, header);
        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(compressed, CompressionLevel.NoCompression, leaveOpen: true))
            zlib.Write(new byte[(1024 * 3 + 1) * 64]);
        Chunk(image, "IDAT"u8, compressed.ToArray());
        Chunk(image, "IEND"u8, []);
        return image.ToArray();
    }

    private static void Chunk(Stream output, ReadOnlySpan<byte> type, ReadOnlySpan<byte> data)
    {
        Span<byte> word = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(word, data.Length);
        output.Write(word);
        output.Write(type);
        output.Write(data);
        uint crc = uint.MaxValue;
        foreach (byte value in type)
            Update(value);
        foreach (byte value in data)
            Update(value);
        BinaryPrimitives.WriteUInt32BigEndian(word, ~crc);
        output.Write(word);
        void Update(byte value)
        {
            crc ^= value;
            for (int bit = 0; bit < 8; bit++)
                crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xedb88320u : crc >> 1;
        }
    }
}
