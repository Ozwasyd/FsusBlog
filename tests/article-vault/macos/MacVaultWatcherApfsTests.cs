using System.Runtime.Versioning;
using System.Text;

using FsusBlog.ArticleVault.MacOS;
using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.MacOS.Tests;

// These tests fail on a non-macOS/non-APFS host; the native category has no skip or fake receipt.
[SupportedOSPlatform("macos")]
[Trait("Category", "MacArticleVaultWatcher")]
public sealed class MacVaultWatcherApfsTests
{
    [Fact]
    public async Task RealCreateModifyRemoveRetainFlagsAndOneRootBinding()
    {
        using var fixture = new ApfsFixture("article.md");
        using MacVaultWatcherSession session = fixture.Open();
        Assert.Equal("apfs", session.Identity.Filesystem.FileSystem);
        MacVaultRawFact restart = Assert.Single(session.Drain());
        Assert.Equal(MacVaultFactClass.WatcherRestarted, restart.FactClass);
        Assert.False(session.Watermark.IsValid);
        string source = fixture.PathFor("article.md");
        await File.WriteAllTextAsync(source, "first source\r\n", Encoding.UTF8);
        await RequireNative(session, "article.md", 0x100);
        await File.AppendAllTextAsync(source, "second source\n", Encoding.UTF8);
        await RequireNative(session, "article.md", 0x1000);
        File.Delete(source);
        MacVaultRawFact remove = await RequireNative(session, "article.md", 0x200);
        Assert.Equal("article.md", remove.RawOldRelativePath);
        Assert.Null(remove.RawNewRelativePath);
        Assert.True(remove.RescanRequired);
        Assert.False(remove.WatermarkValid);
    }

    [Fact]
    public async Task RealRenameRetainsObservedSpellingWithoutSynthesizingPair()
    {
        using var fixture = new ApfsFixture("article.md", "moved.md");
        await File.WriteAllTextAsync(fixture.PathFor("article.md"), "rename source\n");
        using MacVaultWatcherSession session = fixture.Open();
        session.Drain();
        File.Move(fixture.PathFor("article.md"), fixture.PathFor("moved.md"));
        MacVaultRawFact rename = await RequireNative(session, "moved.md", 0x800);
        Assert.Null(rename.RawOldRelativePath);
        Assert.Null(rename.RawNewRelativePath);
        Assert.Equal("moved.md", rename.RawObservedRelativePath);
    }

    [Fact]
    public async Task RealTempSaveAtomicReplacePreservesRawFlagsAndUnknownTempFailure()
    {
        using var fixture = new ApfsFixture("article.md");
        string source = fixture.PathFor("article.md");
        await File.WriteAllTextAsync(source, "old source\n");
        using MacVaultWatcherSession session = fixture.Open();
        session.Drain();
        string temporary = fixture.PathFor("editor-save.tmp");
        await File.WriteAllTextAsync(temporary, "replacement source\r\n");
        await RequireFact(session, static fact => fact.FactClass == MacVaultFactClass.BlockedPath
            && fact.RawObservedRelativePath == "editor-save.tmp");
        File.Move(temporary, source, overwrite: true);
        MacVaultRawFact replaced = await RequireFact(session, static fact => fact.RawObservedRelativePath == "article.md"
            && fact.FactClass == MacVaultFactClass.NativeEvent && (fact.NativeFlags & (0x100u | 0x800u | 0x1000u)) != 0);
        Assert.True(replaced.RescanRequired);
        Assert.False(session.Watermark.IsValid);
        Assert.Equal("replacement source\r\n", await File.ReadAllTextAsync(source));
    }

    [Fact]
    public async Task RealTruncatePartialWriteNeverReadsOrAdmitsEmptyBody()
    {
        using var fixture = new ApfsFixture("article.md");
        string source = fixture.PathFor("article.md");
        await File.WriteAllTextAsync(source, "original body\n");
        using MacVaultWatcherSession session = fixture.Open();
        session.Drain();
        using (var writer = new FileStream(source, FileMode.Open, FileAccess.Write, FileShare.ReadWrite))
        {
            writer.SetLength(0);
            writer.Flush(flushToDisk: true);
            await RequireNative(session, "article.md", 0x1000);
            Assert.False(session.Watermark.IsValid);
            await writer.WriteAsync("half"u8.ToArray());
            writer.Flush(flushToDisk: true);
            await RequireNative(session, "article.md", 0x1000);
            await writer.WriteAsync("-complete\r\n"u8.ToArray());
            writer.Flush(flushToDisk: true);
        }

        Assert.Equal("half-complete\r\n", await File.ReadAllTextAsync(source));
        Assert.False(session.Watermark.IsValid);
    }

