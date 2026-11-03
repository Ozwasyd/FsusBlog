using System.Runtime.CompilerServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;

using Xunit;

namespace FsusBlog.Migration.Tests;

[SupportedOSPlatform("linux")]
public sealed class ArticleMediaInventoryTests
{
    private static readonly Uri s_origin = new("https://legacy.example/");
    private static readonly Uri s_document = new("https://legacy.example/articles/7");
    private static readonly ArticleMediaLimits s_limits = new(10, 100, 100, 1_000_000,
        4096, 1_000_000, 8_000_000, 32_000_000);
    private const string Prefix = "/uploads/illustration/";

    [Fact]
    public async Task Inventory_PreservesCoverMarkdownReferencesAndRawBytes()
    {
        using var fixture = new MediaFixture();
        byte[] bytes = [0, 255, 13, 10, 239, 187, 191];
        fixture.Write("nested/cover.PNG", bytes);
        fixture.Write("attachment.bin", [7, 8]);
        const string Markdown = "\ufeff![body](/uploads/illustration/nested/cover.PNG)\r\n"
            + "[download](/uploads/illustration/attachment.bin)  \n";
        var source = new ArticleMediaSource(7, Prefix + "nested/cover.PNG", Markdown, s_document);

        ArticleMediaInventory inventory = await Inventory(fixture, source);

        Assert.Equal(2, inventory.Files.Length);
        ArticleMediaFile image = inventory.Files.Single(static file => file.RelativePath == "nested/cover.PNG");
        Assert.Equal(bytes.Length, image.Bytes);
        Assert.Equal(Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), image.Sha256);
        Assert.Equal(".PNG", image.Extension);
        Assert.StartsWith("linux:", image.SourceFileIdentity);
        Assert.Contains(image.Aliases, static alias => alias.Kind == ArticleMediaReferenceKind.Cover && alias.Offset == -1);
        Assert.Contains(image.Aliases, static alias => alias.Kind == ArticleMediaReferenceKind.Image && alias.SourceLength > 0);
        Assert.Equal(bytes, File.ReadAllBytes(Path.Combine(fixture.Source, "nested/cover.PNG")));
        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.Target));
        await ArticleMediaPreservation.VerifyInventoryAsync(inventory, Documents([source]),
            fixture.Source, s_origin, Prefix, s_limits, default);
    }

    [Fact]
    public async Task Inventory_BindsAcceptedHtmlAttributesToUnchangedSourceSpans()
    {
        using var fixture = new MediaFixture();
        fixture.Write("a&b.bin", [1]);
        fixture.Write("poster.bin", [2]);
        fixture.Write("small.bin", [3]);
        fixture.Write("large.bin", [4]);
        const string Markdown = "你好😀\r\n\r\n<div>\r\n<IMG\r\n SRC = \"/uploads/illustration/a&amp;b.bin\" src='/ignored.bin'>\r\n"
            + "<video src='/uploads/illustration/a&amp;b.bin' poster=/uploads/illustration/poster.bin></video>\r\n"
            + "<source srcset='/uploads/illustration/small.bin 1x, /uploads/illustration/large.bin 2x'>\r\n</div>\r\n";
        ArticleMediaInventory inventory = await Inventory(fixture, Source(1, Markdown));

        ArticleMediaAlias[] imageAliases = inventory.Files.Single(static file => file.RelativePath == "a&b.bin").Aliases.ToArray();
        Assert.Equal(2, imageAliases.Length);
        foreach (ArticleMediaAlias alias in imageAliases)
        {
            Assert.Equal("/uploads/illustration/a&amp;b.bin", Markdown.Substring(alias.Offset, alias.SourceLength));
            Assert.Equal("/uploads/illustration/a&b.bin", alias.Url);
        }
        ArticleMediaAlias poster = Assert.Single(inventory.Files.Single(static file => file.RelativePath == "poster.bin").Aliases);
        Assert.Equal("/uploads/illustration/poster.bin", Markdown.Substring(poster.Offset, poster.SourceLength));
        foreach (ArticleMediaFile file in inventory.Files.Where(static file => file.RelativePath is "small.bin" or "large.bin"))
        {
            ArticleMediaAlias alias = Assert.Single(file.Aliases);
            Assert.Equal("/uploads/illustration/small.bin 1x, /uploads/illustration/large.bin 2x",
                Markdown.Substring(alias.Offset, alias.SourceLength));
        }
        await ArticleMediaPreservation.VerifyInventoryAsync(inventory, Documents([Source(1, Markdown)]),
            fixture.Source, s_origin, Prefix, s_limits, default);
    }

    [Theory]
    [InlineData("before <img src=\"/uploads/illustration/file.bin\"> after")]
    [InlineData("before <img SRC='/uploads/illustration/file.bin'> after")]
    [InlineData("before <img src=/uploads/illustration/file.bin> after")]
    [InlineData("> <div>\r\n> <img src='/uploads/illustration/file.bin'>\r\n> </div>")]
    public async Task Inventory_HtmlSourceRangeUsesOriginalMarkdown(string markdown)
    {
        using var fixture = new MediaFixture();
        fixture.Write("file.bin", [1]);
        ArticleMediaInventory inventory = await Inventory(fixture, Source(1, markdown));
        ArticleMediaAlias alias = Assert.Single(Assert.Single(inventory.Files).Aliases);
        Assert.Equal("/uploads/illustration/file.bin", markdown.Substring(alias.Offset, alias.SourceLength));
    }

    [Fact]
    public async Task Inventory_RetainsEveryAliasWithoutFilenameOrHashIdentityMerging()
    {
        using var fixture = new MediaFixture();
        fixture.Write("a/same.bin", [1, 2, 3]);
        fixture.Write("b/same.bin", [1, 2, 3]);
        ArticleMediaInventory inventory = await Inventory(fixture,
            Source(1, "![a](/uploads/illustration/a/same.bin) ![again](/uploads/illustration/a/same.bin)"),
            Source(2, "![b](/uploads/illustration/b/same.bin) ![shared](/uploads/illustration/a/same.bin)"));

        Assert.Equal(2, inventory.Files.Length);
        Assert.Equal(inventory.Files[0].Sha256, inventory.Files[1].Sha256);
        Assert.Equal(3, inventory.Files[0].Aliases.Length);
        Assert.Equal(new long[] { 1, 1, 2 }, inventory.Files[0].Aliases.Select(static alias => alias.ArticleId));
        Assert.NotEqual(inventory.Files[0].SourceFileIdentity, inventory.Files[1].SourceFileIdentity);
    }

    [Fact]
    public async Task Inventory_RecordsExternalReferencesWithoutFetchingOrRewritingThem()
    {
        using var fixture = new MediaFixture();
        ArticleMediaSource source = Source(1, "![http](https://unreachable.invalid/x.png) "
            + "![data](data:image/png;base64,AQID) ![blob](blob:https://legacy.example/123) "
            + "[external](mailto:a@example.invalid) [navigation](/articles/4)");
        ArticleMediaInventory inventory = await Inventory(fixture, source);

        Assert.Empty(inventory.Files);
        Assert.Equal(new[] { ArticleMediaUrlDisposition.RemoteHttp, ArticleMediaUrlDisposition.Data,
            ArticleMediaUrlDisposition.Blob, ArticleMediaUrlDisposition.External, ArticleMediaUrlDisposition.Navigation },
            inventory.NonLocalReferences.Select(static alias => alias.Disposition));
        Assert.Equal(0, inventory.TotalBytes);
        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.Source));
        await ArticleMediaPreservation.VerifyInventoryAsync(inventory, Documents([source]),
            fixture.Source, s_origin, Prefix, s_limits, default);
    }

    [Theory]
    [InlineData("/uploads/illustration/../outside.bin")]
    [InlineData("/uploads/illustration/%2e%2e/outside.bin")]
    [InlineData("/uploads/illustration/%252e%252e/outside.bin")]
    [InlineData("/uploads/illustration/a%2fb.bin")]
    [InlineData("/uploads/illustration/a%5cb.bin")]
    [InlineData("/uploads/illustration/./x.bin")]
    [InlineData("/uploads/illustration/a%00.bin")]
    [InlineData("/uploads/illustration/%ff.bin")]
    [InlineData("C:/outside.bin")]
    [InlineData("C:\\outside.bin")]
    [InlineData("\\\\server\\outside.bin")]
    [InlineData("//server/outside.bin")]
    [InlineData("file:///tmp/outside.bin")]
    [InlineData("/tmp/outside.bin")]
    [InlineData("https://user@legacy.example/uploads/illustration/x.bin")]
    public async Task Inventory_RejectsUnsafeLocalPathsBeforeAnyCopy(string url)
    {
        using var fixture = new MediaFixture();
        await Assert.ThrowsAsync<ArticleMediaException>(() => Inventory(fixture,
            new ArticleMediaSource(1, url, string.Empty, s_document)));
        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.Target));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("directory")]
    [InlineData("symlink-file")]
    [InlineData("symlink-parent")]
    [InlineData("unreadable")]
    public async Task Inventory_RejectsUnavailableAndNonRegularSources(string change)
    {
        using var fixture = new MediaFixture();
        string path = "file.bin";
        switch (change)
        {
            case "directory":
                Directory.CreateDirectory(Path.Combine(fixture.Source, path));
                break;
            case "symlink-file":
                File.WriteAllBytes(Path.Combine(fixture.Root, "outside.bin"), [1]);
                File.CreateSymbolicLink(Path.Combine(fixture.Source, path), Path.Combine(fixture.Root, "outside.bin"));
                break;
            case "symlink-parent":
                Directory.CreateSymbolicLink(Path.Combine(fixture.Source, "escape"), fixture.Root);
                path = "escape/outside.bin";
                break;
            case "unreadable":
                fixture.Write(path, [1]);
                File.SetUnixFileMode(Path.Combine(fixture.Source, path), UnixFileMode.None);
                break;
        }
        await Assert.ThrowsAsync<ArticleMediaException>(() => Inventory(fixture, Source(1, $"![x]({Prefix}{path})")));
    }

    [Theory]
    [InlineData("A.bin", "a.bin")]
    [InlineData("caf\u00e9.bin", "cafe\u0301.bin")]
    [InlineData("A/x.bin", "a/y.bin")]
    [InlineData("file", "file/child")]
    public async Task Inventory_RejectsCaseUnicodeAndDirectoryFileCollisions(string first, string second)
    {
        using var fixture = new MediaFixture();
        // Collision admission precedes opening either path; no arbitrary file wins.
        ArticleMediaException failure = await Assert.ThrowsAsync<ArticleMediaException>(() => Inventory(fixture,
            Source(1, $"![a]({Prefix}{first}) ![b]({Prefix}{second})")));
        Assert.Equal("media_path_collision", failure.Message);
    }

    [Fact]
    public async Task Inventory_IsIndependentOfDirectoryOrderAndModificationTime()
    {
        using var fixture = new MediaFixture();
        fixture.Write("z.bin", [9]);
        fixture.Write("a.bin", [1]);
        ArticleMediaSource source = Source(1, $"![z]({Prefix}z.bin) ![a]({Prefix}a.bin)");
        ArticleMediaInventory first = await Inventory(fixture, source);
        File.SetLastWriteTimeUtc(Path.Combine(fixture.Source, "a.bin"), DateTime.UnixEpoch);
        File.SetLastWriteTimeUtc(Path.Combine(fixture.Source, "z.bin"), DateTime.UnixEpoch.AddDays(1));
        fixture.Write("unreferenced.bin", [7]);
        ArticleMediaInventory second = await Inventory(fixture, source);

        Assert.Equal(new[] { "a.bin", "z.bin" }, first.Files.Select(static file => file.RelativePath));
        Assert.Equal(ArticlePreservationSemanticReceipt.Serialize(first), ArticlePreservationSemanticReceipt.Serialize(second));
    }

    [Theory]
    [InlineData("bytes")]
    [InlineData("same-bytes-new-inode")]
    [InlineData("markdown-newline")]
    [InlineData("alias")]
    [InlineData("omitted-file")]
    public async Task Verifier_RejectsSourceOrResealedInventoryDrift(string change)
    {
        using var fixture = new MediaFixture();
        fixture.Write("file.bin", [1, 2, 3]);
        ArticleMediaSource source = Source(1, $"![x]({Prefix}file.bin)");
        ArticleMediaInventory expected = await Inventory(fixture, source);
        switch (change)
        {
            case "bytes":
                fixture.Write("file.bin", [3, 2, 1]);
                break;
            case "same-bytes-new-inode":
                fixture.Write("replacement.bin", [1, 2, 3]);
                File.Move(Path.Combine(fixture.Source, "replacement.bin"), Path.Combine(fixture.Source, "file.bin"), overwrite: true);
                break;
            case "markdown-newline":
                source = source with
                {
                    Markdown = source.Markdown + "\n"
                };
                break;
            case "alias":
                ArticleMediaFile file = expected.Files[0];
                expected = expected with
                {
                    Files = [file with { Aliases = [file.Aliases[0] with { ArticleId = 2 }] }]
                };
                expected = expected with
                {
                    ManifestDigest = ArticleMediaPreservation.ComputeManifestDigest(expected)
                };
                break;
            case "omitted-file":
                expected = expected with
                {
                    Files = [],
                    TotalBytes = 0
                };
                expected = expected with
                {
                    ManifestDigest = ArticleMediaPreservation.ComputeManifestDigest(expected)
                };
                break;
        }
        ArticleMediaException failure = await Assert.ThrowsAsync<ArticleMediaException>(() =>
            ArticleMediaPreservation.VerifyInventoryAsync(expected, Documents([source]),
                fixture.Source, s_origin, Prefix, s_limits, default));
        Assert.Equal("inventory_source_changed", failure.Message);
    }

    [Fact]
    public async Task Inventory_BoundsStreamingBytesAndMetadataWithoutCopying()
    {
        using var fixture = new MediaFixture();
        string path = Path.Combine(fixture.Source, "large.bin");
        using (var stream = File.Create(path))
        {
            stream.SetLength(4_000_000);
        }
        ArticleMediaSource source = Source(1, $"![large]({Prefix}large.bin)");
        ArticleMediaInventory inventory = await Inventory(fixture, source);
        Assert.Equal(4_000_000, inventory.TotalBytes);
        await Assert.ThrowsAsync<ArticleMediaException>(() => ArticleMediaPreservation.InventoryAsync(
            Documents([source]), fixture.Source, s_origin, Prefix, s_limits with
            {
                FileBytes = 3_999_999
            }, default));
        await Assert.ThrowsAsync<ArticleMediaException>(() => ArticleMediaPreservation.InventoryAsync(
            Documents([source]), fixture.Source, s_origin, Prefix, s_limits with
            {
                MetadataBytes = 1
            }, default));
        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.Target));
    }

    [Fact]
    public async Task CopyPlan_FreezesExactPhysicalBindingsAndRejectsTamper()
    {
        using var fixture = new MediaFixture();
        fixture.Write("file.bin", [1, 2]);
        ArticleMediaInventory inventory = await Inventory(fixture, Source(1, $"![x]({Prefix}file.bin)"));
        using var target = ArticleMediaDirectory.Open(fixture.Target, writable: true);
        var binding = new ArticleMediaBinding(Guid.NewGuid(), new string('a', 64), new string('b', 64),
            new string('c', 64), inventory.ManifestDigest, inventory.SourceRootIdentity, target.Identity, "generation");

        ArticleMediaCopyPlan plan = ArticleMediaPreservation.CreateCopyPlan(inventory, binding, s_limits);

        Assert.Equal(0x1c0, plan.DirectoryUnixMode);
        Assert.Equal(0x180, plan.FileUnixMode);
        Assert.Equal(".media-" + binding.RunId.ToString("N") + ".tmp", plan.TemporaryDirectoryName);
        Assert.Equal(plan, ArticleMediaPreservation.CreateCopyPlan(inventory, binding, s_limits));
        Assert.Throws<ArticleMediaException>(() => ArticleMediaPreservation.ValidateCopyPlan(
            plan with
            {
                FileUnixMode = 0x1ff
            }, s_limits));
        Assert.Throws<ArticleMediaException>(() => ArticleMediaPreservation.ValidateCopyPlan(
            plan with
            {
                TemporaryDirectoryName = ".media-another-run.tmp"
            }, s_limits));
        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.Target));
    }

    private static ArticleMediaSource Source(long id, string markdown)
        => new(id, null, markdown, s_document);

    private static Task<ArticleMediaInventory> Inventory(MediaFixture fixture, params ArticleMediaSource[] source)
        => ArticleMediaPreservation.InventoryAsync(Documents(source), fixture.Source, s_origin, Prefix, s_limits, default);

    private static async IAsyncEnumerable<ArticleMediaSource> Documents(ArticleMediaSource[] source,
        [EnumeratorCancellation] CancellationToken token = default)
    {
        foreach (ArticleMediaSource article in source)
        {
            token.ThrowIfCancellationRequested();
            yield return article;
        }
        await Task.CompletedTask;
    }

    private sealed class MediaFixture : IDisposable
    {
        public MediaFixture()
        {
            Root = Path.Combine(Path.GetTempPath(), "fsusblog-media-inventory-" + Guid.NewGuid().ToString("N"));
            Source = Path.Combine(Root, "source");
            Target = Path.Combine(Root, "target");
            Directory.CreateDirectory(Source, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            Directory.CreateDirectory(Target, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        public string Root
        {
            get;
        }
        public string Source
        {
            get;
        }
        public string Target
        {
            get;
        }

        public void Write(string relative, byte[] bytes)
        {
            string path = Path.Combine(Source, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllBytes(path, bytes);
        }

        public void Dispose()
        {
            Directory.Delete(Root, recursive: true);
        }
    }
}
