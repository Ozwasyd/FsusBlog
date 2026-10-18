using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Tests.Unit;

public sealed class ArticlePackageAssetCollectionTests
{
    [Fact]
    public void CollectionRoundTripBindsEveryEntryAndSharedReferenceWithIndependentDigest()
    {
        var sources = Sources();
        var references = References();
        var inventory = Inventory();
        Assert.True(ArticlePackageAssetCollectionMapper.TryMapCandidate(sources, references, inventory, out var candidate).IsValid);
        Assert.Equal(2, candidate!.Assets.Count);
        Assert.Equal(3, candidate.References.Count);
        Assert.Equal(Bytes().Length * 2L, candidate.TotalAssetBytes);
        Assert.Equal(IndependentDigest(candidate), candidate.ComponentDigest);
        byte[] written = ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(candidate);
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseAssetCollectionCandidate(written, inventory, out var parsed).IsValid);
        Assert.Equal(written, ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(parsed!));
        Assert.Equal(candidate.ComponentDigest, parsed!.ComponentDigest);
        Assert.True(ArticlePackageAssetCollectionMapper.ValidateCandidate(parsed, sources, references, inventory).IsValid);
        Assert.False(ArticlePackageAssetCollectionMapper.ValidateCandidate(null, sources, references, inventory).IsValid);
        Assert.False(parsed.RequireAssetAuthority().IsValid);
        Assert.Equal("article_package_manifest_asset_rights_retention_authority_unavailable", parsed.RequireAssetAuthority().ReasonCode);
        foreach (var asset in parsed.Assets)
        {
            Assert.False(asset.RequireAssetAuthority().IsValid);
            byte[] individual = ArticlePackageManifestCandidateCodec.WriteAssetMetadataCandidate(asset);
            Assert.True(ArticlePackageManifestCandidateCodec.TryParseAssetMetadataCandidate(individual, out var single).IsValid);
            Assert.Equal(asset.Metadata, single!.Metadata);
        }
        string text = Encoding.UTF8.GetString(written);
        foreach (string field in new[] { "storageKey", "storageClass", "ownerAdminPrincipalId", "state", "createdAtUtc", "updatedAtUtc" })
        {
            Assert.DoesNotContain(field, text, StringComparison.Ordinal);
        }
        Assert.DoesNotContain(sources[0].Record.StorageKey.Value, text, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(false, false, true)]
    [InlineData(false, true, false)]
    [InlineData(false, true, true)]
    [InlineData(true, false, false)]
    [InlineData(true, false, true)]
    [InlineData(true, true, false)]
    [InlineData(true, true, true)]
    public void InputAndJsonOrderingCanonicalizeToIdenticalBytes(bool reverseAssets, bool reverseReferences, bool reverseInventory)
    {
        var expected = Candidate();
        var sources = Sources();
        var references = References();
        var inventory = Inventory();
        if (reverseAssets)
        {
            sources.Reverse();
        }
        if (reverseReferences)
        {
            references.Reverse();
        }
        if (reverseInventory)
        {
            inventory.Reverse();
        }
        Assert.True(ArticlePackageAssetCollectionMapper.TryMapCandidate(sources, references, inventory, out var mapped).IsValid);
        Assert.Equal(ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(expected),
            ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(mapped!));
        JsonObject document = Document();
        if (reverseAssets)
        {
            document["assets"] = new JsonArray(document["assets"]!.AsArray().Reverse().Select(static node => node!.DeepClone()).ToArray());
        }
        if (reverseReferences)
        {
            document["references"] = new JsonArray(document["references"]!.AsArray().Reverse().Select(static node => node!.DeepClone()).ToArray());
        }
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseAssetCollectionCandidate(Encode(document), inventory, out var parsed).IsValid);
        Assert.Equal(ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(expected),
            ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(parsed!));
    }

    [Fact]
    public void EmptyAssetCollectionIsValidOnlyWithoutAssetEntriesOrReferences()
    {
        var inventory = Inventory().Where(static entry => !entry.Path.StartsWith("assets/", StringComparison.Ordinal)).ToList();
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateAssetCollectionCandidate([], [], inventory, out var empty).IsValid);
        byte[] bytes = ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(empty!);
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseAssetCollectionCandidate(bytes, inventory, out _).IsValid);
        RejectCreate([], [], Inventory());
        RejectCreate([], References(), inventory);
    }

    [Theory]
    [InlineData("sameEntry")]
    [InlineData("portableAlias")]
    [InlineData("sourceAlias")]
    public void DuplicateIdentitiesAndContradictoryMappingsNeverYieldPartialResults(string kind)
    {
        var sources = Sources();
        sources[1] = kind switch
        {
            "sameEntry" => sources[0],
            "portableAlias" => sources[1] with { PortableAsset = sources[0].PortableAsset },
            _ => sources[1] with { Record = sources[1].Record with { Id = sources[0].Record.Id } }
        };
        RejectMap(sources, References(), Inventory(), "article_package_manifest_asset_collection_duplicate");
        var metadata = Candidate().Assets.Select(static asset => asset.Metadata).ToList();
        metadata[1] = kind switch
        {
            "sameEntry" => metadata[0],
            "portableAlias" => metadata[1] with { PortableAsset = metadata[0].PortableAsset, PackagePath = metadata[0].PackagePath },
            _ => metadata[1] with { SourceAssetId = metadata[0].SourceAssetId }
        };
        RejectCreate(metadata, References(), Inventory(), "article_package_manifest_asset_collection_duplicate");
    }

    [Theory]
    [InlineData("duplicate")]
    [InlineData("unknownAsset")]
    [InlineData("unknownArticle")]
    [InlineData("wrongArticleKind")]
    [InlineData("wrongAssetKind")]
    [InlineData("orphan")]
    public void SharedEdgesRejectDuplicatesDanglingIdentitiesAndOrphanMetadata(string kind)
    {
        var references = References();
        switch (kind)
        {
            case "duplicate":
                references.Add(references[0]);
                break;
            case "unknownAsset":
                references[0] = references[0] with
                {
                    PortableAsset = Asset(99)
                };
                break;
            case "unknownArticle":
                references[0] = references[0] with
                {
                    PortableArticle = Article(99)
                };
                break;
            case "wrongArticleKind":
                references[0] = references[0] with
                {
                    PortableArticle = Asset(99)
                };
                break;
            case "wrongAssetKind":
                references[0] = references[0] with
                {
                    PortableAsset = Article(1)
                };
                break;
            default:
                references.RemoveAll(static reference => reference.PortableAsset == Asset(3));
                break;
        }
        RejectMap(Sources(), references, Inventory());
        RejectCreate(Candidate().Assets.Select(static asset => asset.Metadata).ToArray(), references, Inventory());
    }

    [Theory]
    [InlineData("missingAsset")]
    [InlineData("orphanAsset")]
    [InlineData("size")]
    [InlineData("extension")]
    [InlineData("case")]
    [InlineData("duplicatePath")]
    [InlineData("missingManifest")]
    [InlineData("missingChecksums")]
    [InlineData("missingArticle")]
    [InlineData("link")]
    [InlineData("ratio")]
    public void CompleteInventoryCannotDriftFromCollection(string kind)
    {
        var inventory = Inventory();
        int asset = inventory.FindIndex(static entry => entry.Path == Path(Asset(2)));
        switch (kind)
        {
            case "missingAsset":
                inventory.RemoveAt(asset);
                break;
            case "orphanAsset":
                inventory.Add(Entry(Path(Asset(9)), Bytes().Length));
                break;
            case "size":
                inventory[asset] = Entry(inventory[asset].Path, Bytes().Length + 1);
                break;
            case "extension":
                inventory[asset] = inventory[asset] with
                {
                    Path = Path(Asset(2), ".gif")
                };
                break;
            case "case":
                inventory[asset] = inventory[asset] with
                {
                    Path = inventory[asset].Path.ToUpperInvariant()
                };
                break;
            case "duplicatePath":
                inventory.Add(inventory[asset]);
                break;
            case "missingManifest":
                inventory.RemoveAll(static entry => entry.Path == ArticlePackageInventory.ManifestPath);
                break;
            case "missingChecksums":
                inventory.RemoveAll(static entry => entry.Path == ArticlePackageInventory.ChecksumsPath);
                break;
            case "missingArticle":
                inventory.RemoveAll(static entry => entry.Path.StartsWith("articles/", StringComparison.Ordinal));
                break;
            case "link":
                inventory[asset] = inventory[asset] with
                {
                    Kind = ArticlePackageEntryKind.SymbolicLink
                };
                break;
            default:
                inventory[asset] = inventory[asset] with
                {
                    UncompressedBytes = 101,
                    CompressedBytes = 1
                };
                break;
        }
        RejectMap(Sources(), References(), inventory);
        RejectParse(Encode(Document()), inventory);
    }

    [Theory]
    [InlineData("bytes")]
    [InlineData("size")]
    [InlineData("sha256")]
    [InlineData("mime")]
    [InlineData("extension")]
    [InlineData("dimensions")]
    [InlineData("private")]
    [InlineData("deleting")]
    [InlineData("storage")]
    [InlineData("portable")]
    [InlineData("missingRecord")]
    public void OriginalByteMediaAndPrivacyChecksAreAppliedToEveryEntry(string kind)
    {
        var sources = Sources();
        var source = sources[1];
        sources[1] = kind switch
        {
            "bytes" => source with { SourceBytes = new byte[Bytes().Length] },
            "size" => source with { Record = source.Record with { SizeBytes = source.Record.SizeBytes + 1 } },
            "sha256" => source with { Record = source.Record with { Sha256 = new string('a', 64) } },
            "mime" => source with { Record = source.Record with { MimeType = "image/gif" } },
            "extension" => source with { Record = source.Record with { Extension = ".gif" } },
            "dimensions" => source with { Record = source.Record with { WidthPixels = 2 } },
            "private" => source with { Record = source.Record with { StorageClass = "private" } },
            "deleting" => source with { Record = source.Record with { State = ContentAssetState.PendingDelete } },
            "storage" => source with { Record = source.Record with { StorageKey = default } },
            "portable" => source with { PortableAsset = default },
            _ => source with { Record = null! }
        };
        RejectMap(sources, References(), Inventory());
        Assert.False(ArticlePackageAssetCollectionMapper.ValidateCandidate(Candidate(), sources, References(), Inventory()).IsValid);
    }

    [Fact]
    public void RebindingRecomputesBytesAndCompleteDigestRatherThanTrustingACopiedDigest()
    {
        var candidate = Candidate();
        var sources = Sources();
        byte[] bytes = Bytes();
        bytes[^1] ^= 1;
        sources[1] = sources[1] with
        {
            SourceBytes = bytes,
            Record = Record(11, bytes)
        };
        Assert.True(ArticlePackageAssetCollectionMapper.TryMapCandidate(sources, References(), Inventory(), out var current).IsValid);
        Assert.NotEqual(candidate.ComponentDigest, current!.ComponentDigest);
        Assert.False(ArticlePackageAssetCollectionMapper.ValidateCandidate(candidate, sources, References(), Inventory()).IsValid);
        Assert.Equal(IndependentDigest(current), current.ComponentDigest);
    }

    [Theory]
    [InlineData("size")]
    [InlineData("mime")]
    [InlineData("width")]
    [InlineData("height")]
    public void IdenticalByteDigestsCannotCarryContradictoryContentMetadata(string field)
    {
        var metadata = Candidate().Assets.Select(static asset => asset.Metadata).ToArray();
        var inventory = Inventory();
        metadata[1] = field switch
        {
            "size" => metadata[1] with { SizeBytes = metadata[1].SizeBytes + 1 },
            "mime" => metadata[1] with { MimeType = "image/gif" },
            "width" => metadata[1] with { WidthPixels = 2 },
            _ => metadata[1] with { HeightPixels = 2 }
        };
        int index = inventory.FindIndex(entry => entry.Path == metadata[1].PackagePath);
        inventory[index] = Entry(metadata[1].PackagePath, metadata[1].SizeBytes);
        RejectCreate(metadata, References(), inventory, "article_package_manifest_asset_collection_content_mismatch");
    }

    [Theory]
    [InlineData("asset")]
    [InlineData("source")]
    [InlineData("sha")]
    [InlineData("mime")]
    [InlineData("size")]
    [InlineData("dimensions")]
    [InlineData("edge")]
    [InlineData("digest")]
    public void IndependentlyValidSingleComponentsCannotHideCompleteCollectionDigestDrift(string field)
    {
        var candidate = Candidate();
        var metadata = candidate.Assets.Select(static asset => asset.Metadata).ToArray();
        var references = References();
        var inventory = Inventory();
        if (field == "edge")
        {
            references.RemoveAt(1);
        }
        else if (field != "digest")
        {
            metadata[0] = field switch
            {
                "asset" => metadata[0] with { PortableAsset = Asset(99), PackagePath = Path(Asset(99)) },
                "source" => metadata[0] with { SourceAssetId = Token(99) },
                "sha" => metadata[0] with { Sha256 = new string('a', 64) },
                "mime" => metadata[0] with { MimeType = "image/gif", Sha256 = new string('a', 64) },
                "size" => metadata[0] with { SizeBytes = metadata[0].SizeBytes + 1, Sha256 = new string('a', 64) },
                _ => metadata[0] with { WidthPixels = 2, Sha256 = new string('a', 64) }
            };
            int index = inventory.FindIndex(static entry => entry.Path == Path(Asset(2)));
            inventory[index] = Entry(metadata[0].PackagePath, metadata[0].SizeBytes);
            for (int i = 0; i < references.Count; i++)
            {
                if (references[i].PortableAsset == Asset(2))
                {
                    references[i] = references[i] with
                    {
                        PortableAsset = metadata[0].PortableAsset
                    };
                }
            }
        }
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateAssetCollectionCandidate(metadata, references, inventory, out var changed).IsValid);
        JsonObject document = JsonNode.Parse(ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(changed!))!.AsObject();
        document["componentDigest"] = field == "digest" ? new string('a', 64) : candidate.ComponentDigest;
        RejectParse(Encode(document), inventory, "article_package_manifest_asset_collection_digest_mismatch");
    }

    [Theory]
    [InlineData("token")]
    [InlineData("session")]
    [InlineData("storageKey")]
    [InlineData("ownerAdminPrincipalId")]
    [InlineData("auditPayload")]
    [InlineData("rights")]
    [InlineData("retention")]
    [InlineData("unknown")]
    public void UnknownPrivateAndAuthorityFieldsAreRefusedAtEveryObjectDepth(string field)
    {
        for (int depth = 0; depth < 3; depth++)
        {
            JsonObject document = Document();
            JsonObject target = depth switch
            {
                0 => document,
                1 => document["assets"]![0]!.AsObject(),
                _ => document["references"]![0]!.AsObject()
            };
            target[field] = "fixture";
            RejectParse(Encode(document), Inventory());
        }
    }

    [Theory]
    [InlineData("missingAssets")]
    [InlineData("missingReferences")]
    [InlineData("missingDigest")]
    [InlineData("assetsType")]
    [InlineData("referenceType")]
    [InlineData("assetNull")]
    [InlineData("referenceNull")]
    [InlineData("digestType")]
    [InlineData("digestCase")]
    [InlineData("childDigest")]
    [InlineData("missingChild")]
    [InlineData("missingEdge")]
    [InlineData("pathDrift")]
    public void MalformedCollectionAndOriginalChildShapesFailClosed(string field)
    {
        JsonObject document = Document();
        switch (field)
        {
            case "missingAssets":
                document.Remove("assets");
                break;
            case "missingReferences":
                document.Remove("references");
                break;
            case "missingDigest":
                document.Remove("componentDigest");
                break;
            case "assetsType":
                document["assets"] = new JsonObject();
                break;
            case "referenceType":
                document["references"] = 1;
                break;
            case "assetNull":
                document["assets"]![0] = null;
                break;
            case "referenceNull":
                document["references"]![0] = null;
                break;
            case "digestType":
                document["componentDigest"] = 1;
                break;
            case "digestCase":
                document["componentDigest"] = new string('A', 64);
                break;
            case "childDigest":
                document["assets"]![0]!["componentDigest"] = new string('a', 64);
                break;
            case "missingChild":
                document["assets"]![0]!.AsObject().Remove("sourceAssetId");
                break;
            case "missingEdge":
                document["references"]![0]!.AsObject().Remove("portableAsset");
                break;
            default:
                document["assets"]![0]!["packagePath"] = "assets/../private.png";
                break;
        }
        RejectParse(Encode(document), Inventory());
    }

    [Theory]
    [InlineData("duplicateRoot")]
    [InlineData("duplicateChild")]
    [InlineData("duplicateEdge")]
    [InlineData("comment")]
    [InlineData("trailingComma")]
    [InlineData("utf8")]
    [InlineData("surrogate")]
    [InlineData("depth")]
    [InlineData("document")]
    [InlineData("oversizedChild")]
    public void InvalidJsonEncodingDuplicateKeysAndBudgetsCannotProduceAResult(string kind)
    {
        string json = Encoding.UTF8.GetString(Encode(Document()));
        byte[] bytes = kind switch
        {
            "duplicateRoot" => Encoding.UTF8.GetBytes(json.Insert(1, "\"assets\":[],")),
            "duplicateChild" => Encoding.UTF8.GetBytes(json.Replace("\"sourceAssetId\":", "\"sourceAssetId\":\"duplicate\",\"sourceAssetId\":", StringComparison.Ordinal)),
            "duplicateEdge" => Encoding.UTF8.GetBytes(json.Replace("\"portableArticle\":", "\"portableArticle\":\"duplicate\",\"portableArticle\":", StringComparison.Ordinal)),
            "comment" => Encoding.UTF8.GetBytes("/*comment*/" + json),
            "trailingComma" => Encoding.UTF8.GetBytes(json.Insert(json.Length - 1, ",")),
            "utf8" => [0xff, 0x7b, 0x7d],
            "surrogate" => Encoding.UTF8.GetBytes(json.Replace("image/png", "\\uD800", StringComparison.Ordinal)),
            "depth" => Encoding.UTF8.GetBytes(new string('[', 9) + "0" + new string(']', 9)),
            "document" => new byte[ArticlePackageManifestCandidateCodec.MaxAssetCollectionJsonBytes + 1],
            _ => Encoding.UTF8.GetBytes(json.Replace("image/png", new string('x', ArticlePackageManifestCandidateCodec.MaxAssetMetadataJsonBytes + 1), StringComparison.Ordinal))
        };
        RejectParse(bytes, Inventory());
    }

    [Theory]
    [InlineData("sources")]
    [InlineData("references")]
    [InlineData("inventory")]
    public void NullInputsAndNullRowsAreRejectedWithoutPartialResults(string field)
    {
        RejectMap(field == "sources" ? null : Sources(), field == "references" ? null : References(), field == "inventory" ? null : Inventory());
        var sources = Sources();
        var references = References();
        var inventory = Inventory();
        if (field == "sources")
        {
            sources[1] = null!;
        }
        if (field == "references")
        {
            references[1] = null!;
        }
        if (field == "inventory")
        {
            inventory[1] = null!;
        }
        RejectMap(sources, references, inventory);
    }

    [Fact]
    public void CollectionOwnsListsAndBytesAndReadsOnlyOneBoundedIndexSnapshot()
    {
        var sources = Sources();
        var references = References();
        var inventory = Inventory();
        var sourceList = new IndexList<ArticlePackageAssetCollectionSource>(sources, sources.Count);
        var referenceList = new IndexList<ArticlePackageManifestAssetReference>(references, references.Count);
        var inventoryList = new IndexList<ArticlePackageInventoryEntry>(inventory, inventory.Count);
        Assert.True(ArticlePackageAssetCollectionMapper.TryMapCandidate(sourceList, referenceList, inventoryList, out var mapped).IsValid);
        Assert.Equal(1, sourceList.CountReads);
        Assert.Equal(sources.Count, sourceList.IndexReads);
        Assert.Equal(1, referenceList.CountReads);
        Assert.Equal(references.Count, referenceList.IndexReads);
        Assert.Equal(1, inventoryList.CountReads);
        Assert.Equal(inventory.Count, inventoryList.IndexReads);
        byte[] saved = ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(mapped!);
        sources.Clear();
        references.Clear();
        inventory.Clear();
        Assert.Equal(saved, ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(mapped!));
        Assert.Throws<NotSupportedException>(() => ((IList<ArticlePackageManifestAssetMetadataCandidate>)mapped!.Assets).Clear());
        Assert.Throws<NotSupportedException>(() => ((IList<ArticlePackageManifestAssetReference>)mapped!.References).Clear());
        Assert.Throws<NotSupportedException>(() => ((IList<ArticlePackageInventoryEntry>)mapped!.Inventory).Clear());
        var metadata = mapped!.Assets.Select(static asset => asset.Metadata).ToArray();
        var held = new IndexList<ArticlePackageManifestAssetMetadata>(metadata, metadata.Length);
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateAssetCollectionCandidate(held, mapped.References, mapped.Inventory, out _).IsValid);
        Assert.Equal(1, held.CountReads);
        Assert.Equal(metadata.Length, held.IndexReads);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(ArticlePackageInventory.MaxAssets + 1)]
    public void InvalidAssetCountIsRefusedBeforeIndexOrByteAccess(int count)
    {
        var sources = new IndexList<ArticlePackageAssetCollectionSource>([], count);
        RejectMap(sources, References(), Inventory());
        Assert.Equal(1, sources.CountReads);
        Assert.Equal(0, sources.IndexReads);
        var metadata = new IndexList<ArticlePackageManifestAssetMetadata>([], count);
        RejectCreate(metadata, References(), Inventory());
        Assert.Equal(1, metadata.CountReads);
        Assert.Equal(0, metadata.IndexReads);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public void IndexedCopyFailureCannotExposeAPrefix(int failure)
    {
        var sources = new IndexList<ArticlePackageAssetCollectionSource>(Sources(), 2, failure);
        RejectMap(sources, References(), Inventory());
        var metadata = new IndexList<ArticlePackageManifestAssetMetadata>(Candidate().Assets.Select(static asset => asset.Metadata).ToArray(), 2, failure);
        RejectCreate(metadata, References(), Inventory());
    }

    [Fact]
    public void ActualByteAggregateAndIndividualBudgetsAreCheckedBeforeProjection()
    {
        byte[] large = new byte[ArticlePackageAssetMetadataMapper.MaxCandidateAssetBytes];
        var sources = Enumerable.Range(0, 9).Select(index => new ArticlePackageAssetCollectionSource(Asset(index + 10), Record(index + 20, large), large)).ToArray();
        RejectMap(sources, [], Inventory(), "article_package_manifest_asset_collection_byte_budget_exceeded");
        byte[] tooLarge = new byte[ArticlePackageAssetMetadataMapper.MaxCandidateAssetBytes + 1];
        RejectMap([new(Asset(10), Record(20, tooLarge), tooLarge)], [], Inventory(), "article_package_manifest_asset_collection_byte_budget_exceeded");
    }

    [Fact]
    public void AggregateArchiveBytesPreserveTheOriginalExactInventoryBoundary()
    {
        var assets = new List<ArticlePackageManifestAssetMetadata>();
        var references = new List<ArticlePackageManifestAssetReference>();
        var inventory = new List<ArticlePackageInventoryEntry>
        {
            Entry(ArticlePackageInventory.ManifestPath, 1),
            Entry(ArticlePackageInventory.ChecksumsPath, 1),
            Entry("articles/" + Article(1).FileNameToken + ".md", 1)
        };
        for (int index = 0; index < 16; index++)
        {
            long bytes = ArticlePackageInventory.MaxAssetBytes - (index == 15 ? 3 : 0);
            assets.Add(Metadata(index + 10, bytes));
            references.Add(new(Article(1), Asset(index + 10)));
            inventory.Add(Entry(assets[^1].PackagePath, bytes));
        }
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateAssetCollectionCandidate(assets, references, inventory, out var candidate).IsValid);
        Assert.Equal(ArticlePackageInventory.MaxTotalBytes - 3, candidate!.TotalAssetBytes);
        assets[^1] = assets[^1] with
        {
            SizeBytes = assets[^1].SizeBytes + 1
        };
        inventory[^1] = Entry(assets[^1].PackagePath, assets[^1].SizeBytes);
        RejectCreate(assets, references, inventory, "article_package_total_bytes_exceeded");
    }

    [Fact]
    public void MaximumDistinctAssetsAndReferenceCountsAreBoundedAlongWithSerializedBytes()
    {
        var assets = Enumerable.Range(10, ArticlePackageInventory.MaxAssets).Select(static index => Metadata(index, 1)).ToArray();
        var references = assets.Select(static asset => new ArticlePackageManifestAssetReference(Article(1), asset.PortableAsset)).ToList();
        var inventory = new List<ArticlePackageInventoryEntry>
        {
            Entry(ArticlePackageInventory.ManifestPath, 1), Entry(ArticlePackageInventory.ChecksumsPath, 1),
            Entry("articles/" + Article(1).FileNameToken + ".md", 1)
        };
        inventory.AddRange(assets.Select(static asset => Entry(asset.PackagePath, 1)));
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateAssetCollectionCandidate(assets, references, inventory, out var candidate).IsValid);
        Assert.Equal(ArticlePackageInventory.MaxAssets, candidate!.Assets.Count);
        for (int article = 2; article <= 5; article++)
        {
            inventory.Add(Entry("articles/" + Article(article).FileNameToken + ".md", 1));
            references.AddRange(assets.Select(asset => new ArticlePackageManifestAssetReference(Article(article), asset.PortableAsset)));
        }
        Assert.Equal(ArticlePackageManifestCandidateCodec.MaxAssetCollectionReferences, references.Count);
        RejectCreate(assets, references, inventory, "article_package_manifest_asset_collection_budget_exceeded");
        references.Add(new(Article(1), Asset(10)));
        RejectCreate(assets, references, inventory, "article_package_manifest_asset_collection_input_invalid");
    }

    [Fact]
    public void OriginalEnvelopeStillRefusesCollectionAsPackageAuthority()
    {
        Assert.True(ArticlePackageSourceBytes.Inspect("line\n"u8, out var bytes).IsValid);
        var row = new ArticlePackageManifestArticle(Article(1), new(1, 11, 2, new string('a', 64), "site", 1, null, null, null),
            "Title", null, new string('b', 64), new string('c', 64), new string('d', 64), bytes!, new(0, null, null));
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate([row], out var manifest).IsValid);
        JsonObject document = JsonNode.Parse(ArticlePackageManifestCandidateCodec.WriteCandidate(manifest!))!.AsObject();
        document["assets"] = Document();
        Assert.False(ArticlePackageManifestCandidateCodec.TryParseCandidate(Encode(document), out _).IsValid);
        Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(null!));
    }

    private static ArticlePackageManifestAssetCollectionCandidate Candidate()
    {
        var result = ArticlePackageAssetCollectionMapper.TryMapCandidate(Sources(), References(), Inventory(), out var candidate);
        Assert.True(result.IsValid, result.ReasonCode);
        return candidate!;
    }

    private static List<ArticlePackageAssetCollectionSource> Sources()
        => [new(Asset(2), Record(10, Bytes()), Bytes()), new(Asset(3), Record(11, Bytes()), Bytes())];

    private static List<ArticlePackageManifestAssetReference> References()
        => [new(Article(1), Asset(2)), new(Article(2), Asset(2)), new(Article(1), Asset(3))];

    private static List<ArticlePackageInventoryEntry> Inventory()
        => [Entry(ArticlePackageInventory.ManifestPath, 1), Entry(ArticlePackageInventory.ChecksumsPath, 1),
            Entry("articles/" + Article(1).FileNameToken + ".md", 1), Entry("articles/" + Article(2).FileNameToken + ".md", 1),
            Entry(Path(Asset(2)), Bytes().Length), Entry(Path(Asset(3)), Bytes().Length)];

    private static ArticlePackageManifestAssetMetadata Metadata(int index, long bytes)
        => new(Asset(index), Token(index + 100000), Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Token(index)))),
            "image/png", ".png", bytes, 1, 1, Path(Asset(index)));

    private static ArticlePackageInventoryEntry Entry(string path, long bytes)
        => new(path, ArticlePackageEntryKind.RegularFile, bytes, bytes);

    private static string Token(int index) => $"{index:x8}-0000-4000-8000-000000000001";

    private static ArticlePackageIdentity Article(int index) => Identity(ArticlePackageIdentityKind.Article, "article:" + Token(index));

    private static ArticlePackageIdentity Asset(int index) => Identity(ArticlePackageIdentityKind.Asset, "portable-asset:" + Token(index));

    private static ArticlePackageIdentity Identity(ArticlePackageIdentityKind kind, string text)
    {
        Assert.True(ArticlePackageIdentity.TryCreate(kind, text, out var identity).IsValid);
        return identity;
    }

    private static string Path(ArticlePackageIdentity identity, string extension = ".png") => "assets/" + identity.FileNameToken + extension;

    private static byte[] Bytes()
        => Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZgAAAABJRU5ErkJggg==");

    private static AssetRecord Record(int index, byte[] bytes)
        => new(AssetId.Parse(Token(index)), "public", AssetStorageKey.Parse("content/public/example.png"),
            "image/png", ".png", bytes.Length, Convert.ToHexStringLower(SHA256.HashData(bytes)), 1, 1, 9,
            ContentAssetState.Active, new(2026, 10, 8, 0, 0, 0, TimeSpan.Zero), new(2026, 10, 8, 0, 0, 0, TimeSpan.Zero));

    private static JsonObject Document()
        => JsonNode.Parse(ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(Candidate()))!.AsObject();

    private static byte[] Encode(JsonObject document) => Encoding.UTF8.GetBytes(document.ToJsonString());

    private static void RejectMap(IReadOnlyList<ArticlePackageAssetCollectionSource>? sources,
        IReadOnlyList<ArticlePackageManifestAssetReference>? references, IReadOnlyList<ArticlePackageInventoryEntry>? inventory, string? reason = null)
    {
        var result = ArticlePackageAssetCollectionMapper.TryMapCandidate(sources, references, inventory, out var candidate);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        if (reason is not null)
        {
            Assert.Equal(reason, result.ReasonCode);
        }
    }

    private static void RejectCreate(IReadOnlyList<ArticlePackageManifestAssetMetadata>? metadata,
        IReadOnlyList<ArticlePackageManifestAssetReference>? references, IReadOnlyList<ArticlePackageInventoryEntry>? inventory, string? reason = null)
    {
        var result = ArticlePackageManifestCandidateCodec.TryCreateAssetCollectionCandidate(metadata, references, inventory, out var candidate);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        if (reason is not null)
        {
            Assert.Equal(reason, result.ReasonCode);
        }
    }

    private static void RejectParse(byte[] bytes, IReadOnlyList<ArticlePackageInventoryEntry>? inventory, string? reason = null)
    {
        var result = ArticlePackageManifestCandidateCodec.TryParseAssetCollectionCandidate(bytes, inventory, out var candidate);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        if (reason is not null)
        {
            Assert.Equal(reason, result.ReasonCode);
        }
    }

    // Independent fixed-key writer and SHA256 calculation; no production digest or serializer call.
    private static string IndependentDigest(ArticlePackageManifestAssetCollectionCandidate candidate)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteStartArray("assets");
            foreach (var asset in candidate.Assets.OrderBy(static asset => asset.Metadata.PortableAsset.Value, StringComparer.Ordinal))
            {
                byte[] payload = IndependentAsset(asset.Metadata, null);
                string digest = Hash("fsusblog.article-package.manifest-asset-metadata-candidate.v1", payload);
                Assert.Equal(digest, asset.ComponentDigest);
                writer.WriteRawValue(IndependentAsset(asset.Metadata, digest));
            }
            writer.WriteEndArray();
            writer.WriteStartArray("references");
            foreach (var reference in candidate.References.OrderBy(static edge => edge.PortableArticle.Value, StringComparer.Ordinal)
                .ThenBy(static edge => edge.PortableAsset.Value, StringComparer.Ordinal))
            {
                writer.WriteStartObject();
                writer.WriteString("portableArticle", reference.PortableArticle.Value);
                writer.WriteString("portableAsset", reference.PortableAsset.Value);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        return Hash("fsusblog.article-package.manifest-asset-collection-candidate.v1", stream.ToArray());
    }

    private static byte[] IndependentAsset(ArticlePackageManifestAssetMetadata asset, string? digest)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("portableAsset", asset.PortableAsset.Value);
            writer.WriteString("sourceAssetId", asset.SourceAssetId);
            writer.WriteString("sha256", asset.Sha256);
            writer.WriteString("mimeType", asset.MimeType);
            writer.WriteString("extension", asset.Extension);
            writer.WriteNumber("sizeBytes", asset.SizeBytes);
            if (asset.WidthPixels.HasValue)
            {
                writer.WriteNumber("widthPixels", asset.WidthPixels.Value);
                writer.WriteNumber("heightPixels", asset.HeightPixels!.Value);
            }
            else
            {
                writer.WriteNull("widthPixels");
                writer.WriteNull("heightPixels");
            }
            writer.WriteString("packagePath", asset.PackagePath);
            if (digest is not null)
            {
                writer.WriteString("componentDigest", digest);
            }
            writer.WriteEndObject();
        }
        return stream.ToArray();
    }

    private static string Hash(string domain, byte[] payload)
    {
        byte[] prefix = Encoding.UTF8.GetBytes(domain + "\0");
        byte[] bytes = new byte[prefix.Length + payload.Length];
        prefix.CopyTo(bytes, 0);
        payload.CopyTo(bytes, prefix.Length);
        return Convert.ToHexStringLower(SHA256.HashData(bytes));
    }

    private sealed class IndexList<T>(IReadOnlyList<T> values, int firstCount, int failure = 0) : IReadOnlyList<T>
    {
        public int CountReads
        {
            get; private set;
        }
        public int IndexReads
        {
            get; private set;
        }
        public int Count => ++CountReads == 1 ? firstCount : int.MaxValue;
        public T this[int index]
        {
            get
            {
                IndexReads++;
                if (failure == 1)
                {
                    throw new ArgumentOutOfRangeException(nameof(index));
                }
                if (failure == 2)
                {
                    throw new IndexOutOfRangeException();
                }
                return values[index];
            }
        }
        public IEnumerator<T> GetEnumerator() => throw new InvalidOperationException("Input enumeration is forbidden.");
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