    [Fact]
    public async Task RealSymlinkEscapeIsBlockedAndDoesNotReadTarget()
    {
        using var fixture = new ApfsFixture("article.md");
        string target = fixture.PathFor("unregistered-private.md");
        await File.WriteAllTextAsync(target, "private sentinel body");
        using MacVaultWatcherSession session = fixture.Open();
        session.Drain();
        File.CreateSymbolicLink(fixture.PathFor("article.md"), target);
        MacVaultRawFact fact = await RequireFact(session, static fact => fact.FactClass == MacVaultFactClass.BlockedPath
            && fact.RawObservedRelativePath == "article.md");
        Assert.Equal("mac_vault_path_blocked", fact.ErrorCode);
        Assert.Null(fact.FileIdDiagnostic);
        Assert.Equal("private sentinel body", await File.ReadAllTextAsync(target));
    }

    [Fact]
    public async Task RealPermissionLossAndControlTamperRequireRescan()
    {
        using var fixture = new ApfsFixture("article.md");
        string source = fixture.PathFor("article.md");
        await File.WriteAllTextAsync(source, "source stays unchanged");
        using MacVaultWatcherSession session = fixture.Open();
        session.Drain();
        File.SetUnixFileMode(source, UnixFileMode.None);
        await RequireFact(session, static fact => fact.ErrorCode == "mac_vault_permission_blocked");
        File.SetUnixFileMode(source, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        await File.WriteAllTextAsync(fixture.PathFor(".fsus/vault.json"), "{}");
        await RequireFact(session, static fact => fact.ErrorCode == "mac_vault_control_manifest_invalid");
        Assert.False(session.Watermark.IsValid);
    }

    [Fact]
    public async Task RealRootMoveAndRestartInvalidateInstanceAndReleaseResources()
    {
        using var fixture = new ApfsFixture("article.md");
        MacVaultWatchIdentity first;
        using (MacVaultWatcherSession session = fixture.Open())
        {
            first = session.Identity;
            session.Drain();
            string movedRoot = fixture.Root + "-moved";
            Directory.Move(fixture.Root, movedRoot);
            fixture.CurrentRoot = movedRoot;
            await RequireFact(session, static fact => (fact.NativeFlags & 0x20u) != 0
                && fact.RescanRequired && !fact.WatermarkValid);
        }

        Directory.Move(fixture.CurrentRoot, fixture.Root);
        fixture.CurrentRoot = fixture.Root;
        using MacVaultWatcherSession restarted = fixture.Open();
        Assert.NotEqual(first.WatchInstanceIdentity, restarted.Identity.WatchInstanceIdentity);
        Assert.Equal(first.RootIdentitySha256, restarted.Identity.RootIdentitySha256);
        Assert.False(restarted.Watermark.IsValid);
        Assert.Equal(MacVaultFactClass.WatcherRestarted, Assert.Single(restarted.Drain()).FactClass);
        restarted.Dispose();
        restarted.Dispose();
        Assert.Throws<ObjectDisposedException>(() => restarted.Drain());
    }

    [Fact]
    public void RealApfsUnicodeAndCaseManifestCollisionsFailBeforeStream()
    {
        using var unicode = new ApfsFixture("caf\u00e9.md", "cafe\u0301.md");
        MacVaultWatcherException normalization = Assert.Throws<MacVaultWatcherException>(() => unicode.Open());
        Assert.Equal("mac_vault_projection_collision", normalization.ReasonCode);
        using var casing = new ApfsFixture("Article.md", "article.md");
        // The APFS host's actual volume capability controls which comparison policy applies.
        using var probe = new ApfsFixture("probe.md");
        using MacVaultWatcherSession admitted = probe.Open();
        if (admitted.Identity.Filesystem.CaseSensitive)
        {
            using MacVaultWatcherSession distinct = casing.Open();
            Assert.True(distinct.Identity.Filesystem.CaseSensitive);
        }
        else
        {
            MacVaultWatcherException collision = Assert.Throws<MacVaultWatcherException>(() => casing.Open());
            Assert.Equal("mac_vault_projection_collision", collision.ReasonCode);
        }
    }

    [Fact]
    public async Task RealDeliveryOverflowPreservesFailureAndInvalidWatermark()
    {
        string[] projections = Enumerable.Range(0, 32).Select(static index => $"article-{index:D2}.md").ToArray();
        using var fixture = new ApfsFixture(projections);
        using MacVaultWatcherSession session = fixture.Open(new(8, 8));
        foreach (string projection in projections)
        {
            await File.WriteAllTextAsync(fixture.PathFor(projection), "queue burst\n");
        }

        await Task.Delay(1500);
        IReadOnlyList<MacVaultRawFact> facts = session.Drain();
        Assert.InRange(facts.Count, 1, 9);
        Assert.Contains(facts, static fact => fact.FactClass == MacVaultFactClass.DeliveryOverflow);
        Assert.All(facts, fact => Assert.True(MacVaultRawFactCodec.Validate(fact, session.Identity)));
        Assert.False(session.Watermark.IsValid);
    }

    private static Task<MacVaultRawFact> RequireNative(MacVaultWatcherSession session, string relative, uint flags)
        => RequireFact(session, fact => fact.FactClass == MacVaultFactClass.NativeEvent
            && fact.RawObservedRelativePath == relative && (fact.NativeFlags & flags) != 0);

    private static async Task<MacVaultRawFact> RequireFact(MacVaultWatcherSession session, Func<MacVaultRawFact, bool> predicate)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < deadline)
        {
            foreach (MacVaultRawFact fact in session.Drain())
            {
                Assert.True(MacVaultRawFactCodec.Validate(fact, session.Identity));
                Assert.True(fact.RescanRequired);
                Assert.False(fact.WatermarkValid);
                if (predicate(fact))
                {
                    return fact;
                }
            }

            // Wait for native callback delivery; this does not inspect filesystem state.
            await Task.Delay(30);
        }

