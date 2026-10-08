using System.Collections;
using System.Text;
using System.Text.Json.Nodes;

using FsusBlog.Contracts.Articles;
using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Tests.Unit;

public sealed class ArticlePackageManifestMetadataCodecTests
{
    [Fact]
    public void Roundtrip_PreservesAllExplicitPolicyAndHistoricalResponsibilityFields()
    {
        ArticlePackageManifestMetadataInput input = Input();
        ArticlePackageManifestMetadataCandidate candidate = Create(input);
        byte[] bytes = ArticlePackageManifestCandidateCodec.WriteMetadataCandidate(candidate);
        var parseResult = ArticlePackageManifestCandidateCodec.TryParseMetadataCandidate(bytes, out var parsed);
        Assert.True(parseResult.IsValid, parseResult.ReasonCode);
        Assert.Equal(candidate.ComponentDigest, parsed!.ComponentDigest);
        Assert.Equal(input.Rights, parsed.Input.Rights);
        Assert.Equal(input.CanonicalRights, parsed.Input.CanonicalRights);
        Assert.Equal(input.RightsPolicyHash, parsed.Input.RightsPolicyHash);
        Assert.Equal(input.Article, parsed.Input.Article);
        Assert.Equal(input.Responsibility.Authors, parsed.Input.Responsibility.Authors);
        Assert.Equal(input.Responsibility.Sources, parsed.Input.Responsibility.Sources);
        Assert.Equal(input.Responsibility.Reviewer, parsed.Input.Responsibility.Reviewer);
        Assert.Equal(input.Responsibility with
        {
            Authors = parsed.Input.Responsibility.Authors,
            Sources = parsed.Input.Responsibility.Sources
        }, parsed.Input.Responsibility);
        Assert.Equal(bytes, ArticlePackageManifestCandidateCodec.WriteMetadataCandidate(parsed));
        Assert.False(parsed.RequireMetadataAuthority().IsValid);
        Assert.Equal("article_package_manifest_metadata_source_authority_unavailable", parsed.RequireMetadataAuthority().ReasonCode);
        Assert.False(parsed.Input.Rights.Enabled);
        Assert.False(parsed.Input.Rights.ProofBindingEnabled);
        Assert.False(parsed.Input.Responsibility.ResponsiblePersonConfirmed);
        Assert.Equal(3, parsed.Input.Responsibility.ResponsibilityVersion);
        Assert.Equal("  exact\r\n", parsed.Input.Responsibility.UpdateSummary);
    }

    [Fact]
    public void Binding_RequiresEveryCurrentFieldDespiteCopiedComponentDigest()
    {
        ArticlePackageManifestMetadataInput input = Input();
        ArticlePackageManifestMetadataCandidate candidate = Create(input);
        Assert.True(ArticlePackageManifestCandidateCodec.TryBindMetadataCandidate(candidate, input, out var rebound).IsValid);
        Assert.NotNull(rebound);
        ArticlePackageManifestMetadataInput changed = input with
        {
            Rights = input.Rights with
            {
                Enabled = true
            }
        };
        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidateCodec.TryBindMetadataCandidate(candidate, changed, out rebound);
        Assert.False(result.IsValid);
        Assert.Equal("article_package_manifest_metadata_binding_mismatch", result.ReasonCode);
        Assert.Null(rebound);
        changed = input with
        {
            Responsibility = input.Responsibility with
            {
                ResponsiblePersonConfirmed = true
            }
        };
        Assert.False(ArticlePackageManifestCandidateCodec.TryBindMetadataCandidate(candidate, changed, out rebound).IsValid);
        Assert.Null(rebound);
        Assert.False(ArticlePackageManifestCandidateCodec.TryBindMetadataCandidate(null, input, out rebound).IsValid);
        Assert.Null(rebound);
    }

    [Theory]
    [InlineData("enabled")]
    [InlineData("proofBindingEnabled")]
    public void Digest_BindsFlagsAbsentFromTheCanonicalRightsPayload(string field)
    {
        JsonObject document = Document();
        document["rights"]![field] = true;
        Reject(document, "article_package_manifest_metadata_digest_mismatch");
    }

