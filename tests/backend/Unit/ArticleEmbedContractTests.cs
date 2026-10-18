using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Shared.Contracts.ArticleEmbeds;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleEmbedContractTests
{
    private const string ArticleA = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private const string ArticleB = "article:01991e72-a611-7d16-9fd4-38f7d2e65498";
    private const string HeadingA = "heading:01991e72-b871-7a86-bc95-5518cf8bd7dc";
    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string DigestC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    [Theory]
    [InlineData(ArticleA, ArticleEmbedTargetKind.Article, null, null)]
    [InlineData(ArticleA + "#" + HeadingA, ArticleEmbedTargetKind.Heading, HeadingA, null)]
    [InlineData(ArticleA + "#release-notes-2026", ArticleEmbedTargetKind.Block, null, "release-notes-2026")]
    public void TargetCodec_RoundTripsExactArticleHeadingAndBlockTargets(
        string token,
        ArticleEmbedTargetKind mode,
        string? heading,
        string? block)
    {
        ArticleEmbedValidationResult validation = ArticleEmbedTargetCodec.TryDecode(token, mode, out ArticleEmbedTargetIdentity? target);

        Assert.True(validation.IsValid, validation.ReasonCode);
        Assert.NotNull(target);
        Assert.Equal(ArticleA, target.PortableArticleIdentity);
        Assert.Equal(mode, target.Kind);
        Assert.Equal(heading, target.HeadingIdentity);
        Assert.Equal(block, target.BlockAnchor);
        Assert.Equal(token, ArticleEmbedTargetCodec.Encode(target));
        Assert.DoesNotContain('^', ArticleEmbedTargetCodec.Encode(target));
    }

    [Theory]
    [InlineData("42", ArticleEmbedTargetKind.Article)]
    [InlineData("my-article", ArticleEmbedTargetKind.Article)]
    [InlineData("Article Title", ArticleEmbedTargetKind.Article)]
    [InlineData("https://example.test/article", ArticleEmbedTargetKind.Article)]
    [InlineData("/posts/article", ArticleEmbedTargetKind.Article)]
    [InlineData("../article.md", ArticleEmbedTargetKind.Article)]
    [InlineData("article:00000000-0000-0000-0000-000000000000", ArticleEmbedTargetKind.Article)]
    [InlineData("article:01991E72-9A2C-7B60-8F47-B339F58E4A11", ArticleEmbedTargetKind.Article)]
    [InlineData(ArticleA + "#fragment", ArticleEmbedTargetKind.Article)]
    [InlineData(ArticleA, ArticleEmbedTargetKind.Heading)]
    [InlineData(ArticleA + "#title", ArticleEmbedTargetKind.Heading)]
    [InlineData(ArticleA + "#heading:00000000-0000-0000-0000-000000000000", ArticleEmbedTargetKind.Heading)]
    [InlineData(ArticleA + "#^anchor", ArticleEmbedTargetKind.Block)]
    [InlineData(ArticleA + "#Anchor", ArticleEmbedTargetKind.Block)]
    [InlineData(ArticleA + "#anchor_name", ArticleEmbedTargetKind.Block)]
    [InlineData(ArticleA + "#anchor#other", ArticleEmbedTargetKind.Block)]
    [InlineData(ArticleA, (ArticleEmbedTargetKind)99)]
    public void TargetCodec_RejectsDatabaseSlugTitleUrlPathModeGuessAndInvalidFragments(
        string token,
        ArticleEmbedTargetKind mode)
    {
        ArticleEmbedValidationResult validation = ArticleEmbedTargetCodec.TryDecode(token, mode, out ArticleEmbedTargetIdentity? target);

        Assert.False(validation.IsValid);
        Assert.Null(target);
    }

    [Fact]
    public void ProviderRequest_BindsFsusUiProjectionHostScopeActorRuntimeSignalAndDigests()
    {
        using var cancellation = new CancellationTokenSource();
        ArticleEmbedProviderRequest request = ValidRequest(ArticleEmbedRequestedScope.Authoring, cancellation.Token);

        Assert.True(ArticleEmbedContractValidator.Validate(request).IsValid);
        Assert.Equal(ArticleEmbedSchemas.ParserContract, request.Directive.ParserContract);
        Assert.Equal(new ArticleEmbedSourceRange(16, 112), request.Directive.RawRange);
        Assert.Equal(ArticleEmbedSchemas.ProviderRuntime, request.Runtime.RuntimeVersion);

        AssertInvalidRequest(request with
        {
            SchemaVersion = 2
        }, "article_embed_request_schema_unknown");
        AssertInvalidRequest(request with
        {
            HostPortableArticleIdentity = "19"
        }, "article_embed_host_coordinate_invalid");
        AssertInvalidRequest(request with
        {
            SourceRevision = 0
        }, "article_embed_host_coordinate_invalid");
        AssertInvalidRequest(request with
        {
            AbortSignal = CancellationToken.None
        }, "article_embed_abort_signal_required");
        AssertInvalidRequest(request with
        {
            Directive = request.Directive with
            {
                ParserContract = "blog.second-parser.v1"
            }
        }, "article_embed_directive_projection_invalid");
        AssertInvalidRequest(request with
        {
            Directive = request.Directive with
            {
                Mode = ArticleEmbedTargetKind.Block
            }
        }, "article_embed_directive_target_binding_mismatch");
        AssertInvalidRequest(request with
        {
            RequestedScope = (ArticleEmbedRequestedScope)99
        }, "article_embed_scope_unknown");
        AssertInvalidRequest(request with
        {
            Runtime = request.Runtime with
            {
                RuntimeVersion = "fsusblog.article-embed-provider.v2"
            }
        }, "article_embed_runtime_context_invalid");
        AssertInvalidRequest(request with
        {
            ContentDigest = DigestB
        }, "article_embed_request_digest_mismatch");
    }

    [Fact]
    public void ProviderResult_SeparatesAuthoringCurrentFromFrozenPublicPolicy()
    {
        using var cancellation = new CancellationTokenSource();
        ArticleEmbedProviderRequest authoring = ValidRequest(ArticleEmbedRequestedScope.Authoring, cancellation.Token);
        ArticleEmbedProviderResult currentDraft = ValidResult(
            authoring,
            ArticleEmbedVisibilityStatus.Private,
            ArticleEmbedLifecycleStatus.Draft);

        Assert.True(ArticleEmbedContractValidator.Validate(currentDraft, authoring).IsValid);

        ArticleEmbedProviderRequest publication = ValidRequest(ArticleEmbedRequestedScope.PublicationPlan, cancellation.Token);
        ArticleEmbedProviderResult frozenPublic = ValidResult(
            publication,
            ArticleEmbedVisibilityStatus.Public,
            ArticleEmbedLifecycleStatus.Published);
        Assert.True(ArticleEmbedContractValidator.Validate(frozenPublic, publication).IsValid);

        ArticleEmbedProviderResult draftInPublication = ArticleEmbedContractValidator.Seal(frozenPublic with
        {
            Visibility = ArticleEmbedVisibilityStatus.Private,
            Lifecycle = ArticleEmbedLifecycleStatus.Draft
        });
        ArticleEmbedValidationResult rejected = ArticleEmbedContractValidator.Validate(draftInPublication, publication);
        Assert.False(rejected.IsValid);
        Assert.Equal("article_embed_publication_target_not_frozen_public", rejected.ReasonCode);
    }

    [Fact]
    public void ProviderResult_RoundTripsWithoutLosingBoundAttribution()
    {
        using var cancellation = new CancellationTokenSource();
        ArticleEmbedProviderRequest request = ValidRequest(ArticleEmbedRequestedScope.Authoring, cancellation.Token);
        ArticleEmbedProviderResult original = ValidResult(request, ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Published);
        ArticleEmbedProviderResult restored = JsonSerializer.Deserialize<ArticleEmbedProviderResult>(JsonSerializer.Serialize(original))!;

        Assert.Equal(original, restored);
        Assert.True(ArticleEmbedContractValidator.Validate(restored, request).IsValid);
    }

    [Theory]
    [InlineData("", "Html")]
    [InlineData("", "Component")]
    [InlineData("", "Service")]
    [InlineData("Coordinate", "Latest")]
    [InlineData("Coordinate.Target", "DatabaseId")]
    [InlineData("Projection", "Dom")]
    [InlineData("Attribution", "Url")]
    [InlineData("Budgets", "FutureBudget")]
    public void ProviderResult_RejectsUnknownFieldsAtEveryNestedBoundary(string path, string field)
    {
        using var cancellation = new CancellationTokenSource();
        ArticleEmbedProviderRequest request = ValidRequest(ArticleEmbedRequestedScope.Authoring, cancellation.Token);
        JsonObject json = JsonSerializer.SerializeToNode(ValidResult(request,
            ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Published))!.AsObject();
        JsonObject boundary = json;
        foreach (string property in path.Split('.', StringSplitOptions.RemoveEmptyEntries))
        {
            boundary = boundary[property]!.AsObject();
        }
        boundary[field] = new JsonObject { ["payload"] = "untrusted" };

        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<ArticleEmbedProviderResult>(json.ToJsonString()));
    }

    [Theory]
    [InlineData("", "Latest")]
    [InlineData("HostDocument", "DatabaseId")]
    [InlineData("Directive", "Html")]
    [InlineData("Directive.RawRange", "DomPath")]
    [InlineData("Target", "Slug")]
    [InlineData("Actor", "Service")]
    [InlineData("Runtime", "Component")]
    public void ProviderRequest_RejectsUnknownFieldsAtEveryNestedBoundary(string path, string field)
    {
        using var cancellation = new CancellationTokenSource();
        JsonObject json = JsonSerializer.SerializeToNode(ValidRequest(ArticleEmbedRequestedScope.Authoring, cancellation.Token))!.AsObject();
        JsonObject boundary = json;
        foreach (string property in path.Split('.', StringSplitOptions.RemoveEmptyEntries))
        {
            boundary = boundary[property]!.AsObject();
        }
        boundary[field] = "untrusted";

        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<ArticleEmbedProviderRequest>(json.ToJsonString()));
    }

    [Fact]
    public void ProviderResult_RejectsResealedAttributionTamper()
    {
        using var cancellation = new CancellationTokenSource();
        ArticleEmbedProviderRequest request = ValidRequest(ArticleEmbedRequestedScope.Authoring, cancellation.Token);
        ArticleEmbedProviderResult original = ValidResult(request, ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Published);
        foreach (ArticleEmbedAttribution changed in new[]
        {
            original.Attribution! with { DisplayText = "Different title" },
            original.Attribution! with { AttributionDigest = DigestB }
        })
        {
            ArticleEmbedProviderResult tampered = ArticleEmbedContractValidator.Seal(original with
            {
                Attribution = changed
            });
            Assert.Equal("article_embed_resolved_payload_mismatch", ArticleEmbedContractValidator.Validate(tampered, request).ReasonCode);
        }
    }

    [Fact]
    public void ErrorTaxonomy_IsClosedAndEveryRequiredFailureValidates()
    {
        using var cancellation = new CancellationTokenSource();
        ArticleEmbedProviderRequest request = ValidRequest(ArticleEmbedRequestedScope.Authoring, cancellation.Token);

        ArticleEmbedErrorCode[] expected =
        [
            ArticleEmbedErrorCode.Missing,
            ArticleEmbedErrorCode.Ambiguous,
            ArticleEmbedErrorCode.InvalidTarget,
            ArticleEmbedErrorCode.PermissionDenied,
            ArticleEmbedErrorCode.PermissionUnknown,
            ArticleEmbedErrorCode.Private,
            ArticleEmbedErrorCode.Draft,
            ArticleEmbedErrorCode.Unpublished,
            ArticleEmbedErrorCode.Archived,
            ArticleEmbedErrorCode.Deleted,
            ArticleEmbedErrorCode.HeadingMissing,
            ArticleEmbedErrorCode.HeadingDuplicate,
            ArticleEmbedErrorCode.BlockMissing,
            ArticleEmbedErrorCode.BlockDuplicate,
            ArticleEmbedErrorCode.Cycle,
            ArticleEmbedErrorCode.DepthExceeded,
            ArticleEmbedErrorCode.SizeExceeded,
            ArticleEmbedErrorCode.TimeExceeded,
            ArticleEmbedErrorCode.StaleSource,
            ArticleEmbedErrorCode.StaleTarget,
            ArticleEmbedErrorCode.StaleRuntime
        ];
        Assert.Equal(expected, Enum.GetValues<ArticleEmbedErrorCode>());

        foreach (ArticleEmbedErrorCode code in expected)
        {
            ArticleEmbedProviderResult failure = FailureResult(request, code);
            ArticleEmbedValidationResult validation = ArticleEmbedContractValidator.Validate(failure, request);
            Assert.True(validation.IsValid, $"{code}: {validation.ReasonCode}");
        }

        ArticleEmbedProviderResult unknown = ArticleEmbedContractValidator.Seal(FailureResult(request, expected[0]) with
        {
            Error = new((ArticleEmbedErrorCode)99, "future-error")
        });
        Assert.Equal(
            "article_embed_failed_payload_invalid",
            ArticleEmbedContractValidator.Validate(unknown, request).ReasonCode);
    }

    [Fact]
    public void DependencyCoordinate_IsSharedStableIdentityAndRejectsTamper()
    {
        ArticleEmbedTargetCodec.TryDecode(
            ArticleA + "#" + HeadingA,
            ArticleEmbedTargetKind.Heading,
            out ArticleEmbedTargetIdentity? target);
        ArticleEmbedDependencyCoordinate coordinate = ArticleEmbedContractValidator.Seal(new ArticleEmbedDependencyCoordinate(
            ArticleEmbedSchemas.DependencyCoordinate,
            ArticleEmbedSchemas.Version,
            target!,
            17,
            "revision:17",
            "projection:heading-subtree",
            DigestA,
            string.Empty));

        Assert.True(ArticleEmbedContractValidator.Validate(coordinate).IsValid);
        string digest = coordinate.DependencyDigest;
        var firstAttribution = new ArticleEmbedAttribution(ArticleA, 17, "Old title", DigestB);
        var renamedAttribution = firstAttribution with
        {
            DisplayText = "Renamed title and slug"
        };
        Assert.Equal(digest, coordinate.DependencyDigest);
        Assert.NotEqual(firstAttribution.DisplayText, renamedAttribution.DisplayText);

        Assert.Equal(
            "article_embed_dependency_digest_mismatch",
            ArticleEmbedContractValidator.Validate(coordinate with
            {
                ResolvedRevision = 18
            }).ReasonCode);
        Assert.Equal(
            "article_embed_dependency_digest_mismatch",
            ArticleEmbedContractValidator.Validate(coordinate with
            {
                ProjectionDigest = DigestB
            }).ReasonCode);
    }

    [Fact]
    public void Result_RejectsRequestCoordinateProjectionAttributionStateAndDigestTamper()
    {
        using var cancellation = new CancellationTokenSource();
        ArticleEmbedProviderRequest request = ValidRequest(ArticleEmbedRequestedScope.Authoring, cancellation.Token);
        ArticleEmbedProviderResult result = ValidResult(
            request,
            ArticleEmbedVisibilityStatus.Public,
            ArticleEmbedLifecycleStatus.Published);

        Assert.Equal(
            "article_embed_result_request_binding_mismatch",
            ArticleEmbedContractValidator.Validate(
                ArticleEmbedContractValidator.Seal(result with
                {
                    RequestId = "request:other"
                }),
                request).ReasonCode);
        Assert.Equal(
            "article_embed_dependency_digest_mismatch",
            ArticleEmbedContractValidator.Validate(
                ArticleEmbedContractValidator.Seal(result with
                {
                    Coordinate = result.Coordinate! with
                    {
                        ResolvedRevision = 99
                    }
                }),
                request).ReasonCode);
        Assert.Equal(
            "article_embed_resolved_payload_mismatch",
            ArticleEmbedContractValidator.Validate(
                ArticleEmbedContractValidator.Seal(result with
                {
                    Projection = result.Projection! with
                    {
                        ProjectionIdentity = "projection:other"
                    }
                }),
                request).ReasonCode);
        Assert.Equal(
            "article_embed_result_digest_mismatch",
            ArticleEmbedContractValidator.Validate(result with
            {
                ResultDigest = DigestC
            }, request).ReasonCode);
    }

    [Fact]
    public void Schema_IsEmbeddedClosedVersionedAndContainsNoExecutableOrHtmlResultSurface()
    {
        string resourceName = "FsusBlog.Contracts.ArticleEmbeds.article-embed-contract.schema.json";
        Assert.Contains(resourceName, typeof(ArticleEmbedSchemas).Assembly.GetManifestResourceNames());
        using Stream stream = typeof(ArticleEmbedSchemas).Assembly.GetManifestResourceStream(resourceName)!;
        using JsonDocument schema = JsonDocument.Parse(stream);
        JsonElement definitions = schema.RootElement.GetProperty("$defs");

        foreach (string name in new[] { "providerRequest", "providerResult", "dependencyCoordinate", "target" })
        {
            Assert.False(definitions.GetProperty(name).GetProperty("additionalProperties").GetBoolean());
        }

        JsonElement sourceGrammar = schema.RootElement
            .GetProperty("x-fsusblog-contract")
            .GetProperty("sourceGrammar");
        Assert.Equal(ArticleEmbedSchemas.ParserPackage, sourceGrammar.GetProperty("ownerPackage").GetString());
        Assert.Equal(ArticleEmbedSchemas.ParserExport, sourceGrammar.GetProperty("parserExport").GetString());
        Assert.True(sourceGrammar.GetProperty("modeRequired").GetBoolean());
        Assert.Equal(
            new[] { "article", "heading", "block" },
            sourceGrammar.GetProperty("modes").EnumerateArray().Select(item => item.GetString()));

        string[] resultFields = definitions.GetProperty("providerResult")
            .GetProperty("properties")
            .EnumerateObject()
            .Select(property => property.Name)
            .ToArray();
        Assert.DoesNotContain(resultFields, name =>
            name.Contains("html", StringComparison.OrdinalIgnoreCase)
            || name.Contains("dom", StringComparison.OrdinalIgnoreCase)
            || name.Contains("component", StringComparison.OrdinalIgnoreCase)
            || name.Contains("iframe", StringComparison.OrdinalIgnoreCase)
            || name.Contains("service", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void ProviderContracts_ContainNoResolutionPublicationCacheOrUiImplementation()
    {
        Type[] contractTypes = typeof(ArticleEmbedSchemas).Assembly.GetTypes()
            .Where(type => type.Namespace == typeof(ArticleEmbedSchemas).Namespace)
            .ToArray();
        Assert.DoesNotContain(contractTypes, type =>
            type.Name.Contains("Resolver", StringComparison.Ordinal)
            || type.Name.Contains("Cache", StringComparison.Ordinal)
            || type.Name.Contains("Renderer", StringComparison.Ordinal)
            || type.Name.Contains("Finalizer", StringComparison.Ordinal));
        Assert.DoesNotContain(typeof(ArticleEmbedProviderResult).GetProperties(), property =>
            property.Name.Contains("Html", StringComparison.OrdinalIgnoreCase)
            || property.PropertyType.Name.Contains("Component", StringComparison.OrdinalIgnoreCase));
    }

    private static ArticleEmbedProviderRequest ValidRequest(
        ArticleEmbedRequestedScope scope,
        CancellationToken cancellationToken)
    {
        ArticleEmbedTargetCodec.TryDecode(ArticleA, ArticleEmbedTargetKind.Article, out ArticleEmbedTargetIdentity? target);
        return ArticleEmbedContractValidator.Seal(new ArticleEmbedProviderRequest(
            ArticleEmbedSchemas.ProviderRequest,
            ArticleEmbedSchemas.Version,
            "request:01991e72-c397-75a2-b61a-da6d7dbd8092",
            ArticleB,
            new("document:01991e72-d093-78ad-b06d-8f7664902992", 3),
            8,
            new(
                ArticleEmbedSchemas.ParserContract,
                ArticleA,
                ArticleEmbedTargetKind.Article,
                new(16, 112)),
            target!,
            scope,
            new("actor:01991e72-dbed-74bd-a467-027699b78ad8", "site:primary", DigestA),
            new("article-embed", 1, ArticleEmbedSchemas.ProviderRuntime, DigestB),
            DigestC,
            string.Empty,
            cancellationToken));
    }

    private static ArticleEmbedProviderResult ValidResult(
        ArticleEmbedProviderRequest request,
        ArticleEmbedVisibilityStatus visibility,
        ArticleEmbedLifecycleStatus lifecycle)
    {
        ArticleEmbedDependencyCoordinate coordinate = ArticleEmbedContractValidator.Seal(new ArticleEmbedDependencyCoordinate(
            ArticleEmbedSchemas.DependencyCoordinate,
            ArticleEmbedSchemas.Version,
            request.Target,
            17,
            "revision:17",
            "projection:article-body",
            DigestA,
            string.Empty));
        return ArticleEmbedContractValidator.Seal(new ArticleEmbedProviderResult(
            ArticleEmbedSchemas.ProviderResult,
            ArticleEmbedSchemas.Version,
            request.RequestId,
            request.RequestDigest,
            ArticleEmbedProviderResultStatus.Resolved,
            coordinate,
            new(ArticleEmbedProjectionKind.Markdown, coordinate.ProjectionIdentity, coordinate.ProjectionDigest),
            new(request.Target.PortableArticleIdentity, coordinate.ResolvedRevision, "Target title",
                ArticleEmbedContractDigest.ComputeAttribution(request.Target.PortableArticleIdentity, coordinate.ResolvedRevision, "Target title")),
            visibility,
            lifecycle,
            ArticleEmbedPermissionStatus.Allowed,
            new(1, 1, 128, 4),
            null,
            string.Empty));
    }

    private static ArticleEmbedProviderResult FailureResult(
        ArticleEmbedProviderRequest request,
        ArticleEmbedErrorCode code)
    {
        ArticleEmbedVisibilityStatus visibility = code == ArticleEmbedErrorCode.Private
            ? ArticleEmbedVisibilityStatus.Private
            : ArticleEmbedVisibilityStatus.Unknown;
        ArticleEmbedLifecycleStatus lifecycle = code switch
        {
            ArticleEmbedErrorCode.Draft => ArticleEmbedLifecycleStatus.Draft,
            ArticleEmbedErrorCode.Unpublished => ArticleEmbedLifecycleStatus.Scheduled,
            ArticleEmbedErrorCode.Archived => ArticleEmbedLifecycleStatus.Archived,
            ArticleEmbedErrorCode.Deleted => ArticleEmbedLifecycleStatus.Deleted,
            _ => ArticleEmbedLifecycleStatus.Unknown
        };
        ArticleEmbedPermissionStatus permission = code switch
        {
            ArticleEmbedErrorCode.PermissionDenied => ArticleEmbedPermissionStatus.Denied,
            ArticleEmbedErrorCode.PermissionUnknown => ArticleEmbedPermissionStatus.Unknown,
            _ => ArticleEmbedPermissionStatus.Unknown
        };
        string reason = ToReasonCode(code);
        return ArticleEmbedContractValidator.Seal(new ArticleEmbedProviderResult(
            ArticleEmbedSchemas.ProviderResult,
            ArticleEmbedSchemas.Version,
            request.RequestId,
            request.RequestDigest,
            ArticleEmbedProviderResultStatus.Failed,
            null,
            null,
            null,
            visibility,
            lifecycle,
            permission,
            new(0, 0, 0, 0),
            new(code, reason),
            string.Empty));
    }

    private static string ToReasonCode(ArticleEmbedErrorCode code)
    {
        string name = code.ToString();
        var characters = new List<char>(name.Length + 4);
        for (int index = 0; index < name.Length; index++)
        {
            char character = name[index];
            if (index > 0 && char.IsUpper(character))
            {
                characters.Add('-');
            }
            characters.Add(char.ToLowerInvariant(character));
        }
        return new string([.. characters]);
    }

    private static void AssertInvalidRequest(ArticleEmbedProviderRequest request, string expectedReason)
    {
        ArticleEmbedValidationResult validation = ArticleEmbedContractValidator.Validate(request);
        Assert.False(validation.IsValid);
        Assert.Equal(expectedReason, validation.ReasonCode);
    }
}