        throw new Xunit.Sdk.XunitException("Required native APFS fact was not delivered.");
    }

    private sealed class ApfsFixture : IDisposable
    {
        private readonly ArticleVaultRootManifest _manifest;

        internal ApfsFixture(params string[] projections)
        {
            Assert.True(OperatingSystem.IsMacOS(), "Real macOS/APFS is required; platform skips are forbidden.");
            Root = Path.Combine(AppContext.BaseDirectory, "macos-apfs-" + Guid.NewGuid().ToString("N"));
            CurrentRoot = Root;
            Directory.CreateDirectory(PathFor(".fsus"));
            File.SetUnixFileMode(PathFor(".fsus"), UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            VaultArticleReference[] articles = projections.Select((path, index) => new VaultArticleReference(
                $"portable-{index:D3}", $".fsus/articles/portable-{index:D3}.json", new string('a', 64), path)).ToArray();
            var unsealed = new ArticleVaultRootManifest(ArticleVaultSchemas.RootManifest, 1, ArticleVaultSchemas.ControlTreeVersion,
                new(".fsus/vault.json", ".fsus/articles", ".fsus/receipts"), "site-a", "vault-a", "device-a", articles, [], string.Empty);
            _manifest = unsealed with
            {
                ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsealed)
            };
            File.WriteAllBytes(PathFor(".fsus/vault.json"), ArticleVaultManifestCodec.Serialize(_manifest));
            File.SetUnixFileMode(PathFor(".fsus/vault.json"), UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }

        internal string Root
        {
            get;
        }
        internal string CurrentRoot
        {
            get; set;
        }
        internal string PathFor(string relative) => Path.Combine(CurrentRoot, relative);
        internal MacVaultWatcherSession Open(MacVaultWatcherOptions? options = null)
            => MacVaultWatcherSession.Open(new(Root, _manifest, "agent-a", options ?? new()));

        public void Dispose() => Directory.Delete(CurrentRoot, recursive: true);
    }
}
