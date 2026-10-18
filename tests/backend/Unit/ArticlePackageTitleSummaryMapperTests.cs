using System.Collections;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Pure canonical-input mapping controls; no fixture establishes a persisted or authorized revision.</summary>
public sealed class ArticlePackageTitleSummaryMapperTests
{
    private const int MaxCanonicalTextCodeUnits = 1048576;
    private static readonly DateTime s_now = new(2026, 10, 8, 12, 0, 0, DateTimeKind.Utc);

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("摘要 CJK 😀 שלום\r\nsecond line  \r\n")]
    public void Mapper_PreservesExactTitleAndNullableSummary(string? summary)
    {
        ArticleCanonicalInput source = Source(summary: summary);
        ArticlePackageTitleSummaryBinding binding = Binding(source);
        ArticlePackageTitleSummaryCandidate candidate = Map(source, binding);

        Assert.Equal(source.Title, candidate.Title);
        Assert.Equal(source.Summary, candidate.Summary);
        Assert.Equal(source.ArticleId, candidate.SourceArticleId);
        Assert.Equal(source.ArticleRevisionId, candidate.SourceRevisionId);
        Assert.Equal(source.RevisionNo, candidate.SourceRevisionNo);
        Assert.Equal(ArticleCanonicalHashV1.ComputeHashHex(source), candidate.SourceCanonicalHash);
        Assert.Equal(binding.PortableArticle, candidate.PortableArticle);
        Assert.NotEqual(candidate.SourceCanonicalHash, candidate.MappingDigest);
        Assert.True(ArticlePackageTitleSummaryMapper.ValidateCandidate(source, binding, candidate).IsValid);
    }

    [Theory]
    [InlineData("title-nfc")]
    [InlineData("title-crlf")]
    [InlineData("summary-nfc")]
    [InlineData("summary-crlf")]
    public void Mapper_RawTextDifferencesSurviveCanonicalHashNormalization(string difference)
    {
        ArticleCanonicalInput first = Source("Café\n尾  ", "Résumé\n終  ");
        ArticleCanonicalInput second = difference switch
        {
            "title-nfc" => first with
            {
                Title = "Cafe\u0301\n尾  "
            },
            "title-crlf" => first with
            {
                Title = "Café\r\n尾  "
            },
            "summary-nfc" => first with
            {
                Summary = "Re\u0301sume\u0301\n終  "
            },
            _ => first with
            {
                Summary = "Résumé\r\n終  "
            }
        };
        ArticlePackageTitleSummaryCandidate left = Map(first, Binding(first));
        ArticlePackageTitleSummaryCandidate right = Map(second, Binding(second));

        Assert.Equal(ArticleCanonicalHashV1.ComputeHashHex(first), ArticleCanonicalHashV1.ComputeHashHex(second));
        Assert.Equal(left.SourceCanonicalHash, right.SourceCanonicalHash);
        Assert.NotEqual(left.MappingDigest, right.MappingDigest);
        Assert.Equal(second.Title, right.Title);
        Assert.Equal(second.Summary, right.Summary);
        Assert.False(ArticlePackageTitleSummaryMapper.ValidateCandidate(second, Binding(second), left).IsValid);
    }

    [Fact]
    public void Mapper_DistinguishesNullAndEmptySummaryAndHasRepeatableMapping()
    {
        ArticleCanonicalInput absent = Source(summary: null);
        ArticleCanonicalInput empty = Source(summary: string.Empty);
        ArticlePackageTitleSummaryCandidate missing = Map(absent, Binding(absent));
        ArticlePackageTitleSummaryCandidate explicitEmpty = Map(empty, Binding(empty));

        Assert.Null(missing.Summary);
        Assert.Equal(string.Empty, explicitEmpty.Summary);
        Assert.NotEqual(missing.SourceCanonicalHash, explicitEmpty.SourceCanonicalHash);
        Assert.NotEqual(missing.MappingDigest, explicitEmpty.MappingDigest);
        Assert.Equal(missing.MappingDigest, Map(absent, Binding(absent)).MappingDigest);
    }

    [Theory]
    [InlineData(null, "01f650b2d522eb5f80bf7f819ed76b5ce056996c24b78d70705b53761ac3476c",
        "d20fe453b0f101d2779628b4dcfec5dfd004feaea1d43e5192551d24a03d8a40")]
    [InlineData("", "baddb439eca11b0e9a362c9d5da908680b93e5fdf165d38ceef549df15dc34a3",
        "06d74e83d4cf8c726138800ad1afcc262eb6a46c7e490f2c4841471a283c4b28")]
    public void Mapper_MatchesIndependentUtf8LittleEndianFramingVectors(string? summary, string canonicalHash, string mappingDigest)
    {
        // Python hashlib/struct vectors seal UTF-8 byte lengths, raw CRLF, Int64 revision, and null versus empty.
        var source = new ArticleCanonicalInput(17, 501, 3, null, "标题😀\r\n  ", summary, null, 1, [], 0, null, null, string.Empty);
        ArticlePackageTitleSummaryBinding binding = Binding(source);

        Assert.Equal(canonicalHash, ArticleCanonicalHashV1.ComputeHashHex(source));
        Assert.Equal(mappingDigest, Map(source, binding).MappingDigest);
    }

    [Theory]
    [InlineData("article")]
    [InlineData("revision-id")]
    [InlineData("revision-number")]
    [InlineData("hash")]
    [InlineData("uppercase-hash")]
    [InlineData("prefixed-hash")]
    [InlineData("missing-hash")]
    [InlineData("invalid-hash")]
    [InlineData("zero-article")]
    [InlineData("zero-revision")]
    [InlineData("zero-revision-number")]
    [InlineData("missing-portable")]
    [InlineData("wrong-portable-kind")]
    public void Mapper_RejectsMissingOrMismatchedBindingCoordinatesAndIdentity(string fault)
    {
        ArticleCanonicalInput source = Source();
        ArticlePackageTitleSummaryBinding valid = Binding(source);
        string hash = fault switch
        {
            "hash" => new string('0', 64),
            "uppercase-hash" => valid.SourceCanonicalHash.ToUpperInvariant(),
            "prefixed-hash" => "sha256:" + valid.SourceCanonicalHash,
            "missing-hash" => null!,
            "invalid-hash" => new string('g', 64),
            _ => valid.SourceCanonicalHash
        };
        ArticlePackageIdentity identity = fault switch
        {
            "missing-portable" => default,
            "wrong-portable-kind" => Portable(ArticlePackageIdentityKind.Definition),
            _ => valid.PortableArticle
        };
        var binding = new ArticlePackageTitleSummaryBinding(
            fault == "article" ? valid.SourceArticleId + 1 : fault == "zero-article" ? 0 : valid.SourceArticleId,
            fault == "revision-id" ? valid.SourceRevisionId + 1 : fault == "zero-revision" ? 0 : valid.SourceRevisionId,
            fault == "revision-number" ? valid.SourceRevisionNo + 1 : fault == "zero-revision-number" ? 0 : valid.SourceRevisionNo,
            hash, identity);

        Reject(source, binding);
    }

    [Theory]
    [InlineData("missing-revision")]
    [InlineData("missing-revision-number")]
    [InlineData("zero-revision")]
    [InlineData("zero-revision-number")]
    [InlineData("zero-article")]
    [InlineData("zero-category")]
    [InlineData("zero-tag")]
    [InlineData("negative-tag")]
    [InlineData("missing-title")]
    [InlineData("missing-markdown")]
    [InlineData("missing-tags")]
    public void Mapper_RejectsInvalidCanonicalInputsAndIncompleteRevisionCoordinates(string fault)
    {
        ArticleCanonicalInput valid = Source();
        ArticleCanonicalInput invalid = fault switch
        {
            "missing-revision" => valid with
            {
                ArticleRevisionId = null
            },
            "missing-revision-number" => valid with
            {
                RevisionNo = null
            },
            "zero-revision" => valid with
            {
                ArticleRevisionId = 0
            },
            "zero-revision-number" => valid with
            {
                RevisionNo = 0
            },
            "zero-article" => valid with
            {
                ArticleId = 0
            },
            "zero-category" => valid with
            {
                CategoryId = 0
            },
            "zero-tag" => valid with
            {
                TagIds = [1, 0]
            },
            "negative-tag" => valid with
            {
                TagIds = [-1]
            },
            "missing-title" => valid with
            {
                Title = null!
            },
            "missing-markdown" => valid with
            {
                MarkdownContent = null!
            },
            _ => valid with
            {
                TagIds = null!
            }
        };

        Reject(invalid, Binding(valid));
    }

    [Theory]
    [InlineData("markdown")]
    [InlineData("route")]
    [InlineData("cover")]
    [InlineData("category")]
    [InlineData("tags")]
    [InlineData("status")]
    [InlineData("publication-time")]
    [InlineData("schedule-time")]
    public void Mapper_RecomputesWholeCanonicalInputEvenForUnprojectedFields(string field)
    {
        ArticleCanonicalInput source = Source();
        ArticleCanonicalInput changed = field switch
        {
            "markdown" => source with
            {
                MarkdownContent = source.MarkdownContent + "changed"
            },
            "route" => source with
            {
                PublicRouteKey = "other-route"
            },
            "cover" => source with
            {
                CoverImageUrl = "/other.png"
            },
            "category" => source with
            {
                CategoryId = 2
            },
            "tags" => source with
            {
                TagIds = [9]
            },
            "status" => source with
            {
                Status = source.Status + 1
            },
            "publication-time" => source with
            {
                PublishedAt = s_now.AddTicks(1)
            },
            _ => source with
            {
                ScheduledPublishAt = s_now
            }
        };

        Assert.NotEqual(ArticleCanonicalHashV1.ComputeHashHex(source), ArticleCanonicalHashV1.ComputeHashHex(changed));
        Reject(changed, Binding(source));
        ArticlePackageTitleSummaryCandidate next = Map(changed, Binding(changed));
        Assert.Equal(changed.Title, next.Title);
        Assert.Equal(changed.Summary, next.Summary);
    }

    [Theory]
    [InlineData("title")]
    [InlineData("summary")]
    [InlineData("markdown")]
    [InlineData("route")]
    [InlineData("cover")]
    public void Mapper_RejectsMalformedUtf16InEveryCanonicalString(string field)
    {
        ArticleCanonicalInput source = Source();
        ArticleCanonicalInput invalid = field switch
        {
            "title" => source with
            {
                Title = "\uD800"
            },
            "summary" => source with
            {
                Summary = "\uDC00"
            },
            "markdown" => source with
            {
                MarkdownContent = "\uD800"
            },
            "route" => source with
            {
                PublicRouteKey = "\uDC00"
            },
            _ => source with
            {
                CoverImageUrl = "\uD800"
            }
        };

        Reject(invalid, Binding(source));
    }

    [Theory]
    [InlineData(DateTimeKind.Local, false)]
    [InlineData(DateTimeKind.Unspecified, false)]
    [InlineData(DateTimeKind.Local, true)]
    [InlineData(DateTimeKind.Unspecified, true)]
    public void Mapper_RejectsAmbientTimezoneDependentDates(DateTimeKind kind, bool schedule)
    {
        ArticleCanonicalInput source = Source();
        DateTime date = DateTime.SpecifyKind(s_now, kind);
        ArticleCanonicalInput invalid = schedule ? source with
        {
            ScheduledPublishAt = date
        } : source with
        {
            PublishedAt = date
        };

        Reject(invalid, Binding(source));
    }

    [Fact]
    public void Mapper_EnforcesAggregateRawTextBudgetBeforeCanonicalNormalization()
    {
        ArticleCanonicalInput source = Source();
        int metadataLength = source.Title.Length + (source.Summary?.Length ?? 0)
            + (source.PublicRouteKey?.Length ?? 0) + (source.CoverImageUrl?.Length ?? 0);
        ArticleCanonicalInput boundary = source with
        {
            MarkdownContent = new string('x', MaxCanonicalTextCodeUnits - metadataLength)
        };
        Assert.True(ArticlePackageTitleSummaryMapper.ValidateCandidate(boundary, Binding(boundary), Map(boundary, Binding(boundary))).IsValid);
        ArticleCanonicalInput overflow = boundary with
        {
            MarkdownContent = boundary.MarkdownContent + "x"
        };
        Reject(overflow, Binding(overflow));
        ArticleCanonicalInput spreadOverflow = source with
        {
            Title = new string('x', MaxCanonicalTextCodeUnits / 2),
            Summary = new string('x', MaxCanonicalTextCodeUnits / 2),
            MarkdownContent = string.Empty
        };
        Reject(spreadOverflow, Binding(spreadOverflow));
    }

    [Fact]
    public void Mapper_EnforcesRawTagBudgetBeforeCanonicalDeduplication()
    {
        ArticleCanonicalInput boundary = Source() with
        {
            TagIds = Enumerable.Range(1, 1000).ToArray()
        };
        Assert.True(ArticlePackageTitleSummaryMapper.ValidateCandidate(boundary, Binding(boundary), Map(boundary, Binding(boundary))).IsValid);
        ArticleCanonicalInput overflow = boundary with
        {
            TagIds = Enumerable.Range(1, 1001).ToArray()
        };
        Reject(overflow, Binding(overflow));
        ArticleCanonicalInput duplicateOverflow = boundary with
        {
            TagIds = Enumerable.Repeat(1, 1001).ToArray()
        };
        Reject(duplicateOverflow, Binding(duplicateOverflow));
    }

    [Fact]
    public void Mapper_ReadsCallerTagCountOnceAndCopiesOnlyBoundedIndexes()
    {
        ArticleCanonicalInput ordinary = Source() with
        {
            TagIds = [1]
        };
        ArticlePackageTitleSummaryBinding binding = Binding(ordinary);
        var tags = new TrackingTagList(1, 1001);
        ArticleCanonicalInput source = ordinary with
        {
            TagIds = tags
        };
        ArticlePackageTitleSummaryCandidate candidate = Map(source, binding);

        Assert.Equal(1, tags.CountReads);
        Assert.Equal(1, tags.IndexReads);
        Assert.Equal(0, tags.EnumeratorReads);
        Assert.Equal(binding.SourceCanonicalHash, candidate.SourceCanonicalHash);
        Assert.False(ArticlePackageTitleSummaryMapper.ValidateCandidate(source, binding, candidate).IsValid);
        Assert.Equal(2, tags.CountReads);
        Assert.Equal(1, tags.IndexReads);
        Assert.Equal(0, tags.EnumeratorReads);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(1001)]
    public void Mapper_RejectsInvalidFirstTagCountBeforeReadingAnyItem(int count)
    {
        ArticleCanonicalInput ordinary = Source() with
        {
            TagIds = [1]
        };
        var tags = new TrackingTagList(count, 1);
        ArticleCanonicalInput source = ordinary with
        {
            TagIds = tags
        };

        Reject(source, Binding(ordinary));
        Assert.Equal(1, tags.CountReads);
        Assert.Equal(0, tags.IndexReads);
        Assert.Equal(0, tags.EnumeratorReads);
    }

    [Fact]
    public void Mapper_TreatsCallerTagIndexFailureAsInvalidWithoutEnumerationFallback()
    {
        ArticleCanonicalInput ordinary = Source() with
        {
            TagIds = [1]
        };
        var tags = new TrackingTagList(1, 1, failIndex: true);
        ArticleCanonicalInput source = ordinary with
        {
            TagIds = tags
        };

        Reject(source, Binding(ordinary));
        Assert.Equal(1, tags.CountReads);
        Assert.Equal(1, tags.IndexReads);
        Assert.Equal(0, tags.EnumeratorReads);
    }

    [Theory]
    [InlineData("schema")]
    [InlineData("article")]
    [InlineData("revision")]
    [InlineData("revision-number")]
    [InlineData("hash")]
    [InlineData("portable")]
    [InlineData("title")]
    [InlineData("summary")]
    [InlineData("mapping-digest")]
    public void Validator_RejectsEveryCandidateMutationWithCopiedOriginalDigest(string fault)
    {
        ArticleCanonicalInput source = Source();
        ArticlePackageTitleSummaryBinding binding = Binding(source);
        ArticlePackageTitleSummaryCandidate candidate = Map(source, binding);
        var altered = new ArticlePackageTitleSummaryCandidate(
            fault == "schema" ? candidate.SchemaVersion + 1 : candidate.SchemaVersion,
            fault == "article" ? candidate.SourceArticleId + 1 : candidate.SourceArticleId,
            fault == "revision" ? candidate.SourceRevisionId + 1 : candidate.SourceRevisionId,
            fault == "revision-number" ? candidate.SourceRevisionNo + 1 : candidate.SourceRevisionNo,
            fault == "hash" ? new string('0', 64) : candidate.SourceCanonicalHash,
            fault == "portable" ? Portable(ArticlePackageIdentityKind.Article, true) : candidate.PortableArticle,
            fault == "title" ? candidate.Title + "changed" : candidate.Title,
            fault == "summary" ? null : candidate.Summary,
            fault == "mapping-digest" ? new string('0', 64) : candidate.MappingDigest);

        Assert.False(ArticlePackageTitleSummaryMapper.ValidateCandidate(source, binding, altered).IsValid);
    }

    [Fact]
    public void Mapper_RequiresExplicitBindingAndKeepsSelfSealedInputOnlyACandidate()
    {
        ArticleCanonicalInput source = Source();
        ArticlePackageTitleSummaryBinding binding = Binding(source);
        ArticlePackageTitleSummaryCandidate candidate = Map(source, binding);
        var anotherIdentity = new ArticlePackageTitleSummaryBinding(binding.SourceArticleId, binding.SourceRevisionId,
            binding.SourceRevisionNo, binding.SourceCanonicalHash, Portable(ArticlePackageIdentityKind.Article, true));

        Assert.Equal(source.Title, candidate.Title);
        Assert.NotEqual(candidate.MappingDigest, Map(source, anotherIdentity).MappingDigest);
        Assert.False(ArticlePackageTitleSummaryMapper.ValidateCandidate(source, anotherIdentity, candidate).IsValid);
        Assert.False(ArticlePackageTitleSummaryMapper.TryMapCandidate(null, binding, out var noSource).IsValid);
        Assert.Null(noSource);
        Assert.False(ArticlePackageTitleSummaryMapper.TryMapCandidate(source, null, out var noBinding).IsValid);
        Assert.Null(noBinding);
        Assert.False(ArticlePackageTitleSummaryMapper.ValidateCandidate(source, binding, null).IsValid);
        // A caller-recomputed canonical hash grants no persistence, lifecycle, taxonomy or rights authority.
        Assert.True(ArticlePackageTitleSummaryMapper.ValidateCandidate(source, binding, candidate).IsValid);
    }

    private static ArticlePackageTitleSummaryCandidate Map(ArticleCanonicalInput source, ArticlePackageTitleSummaryBinding binding)
    {
        ArticlePackageTitleSummaryMappingResult result = ArticlePackageTitleSummaryMapper.TryMapCandidate(source, binding, out var candidate);
        Assert.True(result.IsValid, result.ReasonCode);
        return Assert.IsType<ArticlePackageTitleSummaryCandidate>(candidate);
    }

    private static void Reject(ArticleCanonicalInput source, ArticlePackageTitleSummaryBinding binding)
    {
        ArticlePackageTitleSummaryMappingResult result = ArticlePackageTitleSummaryMapper.TryMapCandidate(source, binding, out var candidate);
        Assert.False(result.IsValid);
        Assert.False(string.IsNullOrWhiteSpace(result.ReasonCode));
        Assert.Null(candidate);
    }

    private static ArticleCanonicalInput Source(string title = "原文 Cafe\u0301 😀\r\n尾  ", string? summary = "摘要  ")
        => new(17, 501, 3, "article:route", title, summary, "/assets/cover.png", 1, [3, 1], 2, s_now, null, "# 正文\r\nexact  \r\n");

    private static ArticlePackageTitleSummaryBinding Binding(ArticleCanonicalInput source)
        => new(source.ArticleId, source.ArticleRevisionId!.Value, source.RevisionNo!.Value,
            ArticleCanonicalHashV1.ComputeHashHex(source), Portable(ArticlePackageIdentityKind.Article));

    private static ArticlePackageIdentity Portable(ArticlePackageIdentityKind kind, bool other = false)
    {
        string prefix = kind == ArticlePackageIdentityKind.Article ? "article:" : "portable-definition:";
        string token = other ? "20000000-0000-4000-8000-000000000002" : "20000000-0000-4000-8000-000000000001";
        Assert.True(ArticlePackageIdentity.TryCreate(kind, prefix + token, out var identity).IsValid);
        return identity;
    }

    private sealed class TrackingTagList(int firstCount, int laterCount, bool failIndex = false) : IReadOnlyList<int>
    {
        public int CountReads
        {
            get;
            private set;
        }
        public int IndexReads
        {
            get;
            private set;
        }
        public int EnumeratorReads
        {
            get;
            private set;
        }
        public int Count
        {
            get
            {
                CountReads++;
                int countReads = CountReads;
                return countReads == 1 ? firstCount : laterCount;
            }
        }
        public int this[int index]
        {
            get
            {
                IndexReads++;
                if (failIndex || index != 0)
                {
                    throw new IndexOutOfRangeException();
                }
                return 1;
            }
        }

        public IEnumerator<int> GetEnumerator()
        {
            EnumeratorReads++;
            throw new InvalidOperationException("Caller tags must be copied through bounded indexes.");
        }

        IEnumerator IEnumerable.GetEnumerator()
            => GetEnumerator();
    }
}
