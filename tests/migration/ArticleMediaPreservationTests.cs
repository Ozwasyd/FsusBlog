using System.Security.Cryptography;

using FsusBlog.Migration;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class ArticleMediaPreservationTests
{
    private static readonly Uri s_origin = new("https://blog.example/");
    private static readonly ArticleMediaLimits s_limits = new(100, 1000, 1000, 1024 * 1024, 4096,
        4 * 1024 * 1024, 16 * 1024 * 1024, 64 * 1024 * 1024);

    [Theory]
    [InlineData("![x](/uploads/a.png)", "/uploads/a.png", ArticleMediaReferenceKind.Image)]
    [InlineData("![x][picture]\n\n[picture]: /uploads/a.png \"title\"", "/uploads/a.png", ArticleMediaReferenceKind.Image)]
    [InlineData("> - **![x](/uploads/a.png)**", "/uploads/a.png", ArticleMediaReferenceKind.Image)]
    [InlineData("| image |\n| --- |\n| ![x](/uploads/a.png) |", "/uploads/a.png", ArticleMediaReferenceKind.Image)]
    [InlineData("[download](/uploads/report.pdf)", "/uploads/report.pdf", ArticleMediaReferenceKind.Attachment)]
    [InlineData("[download][file]\n\n[file]: /uploads/report.pdf", "/uploads/report.pdf", ArticleMediaReferenceKind.Attachment)]
    [InlineData("<img src='/uploads/a.png'>", "/uploads/a.png", ArticleMediaReferenceKind.Image)]
    [InlineData("<video poster='/uploads/a.png'></video>", "/uploads/a.png", ArticleMediaReferenceKind.Image)]
    [InlineData("<a href='/uploads/report.pdf'>download</a>", "/uploads/report.pdf", ArticleMediaReferenceKind.Attachment)]
    public void Parser_UsesRealAstForImagesAttachmentsAndConservativeSourceHtml(string markdown, string expectedUrl, object kind)
    {
        var references = ArticleMediaPreservation.ParseReferences(new(1, null, markdown, s_origin)).ToArray();
        Assert.Contains(references, reference => reference.Url == expectedUrl && reference.Kind == (ArticleMediaReferenceKind)kind);
    }

    [Fact]
    public void Parser_DoesNotTreatCodeOrEscapedMarkdownAsMediaAndDoesNotRewriteOriginal()
    {
        const string markdown = "`![x](/uploads/code.png)`\r\n\r\n```md\r\n![x](/uploads/fence.png)\r\n```\r\n\\![x](/uploads/escaped.png)";
        var article = new ArticleMediaSource(1, null, markdown, s_origin);
        Assert.DoesNotContain(ArticleMediaPreservation.ParseReferences(article), reference => reference.Kind == ArticleMediaReferenceKind.Image);
        Assert.Equal(markdown, article.Markdown);
    }

    [Fact]
    public void Parser_PreservesAllSourceSetCandidatesWithoutSplittingDataUrlCommas()
    {
        var references = ArticleMediaPreservation.ParseReferences(new(1, null,
            "<picture><source srcset='/uploads/Case.png 1x, /uploads/case.png 2x'><img srcset='data:image/png;base64,AAAA 1x, /uploads/other.png 2x'></picture>", s_origin)).ToArray();
        Assert.Contains(references, reference => reference.Url == "/uploads/Case.png");
        Assert.Contains(references, reference => reference.Url == "/uploads/case.png");
        Assert.Contains(references, reference => reference.Url == "/uploads/other.png");
        Assert.Contains(references, reference => reference.Url == "data:image/png;base64,AAAA");
    }

    [Theory]
    [InlineData("/uploads/Case.png", "Case.png")]
    [InlineData("/uploads/case.png", "case.png")]
    [InlineData("https://blog.example/uploads/a%20b.png?v=1#image", "a b.png")]
    [InlineData("./uploads/a.png", "a.png")]
    [InlineData("/uploads/%E5%9B%BE.png", "图.png")]
    public void Locator_PreservesCaseUnicodeAndSingleDecodedAliases(string url, string expected)
    {
        Assert.Equal(expected, ArticleMediaPreservation.ResolveLocal(url, s_origin, s_origin, "/uploads/", ArticleMediaReferenceKind.Image));
    }

    [Theory]
    [InlineData("/uploads/../secret.png")]
    [InlineData("/uploads/%2e%2e/secret.png")]
    [InlineData("/uploads/a%2fb.png")]
    [InlineData("/uploads/a%5cb.png")]
    [InlineData("/uploads/%252e%252e/secret.png")]
    [InlineData("/uploads/%ff.png")]
    [InlineData("//blog.example/uploads/a.png")]
    [InlineData("/uploads/a\\b.png")]
    public void Locator_RejectsTraversalAmbiguousEncodingAndUnsafePaths(string url)
    {
        Assert.Throws<ArticleMediaException>(() => ArticleMediaPreservation.ResolveLocal(url, s_origin, s_origin, "/uploads/", ArticleMediaReferenceKind.Image));
    }

    [Fact]
    public void Locator_IgnoresExternalMediaAndNavigationButRefusesUnmappedLocalImages()
    {
        Assert.Null(ArticleMediaPreservation.ResolveLocal("https://external.example/a.png", s_origin, s_origin, "/uploads/", ArticleMediaReferenceKind.Image));
        Assert.Null(ArticleMediaPreservation.ResolveLocal("/article/42", s_origin, s_origin, "/uploads/", ArticleMediaReferenceKind.Attachment));
        Assert.Throws<ArticleMediaException>(() => ArticleMediaPreservation.ResolveLocal("/other/a.png", s_origin, s_origin, "/uploads/", ArticleMediaReferenceKind.Image));
    }

    [Theory]
    [InlineData("https://u:p@blog.example/uploads/a.png")]
    [InlineData("https://user@blog.example/uploads/a.png")]
    [InlineData("https://u%3Ap@blog.example/uploads/a.png")]
    public void Locator_UserinfoIsRefusedRatherThanSilentlyDiscardingLocalMedia(string url)
    {
        ArticleMediaException error = Assert.Throws<ArticleMediaException>(() => ArticleMediaPreservation.ResolveLocal(
            url, s_origin, s_origin, "/uploads/", ArticleMediaReferenceKind.Image));
        Assert.Equal("unsafe_media_url_userinfo", error.Message);
    }

    [Theory]
    [InlineData("cover")]
    [InlineData("image")]
    [InlineData("attachment")]
    public async Task Inventory_UserinfoRefusesTheWholeReadsetBeforeTargetWrites(string kind)
    {
        using var fixture = new MediaFixture();
        fixture.WriteSource("a.bin", [1, 2, 3]);
        const string url = "https://u:p@blog.example/uploads/missing.bin";
        ArticleMediaSource source = kind switch
        {
            "cover" => new(1, url, "[valid](/uploads/a.bin)", s_origin),
            "image" => new(1, null, "[valid](/uploads/a.bin) ![missing](" + url + ")", s_origin),
            _ => new(1, null, "[valid](/uploads/a.bin) [missing](" + url + ")", s_origin)
        };
        ArticleMediaException error = await Assert.ThrowsAsync<ArticleMediaException>(() => Inventory(fixture, source));
        Assert.Equal("unsafe_media_url_userinfo", error.Message);
        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.Target));
    }

    [Fact]
    public async Task SourceDocumentHelperIsTheInventoryDigestAndPreservesEveryRawFieldAndOrder()
    {
        using var fixture = new MediaFixture();
        fixture.WriteSource("a.bin", [1]);
        var first = new ArticleMediaSource(1, null, "[a](/uploads/a.bin)\r\nraw", s_origin);
        var second = new ArticleMediaSource(2, "/uploads/a.bin", "unchanged", new Uri(s_origin, "article/2"));
        ArticleMediaInventory inventory = await ArticleMediaPreservation.InventoryAsync(
            Documents(), fixture.Source, s_origin, "/uploads/", s_limits, default);
        Assert.Equal(inventory.SourceDocumentsDigest, Digest(first, second));
        foreach (ArticleMediaSource changed in new[]
        {
            first with { ArticleId = 3 }, first with { Markdown = first.Markdown.Replace("\r\n", "\n", StringComparison.Ordinal) },
            first with { CoverUrl = "" }, first with { DocumentBase = new Uri(s_origin, "article/1") }
        })
        {
            Assert.NotEqual(inventory.SourceDocumentsDigest, Digest(changed, second));
        }
        Assert.NotEqual(inventory.SourceDocumentsDigest, Digest(second, first));
        ArticleMediaPreservation.ValidateInventory(inventory, s_limits);

        async IAsyncEnumerable<ArticleMediaSource> Documents()
        {
            await Task.CompletedTask;
            yield return first;
            yield return second;
        }

        static string Digest(params ArticleMediaSource[] sources)
        {
            using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            foreach (ArticleMediaSource source in sources)
            {
                ArticleMediaPreservation.AppendSourceDocument(hash, source);
            }
            return Convert.ToHexStringLower(hash.GetHashAndReset());
        }
    }

    [Fact]
    public async Task Inventory_TracksCoverCaseExactFilesDuplicateOccurrencesAndAliases()
    {
        using var fixture = new MediaFixture();
        fixture.WriteSource("Case.png", [1, 2, 3]);
        fixture.WriteSource("case.png", [4, 5, 6]);
        var inventory = await Inventory(fixture, new(1, "/uploads/Case.png",
            "![a](/uploads/Case.png) ![b](/uploads/case.png) ![again](/uploads/%43ase.png)", s_origin));
        Assert.Equal(2, inventory.Files.Length);
        Assert.Equal(3, inventory.Files.Single(file => file.RelativePath == "Case.png").Aliases.Length);
        Assert.Single(inventory.Files.Single(file => file.RelativePath == "case.png").Aliases);
        Assert.NotEqual(inventory.Files[0].Sha256, inventory.Files[1].Sha256);
        Assert.Equal(6, inventory.TotalBytes);
    }

    [Fact]
    public async Task Inventory_MissingCaseVariantRefusesBeforeAnyTargetWrites()
    {
        using var fixture = new MediaFixture();
        fixture.WriteSource("Case.png", [1]);
        var error = await Assert.ThrowsAsync<ArticleMediaException>(() => Inventory(fixture,
            new(1, null, "![a](/uploads/Case.png) ![b](/uploads/case.png)", s_origin)));
        Assert.Equal("missing_file", error.Message);
        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.Target));
    }

    [Fact]
    public async Task Inventory_RejectsSymlinkEscapeAndSymlinkedRootRatherThanFollowingIt()
    {
        using var fixture = new MediaFixture();
        var outside = Path.Combine(fixture.Root, "outside.bin");
        await File.WriteAllBytesAsync(outside, [1, 2, 3]);
        File.CreateSymbolicLink(Path.Combine(fixture.Source, "escape.bin"), outside);
        await Assert.ThrowsAsync<ArticleMediaException>(() => Inventory(fixture, new(1, null, "[file](/uploads/escape.bin)", s_origin)));
        var alias = Path.Combine(fixture.Root, "root-alias");
        Directory.CreateSymbolicLink(alias, fixture.Source);
        Assert.Throws<ArticleMediaException>(() => ArticleMediaDirectory.Open(alias, writable: false));
        Directory.Delete(alias);
        File.Delete(Path.Combine(fixture.Source, "escape.bin"));
    }

    [Theory]
    [InlineData("file")]
    [InlineData("total")]
    [InlineData("references")]
    [InlineData("markdown")]
    [InlineData("metadata")]
    public async Task Inventory_FailsClosedForFiniteOperationBudgetWithoutTruncating(string resource)
    {
        using var fixture = new MediaFixture();
        fixture.WriteSource("a.bin", [1, 2, 3]);
        var limits = resource switch
        {
            "file" => s_limits with { FileBytes = 2 },
            "total" => s_limits with { TotalBytes = 2 },
            "references" => s_limits with { References = 1 },
            "markdown" => s_limits with { MarkdownBytes = 1 },
            _ => s_limits with { MetadataBytes = 1 }
        };
        await Assert.ThrowsAsync<ArticleMediaException>(() => ArticleMediaPreservation.InventoryAsync(
            Articles(new(1, null, "[a](/uploads/a.bin) [again](/uploads/a.bin)", s_origin)), fixture.Source, s_origin, "/uploads/", limits, default));
        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.Target));
    }

    [Fact]
    public async Task Inventory_AccountsForAllDeepDirectoryPrefixesBeforeTargetWrites()
    {
        using var fixture = new MediaFixture();
        var relative = string.Join('/', Enumerable.Repeat("deep", 20)) + "/a.bin";
        fixture.WriteSource(relative, [1]);
        var markdown = "[a](/uploads/" + relative + ")";
        var small = s_limits with { MetadataBytes = 1000 };
        var error = await Assert.ThrowsAsync<ArticleMediaException>(() => ArticleMediaPreservation.InventoryAsync(
            Articles(new(1, null, markdown, s_origin)), fixture.Source, s_origin, "/uploads/", small, default));
        Assert.Equal("directory_metadata_budget", error.Message);
        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.Target));
    }

    [Fact]
    public async Task Publish_CopiesActualBytesAndCanResumeWithoutDuplicateGeneration()
    {
        using var fixture = new MediaFixture();
        fixture.WriteSource("sub/file.bin", [1, 2, 3, 4]);
        var inventory = await Inventory(fixture, new(1, null, "[file](/uploads/sub/file.bin)", s_origin));
        var binding = fixture.Binding(inventory);
        var journal = new TestJournal(binding);
        var publication = await Publish(fixture, inventory, binding, journal);
        Assert.Equal(new byte[] { 1, 2, 3, 4 }, await File.ReadAllBytesAsync(Path.Combine(fixture.Target, "uploads/sub/file.bin")));
        Assert.Equal(ArticleMediaJournalState.MediaPublished, journal.State);
        Assert.Equal(1, journal.PublicationCalls);
        Assert.Equal(publication, await Publish(fixture, inventory, binding, journal));
        Assert.Single(Directory.EnumerateDirectories(fixture.Target));
        Assert.Equal(1, journal.PublicationCalls);
        Assert.NotEqual(ArticleMediaJournalState.DatabaseCommitted, journal.State);
    }

    [Fact]
    public async Task Publish_CrashAfterRenameRecoversByVerifyingRealGenerationBeforeCas()
    {
        using var fixture = new MediaFixture();
        fixture.WriteSource("a.bin", [9, 8, 7]);
        var inventory = await Inventory(fixture, new(1, null, "[a](/uploads/a.bin)", s_origin));
        var binding = fixture.Binding(inventory);
        var journal = new TestJournal(binding) { FailNextPublication = true };
        await Assert.ThrowsAsync<IOException>(() => Publish(fixture, inventory, binding, journal));
        Assert.Equal(ArticleMediaJournalState.Prepared, journal.State);
        Assert.True(File.Exists(Path.Combine(fixture.Target, "uploads/a.bin")));
        await Publish(fixture, inventory, binding, journal);
        Assert.Equal(ArticleMediaJournalState.MediaPublished, journal.State);
        Assert.Single(Directory.EnumerateDirectories(fixture.Target));
    }

    [Fact]
    public async Task Publish_ResumesPartialStageWithoutOverwritingCompletedFileOrDuplicatingGeneration()
    {
        using var fixture = new MediaFixture();
        fixture.WriteSource("a.bin", [1]);
        fixture.WriteSource("nested/b.bin", [2]);
        var inventory = await Inventory(fixture, new(1, null, "[a](/uploads/a.bin) [b](/uploads/nested/b.bin)", s_origin));
        var binding = fixture.Binding(inventory);
        using (var source = ArticleMediaDirectory.Open(fixture.Source, writable: false))
        using (var parent = ArticleMediaDirectory.Open(fixture.Target, writable: true))
        using (var stage = parent.OpenOrCreateDirectory(".media-" + binding.RunId.ToString("N") + ".tmp"))
        {
            await stage.CopyVerifiedAsync(source, inventory.Files[0], s_limits.FileBytes, default);
        }
        var journal = new TestJournal(binding);
        await Publish(fixture, inventory, binding, journal);
        Assert.Equal(new byte[] { 1 }, await File.ReadAllBytesAsync(Path.Combine(fixture.Target, "uploads/a.bin")));
        Assert.Equal(new byte[] { 2 }, await File.ReadAllBytesAsync(Path.Combine(fixture.Target, "uploads/nested/b.bin")));
        Assert.Single(Directory.EnumerateDirectories(fixture.Target));
        Assert.Equal(1, journal.PublicationCalls);
        Assert.Equal(ArticleMediaJournalState.MediaPublished, journal.State);
    }

    [Fact]
    public async Task Publish_CannotReusePreparedBindingForAnotherPhysicalGenerationName()
    {
        using var fixture = new MediaFixture();
        fixture.WriteSource("a.bin", [1]);
        var inventory = await Inventory(fixture, new(1, null, "[a](/uploads/a.bin)", s_origin));
        var binding = fixture.Binding(inventory);
        var journal = new TestJournal(binding);
        await Assert.ThrowsAsync<ArticleMediaException>(() => ArticleMediaPreservation.StageAndPublishAsync(
            inventory, fixture.Source, fixture.Target, "other-uploads", binding, s_limits, journal, default));
        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.Target));
        Assert.Equal(0, journal.PublicationCalls);
    }

    [Fact]
    public async Task Publish_RequiresRealJournalBindingBeforeStageWrites()
    {
        using var fixture = new MediaFixture();
        fixture.WriteSource("a.bin", [1]);
        var inventory = await Inventory(fixture, new(1, null, "[a](/uploads/a.bin)", s_origin));
        var binding = fixture.Binding(inventory);
        await Assert.ThrowsAsync<ArticleMediaException>(() => Publish(fixture, inventory, binding,
            new TestJournal(binding with { PlanArtifactSha256 = new string('b', 64) })));
        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.Target));
    }

    [Fact]
    public async Task Publish_ChangedSourceFailsWithoutPublishingOrDatabaseCommit()
    {
        using var fixture = new MediaFixture();
        fixture.WriteSource("a.bin", [1, 2]);
        var inventory = await Inventory(fixture, new(1, null, "[a](/uploads/a.bin)", s_origin));
        fixture.WriteSource("a.bin", [3, 4]);
        var binding = fixture.Binding(inventory);
        var journal = new TestJournal(binding);
        await Assert.ThrowsAsync<ArticleMediaException>(() => Publish(fixture, inventory, binding, journal));
        Assert.False(Directory.Exists(Path.Combine(fixture.Target, "uploads")));
        Assert.Equal(ArticleMediaJournalState.Prepared, journal.State);
    }

    [Fact]
    public async Task Publish_UnexpectedGenerationFileCannotBeReplayedAsSuccessful()
    {
        using var fixture = new MediaFixture();
        fixture.WriteSource("a.bin", [1]);
        var inventory = await Inventory(fixture, new(1, null, "[a](/uploads/a.bin)", s_origin));
        var binding = fixture.Binding(inventory);
        var journal = new TestJournal(binding);
        await Publish(fixture, inventory, binding, journal);
        await File.WriteAllBytesAsync(Path.Combine(fixture.Target, "uploads/unexpected.bin"), [2]);
        await Assert.ThrowsAsync<ArticleMediaException>(() => Publish(fixture, inventory, binding, journal));
        Assert.NotEqual(ArticleMediaJournalState.DatabaseCommitted, journal.State);
    }

    [Fact]
    public async Task Publish_DatabaseCommittedButMissingGenerationRefusesInsteadOfInventingRecovery()
    {
        using var fixture = new MediaFixture();
        fixture.WriteSource("a.bin", [1]);
        var inventory = await Inventory(fixture, new(1, null, "[a](/uploads/a.bin)", s_origin));
        var binding = fixture.Binding(inventory);
        var journal = new TestJournal(binding) { State = ArticleMediaJournalState.DatabaseCommitted };
        await Assert.ThrowsAsync<ArticleMediaException>(() => Publish(fixture, inventory, binding, journal));
        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.Target));
    }

    private static Task<ArticleMediaInventory> Inventory(MediaFixture fixture, ArticleMediaSource article) =>
        ArticleMediaPreservation.InventoryAsync(Articles(article), fixture.Source, s_origin, "/uploads/", s_limits, default);
    private static Task<ArticleMediaPublication> Publish(MediaFixture fixture, ArticleMediaInventory inventory,
        ArticleMediaBinding binding, TestJournal journal) => ArticleMediaPreservation.StageAndPublishAsync(
            inventory, fixture.Source, fixture.Target, "uploads", binding, s_limits, journal, default);
    private static async IAsyncEnumerable<ArticleMediaSource> Articles(ArticleMediaSource article)
    {
        await Task.CompletedTask;
        yield return article;
    }

    // Fixture only: this does not provide authenticated DB preparation or qualify any provider.
    private sealed class TestJournal(ArticleMediaBinding expected) : IArticleMediaPreservationJournal
    {
        public ArticleMediaJournalState State { get; set; } = ArticleMediaJournalState.Prepared;
        public bool FailNextPublication { get; set; }
        public int PublicationCalls { get; private set; }
        public Task<ArticleMediaJournalState> RequirePreparedAsync(ArticleMediaBinding binding, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            if (binding != expected) throw new ArticleMediaException("test_journal_prepare_mismatch");
            return Task.FromResult(State);
        }
        public Task RecordPublishedAsync(ArticleMediaPublication publication, ArticleMediaJournalState expectedState, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            if (publication.Binding != expected || State != expectedState) throw new ArticleMediaException("test_journal_cas_mismatch");
            PublicationCalls++;
            if (FailNextPublication)
            {
                FailNextPublication = false;
                throw new IOException("test crash after media rename");
            }
            State = ArticleMediaJournalState.MediaPublished;
            return Task.CompletedTask;
        }
    }

    private sealed class MediaFixture : IDisposable
    {
        public string Root { get; } = Path.Combine(Path.GetTempPath(), "fsusblog-media-tests-" + Guid.NewGuid().ToString("N"));
        public string Source => Path.Combine(Root, "source");
        public string Target => Path.Combine(Root, "target");
        public MediaFixture()
        {
            Assert.True(OperatingSystem.IsLinux(), "Anchored media capability requires the original Linux execution lane.");
            Directory.CreateDirectory(Source, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            Directory.CreateDirectory(Target, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        public void WriteSource(string relative, byte[] bytes)
        {
            var path = Path.Combine(Source, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllBytes(path, bytes);
        }
        public ArticleMediaBinding Binding(ArticleMediaInventory inventory)
        {
            using var target = ArticleMediaDirectory.Open(Target, writable: true);
            return new(Guid.NewGuid(), new string('a', 64), new string('b', 64), new string('c', 64),
                inventory.ManifestDigest, inventory.SourceRootIdentity, target.Identity, "uploads");
        }
        public void Dispose() => Directory.Delete(Root, recursive: true); // Exact freshly-created fixture root only.
    }
}
