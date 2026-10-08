using System.Collections.Immutable;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Algorithm fixtures only; these do not qualify the missing canonical source adapter or durable storage.</summary>
[Trait("Category", "Unit")]
public sealed class AuthorFullTextSearchIndexTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(10_000)]
    public async Task Rebuild_Is_Batched_And_Generation_Gated(int count)
    {
        var source = new SourceFixture(count);
        var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        Assert.Throws<AuthorSearchContractException>(() => index.RequireCurrentGeneration());
        await Rebuild(index);
        Assert.Equal(AuthorSearchIndexStatus.Current, index.Status);
        Assert.Equal(1, index.RequireCurrentGeneration());
        Assert.Equal(Math.Max(1, (count + AuthorFullTextSearchIndex.BatchSize - 1) / AuthorFullTextSearchIndex.BatchSize), source.ReadCount);
        Assert.True(source.LargestPage <= AuthorFullTextSearchIndex.BatchSize);
        int sourceReads = source.ReadCount;
        AuthorSearchIndexPostingPage page = await index.ReadPostingsAsync(42, "primary", 1,
            "café", 0, AuthorFullTextSearchIndex.MaxPostingPageSize);
        Assert.Equal(Math.Min(count, AuthorFullTextSearchIndex.MaxPostingPageSize), page.Postings.Length);
        Assert.Equal(count > AuthorFullTextSearchIndex.MaxPostingPageSize, page.HasMore);
        Assert.Equal(sourceReads, source.ReadCount);
        string first = index.SemanticDigest();
        await Rebuild(index);
        Assert.Equal(2, index.RequireCurrentGeneration());
        Assert.Equal(first, index.SemanticDigest());
    }

    [Theory]
    [InlineData(AuthorSearchIndexLifecycleEvent.Create)]
    [InlineData(AuthorSearchIndexLifecycleEvent.Edit)]
    [InlineData(AuthorSearchIndexLifecycleEvent.Publish)]
    [InlineData(AuthorSearchIndexLifecycleEvent.Schedule)]
    [InlineData(AuthorSearchIndexLifecycleEvent.Archive)]
    [InlineData(AuthorSearchIndexLifecycleEvent.Delete)]
    [InlineData(AuthorSearchIndexLifecycleEvent.Restore)]
    [InlineData(AuthorSearchIndexLifecycleEvent.Rollback)]
    [InlineData(AuthorSearchIndexLifecycleEvent.Import)]
    [InlineData(AuthorSearchIndexLifecycleEvent.Migration)]
    [InlineData(AuthorSearchIndexLifecycleEvent.PermissionChange)]
    [InlineData(AuthorSearchIndexLifecycleEvent.LocaleChange)]
    [InlineData(AuthorSearchIndexLifecycleEvent.TaxonomyChange)]
    [InlineData(AuthorSearchIndexLifecycleEvent.PropertyChange)]
    public async Task Lifecycle_Replaces_Current_Sets_With_Incremental_Rebuild_Parity(AuthorSearchIndexLifecycleEvent lifecycleEvent)
    {
        var source = new SourceFixture(1);
        var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        await Rebuild(index);
        string before = index.SemanticDigest();
        source.Sequence = 2;
        source.Generation = 2;
        source.Deleted = lifecycleEvent == AuthorSearchIndexLifecycleEvent.Delete;
        await index.ApplyAsync(1, 2, lifecycleEvent);
        string incremental = index.SemanticDigest();
        Assert.NotEqual(before, incremental);
        int reads = source.ReadCount;
        await index.ApplyAsync(1, 1, lifecycleEvent);
        await index.ApplyAsync(1, 2, lifecycleEvent);
        Assert.Equal(reads, source.ReadCount);
        Assert.Equal(incremental, index.SemanticDigest());
        await Rebuild(index);
        Assert.Equal(incremental, index.SemanticDigest());
    }

    [Fact]
    public async Task Reordered_Event_Rereads_Current_Source_Instead_Of_Overwriting_With_Event_State()
    {
        var source = new SourceFixture(1);
        var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        await Rebuild(index);
        source.Sequence = 3;
        await index.ApplyAsync(1, 2, AuthorSearchIndexLifecycleEvent.Edit);
        int reads = source.ReadCount;
        await index.ApplyAsync(1, 3, AuthorSearchIndexLifecycleEvent.Publish);
        Assert.Equal(reads, source.ReadCount);
        string incremental = index.SemanticDigest();
        await Rebuild(index);
        Assert.Equal(incremental, index.SemanticDigest());
    }

    [Fact]
    public async Task Rebuild_Failure_And_Checkpoint_Resume_Do_Not_Admit_Partial_Or_Serialized_Content()
    {
        var source = new SourceFixture(101);
        var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        AuthorSearchIndexCheckpoint checkpoint = (await index.RebuildStepAsync())!;
        Assert.Equal(100, checkpoint.ArticleCount);
        Assert.Equal(AuthorSearchIndexStatus.Rebuilding, index.Status);
        Assert.Throws<AuthorSearchContractException>(() => index.RequireCurrentGeneration());
        source.FailNextRead = true;
        await Assert.ThrowsAsync<IOException>(() => index.RebuildStepAsync());
        Assert.Equal(AuthorSearchIndexStatus.RebuildRequired, index.Status);
        Assert.Throws<AuthorSearchContractException>(() => index.SemanticDigest());
        var resumed = new AuthorFullTextSearchIndex(source, 42, "primary");
        await resumed.ResumeRebuildAsync(checkpoint);
        Assert.Equal(AuthorSearchIndexStatus.Current, resumed.Status);
        await Rebuild(index);
        Assert.Equal(index.SemanticDigest(), resumed.SemanticDigest());
        source.Generation++;
        var stale = new AuthorFullTextSearchIndex(source, 42, "primary");
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => stale.ResumeRebuildAsync(checkpoint));
        Assert.Equal(AuthorSearchIndexStatus.RebuildRequired, stale.Status);
    }

    [Fact]
    public async Task Source_Generation_Drift_Permission_Failure_And_Late_Facts_Require_Rebuild()
    {
        var source = new SourceFixture(101);
        var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        await index.RebuildStepAsync();
        source.Generation++;
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.RebuildStepAsync());
        Assert.Equal(AuthorSearchIndexStatus.RebuildRequired, index.Status);
        source.Count = 1;
        await Rebuild(index);
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ApplyAsync(1, 2, AuthorSearchIndexLifecycleEvent.Edit));
        Assert.Equal(AuthorSearchIndexStatus.RebuildRequired, index.Status);
        source.Permission = AuthorSearchPermissionState.Denied;
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => Rebuild(index));
        Assert.Equal(AuthorSearchIndexStatus.RebuildRequired, index.Status);
    }

    [Fact]
    public async Task Large_Source_Is_Bounded_And_Cancellation_Does_Not_Mark_Partial_Current()
    {
        var source = new SourceFixture(1)
        {
            Text = new string('a', AuthorFullTextSearchTokenizer.MaxSourceCharacters)
        };
        var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        await Rebuild(index);
        Assert.Equal(AuthorSearchIndexStatus.Current, index.Status);
        source.Text += 'a';
        source.Sequence++;
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ApplyAsync(1, 2, AuthorSearchIndexLifecycleEvent.Edit));
        Assert.Equal(AuthorSearchIndexStatus.RebuildRequired, index.Status);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => index.RebuildStepAsync(cancellation.Token));
        Assert.Equal(AuthorSearchIndexStatus.RebuildRequired, index.Status);
    }

    [Fact]
    public async Task Rebuild_Rejects_An_Overbudget_Batch_Before_Token_Output_Is_Allocated()
    {
        var source = new SourceFixture(10)
        {
            Text = new string('a', AuthorFullTextSearchTokenizer.MaxSourceCharacters)
        };
        var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        AuthorSearchContractException failure = await Assert.ThrowsAsync<AuthorSearchContractException>(() => Rebuild(index));
        Assert.Equal("author_search_source_batch_budget_exceeded", failure.Message);
        Assert.Equal(AuthorSearchIndexStatus.RebuildRequired, index.Status);
    }

    private static async Task Rebuild(AuthorFullTextSearchIndex index)
    {
        while (await index.RebuildStepAsync() is not null)
        {
            Assert.Throws<AuthorSearchContractException>(() => index.RequireCurrentGeneration());
        }
    }

    [Fact]
    public async Task Read_Snapshot_Is_Private_Immutable_And_Generation_Bound()
    {
        var source = new SourceFixture(1);
        var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ReadSnapshotAsync(42, "primary", 1));
        await Rebuild(index);
        AuthorSearchIndexReadSnapshot snapshot = await index.ReadSnapshotAsync(42, "primary", 1);
        Assert.Equal(42, snapshot.UserId);
        Assert.Equal("primary", snapshot.SiteScope);
        Assert.Single(snapshot.Articles);
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ReadSnapshotAsync(99, "primary", 1));
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ReadSnapshotAsync(42, "other", 1));
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ReadSnapshotAsync(42, "primary", 2));
        source.Sequence = 2;
        await index.ApplyAsync(1, 2, AuthorSearchIndexLifecycleEvent.Edit);
        Assert.Equal(1, snapshot.Articles[1].SourceSequence);
        Assert.Equal(2, index.RequireCurrentGeneration());
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ReadSnapshotAsync(42, "primary", 1));
        Assert.Equal(2, (await index.ReadSnapshotAsync(42, "primary", 2)).Articles[1].SourceSequence);
        await Rebuild(index);
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ReadSnapshotAsync(42, "primary", 1));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Incremental_Replacement_Invalidates_Old_Generation_And_Rebinds_Untouched_Documents(bool deleted)
    {
        var source = new SourceFixture(2);
        using var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        await Rebuild(index);
        AuthorSearchIndexReadSnapshot before = await index.ReadSnapshotAsync(42, "primary", 1);
        source.Sequence = 2;
        source.Generation = 2;
        source.Deleted = deleted;
        source.ArticleOverrides[2] = (1, false);
        int reads = source.ReadCount;
        await index.ApplyAsync(1, 2, deleted ? AuthorSearchIndexLifecycleEvent.Delete : AuthorSearchIndexLifecycleEvent.Edit);
        Assert.Equal(reads + 1, source.ReadCount);
        Assert.Equal(2, index.RequireCurrentGeneration());
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ReadSnapshotAsync(42, "primary", 1));
        AuthorSearchIndexReadSnapshot after = await index.ReadSnapshotAsync(42, "primary", 2);
        Assert.Equal(1, before.Articles[1].SourceSequence);
        Assert.Equal(1, before.Articles[2].Documents[0].Document.Identity.IndexGeneration);
        Assert.Equal(2, after.Articles[1].SourceSequence);
        Assert.Equal(deleted, after.Articles[1].Deleted);
        Assert.Equal(1, after.Articles[2].SourceSequence);
        Assert.Equal(2, after.Articles[2].Documents[0].Document.Identity.IndexGeneration);
        Assert.Equal(before.Articles[2].Documents[0].Tokens, after.Articles[2].Documents[0].Tokens);
        Assert.NotEqual(before.Articles[2].Documents[0].ContentDigest, after.Articles[2].Documents[0].ContentDigest);
        await AuthorFullTextSearchIndexVerifier.VerifyAsync(after, source);
        int readsAfterVerification = source.ReadCount;
        await index.ApplyAsync(1, 2, AuthorSearchIndexLifecycleEvent.Edit);
        Assert.Equal(2, index.RequireCurrentGeneration());
        Assert.Equal(readsAfterVerification, source.ReadCount);
    }

    [Fact]
    public async Task Independent_Verifier_Rejects_Resealed_Index_Tamper_And_Source_Drift()
    {
        var source = new SourceFixture(2);
        var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        await Rebuild(index);
        AuthorSearchIndexReadSnapshot snapshot = await index.ReadSnapshotAsync(42, "primary", 1);
        await AuthorFullTextSearchIndexVerifier.VerifyAsync(snapshot, source);
        AuthorSearchIndexedArticle article = snapshot.Articles[1];
        AuthorSearchTokenizedDocument document = article.Documents[0];
        AuthorSearchTokenizedDocument tampered = AuthorFullTextSearchVerifier.SealTokenDocument(document with
        {
            Tokens = [document.Tokens[0] with { Term = "tampered" }]
        });
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => AuthorFullTextSearchIndexVerifier.VerifyAsync(snapshot with
        {
            Articles = snapshot.Articles.SetItem(1, article with
            {
                Documents = [tampered]
            })
        }, source));
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => AuthorFullTextSearchIndexVerifier.VerifyAsync(snapshot with
        {
            Articles = snapshot.Articles.Remove(1)
        }, source));
        source.Generation++;
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => AuthorFullTextSearchIndexVerifier.VerifyAsync(snapshot, source));
    }

    [Theory]
    [InlineData(AuthorSearchFieldKind.MarkdownBody)]
    [InlineData(AuthorSearchFieldKind.Heading)]
    public async Task Posting_Pages_Are_Generation_Bound_Bounded_And_Keep_Exact_Raw_Positions(AuthorSearchFieldKind field)
    {
        var source = new SourceFixture(3) { Text = "CAFÉ cafe\u0301 👩‍💻 中文", FieldKind = field };
        using var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        await Rebuild(index);
        int reads = source.ReadCount;
        AuthorSearchIndexReadSnapshot snapshot = await index.ReadSnapshotAsync(42, "primary", 1);
        AuthorSearchIndexPostingPage first = await index.ReadPostingsAsync(42, "primary", 1, "café", 0, 3);
        Assert.Equal(snapshot.RegistryDigest, first.RegistryDigest);
        Assert.Equal(3, first.Postings.Length);
        Assert.True(first.HasMore);
        Assert.Equal(3, first.NextOffset);
        AuthorSearchIndexPostingPage second = await index.ReadPostingsAsync(42, "primary", 1, "café", first.NextOffset, 3);
        Assert.Equal(3, second.Postings.Length);
        Assert.False(second.HasMore);
        Assert.Equal(6, second.NextOffset);
        Assert.Equal(new[] { 1, 1, 2, 2, 3, 3 }, first.Postings.Concat(second.Postings).Select(p => p.ArticleId));
        foreach (AuthorSearchIndexPosting posting in first.Postings.Concat(second.Postings))
        {
            AuthorSearchTokenizedDocument document = snapshot.Articles[posting.ArticleId].Documents.Single();
            Assert.Equal(document.Document.ContentDigest, posting.DocumentDigest);
            Assert.Equal(document.Document.Field.Kind, posting.Field);
            Assert.Equal(document.Document.Field.HeadingIdentity, posting.HeadingIdentity);
            Assert.Equal(document.Tokens[posting.TokenPosition].Source, posting.Source);
            string raw = source.Text[posting.Source.Utf16Start..posting.Source.Utf16End];
            Assert.Equal("café", AuthorFullTextSearchTokenizer.TokenizeQueryValue(raw).Single());
            Assert.Equal(Encoding.UTF8.GetByteCount(source.Text.AsSpan(0, posting.Source.Utf16Start)), posting.Source.Utf8Start);
        }
        Assert.Empty((await index.ReadPostingsAsync(42, "primary", 1, "missing", 0, 10)).Postings);
        Assert.Equal(reads, source.ReadCount);
        source.Sequence = 2;
        source.Generation = 2;
        source.Text = "replacement";
        await index.ApplyAsync(1, 2, AuthorSearchIndexLifecycleEvent.Edit);
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ReadPostingsAsync(42, "primary", 1, "café", 0, 10));
        Assert.Equal(new[] { 2, 2, 3, 3 }, (await index.ReadPostingsAsync(42, "primary", 2, "café", 0, 10)).Postings.Select(p => p.ArticleId));
        Assert.Equal(1, (await index.ReadPostingsAsync(42, "primary", 2, "replacement", 0, 10)).Postings.Single().ArticleId);
        source.Sequence = 3;
        source.Deleted = true;
        await index.ApplyAsync(1, 3, AuthorSearchIndexLifecycleEvent.Delete);
        Assert.Empty((await index.ReadPostingsAsync(42, "primary", 3, "replacement", 0, 10)).Postings);
    }

    [Fact]
    public async Task Posting_Storage_Rejects_Scope_Budget_Normalization_And_Cancelled_Reads()
    {
        var source = new SourceFixture(1);
        using var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ReadPostingsAsync(42, "primary", 1, "café", 0, 1));
        await Rebuild(index);
        foreach (string term in new[] { "CAFÉ", "cafe\u0301", "two words", " ", "a*" })
        {
            await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ReadPostingsAsync(42, "primary", 1, term, 0, 1));
        }
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ReadPostingsAsync(99, "primary", 1, "café", 0, 1));
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ReadPostingsAsync(42, "other", 1, "café", 0, 1));
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ReadPostingsAsync(42, "primary", 1, "café", -1, 1));
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ReadPostingsAsync(42, "primary", 1, "café", 2, 1));
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ReadPostingsAsync(42, "primary", 1, "café", 0, AuthorFullTextSearchIndex.MaxPostingPageSize + 1));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => index.ReadPostingsAsync(42, "primary", 1, "café", 0, 1, cancellation.Token));
        Assert.Equal(AuthorSearchIndexStatus.Current, index.Status);
    }

    private sealed class SourceFixture(int count) : IAuthorFullTextSearchIndexSource
    {
        public AuthorSearchFieldKind FieldKind { get; set; } = AuthorSearchFieldKind.MarkdownBody;
        public Dictionary<int, (long Sequence, bool Deleted)> ArticleOverrides { get; } = [];
        public int Count { get; set; } = count;
        public long Sequence { get; set; } = 1;
        public long Generation { get; set; } = 1;
        public bool Deleted
        {
            get; set;
        }
        public bool FailNextRead
        {
            get; set;
        }
        public string Text { get; set; } = "中文 CAFÉ 👩‍💻 العربية";
        public AuthorSearchPermissionState Permission { get; set; } = AuthorSearchPermissionState.Allowed;
        public int ReadCount
        {
            get; private set;
        }
        public int LargestPage
        {
            get; private set;
        }

        public Task<AuthorSearchIndexSourcePage> ReadAsync(
            int userId, string siteScope, int afterArticleId, int pageSize,
            long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            ReadCount++;
            cancellationToken.ThrowIfCancellationRequested();
            if (FailNextRead)
            {
                FailNextRead = false;
                throw new IOException("simulated-algorithm-boundary-failure");
            }
            var articles = ImmutableArray.CreateBuilder<AuthorSearchIndexArticleSource>();
            for (int id = afterArticleId + 1; id <= Count && articles.Count < pageSize; id++)
            {
                (long sequence, bool deleted) = ArticleOverrides.TryGetValue(id, out var articleState)
                    ? articleState : (Sequence, Deleted);
                string raw = Text;
                string digest = AuthorFullTextSearchContract.Digest(raw);
                AuthorSearchDocument document = AuthorFullTextSearchContract.SealDocument(new(
                    AuthorFullTextSearchContract.SchemaVersion, AuthorFullTextSearchContract.DocumentSchema,
                    AuthorFullTextSearchContract.TokenizerVersion, AuthorFullTextSearchContract.IndexOwner,
                    new(id, userId, siteScope, sequence, sequence, sequence, 1, "en", ArticleStatus.Draft,
                        AuthorSearchScope.CurrentArticle, Permission, AuthorSearchVisibilityScope.AuthorOnly,
                        AuthorFullTextSearchContract.Digest("permission-policy")),
                    new(FieldKind, digest, FieldKind == AuthorSearchFieldKind.Heading ? "algorithm-fixture-heading" : null, null, null),
                    new(AuthorFullTextSearchContract.SourceCoordinateAuthority, "algorithm-fixture-parser",
                        "document:1", sequence, digest, 0, raw.Length, 0, Encoding.UTF8.GetByteCount(raw)), string.Empty));
                articles.Add(new(id, sequence, deleted,
                    deleted ? [] : [new(document, raw, "algorithm-fixture-parser", "document:1")],
                    new Dictionary<Guid, ArticlePropertyDefinition>()));
            }
            LargestPage = Math.Max(LargestPage, articles.Count);
            bool more = articles.Count > 0 && articles[^1].ArticleId < Count;
            return Task.FromResult(new AuthorSearchIndexSourcePage(Generation, articles.ToImmutable(), more));
        }
    }
}
