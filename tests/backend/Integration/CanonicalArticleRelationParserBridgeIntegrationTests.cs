using System.Collections.Immutable;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.BlockLinks;

using NSubstitute;

namespace FsusBlog.Server.Tests.Integration;

// Real Node/public-runtime/WASM controls. Permission/portable registry fixtures are
// explicitly not production admission, corpus-generation or full parsed-source evidence.
[Trait("Category", "Integration")]
[Trait("Dependency", "FsusUI")]
public sealed class CanonicalArticleRelationParserBridgeIntegrationTests
{
    private const string SourceArticle = "article:20000000-0000-4000-8000-000000000001";
    private const string TargetArticle = "article:20000000-0000-4000-8000-000000000002";
    private const string PublicEntryDigest = "ae4ff05e9ff018052551d0f82ab00ae05988f582b43a2261409243f16535967a";
    private const string WasmModuleDigest = "f2f2c9ce3babd60852c008fd683161143c99ed4968a418902c615c1b0f8ac842";
    private static readonly string s_permission = new('a', 64);
    private static readonly ArticleRelationActorContext s_actor = new("actor:bridge-test", "site:primary", s_permission);

    [Fact]
    public async Task RealWasm_PreservesRawCoordinatesAndSeparatesLinksAnchorsEmbeds()
    {
        string source = "\uFEFF# 标题 ^head-a\r\n\r\n> مرحبا 😀 [go](/posts/post-a#anchor-a)\r\n\r\n"
            + "::embed[target=\"opaque-registry-token\" mode=\"block\"]\r\n\r\n"
            + "```md\r\n[not-link](/posts/hidden#anchor-a)\r\n```\r\n";
        var fixture = Fixture(source);
        CanonicalArticleRelationParserBridge.ParsedSource parsed = await fixture.Bridge.ReadAsync(fixture.Request);
        var output = parsed.Projection;
        Assert.Equal("fsus-markdown-runtime", output.Parser);
        Assert.Equal("markdown-wasm-contract@2026-07-29", output.Version);
        Assert.Equal(WasmModuleDigest, output.WasmModuleDigest);
        Assert.Equal(PublicEntryDigest, output.PublicEntryDigest);
        Assert.StartsWith("markdown:", output.SourceIdentity);
        Assert.Equal(Digest(source), output.SourceDigest);
        Assert.Equal(source.Length, output.SourceUtf16Length);
        Assert.Equal(source.Replace("\r\n", "\n").TrimStart('\uFEFF').Length, output.NormalizedUtf16Length);
        Assert.Equal("mounted-document-from-editor", output.DocumentId);
        Assert.Equal(73, output.DocumentEpoch);
        Assert.Empty(output.Diagnostics);
        CanonicalArticleRelationParserNode link = Assert.Single(output.Nodes, static node => node.Kind == "link");
        Assert.Equal("/posts/post-a#anchor-a", link.TargetUrl);
        Assert.Equal("[go](/posts/post-a#anchor-a)", source[link.RawRange.Start..link.RawRange.End]);
        Assert.Equal(source.IndexOf("[go]", StringComparison.Ordinal), link.RawRange.Start);
        Assert.NotNull(link.ParentRawRange);
        Assert.Contains(":73:link:", link.NodeIdentity);
        Assert.Equal("head-a", Assert.Single(output.Nodes, static node => node.Kind == "anchor").AnchorId);
        CanonicalArticleRelationParserNode embed = Assert.Single(output.Nodes, static node => node.Kind == "embed");
        Assert.Equal("opaque-registry-token", embed.TargetUrl);
        Assert.Equal("block", embed.EmbedMode);
        Assert.DoesNotContain(output.Nodes, static node => node.TargetUrl?.Contains("hidden", StringComparison.Ordinal) == true);

        ArticleBlockRelationProductionInput input = Bind(parsed, fixture.Request.Source);
        ArticleBlockRelationProduction production = ArticleBlockRelationProducer.Produce(input);
        Assert.True(production.Produced, production.ReasonCode);
        ArticleRelationRecord record = Assert.Single(production.Set!.Relations);
        Assert.Equal(TargetArticle, record.Target.TargetIdentity!.ArticleIdentity);
        Assert.Equal(link.NodeIdentity, Assert.Single(input.Links).NodeIdentity);
        Assert.Equal(link.RawRange.Start, record.Occurrence.First.Start);
        Assert.Equal(ArticleRelationResolutionStatus.Resolved, record.Resolution);
        await fixture.Authority.Received(2).GetRevisionAsync(7, 11, Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData("# a ^same\n\n# b ^same\n", "anchor-duplicate")]
    [InlineData("^orphan\n", "anchor-orphan")]
    [InlineData("::embed[target=\"x\" mode=\"Article\"]\n", "embed-inferred-mode")]
    public async Task RealParserDiagnostics_BlockWholeProducerBinding(string source, string code)
    {
        var fixture = Fixture(source);
        var parsed = await fixture.Bridge.ReadAsync(fixture.Request);
        Assert.Contains(parsed.Projection.Diagnostics, diagnostic => diagnostic.Code == code);
        Assert.Throws<ArticleRelationIndexException>(() => Bind(parsed, fixture.Request.Source));
    }

    [Fact]
    public async Task ActualCanonicalNodes_RefuseDuplicateOrphanAndSubstitutedRegistryBindings()
    {
        var fixture = Fixture("[one](/posts/post-a#anchor-a) [two](/posts/post-a#anchor-a)\n");
        var parsed = await fixture.Bridge.ReadAsync(fixture.Request);
        ArticleBlockRelationProductionInput input = Bind(parsed, fixture.Request.Source);
        Assert.Equal(2, input.Links.Length);
        var nodes = parsed.Projection.Nodes.Where(static node => node.Kind == "link").ToArray();
        var first = new CanonicalArticleRelationTargetBinding(nodes[0].NodeIdentity, nodes[0].TargetUrl, Target());
        Assert.Throws<ArticleRelationIndexException>(() => Bind(parsed, fixture.Request.Source, [first, first]));
        Assert.Throws<ArticleRelationIndexException>(() => Bind(parsed, fixture.Request.Source, [first]));
        Assert.Throws<ArticleRelationIndexException>(() => Bind(parsed, fixture.Request.Source,
            [first, first with { NodeIdentity = "syn:orphan" }]));
        Assert.Throws<ArticleRelationIndexException>(() => Bind(parsed, fixture.Request.Source,
            [first, new(nodes[1].NodeIdentity, "/posts/forged#anchor-a", Target())]));
        Assert.Throws<ArticleRelationIndexException>(() => Bind(parsed, fixture.Request.Source with { ContentDigest = s_permission }));
        Assert.Throws<ArticleRelationIndexException>(() => Bind(parsed, fixture.Request.Source, targets: [Inventory(), Inventory()]));
        Assert.Throws<ArticleRelationIndexException>(() => Bind(parsed, fixture.Request.Source, targets: []));
        Assert.Throws<ArticleRelationIndexException>(() => Bind(parsed, fixture.Request.Source,
            targets: [Inventory(), Inventory() with { ArticleFacts = Inventory().ArticleFacts with
            {
                TargetIdentity = new("article:20000000-0000-4000-8000-000000000003", ArticleRelationTargetKind.Article, null, null)
            } }]));
        Assert.Throws<ArticleRelationIndexException>(() => new CanonicalArticleRelationParserBridge.ParsedSource(
            new object(), fixture.Request.Source, parsed.PackageDigest, "forged", parsed.Projection));
    }

    [Theory]
    [InlineData("wasm")]
    [InlineData("entry")]
    [InlineData("version")]
    [InlineData("exit")]
    [InlineData("output")]
    [InlineData("memory")]
    [InlineData("timeout")]
    public async Task RealProcessRefusals_HaveNoPartialEnvelopeAndAwaitExit(string fault)
    {
        var configuration = Runtime();
        configuration = fault switch
        {
            "wasm" => configuration with { WasmModuleDigest = s_permission },
            "entry" => configuration with { PublicEntryDigest = s_permission },
            "version" => configuration with { Version = "unavailable-version" },
            "exit" => configuration with { NodeExecutable = "/bin/false" },
            "output" => configuration with { MaxOutputBytes = 32 },
            "memory" => configuration with { MaxWorkingSetBytes = 1 },
            _ => configuration with { TimeoutMilliseconds = 1 }
        };
        string privateSource = "[private-never-log](/posts/post-a#anchor-a)\n";
        var fixture = Fixture(privateSource, configuration);
        int? pid = null;
        fixture.Bridge.ProcessStarted += processId => pid = processId;
        ArticleRelationIndexException error = await Assert.ThrowsAsync<ArticleRelationIndexException>(
            () => fixture.Bridge.ReadAsync(fixture.Request));
        Assert.DoesNotContain("private-never-log", error.Message);
        Assert.NotNull(pid);
        AssertExited(pid!.Value);
        string expectedCode = fault switch
        {
            "output" => "canonical_article_relation_output_budget_exceeded",
            "memory" => "canonical_article_relation_memory_budget_exceeded",
            "timeout" => "canonical_article_relation_process_timeout",
            _ => "canonical_article_relation_process_refused"
        };
        if (fault == "exit")
        {
            Assert.Contains(error.Message, new[] { expectedCode, "canonical_article_relation_process_unavailable" });
        }
        else
        {
            Assert.Equal(expectedCode, error.Message);
        }
    }

    [Fact]
    public async Task OrdinaryLinkCandidate_RequiresItsOwnExplicitRegistryDecision()
    {
        var fixture = Fixture("[web](https://example.test/) [block](/posts/post-a#anchor-a)\n");
        var parsed = await fixture.Bridge.ReadAsync(fixture.Request);
        CanonicalArticleRelationParserNode web = Assert.Single(parsed.Projection.Nodes,
            static node => node.TargetUrl == "https://example.test/");
        CanonicalArticleRelationParserNode block = Assert.Single(parsed.Projection.Nodes,
            static node => node.TargetUrl == "/posts/post-a#anchor-a");
        ArticleBlockRelationProductionInput input = Bind(parsed, fixture.Request.Source,
            [new(web.NodeIdentity, web.TargetUrl, null), new(block.NodeIdentity, block.TargetUrl, Target())]);
        Assert.Single(ArticleBlockRelationProducer.Produce(input).Set!.Relations);
        Assert.Throws<ArticleRelationIndexException>(() => Bind(parsed, fixture.Request.Source,
            [new(block.NodeIdentity, block.TargetUrl, Target())]));
    }

    [Fact]
    public async Task FirstLinkAfterBomBeforeCrlf_UsesPublicInwardCaretAffinities()
    {
        string literal = "[שלום 😀](/posts/post-a#anchor-a)";
        var fixture = Fixture("\uFEFF" + literal + "\r\n");
        var parsed = await fixture.Bridge.ReadAsync(fixture.Request);
        CanonicalArticleRelationParserNode node = Assert.Single(parsed.Projection.Nodes);
        Assert.Equal(0, node.RawRange.Start);
        Assert.Equal(1, node.LinkSourceRange!.Start);
        Assert.Equal(1 + literal.Length, node.LinkSourceRange.End);
        ArticleRelationRecord record = Assert.Single(ArticleBlockRelationProducer.Produce(Bind(parsed, fixture.Request.Source)).Set!.Relations);
        Assert.Equal(literal, record.Occurrence.First.MatchedText);
        Assert.Equal(1, record.Occurrence.First.Start);
        Assert.Equal(1 + literal.Length, record.Occurrence.First.End);
        Assert.Equal(Digest("\uFEFF" + literal + "\r\n"), parsed.Projection.SourceDigest);
    }

    [Fact]
    public async Task ConflictingCanonicalNestedLiteralProjection_RefusesWithoutRepairOrPartialFacts()
    {
        var fixture = Fixture("[go](/posts/post-a#anchor-a)\n\n```md\n::embed[target=\"hidden\" mode=\"article\"]\n```\n");
        int? pid = null;
        fixture.Bridge.ProcessStarted += processId => pid = processId;
        ArticleRelationIndexException error = await Assert.ThrowsAsync<ArticleRelationIndexException>(
            () => fixture.Bridge.ReadAsync(fixture.Request));
        Assert.Equal("canonical_article_relation_process_refused", error.Message);
        Assert.NotNull(pid);
        AssertExited(pid!.Value);
    }

    [Fact]
    public async Task RawProcessOversizedStdin_ExitsWithOnlyContentFreeRefusal()
    {
        var configuration = Runtime();
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo(configuration.NodeExecutable)
            {
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
        };
        process.StartInfo.ArgumentList.Add(configuration.ScriptPath);
        Assert.True(process.Start());
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        try
        {
            byte[] payload = Encoding.UTF8.GetBytes(new string('s', 1024 * 1024 + 4096));
            try
            {
                await process.StandardInput.BaseStream.WriteAsync(payload);
                process.StandardInput.Close();
            }
            catch (IOException)
            {
                // The real child may reject stdin before the final write completes.
            }
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Assert.NotEqual(0, process.ExitCode);
            Assert.Empty(await stdout);
            Assert.Equal("canonical_article_relation_parse_refused\n", await stderr);
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
            await process.WaitForExitAsync();
            await Task.WhenAll(stdout, stderr);
        }
    }

    [Fact]
    public async Task CancellationAfterActualStart_AwaitsChildExitBeforeThrowing()
    {
        var fixture = Fixture("[go](/posts/post-a#anchor-a)\n");
        using var cancellation = new CancellationTokenSource();
        int? pid = null;
        fixture.Bridge.ProcessStarted += processId =>
        {
            pid = processId;
            cancellation.Cancel();
        };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Bridge.ReadAsync(fixture.Request, cancellation.Token));
        Assert.NotNull(pid);
        AssertExited(pid!.Value);
    }

