using System.IO.Compression;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Fonts;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Fonts;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Tests;

public sealed class FontPackageRegistryTests
{
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly byte[] s_fixtureFontBytes = [0x77, 0x4f, 0x46, 0x32, 0x01, 0x02, 0x03];
    private static readonly FontSourceDescriptor s_fixtureSource = new(
        "npm-fontsource",
        "@fontsource/fixture",
        "1.0.0",
        "Fixture upstream");
    private static readonly string s_fixtureSourceJson = JsonSerializer.Serialize(
        s_fixtureSource,
        s_jsonOptions);

    [Fact]
    public async Task ReadAsync_MinimumPackage_ValidatesAndHashesWoff2Faces()
    {
        byte[] fontBytes = s_fixtureFontBytes;
        await using MemoryStream package = CreatePackage(CreateManifest(), new Dictionary<string, byte[]>
        {
            ["fonts/body-regular.woff2"] = fontBytes,
            ["license/LICENSE.txt"] = Encoding.UTF8.GetBytes("fixture license"),
            ["license/source.json"] = Encoding.UTF8.GetBytes(s_fixtureSourceJson)
        });

        ValidatedFontPackage result = await FontPackageReader.ReadAsync(
            package,
            new Version(1, 3, 0));

        FontPackageFace face = Assert.Single(result.Faces);
        Assert.Equal("fsusblog.font.fixture", result.Manifest.Id);
        Assert.Equal("ea41461cc0ae1cd46b04cc751bb0524c7ea98b046ecb8d5f9bb693f2aa53b23b", face.ContentHash);
        Assert.Equal(fontBytes.Length, face.SizeBytes);
        Assert.Equal(fontBytes, face.Content.ToArray());
        Assert.Equal("fixture license", result.LicenseText);
        Assert.Contains("@fontsource/fixture", result.LicenseSourceJson, StringComparison.Ordinal);
        Assert.Equal(".fsfont", FontPackageFormat.Extension);
    }

    [Theory]
    [InlineData("fonts/body-regular.ttf", "font_asset_must_be_woff2")]
    [InlineData("../fonts/body-regular.woff2", "package_path_invalid")]
    [InlineData("fonts/extra.woff2", "font_asset_not_declared")]
    public async Task ReadAsync_RejectsUnsafeOrUnmanifestedFontAssets(string path, string expectedCode)
    {
        await using MemoryStream package = CreatePackage(CreateManifest(), new Dictionary<string, byte[]>
        {
            ["fonts/body-regular.woff2"] = [0x77, 0x4f, 0x46, 0x32],
            [path] = [0x77, 0x4f, 0x46, 0x32, 0x09],
            ["license/LICENSE.txt"] = Encoding.UTF8.GetBytes("fixture license"),
            ["license/source.json"] = Encoding.UTF8.GetBytes(s_fixtureSourceJson)
        });

        FontPackageException error = await Assert.ThrowsAsync<FontPackageException>(
            () => FontPackageReader.ReadAsync(package, new Version(1, 3, 0)));

        Assert.Equal(expectedCode, error.Code);
    }

