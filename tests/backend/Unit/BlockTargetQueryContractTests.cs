using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class BlockTargetQueryContractTests
{
    private const string Article = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private static readonly string s_digest = new('a', 64);

    [Fact]
    public void Layers_RequireExactSelectedRevisionAndKeepArticlePageAnchorFree()
    {
        BlockTargetQueryRequest blocks = Request();
        Assert.True(BlockTargetQueryValidator.Validate(blocks).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(blocks with
        {
            Article = null
        })).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(blocks with
        {
            Layer = BlockTargetQueryLayer.Articles
        })).IsValid);
        Assert.True(BlockTargetQueryValidator.Validate(Seal(blocks with
        {
            Layer = BlockTargetQueryLayer.Articles,
            Article = null
        })).IsValid);
        Assert.True(BlockTargetQueryValidator.Validate(Seal(blocks with
        {
            Layer = BlockTargetQueryLayer.Headings
        })).IsValid);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(101)]
    [InlineData(100000)]
    public void Query_RejectsUnboundedOrEmptyPage(int limit)
        => Assert.False(BlockTargetQueryValidator.Validate(Seal(Request() with
        {
            Limit = limit
        })).IsValid);

    [Fact]
    public void Query_RejectsUnknownScopeContractAndHistoricalAuthoringRevision()
    {
        BlockTargetQueryRequest request = Request();
        Assert.False(BlockTargetQueryValidator.Validate(Seal(request with
        {
            Scope = (BlockTargetQueryScope)99
        })).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(request with
        {
            SchemaVersion = 2
        })).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(request with
        {
            Coordinate = request.Coordinate with
            {
                AnchorContractDigest = new string('b', 64)
            }
        })).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(request with
        {
            Article = request.Article! with
            {
                RevisionKind = ArticleRelationRevisionKind.Published
            }
        })).IsValid);
    }

    [Fact]
    public void PublicScope_RequiresPublishedCoordinateAndLifecycle()
    {
        BlockTargetQueryRequest request = Seal(Request() with
        {
            Scope = BlockTargetQueryScope.CurrentPublicPublication,
            Article = Request().Article! with
            {
                RevisionKind = ArticleRelationRevisionKind.Published,
                Lifecycle = ArticleRelationLifecycleState.Published
            }
        });
        BlockTargetQueryToken token = Token(request);
        Assert.True(BlockTargetQueryValidator.Validate(request).IsValid);
        Assert.True(BlockTargetQueryValidator.Validate(token, request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(request with
        {
            Article = request.Article! with
            {
                Lifecycle = ArticleRelationLifecycleState.Draft
            }
        })).IsValid);
    }

    [Fact]
    public void CursorAndToken_RejectEveryCurrentGenerationAndActorDriftEvenWhenResealed()
    {
        BlockTargetQueryRequest request = Request();
        BlockTargetQueryToken token = Token(request);
        BlockTargetQueryCursor cursor = Cursor(request);
        BlockTargetQueryRequest[] drifted =
        [
            request with { Coordinate = request.Coordinate with { ActorIdentity = "actor:other" } },
            request with { Coordinate = request.Coordinate with { SiteIdentity = "site:other" } },
            request with { Coordinate = request.Coordinate with { PermissionContextDigest = new string('b', 64) } },
            request with { Coordinate = request.Coordinate with { PermissionRevision = 2 } },
            request with { Coordinate = request.Coordinate with { RouteRevision = 2 } },
            request with { Article = request.Article! with { CanonicalSlug = "other-slug" } },
            request with { Coordinate = request.Coordinate with { QueryRevision = 2 } },
            request with { Coordinate = request.Coordinate with { IndexRevision = 2 } },
            request with { RequestSequence = 2 },
            request with { Search = "other" },
            request with { Limit = 2 },
            request with { Article = request.Article! with { RevisionIdentity = "revision:other" } },
            request with { Article = request.Article! with { RevisionNumber = 2 } },
            request with { Article = request.Article! with { ContentDigest = new string('b', 64) } }
        ];
        foreach (BlockTargetQueryRequest current in drifted.Select(Seal))
        {
            Assert.True(BlockTargetQueryValidator.Validate(current).IsValid);
            Assert.False(BlockTargetQueryValidator.Validate(token, current).IsValid);
            Assert.False(BlockTargetQueryValidator.Validate(cursor, current).IsValid);
        }
    }

    [Fact]
    public void Token_RejectsIdentitySwapEmptyNodeInvalidRangeAndOversizedSnippet()
    {
        BlockTargetQueryRequest request = Request();
        BlockTargetQueryToken token = Token(request);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(token with
        {
            Target = ArticleBlockTarget.Create("article:01991e72-9a2c-7b60-8f47-b339f58e4a12", token.Target.AnchorId)
        }), request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(token with
        {
            SourceNodeIdentity = string.Empty
        }), request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(token with
        {
            SourceEnd = token.SourceStart
        }), request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(token with
        {
            ContextSnippet = new string('界', 257)
        }), request).IsValid);
        Assert.True(BlockTargetQueryValidator.Validate(Seal(token with
        {
            ContextSnippet = "章节 العربية עברית"
        }), request).IsValid);
    }

    [Theory]
    [InlineData("A")]
    [InlineData("a_b")]
    [InlineData("1a")]
    [InlineData("^a")]
    [InlineData("a%2db")]
    [InlineData("锚点")]
    public void Token_ReusesCanonicalAnchorValidatorWithoutNormalization(string invalid)
    {
        Assert.False(BlockAnchorId.TryCreate(invalid, out _).IsValid);
        BlockTargetQueryRequest request = Request();
        BlockTargetQueryToken token = Token(request) with
        {
            Target = new ArticleBlockTarget(Article, default)
        };
        Assert.False(BlockTargetQueryValidator.Validate(Seal(token), request).IsValid);
    }

    [Theory]
    [InlineData("a")]
    [InlineData("release-notes")]
    public void Token_UsesStableArticleAnchorAndExistingUrlMapping(string anchor)
    {
        BlockTargetQueryRequest request = Seal(Request() with
        {
            Article = Request().Article! with
            {
                CanonicalSlug = "版本 notes"
            }
        });
        BlockTargetQueryToken token = Seal(Token(request) with
        {
            Target = ArticleBlockTarget.Create(Article, BlockAnchorId.Create(anchor)),
            CanonicalSlug = "版本 notes"
        });
        Assert.True(BlockTargetQueryValidator.Validate(token, request).IsValid);
        string markdown = BlockAnchorMarkdownBuilder.Build("link", token.CanonicalSlug, token.Target);
        Assert.Equal($"[link](/posts/%E7%89%88%E6%9C%AC%20notes#{anchor})", markdown);
        Assert.Equal($"^{anchor}", BlockAnchorCodec.BuildSourceMarker(token.Target.AnchorId));
        Assert.Equal(token.Target, (token with
        {
            CanonicalSlug = "new-slug"
        }).Target);
    }

    [Fact]
    public void Token_RejectsResealedRouteSwapAgainstCurrentProjection()
    {
        BlockTargetQueryRequest request = Request();
        BlockTargetQueryToken token = Seal(Token(request) with
        {
            CanonicalSlug = "different-slug"
        });
        Assert.False(BlockTargetQueryValidator.Validate(token, request).IsValid);
    }

    [Theory]
    [InlineData(BlockTargetInventoryDiagnostic.Duplicate)]
    [InlineData(BlockTargetInventoryDiagnostic.Invalid)]
    [InlineData(BlockTargetInventoryDiagnostic.Malformed)]
    [InlineData(BlockTargetInventoryDiagnostic.Orphan)]
    public void DiagnosticPage_CannotCarryFirstMatchOrContinuation(BlockTargetInventoryDiagnostic diagnostic)
    {
        BlockTargetQueryRequest request = Request();
        BlockTargetQueryPage blocked = Seal(Page(request) with
        {
            Status = BlockTargetQueryPageStatus.Blocked,
            Diagnostic = diagnostic,
            Items = []
        });
        Assert.True(BlockTargetQueryValidator.Validate(blocked, request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(blocked with
        {
            Items = [Token(request)]
        }), request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(blocked with
        {
            Next = Cursor(request)
        }), request).IsValid);
    }

    [Fact]
    public void UnavailableAndCancelledPages_DiscloseNoItemsCursorOrDiagnostic()
    {
        BlockTargetQueryRequest request = Request();
        foreach (BlockTargetQueryPageStatus status in new[]
        {
            BlockTargetQueryPageStatus.Unavailable,
            BlockTargetQueryPageStatus.Cancelled
        })
        {
            BlockTargetQueryPage page = Seal(Page(request) with
            {
                Status = status,
                Items = []
            });
            Assert.True(BlockTargetQueryValidator.Validate(page, request).IsValid);
            Assert.False(BlockTargetQueryValidator.Validate(Seal(page with
            {
                Diagnostic = BlockTargetInventoryDiagnostic.Duplicate
            }), request).IsValid);
            Assert.False(BlockTargetQueryValidator.Validate(Seal(page with
            {
                Next = Cursor(request)
            }), request).IsValid);
            Assert.False(BlockTargetQueryValidator.Validate(Seal(page with
            {
                Items = [Token(request)]
            }), request).IsValid);
        }
    }

    [Theory]
    [InlineData(ArticleRelationPermissionState.Denied, ArticleRelationLifecycleState.Draft)]
    [InlineData(ArticleRelationPermissionState.Unknown, ArticleRelationLifecycleState.Draft)]
    [InlineData(ArticleRelationPermissionState.Allowed, ArticleRelationLifecycleState.Archived)]
    [InlineData(ArticleRelationPermissionState.Allowed, ArticleRelationLifecycleState.Deleted)]
    public void UnlinkableCoordinate_OnlyAdmitsContentFreeUnavailablePage(
        ArticleRelationPermissionState permission,
        ArticleRelationLifecycleState lifecycle)
    {
        BlockTargetQueryRequest request = Seal(Request() with
        {
            Article = Request().Article! with
            {
                Permission = permission,
                Lifecycle = lifecycle
            }
        });
        Assert.True(BlockTargetQueryValidator.Validate(request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Token(request), request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(Page(request) with
        {
            Items = []
        }), request).IsValid);
        Assert.True(BlockTargetQueryValidator.Validate(Seal(Page(request) with
        {
            Status = BlockTargetQueryPageStatus.Unavailable,
            Items = []
        }), request).IsValid);
    }

    [Theory]
    [InlineData(ArticleRelationPermissionState.Denied)]
    [InlineData(ArticleRelationPermissionState.Unknown)]
    public void ReadableButUneditableTarget_IsNotAnAuthoringToken(ArticleRelationPermissionState editPermission)
    {
        BlockTargetQueryRequest request = Seal(Request() with
        {
            Article = Request().Article! with
            {
                EditPermission = editPermission
            }
        });
        Assert.True(BlockTargetQueryValidator.Validate(request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Token(request), request).IsValid);
        BlockTargetQueryRequest published = Seal(request with
        {
            Scope = BlockTargetQueryScope.CurrentPublicPublication,
            Article = request.Article! with
            {
                RevisionKind = ArticleRelationRevisionKind.Published,
                Lifecycle = ArticleRelationLifecycleState.Published
            }
        });
        Assert.True(BlockTargetQueryValidator.Validate(Token(published), published).IsValid);
    }

    [Fact]
    public void Page_RejectsDuplicateAnchorsAndOverBudgetInsteadOfTruncating()
    {
        BlockTargetQueryRequest request = Request();
        BlockTargetQueryToken token = Token(request);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(Page(request) with
        {
            Items = [token, token]
        }), request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(Page(request) with
        {
            Items = Enumerable.Repeat(token, 101).ToArray()
        }), request).IsValid);
        Assert.True(BlockTargetQueryValidator.Validate(Seal(Page(request) with
        {
            Items = []
        }), request).IsValid);
    }

    [Fact]
    public void OriginalSeals_RejectRequestCursorTokenAndPageTamper()
    {
        BlockTargetQueryRequest request = Request();
        Assert.False(BlockTargetQueryValidator.Validate(request with
        {
            Search = "changed"
        }).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Cursor(request) with
        {
            Continuation = "changed"
        }, request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Token(request) with
        {
            ContextSnippet = "changed"
        }, request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Page(request) with
        {
            Items = []
        }, request).IsValid);
    }

    [Fact]
    public void Digest_BindsFullInt64RevisionAndRequestSequence()
    {
        BlockTargetQueryRequest request = Request();
        Assert.NotEqual(request.RequestDigest, Seal(request with
        {
            RequestSequence = 1L + (1L << 32)
        }).RequestDigest);
        Assert.NotEqual(request.RequestDigest, Seal(request with
        {
            Article = request.Article! with
            {
                RevisionNumber = 1L + (1L << 32)
            }
        }).RequestDigest);
    }

    [Fact]
    public void ArticleAndHeadingPages_AreLayeredAndDoNotExposeBlockInventories()
    {
        BlockTargetQueryRequest articles = ArticleRequest();
        BlockTargetArticleQueryPage articlePage = ArticlePage(articles);
        Assert.True(BlockTargetQueryValidator.Validate(articlePage, articles).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(articlePage, Request()).IsValid);
        BlockTargetQueryRequest headings = Seal(Request() with
        {
            Layer = BlockTargetQueryLayer.Headings
        });
        BlockTargetHeadingQueryPage headingPage = HeadingPage(headings);
        Assert.True(BlockTargetQueryValidator.Validate(headingPage, headings).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(headingPage, articles).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(headingPage, Request()).IsValid);
    }

    [Fact]
    public void ArticlePage_RejectsDeniedDuplicateHistoricalAndOverBudgetItems()
    {
        BlockTargetQueryRequest request = ArticleRequest();
        BlockTargetArticleQueryPage page = ArticlePage(request);
        BlockTargetArticleQueryItem item = page.Items[0];
        Assert.False(BlockTargetQueryValidator.Validate(Seal(page with
        {
            Items = [item, item]
        }), request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(page with
        {
            Items = [item with { Article = item.Article with { Permission = ArticleRelationPermissionState.Denied } }]
        }), request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(page with
        {
            Items = [item with
            {
                Article = item.Article with
                {
                    RevisionKind = ArticleRelationRevisionKind.Published,
                    Lifecycle = ArticleRelationLifecycleState.Published
                }
            }]
        }), request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(page with
        {
            Items = Enumerable.Repeat(item, 101).ToArray()
        }), request).IsValid);
        Assert.True(BlockTargetQueryValidator.Validate(Seal(page with
        {
            Items = []
        }), request).IsValid);
    }

    [Theory]
    [InlineData(BlockTargetQueryPageStatus.Unavailable)]
    [InlineData(BlockTargetQueryPageStatus.Cancelled)]
    public void ArticleAndHeadingUnavailablePages_CannotCarryContentOrContinuations(BlockTargetQueryPageStatus status)
    {
        BlockTargetQueryRequest articles = ArticleRequest();
        BlockTargetArticleQueryPage articlePage = Seal(ArticlePage(articles) with
        {
            Status = status,
            Items = []
        });
        Assert.True(BlockTargetQueryValidator.Validate(articlePage, articles).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(articlePage with
        {
            Items = ArticlePage(articles).Items
        }), articles).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(articlePage with
        {
            Next = Cursor(articles)
        }), articles).IsValid);
        BlockTargetQueryRequest headings = Seal(Request() with
        {
            Layer = BlockTargetQueryLayer.Headings
        });
        BlockTargetHeadingQueryPage headingPage = Seal(HeadingPage(headings) with
        {
            Status = status,
            Items = []
        });
        Assert.True(BlockTargetQueryValidator.Validate(headingPage, headings).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(headingPage with
        {
            Items = HeadingPage(headings).Items
        }), headings).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(headingPage with
        {
            Next = Cursor(headings)
        }), headings).IsValid);
    }

    [Fact]
    public void HeadingPage_RejectsFirstMatchIdentityAliasesAndOtherSelectedRevision()
    {
        BlockTargetQueryRequest request = Seal(Request() with
        {
            Layer = BlockTargetQueryLayer.Headings
        });
        BlockTargetHeadingQueryPage page = HeadingPage(request);
        BlockTargetHeadingQueryItem item = page.Items[0];
        Assert.False(BlockTargetQueryValidator.Validate(Seal(page with
        {
            Items = [item, item]
        }), request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(page with
        {
            Items = [item with { HeadingIdentity = "heading:title" }]
        }), request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(page with
        {
            Items = [item with { Article = item.Article with { RevisionNumber = 2 } }]
        }), request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(page with
        {
            Items = [item with { Article = item.Article with { CanonicalSlug = "other" } }]
        }), request).IsValid);
    }

    [Theory]
    [InlineData(BlockTargetInventoryDiagnostic.Duplicate)]
    [InlineData(BlockTargetInventoryDiagnostic.Invalid)]
    [InlineData(BlockTargetInventoryDiagnostic.Malformed)]
    [InlineData(BlockTargetInventoryDiagnostic.Orphan)]
    public void HeadingDiagnostics_BlockAllSelectableItems(BlockTargetInventoryDiagnostic diagnostic)
    {
        BlockTargetQueryRequest request = Seal(Request() with
        {
            Layer = BlockTargetQueryLayer.Headings
        });
        BlockTargetHeadingQueryPage page = Seal(HeadingPage(request) with
        {
            Status = BlockTargetQueryPageStatus.Blocked,
            Diagnostic = diagnostic,
            Items = []
        });
        Assert.True(BlockTargetQueryValidator.Validate(page, request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(page with
        {
            Items = HeadingPage(request).Items
        }), request).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(Seal(page with
        {
            Next = Cursor(request)
        }), request).IsValid);
    }

    [Fact]
    public void ArticleAndHeadingPage_RejectTamperAndOutOfOrderResponse()
    {
        BlockTargetQueryRequest articles = ArticleRequest();
        BlockTargetArticleQueryPage articlePage = ArticlePage(articles);
        Assert.False(BlockTargetQueryValidator.Validate(articlePage with
        {
            Items = []
        }, articles).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(articlePage, Seal(articles with
        {
            RequestSequence = 2
        })).IsValid);
        BlockTargetQueryRequest headings = Seal(Request() with
        {
            Layer = BlockTargetQueryLayer.Headings
        });
        BlockTargetHeadingQueryPage headingPage = HeadingPage(headings);
        Assert.False(BlockTargetQueryValidator.Validate(headingPage with
        {
            Items = []
        }, headings).IsValid);
        Assert.False(BlockTargetQueryValidator.Validate(headingPage, Seal(headings with
        {
            Coordinate = headings.Coordinate with
            {
                PermissionRevision = 2
            }
        })).IsValid);
    }

    private static BlockTargetQueryRequest Request()
        => Seal(new BlockTargetQueryRequest(
            BlockTargetQuerySchemas.Request,
            BlockTargetQuerySchemas.Version,
            new BlockTargetQueryCoordinate("actor:author", "site:current", s_digest, 1, 1, 1, 1,
                BlockAnchorSchemas.Version, BlockAnchorSchemas.ContractDigest),
            BlockTargetQueryLayer.Blocks,
            BlockTargetQueryScope.AuthoringCurrent,
            new BlockTargetArticleCoordinate(Article, "revision:current", 1, ArticleRelationRevisionKind.Current,
                ArticleRelationLifecycleState.Draft, ArticleRelationPermissionState.Allowed,
                ArticleRelationPermissionState.Allowed, s_digest, "slug"),
            string.Empty, 100, 1, string.Empty));

    private static BlockTargetQueryToken Token(BlockTargetQueryRequest request)
        => Seal(new BlockTargetQueryToken(
            BlockTargetQuerySchemas.Token, BlockTargetQuerySchemas.Version, request.RequestDigest,
            ArticleBlockTarget.Create(Article, BlockAnchorId.Create("a")), request.Article!,
            "node:canonical", 0, 10, "paragraph", "context", request.Article!.CanonicalSlug, string.Empty));

    private static BlockTargetQueryCursor Cursor(BlockTargetQueryRequest request)
        => Seal(new BlockTargetQueryCursor(BlockTargetQuerySchemas.Cursor, BlockTargetQuerySchemas.Version,
            request.RequestDigest, "opaque-server-continuation", string.Empty));

    private static BlockTargetQueryPage Page(BlockTargetQueryRequest request)
        => Seal(new BlockTargetQueryPage(BlockTargetQuerySchemas.Page, BlockTargetQuerySchemas.Version,
            request.RequestDigest, BlockTargetQueryPageStatus.Ready, BlockTargetInventoryDiagnostic.None,
            [Token(request)], null, string.Empty));

    private static BlockTargetQueryRequest Seal(BlockTargetQueryRequest request)
        => request with
        {
            RequestDigest = BlockTargetQueryDigest.ComputeRequest(request)
        };

    private static BlockTargetQueryToken Seal(BlockTargetQueryToken token)
        => token with
        {
            TokenDigest = BlockTargetQueryDigest.ComputeToken(token)
        };

    private static BlockTargetQueryCursor Seal(BlockTargetQueryCursor cursor)
        => cursor with
        {
            CursorDigest = BlockTargetQueryDigest.ComputeCursor(cursor)
        };

    private static BlockTargetQueryPage Seal(BlockTargetQueryPage page)
        => page with
        {
            PageDigest = BlockTargetQueryDigest.ComputePage(page)
        };

    private static BlockTargetQueryRequest ArticleRequest()
        => Seal(Request() with
        {
            Layer = BlockTargetQueryLayer.Articles,
            Article = null
        });

    private static BlockTargetArticleQueryPage ArticlePage(BlockTargetQueryRequest request)
        => Seal(new BlockTargetArticleQueryPage(
            BlockTargetQuerySchemas.ArticlePage, BlockTargetQuerySchemas.Version, request.RequestDigest,
            BlockTargetQueryPageStatus.Ready, [new BlockTargetArticleQueryItem(Request().Article!, "章节 العربية", 0)],
            null, string.Empty));

    private static BlockTargetHeadingQueryPage HeadingPage(BlockTargetQueryRequest request)
        => Seal(new BlockTargetHeadingQueryPage(
            BlockTargetQuerySchemas.HeadingPage, BlockTargetQuerySchemas.Version, request.RequestDigest,
            BlockTargetQueryPageStatus.Ready, BlockTargetInventoryDiagnostic.None,
            [new BlockTargetHeadingQueryItem(request.Article!, "heading:01991e72-9a2c-7b60-8f47-b339f58e4a13",
                "node:heading", 0, 10, "章节 العربية")], null, string.Empty));

    private static BlockTargetArticleQueryPage Seal(BlockTargetArticleQueryPage page)
        => page with
        {
            PageDigest = BlockTargetQueryDigest.ComputePage(page)
        };

    private static BlockTargetHeadingQueryPage Seal(BlockTargetHeadingQueryPage page)
        => page with
        {
            PageDigest = BlockTargetQueryDigest.ComputePage(page)
        };
}
