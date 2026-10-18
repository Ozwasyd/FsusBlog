using System.Collections;
using System.Text;
using System.Text.Json.Nodes;

using FsusBlog.Contracts.Articles;
using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Tests.Unit;

public sealed class ArticlePackageManifestTaxonomyCodecTests
{
    [Fact]
    public void Roundtrip_BindsExplicitPortablePairsAndExactRawSourceWithoutAuthority()
    {
        ArticlePackageManifestTaxonomyInput input = Input();
        ArticlePackageManifestTaxonomyCandidate candidate = Create(input);
        byte[] encoded = ArticlePackageManifestCandidateCodec.WriteTaxonomyCandidate(candidate);
        var parsedResult = ArticlePackageManifestCandidateCodec.TryParseTaxonomyCandidate(encoded, out var parsed);
        Assert.True(parsedResult.IsValid, parsedResult.ReasonCode);
        Assert.Equal(candidate.ComponentDigest, parsed!.ComponentDigest);
        Assert.Equal(encoded, ArticlePackageManifestCandidateCodec.WriteTaxonomyCandidate(parsed));
        Assert.True(ArticlePackageManifestCandidateCodec.TryBindTaxonomyCandidate(parsed, Source(), "line\r\n"u8, out var bound).IsValid);
        Assert.NotNull(bound);
        Assert.False(bound!.RequireTaxonomyAuthority().IsValid);
        Assert.Equal("article_package_manifest_taxonomy_source_authority_unavailable", bound.RequireTaxonomyAuthority().ReasonCode);
        Assert.Equal("  category\r\n", bound.Input.Category.Name);
        Assert.Null(bound.Input.Category.Description);
        Assert.Equal("", bound.Input.Tags[0].Description);
        Assert.Equal(1, bound.Input.Category.SourceId);
        Assert.Equal(1, bound.Input.Tags[0].SourceId);
        Assert.NotEqual(bound.Input.Category.PortableIdentity, bound.Input.Tags[0].PortableIdentity);
    }

    [Theory]
    [InlineData(ArticlePackageIdentityKind.Category, "portable-category:")]
    [InlineData(ArticlePackageIdentityKind.Tag, "portable-tag:")]
    public void TaxonomyIdentity_RequiresExplicitClosedNamespaceNotNamesIdsRoutesOrOtherKinds(ArticlePackageIdentityKind kind, string prefix)
    {
        string uuid = "00000001-0000-4000-8000-000000000001";
        Assert.True(ArticlePackageIdentity.TryCreate(kind, prefix + uuid, out var id).IsValid);
        Assert.Equal(kind, id.Kind);
        Assert.Equal(uuid, id.FileNameToken);
        foreach (string invalid in new[] { "1", "Title", "/category/1", "https://example.org/1", "article:" + uuid, "portable-asset:" + uuid, prefix + "0000000A-0000-4000-8000-000000000001" })
        {
            Assert.False(ArticlePackageIdentity.TryCreate(kind, invalid, out var rejected).IsValid);
            Assert.Null(rejected.Value);
        }
    }