    [Theory]
    [InlineData("responsibilityVersion", "4")]
    [InlineData("inheritSiteAuthor", "true")]
    [InlineData("updateSummary", "\"different\"")]
    [InlineData("updateReason", "\"different\"")]
    [InlineData("effectiveAt", "\"2026-10-09T01:02:03.0000000Z\"")]
    [InlineData("conclusionImpact", "\"different\"")]
    [InlineData("methodology", "\"changed\"")]
    [InlineData("applicability", "\"changed\"")]
    [InlineData("limitations", "\"changed\"")]
    [InlineData("responsiblePersonConfirmed", "true")]
    public void Digest_BindsEveryResponsibilityScalar(string field, string replacement)
    {
        JsonObject document = Document();
        document["responsibility"]![field] = JsonNode.Parse(replacement);
        Reject(document, "article_package_manifest_metadata_digest_mismatch");
    }

    [Theory]
    [InlineData("title")]
    [InlineData("url")]
    [InlineData("sourceType")]
    [InlineData("accessedOn")]
    [InlineData("version")]
    [InlineData("citationNote")]
    public void Digest_BindsEachEvidenceField(string field)
    {
        JsonObject document = Document();
        document["responsibility"]!["sources"]![0]![field] = field == "accessedOn" ? "2026-10-09" : field == "url" ? "https://example.org/changed" : "changed";
        Reject(document, "article_package_manifest_metadata_digest_mismatch");
    }

    [Theory]
    [InlineData("name")]
    [InlineData("profileUrl")]
    public void Digest_BindsEachAuthorAndReviewerField(string field)
    {
        foreach (string role in new[] { "author", "reviewer" })
        {
            JsonObject document = Document();
            JsonNode person = role == "author" ? document["responsibility"]!["authors"]![0]! : document["responsibility"]!["reviewer"]!;
            person[field] = field == "profileUrl" ? "https://example.org/changed" : "changed";
            Reject(document, "article_package_manifest_metadata_digest_mismatch");
        }
    }

    [Theory]
    [InlineData("articleId")]
    [InlineData("articleRevisionId")]
    [InlineData("revisionNo")]
    [InlineData("contentCanonicalHash")]
    [InlineData("licenseType")]
    [InlineData("copyrightHolder")]
    [InlineData("copyrightYear")]
    [InlineData("rightsStatement")]
    [InlineData("attributionTemplate")]
    [InlineData("copyPolicy")]
    [InlineData("maxExcerptChars")]
    [InlineData("allowCodeCopy")]
    [InlineData("showPublicBadge")]
    public void CanonicalPolicyBinding_RejectsFieldDriftEvenWhenPolicyHashIsRecomputed(string field)
    {
        ArticlePackageManifestMetadataInput input = Input();
        ArticleRightsCanonicalInput canonical = field switch
        {
            "articleId" => input.CanonicalRights with { ArticleId = 2 },
            "articleRevisionId" => input.CanonicalRights with { ArticleRevisionId = 12 },
            "revisionNo" => input.CanonicalRights with { RevisionNo = 3 },
            "contentCanonicalHash" => input.CanonicalRights with { ContentCanonicalHash = "sha256:" + new string('a', 64) },
            "licenseType" => input.CanonicalRights with { LicenseType = "changed" },
            "copyrightHolder" => input.CanonicalRights with { CopyrightHolder = "changed" },
            "copyrightYear" => input.CanonicalRights with { CopyrightYear = 2025 },
            "rightsStatement" => input.CanonicalRights with { RightsStatement = "changed" },
            "attributionTemplate" => input.CanonicalRights with { AttributionTemplate = "changed" },
            "copyPolicy" => input.CanonicalRights with { CopyPolicy = "changed" },
            "maxExcerptChars" => input.CanonicalRights with { MaxExcerptChars = 1 },
            "allowCodeCopy" => input.CanonicalRights with { AllowCodeCopy = false },
            _ => input.CanonicalRights with { ShowPublicBadge = false }
        };
        RejectCreate(input with
        {
            CanonicalRights = canonical,
            RightsPolicyHash = ArticleRightsCanonicalHashV1.ComputeHashHex(canonical)
        });
    }

    [Fact]
    public void CanonicalPolicyBinding_RejectsMissingOrCopiedPolicyDigest()
    {
        RejectCreate(Input() with
        {
            RightsPolicyHash = "sha256:" + new string('a', 64)
        });
        RejectCreate(Input() with
        {
            RightsPolicyHash = null!
        });
        RejectCreate(Input() with
        {
            CanonicalRights = null!
        });
        RejectCreate(null);
        RejectCreate(Input() with
        {
            Responsibility = null!
        });
        RejectCreate(Input() with
        {
            Article = null!
        });
    }