    [Fact]
    public async Task ProcessAdmission_RejectsConcurrentMaterializationBeforeAnotherReadOrChild()
    {
        var fixture = Fixture("[go](/posts/post-a#anchor-a)\n");
        Task<CanonicalArticleRelationParserBridge.ParsedSource>? concurrent = null;
        int children = 0;
        fixture.Bridge.ProcessStarted += _ =>
        {
            children++;
            concurrent = fixture.Bridge.ReadAsync(fixture.Request);
        };
        await fixture.Bridge.ReadAsync(fixture.Request);
        Assert.NotNull(concurrent);
        ArticleRelationIndexException error = await Assert.ThrowsAsync<ArticleRelationIndexException>(() => concurrent!);
        Assert.Equal("canonical_article_relation_busy", error.Message);
        Assert.Equal(1, children);
        await fixture.Authority.Received(2).GetRevisionAsync(7, 11, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task RepeatedRealProcessCompletion_ReapsChildrenAcrossExitMonitorRaces()
    {
        var fixture = Fixture("[go](/posts/post-a#anchor-a)\n");
        int? pid = null;
        fixture.Bridge.ProcessStarted += processId => pid = processId;
        for (int attempt = 0; attempt < 4; attempt++)
        {
            var parsed = await fixture.Bridge.ReadAsync(fixture.Request);
            Assert.Single(ArticleBlockRelationProducer.Produce(Bind(parsed, fixture.Request.Source)).Set!.Relations);
            Assert.NotNull(pid);
            AssertExited(pid!.Value);
        }
        await fixture.Authority.Received(8).GetRevisionAsync(7, 11, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task DigestAndPackageDrift_AreRejectedByTheOriginalReaderReread()
    {
        string source = "[go](/posts/post-a#anchor-a)\n";
        var fixture = Fixture(source);
        fixture.Bridge.ProcessStarted += _ => fixture.Authority.GetRevisionAsync(7, 11, Arg.Any<CancellationToken>())
            .Returns(Revision(source + "changed"));
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Bridge.ReadAsync(fixture.Request));
        fixture = Fixture(source);
        fixture.Bridge.ProcessStarted += _ => fixture.Authority.GetRevisionAsync(7, 11, Arg.Any<CancellationToken>())
            .Returns(Revision(source) with
            {
                Title = "metadata-drift"
            });
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Bridge.ReadAsync(fixture.Request));
        fixture = Fixture(source);
        bool started = false;
        fixture.Bridge.ProcessStarted += _ => started = true;
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Bridge.ReadAsync(fixture.Request with
        {
            Selector = fixture.Request.Selector with
            {
                ExpectedSourceDigest = s_permission
            }
        }));
        Assert.False(started);
    }

    [Fact]
    public async Task OversizedSourceAndInput_AreRejectedBeforeProcessAndNodeCountFailsClosed()
    {
        var fixture = Fixture(new string('a', CanonicalArticleRelationParserBridge.MaxSourceUtf16Length + 1));
        bool started = false;
        fixture.Bridge.ProcessStarted += _ => started = true;
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Bridge.ReadAsync(fixture.Request));
        Assert.False(started);
        fixture = Fixture("[go](/posts/post-a#anchor-a)", Runtime() with
        {
            MaxInputBytes = 16
        });
        fixture.Bridge.ProcessStarted += _ => started = true;
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Bridge.ReadAsync(fixture.Request));
        Assert.False(started);
        fixture = Fixture(string.Concat(Enumerable.Repeat("[x](/posts/post-a#anchor-a)\n\n", 4200)));
        int? pid = null;
        fixture.Bridge.ProcessStarted += processId => pid = processId;
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Bridge.ReadAsync(fixture.Request));
        Assert.NotNull(pid);
        AssertExited(pid!.Value);
    }

    [Fact]
    public async Task MountedIdentity_IsIndependentFromCompareDraftContextToken()
    {
        string source = "# draft ^draft-anchor\r\n";
        var fixture = Fixture(source);
        var draft = new ServerDraftResponse("draft-key", 7, "Draft", source, null, null, 2, [], "client-token", 1,
            null, new DateTime(2026, 9, 8, 0, 0, 0, DateTimeKind.Utc),
            new()
            {
                Enabled = true,
                LicenseType = "all-rights-reserved"
            }, 11, 3);
        IAuthoringDraftLifecycle authoring = Substitute.For<IAuthoringDraftLifecycle>();
        authoring.GetDraftAsync(5, "draft-key", Arg.Any<CancellationToken>()).Returns(draft);
        fixture.Authority.GetDraftAsync(5, "draft-key", Arg.Any<CancellationToken>()).Returns(draft);
        var contexts = new AuthoringRevisionCompareDraftContextAuthority([new AuthoringRevisionCompareDraftContextProvider(authoring)]);
        var bridge = new CanonicalArticleRelationParserBridge(new(fixture.Authority, contexts), Runtime());
        string compareEpoch = AuthoringRevisionCompareDraftContextProvider.CreateDocumentEpoch(fixture.Request.Reader, 7, draft);
        var request = fixture.Request with
        {
            Source = fixture.Request.Source with
            {
                RevisionKind = ArticleRelationRevisionKind.Draft,
                Lifecycle = ArticleRelationLifecycleState.Draft
            },
            Selector = new(RevisionCompareSourceKind.CurrentDraft, DraftKey: "draft-key", ExpectedServerRevision: 3,
                DocumentEpoch: compareEpoch, ExpectedSourceDigest: Digest(source))
        };
        var parsed = await bridge.ReadAsync(request);
        Assert.Equal(73, parsed.Projection.DocumentEpoch);
        Assert.DoesNotContain(compareEpoch, Assert.Single(parsed.Projection.Nodes).NodeIdentity);
        Assert.Contains(":73:anchor:", Assert.Single(parsed.Projection.Nodes).NodeIdentity);
    }

    private static ArticleBlockRelationProductionInput Bind(
        CanonicalArticleRelationParserBridge.ParsedSource parsed,
        ArticleRelationSourceFacts source,
        ImmutableArray<CanonicalArticleRelationTargetBinding>? bindings = null,
        ImmutableArray<ArticleBlockRelationTargetInventory>? targets = null)
        => ArticleBlockRelationProductionInput.FromCanonicalParsedSource(parsed, source,
            new(s_actor, s_actor, ArticleRelationQueryScope.Authoring, ArticleRelationPublicContext.AuthoringActor, s_permission),
            1, bindings ?? [.. parsed.Projection.Nodes.Where(static node => node.Kind == "link")
                .Select(static node => new CanonicalArticleRelationTargetBinding(node.NodeIdentity, node.TargetUrl, Target()))],
            targets ?? (parsed.Projection.Nodes.Any(static node => node.Kind == "link") ? [Inventory()] : []));

    private static ArticleBlockTarget Target() => ArticleBlockTarget.Create(TargetArticle, BlockAnchorId.Create("anchor-a"));

    private static ArticleBlockRelationTargetInventory Inventory()
        => new(s_actor, 1, new(new(TargetArticle, ArticleRelationTargetKind.Article, null, null),
            "revision:30000000-0000-4000-8000-000000000002", 1, ArticleRelationRevisionKind.Current,
            ArticleRelationLifecycleState.Published, ArticleRelationPermissionState.Allowed), s_permission, "post-a",
            [BlockAnchorId.Create("anchor-a")], BlockTargetInventoryDiagnostic.None);

    private static string Digest(string source) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(source)));

    private static (CanonicalArticleRelationParserBridge Bridge, CanonicalArticleRelationParseRequest Request,
        IAuthoringRevisionCompareAuthority Authority) Fixture(string source, CanonicalArticleRelationParserRuntime? configuration = null)
    {
        IAuthoringRevisionCompareAuthority authority = Substitute.For<IAuthoringRevisionCompareAuthority>();
        var context = new RevisionCompareReadContext(5, "primary", Guid.Parse("297dfbc4-ddaa-4830-9455-d88e6c8f29de"));
        authority.GetAuthorizedArticleAsync(context, 7, Arg.Any<CancellationToken>()).Returns(new AuthoringRevisionCompareArticle(7, 11));
        authority.GetRevisionAsync(7, 11, Arg.Any<CancellationToken>()).Returns(Revision(source));
        var reader = new AuthoringRevisionComparePackageReader(authority, new AuthoringRevisionCompareDraftContextAuthority([]));
        var request = new CanonicalArticleRelationParseRequest(context, 7,
            new(RevisionCompareSourceKind.HistoricalRevision, RevisionId: 11, ExpectedSourceDigest: Digest(source)),
            new(SourceArticle, "revision:30000000-0000-4000-8000-000000000001", 1, ArticleRelationRevisionKind.Published,
                ArticleRelationLifecycleState.Published, ArticleRelationPermissionState.Allowed, s_actor, Digest(source)),
            "mounted-document-from-editor", 73);
        return (new(reader, configuration ?? Runtime()), request, authority);
    }

    private static ArticleRevisionDetailResponse Revision(string source)
        => new("11", 7, 1, "Revision", source, null, null, 2, [], "diff", "5",
            new DateTime(2026, 9, 8, 0, 0, 0, DateTimeKind.Utc), null, null, false, null, null, null);

    private static CanonicalArticleRelationParserRuntime Runtime()
    {
        string blogRoot = BackendTestPaths.RepositoryRoot;
        string uiRoot = Environment.GetEnvironmentVariable("FSUSBLOG_LOCAL_FSUSUI_ROOT")
            ?? Path.GetFullPath(Path.Combine(blogRoot, "..", "FsusUI"));
        string node = Environment.GetEnvironmentVariable("FSUSBLOG_NODE") ?? "node";
        if (!Path.IsPathFullyQualified(node))
        {
            node = (Environment.GetEnvironmentVariable("PATH") ?? string.Empty).Split(Path.PathSeparator)
                .Select(directory => Path.Combine(directory, node)).First(File.Exists);
        }
        return new(node, Path.Combine(blogRoot, "src/backend/Services/Authoring/canonicalArticleRelationParserBridge.mjs"),
            uiRoot, PublicEntryDigest, WasmModuleDigest,
            "markdown-wasm-contract@2026-07-29");
    }

    private static void AssertExited(int pid)
    {
        try
        {
            using Process process = Process.GetProcessById(pid);
            Assert.True(process.HasExited, "the actual Node child must exit before completion");
        }
        catch (ArgumentException)
        {
            // The parent already reaped the actual child.
        }
    }
}