    [Fact]
    public void Mapping_RejectsMissingExtraDuplicateAliasWrongKindAndSourceDrift()
    {
        ArticlePackageManifestTaxonomyInput input = Input();
        RejectCreate(input with
        {
            Category = input.Category with
            {
                SourceId = 2
            }
        });
        RejectCreate(input with
        {
            Category = input.Category with
            {
                PortableIdentity = input.Tags[0].PortableIdentity
            }
        });
        RejectCreate(input with
        {
            SourceTagIds = [1]
        });
        RejectCreate(input with
        {
            Tags = []
        });
        RejectCreate(input with
        {
            Tags = [input.Tags[0], input.Tags[0]]
        });
        RejectCreate(input with
        {
            Tags = [input.Tags[0], input.Tags[1] with { PortableIdentity = input.Tags[0].PortableIdentity }]
        });
        RejectCreate(input with
        {
            Tags = [input.Tags[0], input.Tags[1] with { SourceId = 3 }]
        });
        RejectCreate(input with
        {
            SourceTagIds = [1, 1]
        });
        RejectCreate(input with
        {
            Tags = [input.Tags[0], input.Tags[1] with { PortableIdentity = default }]
        });
        RejectCreate(input with
        {
            Tags = [null!, input.Tags[1]]
        });
        RejectCreate(input with
        {
            Category = null!
        });
        RejectCreate(input with
        {
            Article = null!
        });
        RejectCreate(null);
        // Equal names are permitted display facts, never used to coalesce distinct identities.
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateTaxonomyCandidate(input with
        {
            Tags = [input.Tags[0], input.Tags[1] with { Name = input.Tags[0].Name }]
        }, out _).IsValid);
    }

    [Fact]
    public void Ordering_IsDeterministicAndSourceIdsRemainIndependentOfPortableOrder()
    {
        ArticlePackageManifestTaxonomyInput input = Input();
        var reversed = input with
        {
            SourceTagIds = [2, 1],
            Tags = input.Tags.Reverse().ToArray()
        };
        Assert.Equal(Create(input).ComponentDigest, Create(reversed).ComponentDigest);
        Assert.Equal(ArticlePackageManifestCandidateCodec.WriteTaxonomyCandidate(Create(input)), ArticlePackageManifestCandidateCodec.WriteTaxonomyCandidate(Create(reversed)));
        var renamed = input with
        {
            Tags = [input.Tags[0] with { Name = "changed" }, input.Tags[1]]
        };
        Assert.NotEqual(Create(input).ComponentDigest, Create(renamed).ComponentDigest);
    }

    [Theory]
    [InlineData("article")]
    [InlineData("revision")]
    [InlineData("revisionNo")]
    [InlineData("category")]
    [InlineData("tags")]
    [InlineData("title")]
    [InlineData("summary")]
    [InlineData("route")]
    [InlineData("cover")]
    [InlineData("status")]
    [InlineData("published")]
    [InlineData("scheduled")]
    [InlineData("markdown")]
    public void ExactBinding_RejectsChangedCanonicalFieldEvenIfOtherCoordinatesMatch(string field)
    {
        ArticleCanonicalInput source = Source();
        source = field switch
        {
            "article" => source with { ArticleId = 2 },
            "revision" => source with { ArticleRevisionId = 12 },
            "revisionNo" => source with { RevisionNo = 3 },
            "category" => source with { CategoryId = 2 },
            "tags" => source with { TagIds = [1, 3] },
            "title" => source with { Title = "changed" },
            "summary" => source with { Summary = "" },
            "route" => source with { PublicRouteKey = "changed" },
            "cover" => source with { CoverImageUrl = "https://example.org/changed" },
            "status" => source with { Status = 2 },
            "published" => source with { PublishedAt = new DateTime(2026, 10, 8, 0, 0, 0, DateTimeKind.Utc) },
            "scheduled" => source with { ScheduledPublishAt = new DateTime(2026, 10, 8, 0, 0, 0, DateTimeKind.Utc) },
            _ => source with { MarkdownContent = "line\n" }
        };
        RejectBind(Create(Input()), source, "line\r\n"u8);
    }

    [Fact]
    public void Binding_RejectsNormalizedHashAliasViaActualByteAndExactMarkdownChecks()
    {
        var candidate = Create(Input());
        var normalized = Source() with
        {
            MarkdownContent = "line\n"
        };
        Assert.Equal(ArticleCanonicalHashV1.ComputeHashHex(Source()), ArticleCanonicalHashV1.ComputeHashHex(normalized));
        RejectBind(candidate, normalized, "line\r\n"u8);
        RejectBind(candidate, normalized, "line\n"u8);
        RejectBind(candidate, Source(), [0xff]);
        RejectBind(candidate, Source(), []);
        RejectBind(candidate, Source() with
        {
            TagIds = [1, 1, 2]
        }, "line\r\n"u8);
        RejectBind(candidate, Source() with
        {
            TagIds = null!
        }, "line\r\n"u8);
        RejectBind(null, Source(), "line\r\n"u8);
        RejectBind(candidate, null, "line\r\n"u8);
        RejectBind(candidate, Source() with
        {
            CoverImageUrl = new string('x', 513)
        }, "line\r\n"u8);
    }

    [Fact]
    public void RawBinding_PreservesUtf8BomRatherThanNormalizingItAway()
    {
        byte[] bytes = [0xef, 0xbb, 0xbf, .. "line\r\n"u8];
        Assert.True(ArticlePackageSourceBytes.Inspect(bytes, out var metadata).IsValid);
        var input = Input();
        var candidate = Create(input with
        {
            Article = input.Article with
            {
                SourceBytes = metadata!
            }
        });
        Assert.True(ArticlePackageManifestCandidateCodec.TryBindTaxonomyCandidate(candidate, Source(), bytes, out _).IsValid);
        RejectBind(candidate, Source(), "line\r\n"u8);
    }

    [Theory]
    [InlineData("root")]
    [InlineData("category")]
    [InlineData("tag")]
    public void Decoder_RejectsUnknownSecretMissingDuplicateOrWrongTypedFields(string level)
    {
        foreach (string name in new[] { "unknown", "token", "session", "privatePath", "storageKey", "auditPayload" })
        {
            JsonObject document = Document();
            ObjectAt(document, level)[name] = "fixture";
            RejectDocument(document);
        }
        JsonObject missing = Document();
        string key = ObjectAt(missing, level).First().Key;
        ObjectAt(missing, level).Remove(key);
        RejectDocument(missing, "article_package_manifest_missing_field");
        JsonObject duplicate = Document();
        string nested = ObjectAt(duplicate, level).ToJsonString();
        string doubled = nested.Insert(1, "\"" + key + "\":" + ObjectAt(duplicate, level)[key]!.ToJsonString() + ",");
        RejectBytes(Encoding.UTF8.GetBytes(duplicate.ToJsonString().Replace(nested, doubled, StringComparison.Ordinal)), "article_package_manifest_duplicate_field");
        JsonObject wrongType = Document();
        if (level == "root")
        {
            wrongType["sourceCategoryId"] = "1";
        }
        else
        {
            ObjectAt(wrongType, level)["sourceId"] = true;
        }
        RejectDocument(wrongType);
    }

    [Theory]
    [InlineData("name")]
    [InlineData("description")]
    [InlineData("portableIdentity")]
    public void Digest_RejectsCopiedDigestAfterEntryDrift(string field)
    {
        JsonObject document = Document();
        document["tags"]![0]![field] = field == "portableIdentity" ? "portable-tag:00000004-0000-4000-8000-000000000001" : "changed";
        RejectDocument(document, "article_package_manifest_taxonomy_digest_mismatch");
    }

    [Fact]
    public void Ownership_CopiesAllCallerCollectionsAndDoesNotExposeWritableRowAliases()
    {
        ArticlePackageManifestTaxonomyInput input = Input();
        var ids = input.SourceTagIds.ToList();
        var tags = input.Tags.ToList();
        var candidate = Create(input with
        {
            SourceTagIds = ids,
            Tags = tags
        });
        byte[] before = ArticlePackageManifestCandidateCodec.WriteTaxonomyCandidate(candidate);
        ids.Clear();
        tags[0] = tags[0] with
        {
            Name = "changed"
        };
        tags.Clear();
        Assert.Equal(before, ArticlePackageManifestCandidateCodec.WriteTaxonomyCandidate(candidate));
        Assert.Throws<NotSupportedException>(() => ((IList<int>)candidate.Input.SourceTagIds)[0] = 99);
        Assert.Throws<NotSupportedException>(() => ((IList<ArticlePackageManifestTaxonomyEntry>)candidate.Input.Tags)[0] = input.Tags[0]);
        byte[] returned = ArticlePackageManifestCandidateCodec.WriteTaxonomyCandidate(candidate);
        returned[0] = 0;
        Assert.Equal(before, ArticlePackageManifestCandidateCodec.WriteTaxonomyCandidate(candidate));
    }

    [Fact]
    public void Budgets_RejectCountTextUnicodeAndOversizeJsonWithoutTruncation()
    {
        ArticlePackageManifestTaxonomyInput input = Input();
        RejectCreate(input with
        {
            SourceTagIds = Enumerable.Range(1, 33).ToArray()
        });
        RejectCreate(input with
        {
            Tags = Enumerable.Repeat(input.Tags[0], 33).ToArray()
        });
        RejectCreate(input with
        {
            Category = input.Category with
            {
                Name = new string('x', 129)
            }
        });
        RejectCreate(input with
        {
            Category = input.Category with
            {
                Description = new string('x', 501)
            }
        });
        RejectCreate(input with
        {
            Category = input.Category with
            {
                Name = "\ud800"
            }
        });
        RejectCreate(input with
        {
            SourceTagIds = [0, 2]
        });
        RejectCreate(input with
        {
            Category = input.Category with
            {
                SourceId = 0
            }
        });
        RejectBytes(new byte[ArticlePackageManifestCandidateCodec.MaxTaxonomyJsonBytes + 1], "article_package_manifest_taxonomy_budget_exceeded");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ForeignCollectionFailure_ProducesContentFreeReasonWithoutEnumeration(bool index)
    {
        var input = Input();
        RejectCreate(input with
        {
            SourceTagIds = new ThrowingList(index)
        }, "article_package_manifest_taxonomy_collection_invalid");
        RejectBind(Create(input), Source() with
        {
            TagIds = new ThrowingList(index)
        }, "line\r\n"u8);
    }

    [Fact]
    public void NoTags_IsAnExplicitEmptySetAndDoesNotInventTaxonomyAuthority()
    {
        var input = Input() with
        {
            SourceTagIds = [],
            Tags = []
        };
        var source = Source() with
        {
            TagIds = []
        };
        input = input with
        {
            Article = input.Article with
            {
                Source = input.Article.Source with
                {
                    CanonicalHash = ArticleCanonicalHashV1.ComputeHashHex(source)
                }
            }
        };
        var candidate = Create(input);
        Assert.True(ArticlePackageManifestCandidateCodec.TryBindTaxonomyCandidate(candidate, source, "line\r\n"u8, out var bound).IsValid);
        Assert.False(bound!.RequireTaxonomyAuthority().IsValid);
    }

    [Fact]
    public void FiniteEnvelope_StillRefusesTaxonomyComponentWithoutFullV1Authority()
    {
        var input = Input();
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate([input.Article], out var manifest).IsValid);
        var document = JsonNode.Parse(ArticlePackageManifestCandidateCodec.WriteCandidate(manifest!))!.AsObject();
        document["articles"]![0]!["taxonomy"] = Document();
        Assert.False(ArticlePackageManifestCandidateCodec.TryParseCandidate(Encoding.UTF8.GetBytes(document.ToJsonString()), out _).IsValid);
    }

    [Fact]
    public void WholeSet_RequiresSharedSiteAndGlobalSourcePortableDisplayBijections()
    {
        var input = Input();
        var first = Create(input);
        var secondInput = input with
        {
            Article = input.Article with
            {
                PortableArticle = Identity(ArticlePackageIdentityKind.Article, "article:", 2),
                Source = input.Article.Source with
                {
                    ArticleId = 2,
                    CanonicalHash = ArticleCanonicalHashV1.ComputeHashHex(Source() with
                    {
                        ArticleId = 2
                    })
                }
            }
        };
        var second = Create(secondInput);
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateTaxonomySetCandidate([first, second], out var set).IsValid);
        Assert.False(set!.RequireTaxonomyAuthority().IsValid);
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateTaxonomySetCandidate([second, first], out var reversed).IsValid);
        Assert.Equal(set.ComponentDigest, reversed!.ComponentDigest);
        foreach (var changed in new[]
        {
            secondInput with { Article = secondInput.Article with { Source = secondInput.Article.Source with { SiteScope = "other-site" } } },
            secondInput with { Category = secondInput.Category with { Name = "drift" } },
            secondInput with { Category = secondInput.Category with { PortableIdentity = Identity(ArticlePackageIdentityKind.Category, "portable-category:", 2) } },
            secondInput with { Category = secondInput.Category with { SourceId = 2 }, SourceCategoryId = 2 },
            secondInput with { Tags = [secondInput.Tags[0] with { Description = "drift" }, secondInput.Tags[1]] }
        })
        {
            Assert.False(ArticlePackageManifestCandidateCodec.TryCreateTaxonomySetCandidate([first, Create(changed)], out var rejected).IsValid);
            Assert.Null(rejected);
        }
        Assert.False(ArticlePackageManifestCandidateCodec.TryCreateTaxonomySetCandidate([first, first], out _).IsValid);
        Assert.False(ArticlePackageManifestCandidateCodec.TryCreateTaxonomySetCandidate([], out _).IsValid);
        Assert.False(ArticlePackageManifestCandidateCodec.TryCreateTaxonomySetCandidate(null, out _).IsValid);
        Assert.False(ArticlePackageManifestCandidateCodec.TryCreateTaxonomySetCandidate([null!], out _).IsValid);
    }

    [Fact]
    public void WholeSet_Accepts1000ArticlesWithSharedTaxonomyAndOwnsCallerArray()
    {
        var input = Input();
        var articles = Enumerable.Range(1, 1000).Select(number => Create(input with
        {
            Article = input.Article with
            {
                PortableArticle = Identity(ArticlePackageIdentityKind.Article, "article:", number),
                Source = input.Article.Source with
                {
                    ArticleId = number
                }
            }
        })).ToArray();
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateTaxonomySetCandidate(articles, out var set).IsValid);
        Assert.Equal(1000, set!.Articles.Count);
        Assert.False(set.RequireTaxonomyAuthority().IsValid);
        string digest = set.ComponentDigest;
        articles[0] = null!;
        Assert.NotNull(set.Articles[0]);
        Assert.Equal(digest, set.ComponentDigest);
        Assert.Throws<NotSupportedException>(() => ((IList<ArticlePackageManifestTaxonomyCandidate>)set.Articles)[0] = null!);
        Assert.False(ArticlePackageManifestCandidateCodec.TryCreateTaxonomySetCandidate(new ArticlePackageManifestTaxonomyCandidate[1001], out _).IsValid);
    }

    [Fact]
    public void WholeSet_EnforcesActualAggregateEncodedBudgetWithoutTruncatingSuccess()
    {
        var input = Input();
        string title = new('x', 20_000);
        var articles = Enumerable.Range(1, 1000).Select(number => Create(input with
        {
            Article = input.Article with
            {
                Title = title,
                PortableArticle = Identity(ArticlePackageIdentityKind.Article, "article:", number),
                Source = input.Article.Source with
                {
                    ArticleId = number,
                    CanonicalHash = ArticleCanonicalHashV1.ComputeHashHex(Source() with
                    {
                        ArticleId = number,
                        Title = title
                    })
                }
            }
        })).ToArray();
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateTaxonomySetCandidate(articles.Take(10).ToArray(), out _).IsValid);
        var result = ArticlePackageManifestCandidateCodec.TryCreateTaxonomySetCandidate(articles, out var rejected);
        Assert.False(result.IsValid);
        Assert.Null(rejected);
        Assert.Equal("article_package_manifest_taxonomy_budget_exceeded", result.ReasonCode);
    }

    private static ArticleCanonicalInput Source()
        => new(1, 11, 2, "article:1", "Title", null, null, 1, [1, 2], 0, null, null, "line\r\n");

    private static ArticlePackageManifestTaxonomyInput Input()
    {
        ArticlePackageIdentity articleId = Identity(ArticlePackageIdentityKind.Article, "article:", 1);
        Assert.True(ArticlePackageSourceBytes.Inspect("line\r\n"u8, out var bytes).IsValid);
        var article = new ArticlePackageManifestArticle(articleId, new(1, 11, 2, ArticleCanonicalHashV1.ComputeHashHex(Source()), "site", 4, null, null, null),
            "Title", null, new string('b', 64), new string('c', 64), new string('d', 64), bytes!, new(0, null, null));
        return new(article, 1, [1, 2], new(Identity(ArticlePackageIdentityKind.Category, "portable-category:", 1), 1, "  category\r\n", null),
            [new(Identity(ArticlePackageIdentityKind.Tag, "portable-tag:", 1), 1, "first", ""), new(Identity(ArticlePackageIdentityKind.Tag, "portable-tag:", 2), 2, "second", "description")]);
    }

    private static ArticlePackageIdentity Identity(ArticlePackageIdentityKind kind, string prefix, int number)
    {
        Assert.True(ArticlePackageIdentity.TryCreate(kind, $"{prefix}{number:x8}-0000-4000-8000-000000000001", out var identity).IsValid);
        return identity;
    }

    private static ArticlePackageManifestTaxonomyCandidate Create(ArticlePackageManifestTaxonomyInput input)
    {
        var result = ArticlePackageManifestCandidateCodec.TryCreateTaxonomyCandidate(input, out var candidate);
        Assert.True(result.IsValid, result.ReasonCode);
        return candidate!;
    }

    private static void RejectCreate(ArticlePackageManifestTaxonomyInput? input, string? reason = null)
    {
        var result = ArticlePackageManifestCandidateCodec.TryCreateTaxonomyCandidate(input, out var candidate);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        if (reason is not null)
            Assert.Equal(reason, result.ReasonCode);
    }

    private static void RejectBind(ArticlePackageManifestTaxonomyCandidate? candidate, ArticleCanonicalInput? source, ReadOnlySpan<byte> bytes)
    {
        var result = ArticlePackageManifestCandidateCodec.TryBindTaxonomyCandidate(candidate, source, bytes, out var rebound);
        Assert.False(result.IsValid);
        Assert.Null(rebound);
        Assert.Equal("article_package_manifest_taxonomy_source_mismatch", result.ReasonCode);
    }

    private static JsonObject Document()
        => JsonNode.Parse(ArticlePackageManifestCandidateCodec.WriteTaxonomyCandidate(Create(Input())))!.AsObject();

    private static JsonObject ObjectAt(JsonObject root, string level)
        => level == "root" ? root : level == "tag" ? root["tags"]![0]!.AsObject() : root[level]!.AsObject();

    private static void RejectDocument(JsonObject document, string? reason = null)
        => RejectBytes(Encoding.UTF8.GetBytes(document.ToJsonString()), reason);

    private static void RejectBytes(byte[] bytes, string? reason = null)
    {
        var result = ArticlePackageManifestCandidateCodec.TryParseTaxonomyCandidate(bytes, out var candidate);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        if (reason is not null)
            Assert.Equal(reason, result.ReasonCode);
    }

    private sealed class ThrowingList(bool index) : IReadOnlyList<int>
    {
        public int Count => index ? 1 : throw new InvalidOperationException("private-token-fixture");
        public int this[int position] => throw new IOException("private-path-fixture");
        public IEnumerator<int> GetEnumerator() => throw new InvalidOperationException("must-not-enumerate");
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