    [Fact]
    public void Candidate_OwnsIndexedCollectionsAndReturnedSerializationBytes()
    {
        ArticlePackageManifestMetadataInput input = Input();
        var authors = input.Responsibility.Authors.ToList();
        var sources = input.Responsibility.Sources.ToList();
        input = input with
        {
            Responsibility = input.Responsibility with
            {
                Authors = authors,
                Sources = sources
            }
        };
        ArticlePackageManifestMetadataCandidate candidate = Create(input);
        byte[] original = ArticlePackageManifestCandidateCodec.WriteMetadataCandidate(candidate);
        authors[0] = new("changed", null);
        sources.Clear();
        Assert.Equal(original, ArticlePackageManifestCandidateCodec.WriteMetadataCandidate(candidate));
        byte[] exported = ArticlePackageManifestCandidateCodec.WriteMetadataCandidate(candidate);
        exported[0] = 0;
        Assert.Equal(original, ArticlePackageManifestCandidateCodec.WriteMetadataCandidate(candidate));
        Assert.Throws<NotSupportedException>(() => ((IList<ArticleResponsiblePerson>)candidate.Input.Responsibility.Authors)[0] = new("changed", null));
        Assert.False(ArticlePackageManifestCandidateCodec.TryBindMetadataCandidate(candidate, input, out _).IsValid);
    }

