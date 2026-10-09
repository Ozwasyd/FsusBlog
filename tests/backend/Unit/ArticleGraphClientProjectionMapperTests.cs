using System.Collections;
using System.Text.Json;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleGraph;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleGraphClientProjectionMapperTests
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public void CompleteProjectionUsesExactClientShapeAndOriginalSeals()
    {
        ArticleGraphRequest request = Request();
        ArticleGraphResult result = ArticleGraphContract.Seal(request, Projection(request));
        var client = ArticleGraphClientProjectionMapper.Map(request, result);
        using JsonDocument document = JsonDocument.Parse(JsonSerializer.SerializeToUtf8Bytes(client, JsonSerializerOptions.Web));
        JsonElement root = document.RootElement;
        AssertKeys(root, "schemaVersion", "identity", "sessionId", "sequence", "requestedDepth", "effectiveDepth",
            "status", "reason", "nodes", "edges", "sourceDigest", "requestDigest", "contentDigest");
        JsonElement identity = root.GetProperty("identity");
        AssertKeys(identity, "actor", "site", "permissionDigest", "rootArticle", "rootRevision", "documentEpoch", "indexGeneration");
        Assert.Equal("actor", identity.GetProperty("actor").GetString());
        Assert.Equal("site", identity.GetProperty("site").GetString());
        Assert.Equal(Digest, identity.GetProperty("permissionDigest").GetString());
        Assert.Equal("root", identity.GetProperty("rootArticle").GetString());
        Assert.Equal("revision", identity.GetProperty("rootRevision").GetString());
        Assert.Equal("epoch", identity.GetProperty("documentEpoch").GetString());
        Assert.Equal("generation", identity.GetProperty("indexGeneration").GetString());
        Assert.Equal(1, root.GetProperty("schemaVersion").GetInt32());
        Assert.Equal("session", client.SessionId);
        Assert.Equal(7, client.Sequence);
        Assert.Equal("complete", client.Status);
        Assert.Null(client.Reason);
        AssertKeys(root.GetProperty("nodes")[0], "articleIdentity", "revisionIdentity", "title", "lifecycle");
        AssertKeys(root.GetProperty("edges")[0], "relationIdentity", "sourceArticle", "targetArticle", "kind", "resolution", "source");
        AssertKeys(root.GetProperty("edges")[0].GetProperty("source"), "articleIdentity", "revisionIdentity", "documentEpoch", "start", "end", "recordDigest");
        var edge = Assert.Single(client.Edges);
        Assert.Equal("relation", edge.RelationIdentity);
        Assert.Equal("root", edge.SourceArticle);
        Assert.Equal("target", edge.TargetArticle);
        Assert.Equal("revision", edge.Source.RevisionIdentity);
        Assert.Equal("root", edge.Source.ArticleIdentity);
        Assert.Equal("epoch", edge.Source.DocumentEpoch);
        Assert.Equal(3, edge.Source.Start);
        Assert.Equal(8, edge.Source.End);
        Assert.Equal(Digest, edge.Source.RecordDigest);
        Assert.Equal(Digest, client.SourceDigest);
        Assert.Equal(result.RequestDigest, client.RequestDigest);
        Assert.Equal(result.ContentDigest, client.ContentDigest);
        Assert.NotEqual(result.ContentDigest, Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(
            JsonSerializer.SerializeToUtf8Bytes(client, JsonSerializerOptions.Web))));
    }

    [Fact]
    public void OmittedDepthMapsToOne()
    {
        ArticleGraphRequest request = Request() with
        {
            RequestedDepth = null
        };
        var client = ArticleGraphClientProjectionMapper.Map(request, ArticleGraphContract.Seal(request, Projection(request)));
        Assert.Equal(1, client.RequestedDepth);
        Assert.Equal(1, client.EffectiveDepth);
    }

    [Fact]
    public void TruncationPreservesEachBudgetReasonAndDepths()
    {
        ArticleGraphRequest request = Request() with
        {
            RequestedDepth = 2,
            ExplicitExpansion = true
        };
        foreach (string reason in new[] { "node-budget", "edge-budget", "payload-budget", "index-budget", "time-budget" })
        {
            ArticleGraphProjection projection = Projection(request) with
            {
                Status = ArticleGraphStatus.Truncated,
                EffectiveDepth = 1,
                Reason = reason
            };
            var client = ArticleGraphClientProjectionMapper.Map(request, ArticleGraphContract.Seal(request, projection));
            Assert.Equal("truncated", client.Status);
            Assert.Equal(reason, client.Reason);
            Assert.Equal(2, client.RequestedDepth);
            Assert.Equal(1, client.EffectiveDepth);
            Assert.Equal(2, client.Nodes.Count);
        }
    }

    [Fact]
    public void RootOnlyCompleteGraphIsNotUnavailable()
    {
        ArticleGraphRequest request = Request();
        ArticleGraphProjection projection = Projection(request) with
        {
            Nodes = [Projection(request).Nodes[0]],
            Edges = [],
            Usage = new(1, 0, 0, 0)
        };
        var client = ArticleGraphClientProjectionMapper.Map(request, ArticleGraphContract.Seal(request, projection));
        Assert.Equal("complete", client.Status);
        Assert.Single(client.Nodes);
        Assert.Empty(client.Edges);
        Reject(request, projection with
        {
            Nodes = [],
            Usage = new(0, 0, 0, 0)
        });
    }

    [Fact]
    public void EmptyTerminalStatesPreserveSealsAndExposeNoPayload()
    {
        ArticleGraphRequest request = Request();
        foreach (var (status, expected) in TerminalStates())
        {
            ArticleGraphResult result = ArticleGraphContract.Seal(request, Empty(request, status));
            var client = ArticleGraphClientProjectionMapper.Map(request, result);
            Assert.Equal(expected, client.Status);
            Assert.Equal("source-refused", client.Reason);
            Assert.Equal(0, client.EffectiveDepth);
            Assert.Equal(1, client.RequestedDepth);
            Assert.Empty(client.Nodes);
            Assert.Empty(client.Edges);
            Assert.Equal("", client.SourceDigest);
            Assert.Equal(result.RequestDigest, client.RequestDigest);
            Assert.Equal(result.ContentDigest, client.ContentDigest);
        }
    }

    [Fact]
    public void EveryEdgeKindUsesExistingClientVocabulary()
    {
        ArticleGraphEdgeKind[] values = [ArticleGraphEdgeKind.Link, ArticleGraphEdgeKind.Embed, ArticleGraphEdgeKind.Broken, ArticleGraphEdgeKind.VisibilityRisk];
        string[] expected = ["link", "embed", "broken", "visibility-risk"];
        Assert.Equal(Enum.GetValues<ArticleGraphEdgeKind>(), values);
        ArticleGraphRequest request = Request();
        for (int index = 0; index < values.Length; index++)
        {
            ArticleGraphProjection projection = Projection(request);
            projection = projection with
            {
                Edges = [projection.Edges[0] with
                {
                    Kind = values[index],
                    TargetArticle = values[index] is ArticleGraphEdgeKind.Broken or ArticleGraphEdgeKind.VisibilityRisk ? null : "target"
                }]
            };
            var client = ArticleGraphClientProjectionMapper.Map(request, ArticleGraphContract.Seal(request, projection));
            Assert.Equal(expected[index], Assert.Single(client.Edges).Kind);
            Assert.Equal(projection.Edges[0].TargetArticle, client.Edges[0].TargetArticle);
        }
    }

    [Fact]
    public void EveryLifecycleUsesExistingClientVocabulary()
    {
        ArticleRelationLifecycleState[] values = [ArticleRelationLifecycleState.Draft, ArticleRelationLifecycleState.Scheduled,
            ArticleRelationLifecycleState.Published, ArticleRelationLifecycleState.Archived, ArticleRelationLifecycleState.Deleted];
        string[] expected = ["draft", "scheduled", "published", "archived", "deleted"];
        Assert.Equal(Enum.GetValues<ArticleRelationLifecycleState>(), values);
        ArticleGraphRequest request = Request();
        for (int index = 0; index < values.Length; index++)
        {
            ArticleGraphProjection projection = Projection(request);
            projection = projection with
            {
                Nodes = [projection.Nodes[0] with
                {
                    Lifecycle = values[index]
                }, projection.Nodes[1]]
            };
            var client = ArticleGraphClientProjectionMapper.Map(request, ArticleGraphContract.Seal(request, projection));
            Assert.Equal(expected[index], client.Nodes[0].Lifecycle);
        }
    }

    [Fact]
    public void EveryResolutionUsesExistingClientVocabulary()
    {
        ArticleRelationResolutionStatus[] values = [ArticleRelationResolutionStatus.Resolved, ArticleRelationResolutionStatus.MissingTarget,
            ArticleRelationResolutionStatus.MissingAnchor, ArticleRelationResolutionStatus.Deleted, ArticleRelationResolutionStatus.Archived,
            ArticleRelationResolutionStatus.Unauthorized, ArticleRelationResolutionStatus.Private, ArticleRelationResolutionStatus.Draft,
            ArticleRelationResolutionStatus.Stale, ArticleRelationResolutionStatus.Ambiguous, ArticleRelationResolutionStatus.Unsupported];
        string[] expected = ["resolved", "missing-target", "missing-anchor", "deleted", "archived", "unauthorized", "private", "draft", "stale", "ambiguous", "unsupported"];
        Assert.Equal(Enum.GetValues<ArticleRelationResolutionStatus>(), values);
        ArticleGraphRequest request = Request();
        for (int index = 0; index < values.Length; index++)
        {
            ArticleGraphProjection projection = Projection(request);
            projection = projection with
            {
                Edges = [projection.Edges[0] with
                {
                    Resolution = values[index]
                }]
            };
            var client = ArticleGraphClientProjectionMapper.Map(request, ArticleGraphContract.Seal(request, projection));
            Assert.Equal(expected[index], client.Edges[0].Resolution);
        }
    }

    [Fact]
    public void UnknownEnumsAreRejected()
    {
        ArticleGraphRequest request = Request();
        ArticleGraphProjection projection = Projection(request);
        Reject(request with
        {
            Scope = (ArticleGraphScope)255
        }, projection);
        Reject(request with
        {
            Filters = request.Filters with
            {
                Kinds = [(ArticleGraphEdgeKind)255]
            }
        }, projection);
        Reject(request, projection with
        {
            Status = (ArticleGraphStatus)255
        });
        Reject(request, projection with
        {
            Nodes = [projection.Nodes[0] with
            {
                Lifecycle = (ArticleRelationLifecycleState)255
            }, projection.Nodes[1]]
        });
        Reject(request, projection with
        {
            Edges = [projection.Edges[0] with
            {
                Kind = (ArticleGraphEdgeKind)255
            }]
        });
        Reject(request, projection with
        {
            Edges = [projection.Edges[0] with
            {
                Resolution = (ArticleRelationResolutionStatus)255
            }]
        });
    }

    [Fact]
    public void ResultEnvelopeIdentityMismatchIsRejected()
    {
        ArticleGraphRequest request = Request();
        ArticleGraphResult result = ArticleGraphContract.Seal(request, Projection(request));
        foreach (ArticleGraphResult changed in new[] { result with { SchemaVersion = 2 }, result with { SessionId = "other" }, result with { Sequence = 8 } })
        {
            Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request, changed with
            {
                ContentDigest = ArticleGraphContract.ComputeDigest(changed)
            }));
        }
    }

    [Fact]
    public void EveryProjectionIdentityMismatchIsRejected()
    {
        ArticleGraphRequest request = Request();
        ArticleGraphIdentity identity = request.Identity;
        ArticleGraphIdentity[] changed =
        [
            identity with { Actor = identity.Actor with { ActorIdentity = "other" } },
            identity with { Actor = identity.Actor with { SiteIdentity = "other" } },
            identity with { Actor = identity.Actor with { PermissionContextDigest = new string('b', 64) } },
            identity with { RootArticle = "other" },
            identity with { RootRevision = "other" },
            identity with { DocumentEpoch = "other" },
            identity with { IndexGeneration = "other" }
        ];
        foreach (ArticleGraphIdentity value in changed)
        {
            Reject(request, Projection(request) with
            {
                Identity = value
            });
            Reject(request, Empty(request, ArticleGraphStatus.Unavailable) with
            {
                Identity = value
            });
        }
    }

    [Fact]
    public void RequestedDepthMismatchIsRejected()
    {
        ArticleGraphRequest request = Request();
        Reject(request, Projection(request) with
        {
            RequestedDepth = 2,
            EffectiveDepth = 2
        });
        Reject(request, Empty(request, ArticleGraphStatus.Refused) with
        {
            RequestedDepth = 2
        });
    }

    [Fact]
    public void ChangedRequestIsRejectedWithoutResealing()
    {
        ArticleGraphRequest request = Request();
        ArticleGraphResult result = ArticleGraphContract.Seal(request, Projection(request));
        ArticleGraphRequest[] changed =
        [
            request with { Scope = ArticleGraphScope.Published },
            request with { ExplicitExpansion = true },
            request with { Filters = request.Filters with { Categories = ["other"] } },
            request with { Filters = request.Filters with { Tags = ["other"] } },
            request with { Filters = request.Filters with { Kinds = [ArticleGraphEdgeKind.Link] } },
            request with { Budget = request.Budget with { QueryMilliseconds = 249 } }
        ];
        foreach (ArticleGraphRequest value in changed)
        {
            Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(value, result));
        }
    }

    [Fact]
    public void RequestDigestMismatchIsRejected()
    {
        ArticleGraphRequest request = Request();
        ArticleGraphResult result = ArticleGraphContract.Seal(request, Projection(request));
        foreach (string digest in new[] { "", new string('b', 64), result.RequestDigest.ToUpperInvariant() })
        {
            ArticleGraphResult changed = result with
            {
                RequestDigest = digest
            };
            Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request, changed with
            {
                ContentDigest = ArticleGraphContract.ComputeDigest(changed)
            }));
        }
    }

    [Fact]
    public void ResultDigestMismatchIsRejected()
    {
        ArticleGraphRequest request = Request();
        ArticleGraphResult result = ArticleGraphContract.Seal(request, Projection(request));
        foreach (string digest in new[] { "", new string('b', 64), result.ContentDigest.ToUpperInvariant() })
        {
            Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request, result with
            {
                ContentDigest = digest
            }));
        }
        Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request, result with
        {
            Projection = result.Projection with
            {
                SourceDigest = new string('b', 64)
            }
        }));
    }

    [Fact]
    public void InvalidRequestIsRejected()
    {
        ArticleGraphRequest request = Request();
        ArticleGraphRequest[] invalid =
        [
            request with { SchemaVersion = 0 },
            request with { Sequence = -1 },
            request with { Sequence = 9_007_199_254_740_992 },
            request with { SessionId = "bad id" },
            request with { RequestedDepth = 0 },
            request with { RequestedDepth = 2 },
            request with { Budget = request.Budget with { Nodes = 1001 } },
            request with { Budget = request.Budget with { Edges = 2001 } },
            request with { Budget = request.Budget with { PayloadBytes = 1_048_577 } },
            request with { Budget = request.Budget with { IndexOperations = 4097 } },
            request with { Budget = request.Budget with { QueryMilliseconds = 251 } },
            request with { Filters = request.Filters with { Categories = ["duplicate", "duplicate"] } },
            request with { Filters = request.Filters with { Kinds = [] } }
        ];
        foreach (ArticleGraphRequest value in invalid)
        {
            Reject(value, Projection(request));
        }
        request = request with
        {
            Scope = ArticleGraphScope.Published,
            Sequence = 9_007_199_254_740_991
        };
        Assert.Equal(request.Sequence, ArticleGraphClientProjectionMapper.Map(request, ArticleGraphContract.Seal(request, Projection(request))).Sequence);
    }

    [Fact]
    public void OversizedCollectionsAreRejectedBeforeReadingElements()
    {
        ArticleGraphRequest request = Request();
        ArticleGraphResult result = ArticleGraphContract.Seal(request, Projection(request));
        Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request with
        {
            Filters = request.Filters with
            {
                Categories = new OversizedList<string>(33)
            }
        }, result));
        Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request with
        {
            Filters = request.Filters with
            {
                Tags = new OversizedList<string>(33)
            }
        }, result));
        Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request with
        {
            Filters = request.Filters with
            {
                Kinds = new OversizedList<ArticleGraphEdgeKind>(5)
            }
        }, result));
        Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request, result with
        {
            Projection = result.Projection with
            {
                Nodes = new OversizedList<ArticleGraphNode>(1001)
            }
        }));
        Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request, result with
        {
            Projection = result.Projection with
            {
                Edges = new OversizedList<ArticleGraphEdge>(2001)
            }
        }));
        Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request with
        {
            Budget = request.Budget with
            {
                Nodes = 1
            }
        }, result));
    }

    [Fact]
    public void OversizedTextIsRejectedBeforeDigestVerification()
    {
        ArticleGraphRequest request = Request();
        ArticleGraphResult result = ArticleGraphContract.Seal(request, Projection(request));
        Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request with
        {
            SessionId = new string('a', 1_048_577)
        }, result));
        foreach (ArticleGraphProjection projection in new[]
        {
            result.Projection with { Reason = new string('a', 1_048_577) },
            result.Projection with { SourceDigest = new string('a', 65) },
            result.Projection with { Nodes = [result.Projection.Nodes[0] with { Title = new string('a', 257) }] },
            result.Projection with { Edges = [result.Projection.Edges[0] with { Source = result.Projection.Edges[0].Source with { DocumentEpoch = new string('a', 129) } }] }
        })
        {
            Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request, result with
            {
                Projection = projection
            }));
        }
    }

    [Fact]
    public void OversizedRequestBytesAreRejected()
    {
        ArticleGraphRequest request = Request();
        request = request with
        {
            Budget = request.Budget with
            {
                PayloadBytes = 1024
            },
            Filters = request.Filters with
            {
                Categories = Enumerable.Range(0, 32).Select(index => $"{index:D2}{new string('a', 126)}").ToArray()
            }
        };
        Assert.Null(ArticleGraphContract.Validate(request));
        Assert.True(JsonSerializer.SerializeToUtf8Bytes(request).Length > request.Budget.PayloadBytes);
        Reject(request, Empty(request, ArticleGraphStatus.Unavailable));
    }

    [Fact]
    public void OversizedOriginalResultBytesAreRejected()
    {
        ArticleGraphRequest request = Request();
        ArticleGraphProjection projection = Projection(request);
        int projectionBytes = JsonSerializer.SerializeToUtf8Bytes(projection).Length;
        request = request with
        {
            Budget = request.Budget with
            {
                PayloadBytes = Math.Max(1024, projectionBytes)
            }
        };
        ArticleGraphResult result = ArticleGraphContract.Seal(request, projection);
        Assert.Null(ArticleGraphContract.Validate(request, projection));
        Assert.True(JsonSerializer.SerializeToUtf8Bytes(result).Length > request.Budget.PayloadBytes);
        Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request, result));
    }

    [Fact]
    public void OversizedClientBytesAreRejected()
    {
        ArticleGraphRequest request = Request();
        ArticleGraphProjection projection = Projection(request);
        projection = projection with
        {
            Edges = Enumerable.Range(0, 30).Select(index => projection.Edges[0] with
            {
                RelationIdentity = $"relation-{index:D2}",
                Kind = ArticleGraphEdgeKind.VisibilityRisk,
                Resolution = ArticleRelationResolutionStatus.MissingTarget
            }).ToArray(),
            Usage = new(2, 30, 0, 30)
        };
        ArticleGraphResult result = ArticleGraphContract.Seal(request, projection);
        var client = ArticleGraphClientProjectionMapper.Map(request, result);
        int resultBytes = JsonSerializer.SerializeToUtf8Bytes(result).Length;
        Assert.True(JsonSerializer.SerializeToUtf8Bytes(client, JsonSerializerOptions.Web).Length > resultBytes);
        request = request with
        {
            Budget = request.Budget with
            {
                PayloadBytes = resultBytes
            }
        };
        Assert.Null(ArticleGraphContract.Validate(request, projection));
        Reject(request, projection);
    }

    [Fact]
    public void NonemptyTerminalResponsesAreRejected()
    {
        ArticleGraphRequest request = Request();
        foreach (var (status, _) in TerminalStates())
        {
            ArticleGraphProjection empty = Empty(request, status);
            ArticleGraphProjection[] invalid =
            [
                empty with { Nodes = Projection(request).Nodes },
                empty with { Edges = Projection(request).Edges },
                empty with { EffectiveDepth = 1 },
                empty with { SourceDigest = Digest },
                empty with { Usage = new(1, 0, 0, 0) },
                empty with { Usage = new(0, 1, 0, 0) },
                empty with { Usage = new(0, 0, 1, 0) },
                empty with { Usage = new(0, 0, 0, 1) },
                empty with { Reason = null }
            ];
            foreach (ArticleGraphProjection value in invalid)
            {
                Reject(request, value);
            }
        }
    }

    [Fact]
    public void MalformedProjectionIsRejected()
    {
        ArticleGraphRequest request = Request();
        ArticleGraphProjection projection = Projection(request);
        ArticleGraphProjection[] invalid =
        [
            projection with { Nodes = projection.Nodes.Reverse().ToArray() },
            projection with { Nodes = [projection.Nodes[0], projection.Nodes[0]] },
            projection with { Nodes = [projection.Nodes[0] with { RevisionIdentity = "other" }, projection.Nodes[1]] },
            projection with { EffectiveDepth = 0 },
            projection with { Reason = "node-budget" },
            projection with { Status = ArticleGraphStatus.Truncated, Reason = "unknown" },
            projection with { Usage = new(99, 1, 0, 1) },
            projection with { Usage = new(2, 99, 0, 1) },
            projection with { Usage = new(2, 1, -1, 1) },
            projection with { Usage = new(2, 1, 0, 4097) },
            projection with { SourceDigest = new string('A', 64) }
        ];
        foreach (ArticleGraphProjection value in invalid)
        {
            Reject(request, value);
        }
        ArticleGraphEdge edge = projection.Edges[0];
        ArticleGraphEdge[] edges =
        [
            edge with { SourceArticle = "unknown" },
            edge with { TargetArticle = "unknown" },
            edge with { TargetArticle = null },
            edge with { Source = edge.Source with { ArticleIdentity = "target" } },
            edge with { Source = edge.Source with { RevisionIdentity = "other" } },
            edge with { Source = edge.Source with { DocumentEpoch = "other" } },
            edge with { Source = edge.Source with { Start = -1 } },
            edge with { Source = edge.Source with { End = 3 } },
            edge with { Source = edge.Source with { RecordDigest = "bad" } }
        ];
        foreach (ArticleGraphEdge value in edges)
        {
            Reject(request, projection with
            {
                Edges = [value]
            });
        }
        Reject(request, projection with
        {
            Edges = [edge, edge],
            Usage = new(2, 2, 0, 1)
        });
    }

    [Fact]
    public void MutationAfterSealingIsRejected()
    {
        ArticleGraphRequest request = Request();
        List<string> categories = ["category"];
        List<string> tags = ["tag"];
        List<ArticleGraphEdgeKind> kinds = request.Filters.Kinds.ToList();
        request = request with
        {
            Filters = new(categories, tags, kinds)
        };
        ArticleGraphProjection projection = Projection(request);
        List<ArticleGraphNode> nodes = projection.Nodes.ToList();
        List<ArticleGraphEdge> edges = projection.Edges.ToList();
        projection = projection with
        {
            Nodes = nodes,
            Edges = edges
        };
        ArticleGraphResult result = ArticleGraphContract.Seal(request, projection);
        categories[0] = "other";
        Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request, result));
        categories[0] = "category";
        tags[0] = "other";
        Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request, result));
        tags[0] = "tag";
        kinds.Reverse();
        Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request, result));
        kinds.Reverse();
        ArticleGraphNode originalNode = nodes[0];
        nodes[0] = originalNode with
        {
            Title = "Changed"
        };
        Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request, result));
        nodes[0] = originalNode;
        edges[0] = edges[0] with
        {
            Source = edges[0].Source with
            {
                Start = 4
            }
        };
        Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request, result));
    }

    [Fact]
    public void MappedCollectionsRemainIsolatedAndReadOnly()
    {
        ArticleGraphRequest request = Request();
        List<string> categories = ["category"];
        request = request with
        {
            Filters = request.Filters with
            {
                Categories = categories
            }
        };
        ArticleGraphProjection projection = Projection(request);
        List<ArticleGraphNode> nodes = projection.Nodes.ToList();
        List<ArticleGraphEdge> edges = projection.Edges.ToList();
        ArticleGraphResult result = ArticleGraphContract.Seal(request, projection with
        {
            Nodes = nodes,
            Edges = edges
        });
        var client = ArticleGraphClientProjectionMapper.Map(request, result);
        byte[] before = JsonSerializer.SerializeToUtf8Bytes(client, JsonSerializerOptions.Web);
        categories.Clear();
        nodes[0] = nodes[0] with
        {
            Title = "Changed"
        };
        edges[0] = edges[0] with
        {
            Source = edges[0].Source with
            {
                Start = 4
            }
        };
        nodes.Clear();
        edges.Clear();
        Assert.Equal(before, JsonSerializer.SerializeToUtf8Bytes(client, JsonSerializerOptions.Web));
        Assert.Throws<NotSupportedException>(() => ((IList<ArticleGraphClientProjectionMapper.ClientNode>)client.Nodes).Clear());
        Assert.Throws<NotSupportedException>(() => ((IList<ArticleGraphClientProjectionMapper.ClientEdge>)client.Edges).Clear());
    }

    [Fact]
    public void NullStructureIsRejected()
    {
        ArticleGraphRequest request = Request();
        ArticleGraphResult result = ArticleGraphContract.Seal(request, Projection(request));
        Assert.Throws<ArgumentNullException>(() => ArticleGraphClientProjectionMapper.Map(null!, result));
        Assert.Throws<ArgumentNullException>(() => ArticleGraphClientProjectionMapper.Map(request, null!));
        ArticleGraphRequest[] requests =
        [
            request with { Identity = null! },
            request with { Identity = request.Identity with { Actor = null! } },
            request with { Filters = null! },
            request with { Budget = null! },
            request with { Filters = request.Filters with { Categories = null! } },
            request with { Filters = request.Filters with { Tags = [null!] } }
        ];
        foreach (ArticleGraphRequest value in requests)
        {
            Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(value, result));
        }
        Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request, result with { Projection = null! }));
        ArticleGraphProjection projection = result.Projection;
        ArticleGraphProjection[] projections =
        [
            projection with { Usage = null! },
            projection with { Identity = null! },
            projection with { Nodes = null! },
            projection with { Edges = null! },
            projection with { Nodes = [null!] },
            projection with { Nodes = [projection.Nodes[0] with { Title = null! }] },
            projection with { Edges = [null!] },
            projection with { Edges = [projection.Edges[0] with { Source = null! }] }
        ];
        foreach (ArticleGraphProjection value in projections)
        {
            Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request, result with { Projection = value }));
        }
    }

    private static ArticleGraphRequest Request() => new(1, new(new("actor", "site", Digest), "root", "revision", "epoch", "generation"),
        "session", 7, ArticleGraphScope.CurrentEditable, 1, false,
        new([], [], [ArticleGraphEdgeKind.Link, ArticleGraphEdgeKind.Embed, ArticleGraphEdgeKind.Broken, ArticleGraphEdgeKind.VisibilityRisk]), ArticleGraphBudget.Default);

    private static ArticleGraphProjection Projection(ArticleGraphRequest request) => new(request.Identity, request.RequestedDepth ?? 1,
        request.RequestedDepth ?? 1, ArticleGraphStatus.Complete, null,
        [new("root", "revision", "Root", ArticleRelationLifecycleState.Draft), new("target", "target-revision", "Target", ArticleRelationLifecycleState.Published)],
        [new("relation", "root", "target", ArticleGraphEdgeKind.Link, ArticleRelationResolutionStatus.Resolved,
            new("root", "revision", "epoch", 3, 8, Digest))], new(2, 1, 0, 1), Digest);

    private static ArticleGraphProjection Empty(ArticleGraphRequest request, ArticleGraphStatus status)
        => new(request.Identity, request.RequestedDepth ?? 1, 0, status, "source-refused", [], [], new(0, 0, 0, 0), "");

    private static (ArticleGraphStatus Status, string Expected)[] TerminalStates()
        => [(ArticleGraphStatus.Unavailable, "unavailable"), (ArticleGraphStatus.Refused, "refused"),
            (ArticleGraphStatus.Stale, "stale"), (ArticleGraphStatus.Cancelled, "cancelled")];

    private static void Reject(ArticleGraphRequest request, ArticleGraphProjection projection)
        => Assert.Throws<ArgumentException>(() => ArticleGraphClientProjectionMapper.Map(request, ArticleGraphContract.Seal(request, projection)));

    private static void AssertKeys(JsonElement element, params string[] expected)
        => Assert.Equal(expected.Order(StringComparer.Ordinal), element.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal));

    private sealed class OversizedList<T>(int count) : IReadOnlyList<T>
    {
        public int Count => count;
        public T this[int index] => throw new InvalidOperationException("Oversized input must not be read.");
        public IEnumerator<T> GetEnumerator() => throw new InvalidOperationException("Oversized input must not be enumerated.");
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