    [Fact]
    public async Task ReadAsync_RejectsMissingLicenseAndIncompatibleVersion()
    {
        FontManifest incompatible = CreateManifest() with
        {
            FsusBlog = ">=1.4.0 <1.5.0"
        };
        await using MemoryStream package = CreatePackage(incompatible, new Dictionary<string, byte[]>
        {
            ["fonts/body-regular.woff2"] = [0x77, 0x4f, 0x46, 0x32],
            ["license/source.json"] = Encoding.UTF8.GetBytes(s_fixtureSourceJson)
        });

        FontPackageException error = await Assert.ThrowsAsync<FontPackageException>(
            () => FontPackageReader.ReadAsync(package, new Version(1, 3, 0)));

        Assert.Equal("package_required_file_missing", error.Code);
        Assert.Contains("license/LICENSE.txt", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadAsync_RejectsIncompatibleVersionAndInvalidSourceMetadata()
    {
        FontManifest incompatible = CreateManifest() with
        {
            FsusBlog = ">=1.4.0 <1.5.0"
        };
        await using MemoryStream incompatiblePackage = CreatePackage(incompatible, new Dictionary<string, byte[]>
        {
            ["fonts/body-regular.woff2"] = [0x77, 0x4f, 0x46, 0x32],
            ["license/LICENSE.txt"] = Encoding.UTF8.GetBytes("fixture license"),
            ["license/source.json"] = Encoding.UTF8.GetBytes(s_fixtureSourceJson)
        });

        FontPackageException incompatibleError = await Assert.ThrowsAsync<FontPackageException>(
            () => FontPackageReader.ReadAsync(incompatiblePackage, new Version(1, 3, 0)));
        Assert.Equal("font_fsusblog_version_incompatible", incompatibleError.Code);

        await using MemoryStream invalidSourcePackage = CreatePackage(CreateManifest(), new Dictionary<string, byte[]>
        {
            ["fonts/body-regular.woff2"] = [0x77, 0x4f, 0x46, 0x32],
            ["license/LICENSE.txt"] = Encoding.UTF8.GetBytes("fixture license"),
            ["license/source.json"] = Encoding.UTF8.GetBytes("[]")
        });

        FontPackageException sourceError = await Assert.ThrowsAsync<FontPackageException>(
            () => FontPackageReader.ReadAsync(invalidSourcePackage, new Version(1, 3, 0)));
        Assert.Equal("font_license_source_invalid", sourceError.Code);
    }

    [Fact]
    public async Task ReadAsync_RejectsHashMismatchAndSourceMetadataMismatch()
    {
        FontManifest wrongHash = CreateManifest() with
        {
            Faces =
            [
                CreateManifest().Faces[0] with
                {
                    ContentHash = new string('0', 64)
                }
            ]
        };
        await using MemoryStream hashPackage = CreatePackage(wrongHash, FixtureFiles());

        FontPackageException hashError = await Assert.ThrowsAsync<FontPackageException>(
            () => FontPackageReader.ReadAsync(hashPackage, new Version(1, 3, 0)));
        Assert.Equal("font_asset_hash_mismatch", hashError.Code);

        FontSourceDescriptor otherSource = s_fixtureSource with
        {
            Package = "@fontsource/other"
        };
        Dictionary<string, byte[]> files = FixtureFiles();
        files["license/source.json"] = JsonSerializer.SerializeToUtf8Bytes(otherSource, s_jsonOptions);
        await using MemoryStream sourcePackage = CreatePackage(CreateManifest(), files);

        FontPackageException sourceError = await Assert.ThrowsAsync<FontPackageException>(
            () => FontPackageReader.ReadAsync(sourcePackage, new Version(1, 3, 0)));
        Assert.Equal("font_source_mismatch", sourceError.Code);
    }

    [Theory]
    [InlineData("tools/install.sh", "package_executable_forbidden")]
    [InlineData("outside/body.woff2", "font_asset_outside_fonts")]
    [InlineData("outside/body.ttf", "font_asset_outside_fonts")]
    public async Task ReadAsync_RejectsExecutableAndOutOfRootFontEntries(
        string path,
        string expectedCode)
    {
        Dictionary<string, byte[]> files = FixtureFiles();
        files[path] = path.EndsWith(".woff2", StringComparison.Ordinal)
            ? s_fixtureFontBytes
            : Encoding.UTF8.GetBytes("exit 0");
        await using MemoryStream package = CreatePackage(CreateManifest(), files);

        FontPackageException error = await Assert.ThrowsAsync<FontPackageException>(
            () => FontPackageReader.ReadAsync(package, new Version(1, 3, 0)));

        Assert.Equal(expectedCode, error.Code);
    }

    [Fact]
    public async Task ReadAsync_RejectsRemoteFontUrlWithoutFetching()
    {
        Dictionary<string, byte[]> files = FixtureFiles();
        files["css/remote.css"] = Encoding.UTF8.GetBytes(
            """@font-face { src: url("https://fonts.example/fixture.woff2"); }""");
        await using MemoryStream package = CreatePackage(CreateManifest(), files);

        FontPackageException error = await Assert.ThrowsAsync<FontPackageException>(
            () => FontPackageReader.ReadAsync(package, new Version(1, 3, 0)));

        Assert.Equal("font_remote_url_forbidden", error.Code);
    }

    [Fact]
    public void Validate_RejectsUnknownLicenseRemoteOriginAndMissingHash()
    {
        FontManifest invalid = CreateManifest() with
        {
            License = CreateManifest().License with
            {
                Name = "unknown"
            },
            Source = CreateManifest().Source with
            {
                Upstream = "https://fonts.example/fixture"
            },
            Faces =
            [
                CreateManifest().Faces[0] with
                {
                    ContentHash = string.Empty
                }
            ]
        };

        FontManifestValidation validation = FontManifestValidator.Validate(
            invalid,
            new Version(1, 3, 0));

        Assert.False(validation.IsValid);
        Assert.Contains("font_license_invalid", validation.Errors);
        Assert.Contains("font_source_invalid", validation.Errors);
        Assert.Contains("font_face_content_hash_invalid", validation.Errors);
    }

    [Fact]
    public void Validate_RejectsInvalidCategoryDuplicateFaceAndBudget()
    {
        FontManifest invalid = CreateManifest() with
        {
            Category = "display-serif",
            Faces =
            [
                CreateManifest().Faces[0],
                CreateManifest().Faces[0]
            ],
            Budgets = new FontBudgetDescriptor(1, 1, 1)
        };

        FontManifestValidation validation = FontManifestValidator.Validate(invalid, new Version(1, 3, 0));

        Assert.False(validation.IsValid);
        Assert.Contains("font_category_invalid", validation.Errors);
        Assert.Contains("font_face_duplicate", validation.Errors);
        Assert.Contains("font_budget_face_count_exceeded", validation.Errors);
    }

    [Fact]
    public async Task ReadAsync_RejectsCumulativeBudgetBeforeReadingNextFace()
    {
        FontManifest manifest = CreateManifest() with
        {
            Faces =
            [
                CreateManifest().Faces[0],
                new FontFaceDescriptor(
                    Weight: 500,
                    Style: FontFaceStyles.Normal,
                    File: "fonts/body-medium.woff2",
                    ContentHash: Sha256([0x77, 0x4f, 0x46, 0x32, 0x02]),
                    UnicodeRange: "U+0000-00FF",
                    Critical: true)
            ],
            Budgets = new FontBudgetDescriptor(
                CriticalBytes: 9,
                TotalBytes: 9,
                MaxFaces: 2)
        };
        await using MemoryStream package = CreatePackage(manifest, new Dictionary<string, byte[]>
        {
            ["fonts/body-regular.woff2"] = s_fixtureFontBytes,
            ["fonts/body-medium.woff2"] = [0x77, 0x4f, 0x46, 0x32, 0x02],
            ["license/LICENSE.txt"] = Encoding.UTF8.GetBytes("fixture license"),
            ["license/source.json"] = Encoding.UTF8.GetBytes(s_fixtureSourceJson)
        });

        FontPackageException error = await Assert.ThrowsAsync<FontPackageException>(
            () => FontPackageReader.ReadAsync(package, new Version(1, 3, 0)));

        Assert.Equal("font_budget_total_exceeded", error.Code);
    }

    [Fact]
    public async Task Registry_PersistsLifecycleAndContentAddressedAssets()
    {
        string root = CreateTempDirectory();
        try
        {
            var registry = new LocalFontRegistry(root);
            ValidatedFontPackage package = await ReadFixturePackageAsync();

            FontRegistryEntry installed = await registry.InstallAsync(package);
            FontRegistryEntry enabled = await registry.SetEnabledAsync(installed.Id, enabled: true);
            FontActivation activation = await registry.ActivateAsync(
                FontActivation.DefaultScope,
                new FontActivationSelection(
                    UiFontId: installed.Id,
                    ProseFontId: installed.Id,
                    CodeFontId: FontBuiltIns.CodeMono.Id,
                    CjkFontId: installed.Id,
                    EmojiFontId: FontBuiltIns.Emoji.Id));

            Assert.Equal(FontInstallStates.Installed, enabled.InstallState);
            Assert.True(enabled.Enabled);
            Assert.Equal(1, activation.ConfigVersion);
            FontRegistryPreview preview = await registry.PreviewAsync(installed.Id);
            FontRegistryFace face = Assert.Single(preview.Faces);
            Assert.True(File.Exists(Path.Combine(root, "assets", $"{face.ContentHash}.woff2")));

            var reloaded = new LocalFontRegistry(root);
            FontRegistrySnapshot snapshot = await reloaded.ReadAsync();
            Assert.Contains(snapshot.Fonts, entry => entry.Id == installed.Id && entry.Enabled);
            Assert.Contains(snapshot.Fonts, entry => entry.Id == FontBuiltIns.UiSans.Id && entry.BuiltIn);
            Assert.Equal(installed.Id, Assert.Single(snapshot.Activations).UiFontId);
            Assert.Contains(
                "@fontsource/fixture",
                snapshot.Fonts.Single(entry => entry.Id == installed.Id).LicenseSourceJson,
                StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task Registry_DeletingActiveFontRequiresEnabledReplacementOrFallback()
    {
        string root = CreateTempDirectory();
        try
        {
            var registry = new LocalFontRegistry(root);
            FontRegistryEntry installed = await registry.InstallAsync(await ReadFixturePackageAsync());
            await registry.SetEnabledAsync(installed.Id, enabled: true);
            await registry.ActivateAsync(
                FontActivation.DefaultScope,
                new FontActivationSelection(
                    installed.Id,
                    installed.Id,
                    FontBuiltIns.CodeMono.Id,
                    installed.Id,
                    FontBuiltIns.Emoji.Id));

            FontRegistryException missingFallback = await Assert.ThrowsAsync<FontRegistryException>(
                () => registry.DeleteAsync(installed.Id));
            Assert.Equal("active_font_replacement_required", missingFallback.Code);

            await registry.DeleteAsync(
                installed.Id,
                new FontActivationSelection(
                    FontBuiltIns.UiSans.Id,
                    FontBuiltIns.ProseSans.Id,
                    FontBuiltIns.CodeMono.Id,
                    FontBuiltIns.CjkSans.Id,
                    FontBuiltIns.Emoji.Id));

            FontRegistrySnapshot snapshot = await registry.ReadAsync();
            Assert.DoesNotContain(snapshot.Fonts, entry => entry.Id == installed.Id);
            Assert.Equal(FontBuiltIns.UiSans.Id, Assert.Single(snapshot.Activations).UiFontId);
            FontRegistryPreview fallback = await registry.PreviewAsync(FontBuiltIns.UiSans.Id);
            Assert.True(fallback.Font.BuiltIn);
            Assert.Empty(fallback.Faces);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task Registry_TamperedContentHashFailsClosedBeforePathUse()
    {
        string root = CreateTempDirectory();
        try
        {
            var registry = new LocalFontRegistry(root);
            FontRegistryEntry installed = await registry.InstallAsync(await ReadFixturePackageAsync());
            string registryPath = Path.Combine(root, "registry.json");
            string document = await File.ReadAllTextAsync(registryPath);
            document = document.Replace(
                Assert.Single(installed.Faces).ContentHash,
                "../outside",
                StringComparison.Ordinal);
            await File.WriteAllTextAsync(registryPath, document);

            FontRegistryException error = await Assert.ThrowsAsync<FontRegistryException>(
                () => new LocalFontRegistry(root).ReadAsync());

            Assert.Equal("font_registry_invalid", error.Code);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task Registry_TamperedAssetCannotBeEnabledOrActivated()
    {
        string root = CreateTempDirectory();
        try
        {
            var registry = new LocalFontRegistry(root);
            FontRegistryEntry installed = await registry.InstallAsync(await ReadFixturePackageAsync());
            string assetPath = Path.Combine(root, Assert.Single(installed.Faces).FilePath);
            await File.WriteAllBytesAsync(assetPath, [0x77, 0x4f, 0x46, 0x32, 0xff]);

            FontRegistryException error = await Assert.ThrowsAsync<FontRegistryException>(
                () => registry.SetEnabledAsync(installed.Id, enabled: true));

            Assert.Equal("font_asset_integrity_invalid", error.Code);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task LicenseEvidence_IsAtomicMachineReadableAndFailsOnTamperedAsset()
    {
        string root = CreateTempDirectory();
        try
        {
            var registry = new LocalFontRegistry(root);
            FontRegistryEntry installed = await registry.InstallAsync(await ReadFixturePackageAsync());
            FontRegistrySnapshot snapshot = await registry.ReadAsync();
            string output = Path.Combine(root, FontLicenseEvidenceWriter.RelativeReleasePath);

            FontLicenseEvidence evidence = await FontLicenseEvidenceWriter.WriteAsync(
                snapshot,
                root,
                output);

            Assert.Equal(FontLicenseEvidenceWriter.Schema, evidence.Schema);
            Assert.Equal("ok", evidence.Status);
            FontLicenseEvidenceFont font = Assert.Single(evidence.Fonts);
            Assert.Equal("OFL-1.1", font.License);
            Assert.Equal("@fontsource/fixture@1.0.0", font.Source);
            Assert.True(font.HashVerified);
            Assert.Empty(evidence.Violations);
            Assert.True(File.Exists(output));

            string assetPath = Path.Combine(root, Assert.Single(installed.Faces).FilePath);
            await File.WriteAllBytesAsync(assetPath, [0x77, 0x4f, 0x46, 0x32, 0xff]);
            FontLicenseEvidence blocked = await FontLicenseEvidenceWriter.CreateAsync(
                snapshot,
                root);

            Assert.Equal("blocked", blocked.Status);
            Assert.Contains(
                blocked.Violations,
                violation => violation.Code == "font_asset_hash_mismatch"
                    && violation.FontId == installed.Id);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void RuntimeServices_RegisterFontRegistryAsSingleton()
    {
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-font-runtime-{Guid.NewGuid():N}");
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["FSUSBLOG_DATA_ROOT"] = root
            })
            .Build();
        var services = new ServiceCollection();

        services.AddFsusRuntimeServices(configuration);

        ServiceDescriptor descriptor = Assert.Single(
            services,
            item => item.ServiceType == typeof(IFontRegistry));
        Assert.Equal(ServiceLifetime.Singleton, descriptor.Lifetime);
        using ServiceProvider provider = services.BuildServiceProvider();
        IFontRegistry first = provider.GetRequiredService<IFontRegistry>();
        IFontRegistry second = provider.GetRequiredService<IFontRegistry>();
        Assert.IsType<LocalFontRegistry>(first);
        Assert.Same(first, second);
    }

    private static async Task<ValidatedFontPackage> ReadFixturePackageAsync()
    {
        await using MemoryStream package = CreatePackage(CreateManifest(), FixtureFiles());
        return await FontPackageReader.ReadAsync(package, new Version(1, 3, 0));
    }

    private static Dictionary<string, byte[]> FixtureFiles()
        => new()
        {
            ["fonts/body-regular.woff2"] = s_fixtureFontBytes,
            ["license/LICENSE.txt"] = Encoding.UTF8.GetBytes("fixture license"),
            ["license/source.json"] = Encoding.UTF8.GetBytes(s_fixtureSourceJson)
        };

    private static FontManifest CreateManifest()
        => new(
            Id: "fsusblog.font.fixture",
            Name: "Fixture Sans",
            Version: "1.0.0",
            FsusBlog: ">=1.3.0 <1.4.0",
            Type: "font",
            Family: "Fixture Sans",
            Category: FontCategories.UiSans,
            Scripts: ["latin"],
            Locales: ["en-US"],
            Faces:
            [
                new FontFaceDescriptor(
                    Weight: 400,
                    Style: FontFaceStyles.Normal,
                    File: "fonts/body-regular.woff2",
                    ContentHash: Sha256(s_fixtureFontBytes),
                    UnicodeRange: "U+0000-00FF",
                    Critical: true)
            ],
            License: new FontLicenseDescriptor(
                "OFL-1.1",
                "license/LICENSE.txt",
                "license/source.json"),
            Source: s_fixtureSource,
            Budgets: new FontBudgetDescriptor(
                CriticalBytes: 220_000,
                TotalBytes: 1_200_000,
                MaxFaces: 6),
            Loading: new FontLoadingDescriptor(
                Display: FontDisplayModes.Swap,
                Preload: ["400"],
                Defer: []));

    private static MemoryStream CreatePackage(
        FontManifest manifest,
        IReadOnlyDictionary<string, byte[]> files)
    {
        var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            archive.CreateEntry("fonts/");
            archive.CreateEntry("license/");
            WriteEntry(archive, "manifest.json", JsonSerializer.SerializeToUtf8Bytes(manifest, s_jsonOptions));
            foreach ((string path, byte[] content) in files)
            {
                WriteEntry(archive, path, content);
            }
        }

        stream.Position = 0;
        return stream;
    }

    private static void WriteEntry(ZipArchive archive, string path, byte[] content)
    {
        ZipArchiveEntry entry = archive.CreateEntry(path, CompressionLevel.NoCompression);
        using Stream destination = entry.Open();
        destination.Write(content);
    }

    private static string Sha256(ReadOnlySpan<byte> content)
        => Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(content));

    private static string CreateTempDirectory()
    {
        string path = Path.Combine(Path.GetTempPath(), $"fsusblog-font-registry-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        return path;
    }
}