    [Fact]
    public void NullEmptyAndHistoricalFalseRemainDistinctWithoutCurrentDefaults()
    {
        ArticlePackageManifestMetadataInput input = Input();
        var responsibility = input.Responsibility with
        {
            InheritSiteAuthor = true,
            Authors = [],
            Reviewer = null,
            Sources = [],
            UpdateSummary = null,
            UpdateReason = "",
            EffectiveAt = null,
            ConclusionImpact = null,
            Methodology = "",
            Applicability = null,
            Limitations = ""
        };
        var candidate = Create(input with
        {
            Responsibility = responsibility
        });
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseMetadataCandidate(ArticlePackageManifestCandidateCodec.WriteMetadataCandidate(candidate), out var parsed).IsValid);
        Assert.Null(parsed!.Input.Responsibility.UpdateSummary);
        Assert.Equal("", parsed.Input.Responsibility.UpdateReason);
        Assert.Empty(parsed.Input.Responsibility.Authors);
        Assert.True(parsed.Input.Responsibility.InheritSiteAuthor);
        Assert.False(parsed.Input.Responsibility.ResponsiblePersonConfirmed);
        Assert.NotEqual(candidate.ComponentDigest, Create(input with
        {
            Responsibility = responsibility with
            {
                UpdateSummary = ""
            }
        }).ComponentDigest);
    }

    [Theory]
    [InlineData("root")]
    [InlineData("rights")]
    [InlineData("canonicalRights")]
    [InlineData("responsibility")]
    [InlineData("author")]
    [InlineData("reviewer")]
    [InlineData("source")]
    public void Decoder_RejectsUnknownSecretMissingAndDuplicateFieldsAtEveryComponentLevel(string level)
    {
        foreach (string name in new[] { "unknown", "token", "session", "uploadCredentials", "privateFilesystemPath", "auditPayload" })
        {
            JsonObject document = Document();
            ObjectAt(document, level)[name] = "must-not-be-admitted";
            Reject(document);
        }
        JsonObject missing = Document();
        JsonObject owner = ObjectAt(missing, level);
        string key = owner.First().Key;
        owner.Remove(key);
        Reject(missing, "article_package_manifest_missing_field");
        JsonObject duplicate = Document();
        string nested = ObjectAt(duplicate, level).ToJsonString();
        string duplicateText = nested.Insert(1, "\"" + key + "\":" + ObjectAt(duplicate, level)[key]!.ToJsonString() + ",");
        string json = duplicate.ToJsonString().Replace(nested, duplicateText, StringComparison.Ordinal);
        RejectBytes(Encoding.UTF8.GetBytes(json), "article_package_manifest_duplicate_field");
    }

    [Theory]
    [InlineData("file:///tmp/private")]
    [InlineData("https://user:password@example.org/")]
    [InlineData("http://localhost/")]
    [InlineData("http://127.0.0.1/")]
    [InlineData("http://10.0.0.1/")]
    [InlineData("http://192.168.1.1/")]
    [InlineData("javascript:alert(1)")]
    public void PublicShape_UsesActualOwnerUrlRulesWithoutFetchingOrInferringPrivacy(string url)
    {
        ArticlePackageManifestMetadataInput input = Input();
        var source = input.Responsibility.Sources[0] with
        {
            Url = url
        };
        RejectCreate(input with
        {
            Responsibility = input.Responsibility with
            {
                Sources = [source]
            }
        });
        RejectCreate(input with
        {
            Responsibility = input.Responsibility with
            {
                Reviewer = new("Reviewer", url)
            }
        });
        var canonical = input.CanonicalRights with
        {
            CanonicalUrl = url
        };
        RejectCreate(input with
        {
            CanonicalRights = canonical,
            RightsPolicyHash = ArticleRightsCanonicalHashV1.ComputeHashHex(canonical)
        });
    }

    [Fact]
    public void Privacy_RefusesWholePrivateSourceInsteadOfDroppingOrRelabelingIt()
    {
        ArticlePackageManifestMetadataInput input = Input();
        RejectCreate(input with
        {
            Responsibility = input.Responsibility with
            {
                Sources = [input.Responsibility.Sources[0] with { IsPublic = false }]
            }
        },
            "article_package_manifest_metadata_private_source_rejected");
        JsonObject document = Document();
        document["responsibility"]!["sources"]![0]!["isPublic"] = false;
        Reject(document, "article_package_manifest_metadata_private_source_rejected");
    }

    [Fact]
    public void Budgets_RefuseOverCountOversizeOutputAndInvalidTextWithoutTruncation()
    {
        ArticlePackageManifestMetadataInput input = Input();
        RejectCreate(input with
        {
            Responsibility = input.Responsibility with
            {
                Authors = Enumerable.Repeat(input.Responsibility.Authors[0], 33).ToArray()
            }
        });
        RejectCreate(input with
        {
            Responsibility = input.Responsibility with
            {
                Sources = Enumerable.Repeat(input.Responsibility.Sources[0], 65).ToArray()
            }
        });
        RejectCreate(input with
        {
            Responsibility = input.Responsibility with
            {
                UpdateSummary = new string('x', 513)
            }
        });
        RejectCreate(input with
        {
            Responsibility = input.Responsibility with
            {
                Methodology = "\ud800"
            }
        });
        RejectCreate(input with
        {
            Responsibility = input.Responsibility with
            {
                Authors = [null!]
            }
        });
        RejectCreate(input with
        {
            Responsibility = input.Responsibility with
            {
                Sources = null!
            }
        });
        RejectCreate(input with
        {
            Responsibility = input.Responsibility with
            {
                ResponsibilityVersion = 0
            }
        });
        RejectCreate(input with
        {
            Responsibility = input.Responsibility with
            {
                EffectiveAt = DateTime.SpecifyKind(DateTime.UtcNow, DateTimeKind.Unspecified)
            }
        });
        ArticleEvidenceSource big = input.Responsibility.Sources[0] with
        {
            CitationNote = new string('x', 4000)
        };
        RejectCreate(input with
        {
            Responsibility = input.Responsibility with
            {
                Sources = Enumerable.Repeat(big, 64).ToArray()
            }
        },
            "article_package_manifest_metadata_budget_exceeded");
        RejectBytes(new byte[ArticlePackageManifestCandidateCodec.MaxMetadataJsonBytes + 1], "article_package_manifest_metadata_budget_exceeded");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ForeignCollections_CountOrIndexFailureIsFixedAndNeverLeaksContent(bool index)
    {
        ArticlePackageManifestMetadataInput input = Input();
        RejectCreate(input with
        {
            Responsibility = input.Responsibility with
            {
                Authors = new ThrowingList(index)
            }
        },
            "article_package_manifest_metadata_collection_invalid");
    }

    [Theory]
    [InlineData("true")]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("null")]
    [InlineData("{\"a\":")]
    [InlineData("/*comment*/{}")]
    public void Decoder_RejectsMalformedOrWrongTypedInputWithoutCandidate(string json)
        => RejectBytes(Encoding.UTF8.GetBytes(json));

    [Fact]
    public void Decoder_RejectsInvalidUtf8EscapesAndNonCanonicalUtcSpelling()
    {
        RejectBytes([0xff]);
        JsonObject document = Document();
        document["responsibility"]!["effectiveAt"] = "2026-10-08T01:02:03+00:00";
        Reject(document);
        document = Document();
        document["rights"]!["enabled"] = "false";
        Reject(document);
        string escaped = Encoding.UTF8.GetString(ArticlePackageManifestCandidateCodec.WriteMetadataCandidate(Create(Input()))).Replace("Ada", "\\uD800", StringComparison.Ordinal);
        RejectBytes(Encoding.UTF8.GetBytes(escaped), "article_package_manifest_utf8_invalid");
    }

    [Fact]
    public void FinitePackageEnvelope_StillRefusesComponentAsMissingFullV1Authority()
    {
        ArticlePackageManifestMetadataInput input = Input();
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate([input.Article], out var manifest).IsValid);
        JsonObject document = JsonNode.Parse(ArticlePackageManifestCandidateCodec.WriteCandidate(manifest!))!.AsObject();
        document["articles"]![0]!["rights"] = Document()["rights"]!.DeepClone();
        Assert.False(ArticlePackageManifestCandidateCodec.TryParseCandidate(Encoding.UTF8.GetBytes(document.ToJsonString()), out var parsed).IsValid);
        Assert.Null(parsed);
    }

    private static ArticlePackageManifestMetadataInput Input()
    {
        Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article, "article:00000001-0000-4000-8000-000000000001", out var identity).IsValid);
        Assert.True(ArticlePackageSourceBytes.Inspect("line\r\n"u8, out var bytes).IsValid);
        var canonicalArticle = new ArticleCanonicalInput(1, 11, 2, null, "Title", null, null, 1, [], 0, null, null, "line\r\n");
        string hash = ArticleCanonicalHashV1.ComputeHashHex(canonicalArticle);
        var article = new ArticlePackageManifestArticle(identity, new(1, 11, 2, hash, "site", 4, null, null, null),
            "Title", null, new string('b', 64), new string('c', 64), new string('d', 64), bytes!, new(0, null, null));
        var rights = new ArticleRightsRequestCoreModel(false, "all-rights-reserved", "Holder", 2026, "exact\r\n", "{title}", "append-attribution", 0, true, true, false);
        var canonical = new ArticleRightsCanonicalInput(1, 11, 2, rights.LicenseType, rights.CopyrightHolder, rights.CopyrightYear,
            rights.RightsStatement, rights.AttributionTemplate, rights.CopyPolicy, rights.MaxExcerptChars, rights.AllowCodeCopy, rights.ShowPublicBadge,
            "https://example.org/article/1", "sha256:" + hash);
        var responsibility = new ArticlePackageManifestResponsibility(3, false, [new("Ada", "https://example.org/author")],
            new("Reviewer", null), [new("Evidence", "https://example.org/evidence", "paper", new(2026, 10, 8), "v1", "exact note", true)],
            "  exact\r\n", "reason", new(2026, 10, 8, 1, 2, 3, DateTimeKind.Utc), "changed", "method", "scope", "limitations", false);
        return new(article, rights, canonical, ArticleRightsCanonicalHashV1.ComputeHashHex(canonical), responsibility);
    }

    private static ArticlePackageManifestMetadataCandidate Create(ArticlePackageManifestMetadataInput input)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidateCodec.TryCreateMetadataCandidate(input, out var candidate);
        Assert.True(result.IsValid, result.ReasonCode);
        return candidate!;
    }

    private static JsonObject Document()
        => JsonNode.Parse(ArticlePackageManifestCandidateCodec.WriteMetadataCandidate(Create(Input())))!.AsObject();

    private static JsonObject ObjectAt(JsonObject root, string level)
        => level switch
        {
            "root" => root,
            "author" => root["responsibility"]!["authors"]![0]!.AsObject(),
            "reviewer" => root["responsibility"]!["reviewer"]!.AsObject(),
            "source" => root["responsibility"]!["sources"]![0]!.AsObject(),
            _ => root[level]!.AsObject()
        };

    private static void RejectCreate(ArticlePackageManifestMetadataInput? input, string? reason = null)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidateCodec.TryCreateMetadataCandidate(input, out var candidate);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        Assert.NotNull(result.ReasonCode);
        if (reason is not null)
        {
            Assert.Equal(reason, result.ReasonCode);
        }
    }

    private static void Reject(JsonObject document, string? reason = null)
        => RejectBytes(Encoding.UTF8.GetBytes(document.ToJsonString()), reason);

    private static void RejectBytes(byte[] bytes, string? reason = null)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidateCodec.TryParseMetadataCandidate(bytes, out var candidate);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        Assert.NotNull(result.ReasonCode);
        if (reason is not null)
        {
            Assert.Equal(reason, result.ReasonCode);
        }
    }

    private sealed class ThrowingList(bool index) : IReadOnlyList<ArticleResponsiblePerson>
    {
        public int Count => index ? 1 : throw new InvalidOperationException("private-token-fixture");
        public ArticleResponsiblePerson this[int value] => throw new IOException("private-path-fixture");
        public IEnumerator<ArticleResponsiblePerson> GetEnumerator() => throw new InvalidOperationException("must-not-enumerate");
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
