using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;

using FsusBlog.ArticleVault.Linux;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

[Trait("Category", "LinuxArticleVaultWatcher")]
public sealed class LinuxVaultRawFactContractTests
{
    [Fact]
    public void Session_BindsManifestIdentityAndStartsWithInvalidWatermark()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using LinuxVaultWatcherSession session = root.Open();

        LinuxVaultRawFact fact = Assert.Single(session.ReadAvailable(), item => item.FactClass == LinuxVaultFactClass.WatcherRestarted);

        Assert.Equal(root.Manifest.SiteIdentity, fact.SiteIdentity);
        Assert.Equal(root.Manifest.VaultIdentity, fact.VaultIdentity);
        Assert.Equal(root.Manifest.DeviceIdentity, fact.DeviceIdentity);
        Assert.Equal(root.Manifest.ContentSha256, fact.RootManifestSha256);
        Assert.True(fact.RescanRequired);
        Assert.False(fact.WatermarkValid);
        Assert.True(LinuxVaultRawFactCodec.Validate(fact));
        Assert.False(session.Watermark.IsValid);

        LinuxVaultWatermark acknowledged = session.AcknowledgeRescan(LinuxVaultTestRoot.DigestA);
        Assert.True(acknowledged.IsValid);
        Assert.Equal(LinuxVaultTestRoot.DigestA, acknowledged.RescanReceiptSha256);
    }

    [Fact]
    public void RawFactDigest_RejectsTampering()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using LinuxVaultWatcherSession session = root.Open();
        LinuxVaultRawFact fact = session.ReadAvailable().Single(item => item.FactClass == LinuxVaultFactClass.WatcherRestarted);

        Assert.True(LinuxVaultRawFactCodec.Validate(fact));
        Assert.False(LinuxVaultRawFactCodec.Validate(fact with
        {
            AgentIdentity = "tampered-agent"
        }));
        Assert.False(LinuxVaultRawFactCodec.Validate(fact with
        {
            RawNewRelativePath = "private-body.md"
        }));

        Assert.False(LinuxVaultRawFactCodec.Validate(Reseal(fact with
        {
            FactClass = (LinuxVaultFactClass)int.MaxValue
        })));
        Assert.False(LinuxVaultRawFactCodec.Validate(Reseal(fact with
        {
            PathDisposition = (LinuxVaultPathDisposition)int.MaxValue
        })));
        Assert.False(LinuxVaultRawFactCodec.Validate(Reseal(fact with
        {
            WatermarkValid = true
        })));
        Assert.False(LinuxVaultRawFactCodec.Validate(Reseal(fact with
        {
            RescanRequired = false,
            ErrorCode = null,
            PathDisposition = LinuxVaultPathDisposition.Blocked
        })));
        Assert.False(LinuxVaultRawFactCodec.Validate(Reseal(fact with
        {
            FactClass = LinuxVaultFactClass.MovedFrom,
            RawNewRelativePath = "article.md",
            PathDisposition = LinuxVaultPathDisposition.Source,
            ErrorCode = null,
            RescanRequired = false
        })));
        Assert.False(LinuxVaultRawFactCodec.Validate(Reseal(fact with
        {
            FactClass = LinuxVaultFactClass.MovedTo,
            RawOldRelativePath = "article.md",
            PathDisposition = LinuxVaultPathDisposition.MissingEntry,
            ErrorCode = null,
            RescanRequired = false
        })));
        Assert.False(LinuxVaultRawFactCodec.Validate(Reseal(fact with
        {
            FactClass = LinuxVaultFactClass.Modified,
            RawOldRelativePath = "article.md",
            PathDisposition = LinuxVaultPathDisposition.Source,
            ErrorCode = null,
            RescanRequired = false
        })));
        Assert.False(LinuxVaultRawFactCodec.Validate(Reseal(fact with
        {
            FactClass = LinuxVaultFactClass.Modified,
            CookieDiagnostic = 42,
            RawNewRelativePath = "article.md",
            PathDisposition = LinuxVaultPathDisposition.Source,
            ErrorCode = null,
            RescanRequired = false
        })));

        _ = session.AcknowledgeRescan(LinuxVaultTestRoot.DigestA);
        var convertRecord = typeof(LinuxVaultWatcherSession).GetMethod(
            "ConvertRecord",
            BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("raw conversion entrypoint is missing");
        var unbound = (LinuxVaultRawFact?)convertRecord.Invoke(
            session,
            [int.MaxValue, 0x00000100u, 73u, "forged-root-source.md"]);
        Assert.NotNull(unbound);
        Assert.Equal(LinuxVaultFactClass.Unknown, unbound.FactClass);
        Assert.Equal(LinuxVaultPathDisposition.Blocked, unbound.PathDisposition);
        Assert.Equal("linux_vault_watch_descriptor_unknown", unbound.ErrorCode);
        Assert.Null(unbound.RawOldRelativePath);
        Assert.Null(unbound.RawNewRelativePath);
        Assert.Null(unbound.CookieDiagnostic);
        Assert.True(unbound.RescanRequired);
        Assert.False(unbound.WatermarkValid);
        Assert.Equal("linux_vault_watch_descriptor_unknown", session.Watermark.InvalidatedReasonCode);
        Assert.True(LinuxVaultRawFactCodec.Validate(unbound));
        Assert.False(LinuxVaultRawFactCodec.Validate(Reseal(unbound with
        {
            RawNewRelativePath = "forged-root-source.md",
            PathDisposition = LinuxVaultPathDisposition.Source,
            ErrorCode = null,
            RescanRequired = false
        })));

        _ = session.AcknowledgeRescan(LinuxVaultTestRoot.DigestA);
        var overflow = (LinuxVaultRawFact?)convertRecord.Invoke(
            session,
            [int.MaxValue, 0x00004000u, 91u, "ignored-overflow-name.md"]);
        Assert.NotNull(overflow);
        Assert.Equal(LinuxVaultFactClass.QueueOverflow, overflow.FactClass);
        Assert.Equal("linux_vault_inotify_queue_overflow", overflow.ErrorCode);
        Assert.Null(overflow.RawOldRelativePath);
        Assert.Null(overflow.RawNewRelativePath);
        Assert.Null(overflow.CookieDiagnostic);
        Assert.Equal(LinuxVaultPathDisposition.None, overflow.PathDisposition);
        Assert.True(overflow.RescanRequired);
        Assert.False(overflow.WatermarkValid);
        Assert.Equal("linux_vault_inotify_queue_overflow", session.Watermark.InvalidatedReasonCode);
        Assert.True(LinuxVaultRawFactCodec.Validate(overflow));
        Assert.False(LinuxVaultRawFactCodec.Validate(Reseal(overflow with
        {
            RawNewRelativePath = "ignored-overflow-name.md",
            PathDisposition = LinuxVaultPathDisposition.Source
        })));
    }

    [Fact]
    public void InventoryAndProductionSurface_ExcludeNormalizationMaterializationWritersAndBodyReads()
    {
        string repository = LinuxVaultTestRoot.FindRepositoryRoot();
        string sourceRoot = Path.Combine(repository, "src", "article-vault", "linux");
        string[] productionSources = Directory.EnumerateFiles(sourceRoot, "*.cs")
            .Select(path => Path.GetRelativePath(repository, path).Replace('\\', '/'))
            .Order(StringComparer.Ordinal)
            .ToArray();
        string source = string.Join('\n', productionSources
            .Select(path => File.ReadAllText(Path.Combine(repository, path)))
            .Order(StringComparer.Ordinal)
            .ToArray());

        Assert.DoesNotContain("ArticleVaultSyncPlanner", source, StringComparison.Ordinal);
        Assert.DoesNotContain("IArticleCoreService", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ArticleService", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Materialization", source, StringComparison.Ordinal);
        Assert.DoesNotContain("File.ReadAllText", source, StringComparison.Ordinal);
        Assert.DoesNotContain("File.WriteAllText", source, StringComparison.Ordinal);
        Assert.DoesNotContain("File.WriteAllBytes", source, StringComparison.Ordinal);
        Assert.DoesNotContain("FileSystemWatcher", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ILogger", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Console.", source, StringComparison.Ordinal);

        string inventoryDirectory = Path.Combine(repository, "artifacts", "article-vault");
        string inventoryPath = Assert.Single(Directory.EnumerateFiles(
            inventoryDirectory,
            "linux-watcher-package-inventory.json",
            SearchOption.TopDirectoryOnly));
        using JsonDocument inventory = JsonDocument.Parse(File.ReadAllBytes(inventoryPath));
        JsonElement root = inventory.RootElement;
        Assert.Equal("LinuxArticleVaultWatcherAgent", root.GetProperty("owner").GetString());
        Assert.Equal(2672, root.GetProperty("issue").GetInt32());
        Assert.Equal("7e0a5784314183e1f06989afb12d0e554dcb494c", root.GetProperty("baseCommit").GetString());
        Assert.Equal(productionSources, Strings(root.GetProperty("package").GetProperty("productionSources")));

        string[] publicSymbols = typeof(LinuxVaultWatcherSession).Assembly.GetExportedTypes()
            .Select(static type => type.FullName!)
            .Order(StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(
            Strings(root.GetProperty("publicSymbols")).Order(StringComparer.Ordinal).ToArray(),
            publicSymbols);

        Type native = typeof(LinuxVaultWatcherSession).Assembly.GetType(
            "FsusBlog.ArticleVault.Linux.InotifyNative",
            throwOnError: true)!;
        string[] entryPoints = native.GetMethods(BindingFlags.Static | BindingFlags.NonPublic)
            .Select(static method => method.GetCustomAttribute<LibraryImportAttribute>()?.EntryPoint)
            .Where(static entryPoint => entryPoint is not null)
            .Select(static entryPoint => entryPoint!)
            .Order(StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(
            Strings(root.GetProperty("nativeBoundary").GetProperty("entryPoints")).Order(StringComparer.Ordinal).ToArray(),
            entryPoints);

        string[] testSources = Directory.EnumerateFiles(
                Path.Combine(repository, "tests", "article-vault", "linux"),
                "*.cs")
            .Select(path => Path.GetRelativePath(repository, path).Replace('\\', '/'))
            .Order(StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(
            Strings(root.GetProperty("tests").GetProperty("sources")).Order(StringComparer.Ordinal).ToArray(),
            testSources);

        string[] sessionOperations = typeof(LinuxVaultWatcherSession)
            .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly)
            .Where(static method => !method.IsSpecialName)
            .Select(static method => method.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(["AcknowledgeRescan", "Dispose", "Open", "ReadAvailable"], sessionOperations);
    }

    private static string[] Strings(JsonElement array)
        => array.EnumerateArray().Select(static item => item.GetString()!).Order(StringComparer.Ordinal).ToArray();

    private static LinuxVaultRawFact Reseal(LinuxVaultRawFact fact)
        => LinuxVaultRawFactCodec.Seal(fact with
        {
            ContentSha256 = string.Empty
        });
}
