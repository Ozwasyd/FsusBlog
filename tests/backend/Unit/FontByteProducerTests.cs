using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Fonts;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Shared.Contracts.Fonts;

namespace FsusBlog.Server.Tests;

// Short magic payloads exercise installed byte I/O and tuple wiring only. They
// are deliberately not evidence of real WOFF2 decoding, glyphs or export rendering.
public sealed class FontByteProducerTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"fsusblog-font-bytes-{Guid.NewGuid():N}");
    private static readonly JsonSerializerOptions s_json = new(JsonSerializerDefaults.Web);

    [Fact]
    public async Task InstalledBytes_PreserveExactIdentityAndOwnershipAfterUninstall()
    {
        var registry = new LocalFontRegistry(_root);
        FontRegistryEntry entry = await InstallAsync(registry, "Fixture Sans", [400]);
        FontFaceReadRequest request = Request(entry);
        FontRegistryFaceBytes result = Assert.Single(await registry.ReadFaceBytesAsync([request], 100));
        Assert.Equal(request, result.Identity);
        Assert.Equal(Payload(400), result.Bytes.ToArray());
        Assert.False(entry.Enabled);
        await registry.DeleteAsync(entry.Id);
        Assert.Equal(Payload(400), result.Bytes.ToArray());
        Assert.False(File.Exists(AssetPath(entry)));
        await RefusesAsync("font_not_found", () => registry.ReadFaceBytesAsync([request], 100));
    }

    [Theory]
    [InlineData("version")]
    [InlineData("family")]
    [InlineData("weight")]
    [InlineData("style")]
    [InlineData("hash")]
    public async Task FrozenIdentity_RejectsDrift(string field)
    {
        var registry = new LocalFontRegistry(_root);
        FontRegistryEntry entry = await InstallAsync(registry, "Fixture Sans", [400]);
        FontFaceReadRequest request = Request(entry);
        request = field switch
        {
            "version" => request with { Version = "2.0.0" },
            "family" => request with { Family = "Alias" },
            "weight" => request with { Weight = 500 },
            "style" => request with { Style = "italic" },
            _ => request with { ContentHash = new string('0', 64) }
        };
        await RefusesAsync(field is "version" or "family" ? "font_identity_changed" : "font_face_unavailable",
            () => registry.ReadFaceBytesAsync([request], 100));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("tamper")]
    [InlineData("truncated")]
    [InlineData("oversized")]
    [InlineData("symlink")]
    public async Task OwnedAsset_RejectsMissingModifiedOversizedOrLinkedFiles(string mutation)
    {
        var registry = new LocalFontRegistry(_root);
        FontRegistryEntry entry = await InstallAsync(registry, "Fixture Sans", [400]);
        string path = AssetPath(entry);
        if (mutation == "missing")
        {
            File.Delete(path);
        }
        else if (mutation == "symlink")
        {
            string other = Path.Combine(_root, "other.woff2");
            File.Move(path, other);
            File.CreateSymbolicLink(path, other);
        }
        else
        {
            await using var stream = new FileStream(path, FileMode.Open, FileAccess.Write);
            if (mutation == "oversized")
            {
                stream.SetLength(FontPackageLimits.MaxTotalBytes + 1);
            }
            else if (mutation == "truncated")
            {
                stream.SetLength(2);
            }
            else
            {
                stream.WriteByte(0);
            }
        }

        await RefusesAsync("font_asset_integrity_invalid", () => registry.ReadFaceBytesAsync([Request(entry)], 100));
    }

    [Fact]
    public async Task BatchBudget_RejectsBeforeCopyAndDoesNotReturnPartialBytes()
    {
        var registry = new LocalFontRegistry(_root);
        FontRegistryEntry entry = await InstallAsync(registry, "Fixture Sans", [400, 700]);
        FontFaceReadRequest[] requests = entry.Faces.Select(face => Request(entry, face)).ToArray();
        await RefusesAsync("font_byte_budget_exceeded", () => registry.ReadFaceBytesAsync(requests, Payload(400).Length));
        await RefusesAsync("font_byte_budget_invalid", () => registry.ReadFaceBytesAsync(requests, FontPackageLimits.MaxTotalBytes + 1));
        await RefusesAsync("font_byte_request_invalid", () => registry.ReadFaceBytesAsync([requests[0], requests[0]], 100));
        File.Delete(AssetPath(entry, entry.Faces[1]));
        await RefusesAsync("font_asset_integrity_invalid", () => registry.ReadFaceBytesAsync(requests, 100));
    }

    [Fact]
    public async Task BuiltInStacks_HaveNoOwnedByteFallback()
    {
        var registry = new LocalFontRegistry(_root);
        foreach (FontRegistryEntry entry in (await registry.ReadAsync()).Fonts)
        {
            Assert.Empty(entry.Faces);
            await RefusesAsync("font_owned_faces_unavailable", () => registry.ReadFaceBytesAsync(
                [new FontFaceReadRequest(entry.Id, entry.Version, entry.Family, 400, "normal", new string('0', 64))], 100));
        }
    }

    [Fact]
    public async Task ReadAndUninstall_ShareOriginalGateAndReturnOwnedBytes()
    {
        var registry = new LocalFontRegistry(_root);
        FontRegistryEntry entry = await InstallAsync(registry, "Fixture Sans", [400]);
        SemaphoreSlim gate = Assert.IsType<SemaphoreSlim>(typeof(LocalFontRegistry)
            .GetField("_gate", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(registry));
        await gate.WaitAsync();
        Task<IReadOnlyList<FontRegistryFaceBytes>> read;
        Task uninstall;
        try
        {
            read = registry.ReadFaceBytesAsync([Request(entry)], 100);
            uninstall = registry.DeleteAsync(entry.Id);
            Assert.False(read.IsCompleted);
            Assert.False(uninstall.IsCompleted);
        }
        finally
        {
            gate.Release();
        }

        FontRegistryFaceBytes result = Assert.Single(await read);
        await uninstall;
        Assert.Equal(Payload(400), result.Bytes.ToArray());
        Assert.DoesNotContain((await registry.ReadAsync()).Fonts, font => font.Id == entry.Id);
    }

    [Fact]
    public async Task Replacement_RejectsOldVersionEvenWhenBytesAreIdentical()
    {
        var registry = new LocalFontRegistry(_root);
        FontRegistryEntry entry = await InstallAsync(registry, "Fixture Sans", [400]);
        Task<IReadOnlyList<FontRegistryFaceBytes>> read = registry.ReadFaceBytesAsync([Request(entry)], 100);
        Task replacement = ReplaceAsync();
        Assert.Equal(Payload(400), Assert.Single(await read).Bytes.ToArray());
        await replacement;
        await RefusesAsync("font_identity_changed", () => registry.ReadFaceBytesAsync([Request(entry)], 100));

        async Task ReplaceAsync()
        {
            await registry.DeleteAsync(entry.Id);
            await InstallAsync(registry, "Fixture Sans", [400], "2.0.0");
        }
    }

    [Fact]
    public async Task Cancellation_ReleasesTheGateForSubsequentReads()
    {
        var registry = new LocalFontRegistry(_root);
        FontRegistryEntry entry = await InstallAsync(registry, "Fixture Sans", [400]);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => registry.ReadFaceBytesAsync([Request(entry)], 100, cancellation.Token));
        Assert.Single(await registry.ReadFaceBytesAsync([Request(entry)], 100));
    }

    [Fact]
    public async Task PersistedVersionTamper_IsRejectedAgainstOriginalManifest()
    {
        var registry = new LocalFontRegistry(_root);
        FontRegistryEntry entry = await InstallAsync(registry, "Fixture Sans", [400]);
        string path = Path.Combine(_root, "registry.json");
        string json = await File.ReadAllTextAsync(path);
        await File.WriteAllTextAsync(path, json.Replace("\"version\": \"1.0.0\"", "\"version\": \"2.0.0\"", StringComparison.Ordinal));
        await RefusesAsync("font_identity_changed", () => registry.ReadFaceBytesAsync([Request(entry) with { Version = "2.0.0" }], 100));
    }

    [Theory]
    [InlineData("in-place")]
    [InlineData("replacement")]
    public async Task DescriptorIdentity_DetectsInPlaceMutationAndNameReplacement(string mutation)
    {
        var registry = new LocalFontRegistry(_root);
        FontRegistryEntry entry = await InstallAsync(registry, "Fixture Sans", [400]);
        using FontAssetFile opened = FontAssetFile.Open(_root, entry.Faces[0].ContentHash);
        opened.ValidateUnchanged();
        if (mutation == "in-place")
        {
            await File.WriteAllBytesAsync(AssetPath(entry), Payload(700));
        }
        else
        {
            File.Move(AssetPath(entry), Path.Combine(_root, "old.woff2"));
            await File.WriteAllBytesAsync(AssetPath(entry), Payload(400));
        }

        Assert.Throws<IOException>(() => opened.ValidateUnchanged());
    }

    [Theory]
    [InlineData("root")]
    [InlineData("assets")]
    public async Task AnchoredRead_RejectsDirectorySymlinks(string level)
    {
        var registry = new LocalFontRegistry(_root);
        FontRegistryEntry entry = await InstallAsync(registry, "Fixture Sans", [400]);
        string moved = Path.Combine(_root, "moved-assets");
        string link;
        if (level == "assets")
        {
            link = Path.Combine(_root, "assets");
            Directory.Move(link, moved);
            Directory.CreateSymbolicLink(link, moved);
        }
        else
        {
            link = Path.Combine(_root, "linked-root");
            Directory.CreateSymbolicLink(link, _root);
            registry = new LocalFontRegistry(link);
        }

        await RefusesAsync("font_asset_integrity_invalid", () => registry.ReadFaceBytesAsync([Request(entry)], 100));
    }

    [Fact]
    public async Task Mapper_EmptyRegistryRefusesAuthoritativeTuplesInsteadOfBuiltInAliases()
    {
        var registry = new LocalFontRegistry(_root);
        FontFaceReadRequest[] requests = DocumentExportReadingStyleAuthority.RequiredFonts.Select(tuple =>
            new FontFaceReadRequest(FontBuiltIns.ProseSans.Id, "builtin", tuple.Family,
                tuple.Weight, tuple.Style, new string('0', 64))).ToArray();
        await RefusesAsync("font_owned_faces_unavailable", () => DocumentExportFontMapper.ReadAsync(registry, requests, 1000));
    }

    [Fact]
    public async Task Mapper_ByteIoProjectsExactSevenTuplesWithoutRenderingQualification()
    {
        var registry = new LocalFontRegistry(_root);
        var requests = new List<FontFaceReadRequest>();
        foreach (IGrouping<string, DocumentExportRequiredFont> family in DocumentExportReadingStyleAuthority.RequiredFonts.GroupBy(font => font.Family))
        {
            FontRegistryEntry entry = await InstallAsync(registry, family.Key, family.Select(font => font.Weight).ToArray());
            requests.AddRange(entry.Faces.Select(face => Request(entry, face)));
        }

        var assets = await DocumentExportFontMapper.ReadAsync(registry, requests.AsEnumerable().Reverse().ToArray(), 1000);
        Assert.Equal(DocumentExportReadingStyleAuthority.RequiredFonts,
            assets.Select(asset => new DocumentExportRequiredFont(asset.FontFamily, asset.FontWeight, asset.FontStyle)));
        foreach (var asset in assets)
        {
            Assert.Equal("font", asset.Role);
            Assert.Equal("font/woff2", asset.MediaType);
            Assert.Equal($"sha256:{Hash(asset.Bytes.AsSpan())}", asset.Sha256);
            Assert.Equal(Payload(asset.FontWeight), asset.Bytes.ToArray());
        }

        await RefusesAsync("export_font_tuple_set_invalid", () => DocumentExportFontMapper.ReadAsync(registry, requests.Skip(1).ToArray(), 1000));
        await RefusesAsync("export_font_tuple_set_invalid", () => DocumentExportFontMapper.ReadAsync(registry, [.. requests.Skip(1), requests[1]], 1000));
        await RefusesAsync("export_font_tuple_set_invalid", () => DocumentExportFontMapper.ReadAsync(registry,
            [.. requests.Skip(1), requests[0] with { Family = "Alias" }], 1000));
        await registry.DeleteAsync(requests[0].FontId);
        await RefusesAsync("font_not_found", () => DocumentExportFontMapper.ReadAsync(registry, requests, 1000));
    }

    private static async Task<FontRegistryEntry> InstallAsync(LocalFontRegistry registry, string family, int[] weights, string version = "1.0.0")
    {
        var source = new FontSourceDescriptor("local-vendored", "byte-io-test", "1.0.0", "Byte I/O tests");
        var manifest = new FontManifest(
            $"fsusblog.font.test-{family.Replace(" ", "-", StringComparison.Ordinal).ToLowerInvariant()}",
            family, version, ">=1.3.0 <1.4.0", "font", family, FontCategories.ProseSans,
            ["latin"], ["en-US"],
            weights.Select(weight => new FontFaceDescriptor(weight, "normal", $"fonts/{weight}.woff2", Hash(Payload(weight)), null, false)).ToArray(),
            new FontLicenseDescriptor("MIT", "license/LICENSE.txt", "license/source.json"), source,
            new FontBudgetDescriptor(1000, 1000, weights.Length), new FontLoadingDescriptor("swap", [], []));
        using var package = new MemoryStream();
        using (var archive = new ZipArchive(package, ZipArchiveMode.Create, leaveOpen: true))
        {
            Write("manifest.json", JsonSerializer.SerializeToUtf8Bytes(manifest, s_json));
            Write("license/LICENSE.txt", Encoding.UTF8.GetBytes("Byte I/O test license; no real font included."));
            Write("license/source.json", JsonSerializer.SerializeToUtf8Bytes(source, s_json));
            foreach (int weight in weights)
            {
                Write($"fonts/{weight}.woff2", Payload(weight));
            }

            void Write(string path, byte[] bytes)
            {
                using Stream destination = archive.CreateEntry(path).Open();
                destination.Write(bytes);
            }
        }

        package.Position = 0;
        return await registry.InstallAsync(await FontPackageReader.ReadAsync(package, new Version(1, 3, 0)));
    }

    private static byte[] Payload(int weight) => [0x77, 0x4f, 0x46, 0x32, (byte)(weight / 100)];

    private static string Hash(ReadOnlySpan<byte> bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private static FontFaceReadRequest Request(FontRegistryEntry entry, FontRegistryFace? face = null)
    {
        face ??= entry.Faces[0];
        return new FontFaceReadRequest(entry.Id, entry.Version, entry.Family, face.Weight, face.Style, face.ContentHash);
    }

    private string AssetPath(FontRegistryEntry entry, FontRegistryFace? face = null)
        => Path.Combine(_root, "assets", $"{(face ?? entry.Faces[0]).ContentHash}.woff2");

    private static async Task RefusesAsync<T>(string code, Func<Task<T>> action)
    {
        FontRegistryException error = await Assert.ThrowsAsync<FontRegistryException>(action);
        Assert.Equal(code, error.Code);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }
}
