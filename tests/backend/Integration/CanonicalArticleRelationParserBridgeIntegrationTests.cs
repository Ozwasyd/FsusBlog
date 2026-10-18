using System.Collections.Immutable;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

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
    public async Task SearchPurpose_RealWasmReturnsOriginalStructuresOutlineAndStableHeldReplay()
    {
        string source = "\uFEFF# 标题 😀 ^head-a\r\n\r\nمرحبا [go](/posts/a)\r\n\r\n"
            + "Setext\r\n------\r\n\r\n| A | B |\r\n|---|---|\r\n| 一 | 二 |\r\n\r\n"
            + "```md\r\n::embed[target=\"literal\" mode=\"article\"]\r\n```\r\n";
        var fixture = await SearchFixtureAsync(source);
        using var lifetime = fixture.Bridge.BeginSearchLifetime();
        using var held = await fixture.Bridge.HoldSearchSourceAsync(lifetime, fixture.Request);
        var processes = new List<int>();
        fixture.Bridge.ProcessStarted += processes.Add;
        var parsed = await fixture.Bridge.ReadSearchAsync(held);
        var replay = await fixture.Bridge.ReadSearchAsync(held);
        var output = parsed.Projection;
        Assert.Equal(CanonicalArticleRelationParserBridge.SearchSchema, output.Schema);
        Assert.Equal("fsus-markdown-runtime", output.Parser);
        Assert.Equal("markdown-wasm-contract@2026-07-29", output.Version);
        Assert.Equal(PublicEntryDigest, output.PublicEntryDigest);
        Assert.Equal(WasmModuleDigest, output.WasmModuleDigest);
        Assert.Equal(Digest(source), output.SourceDigest);
        Assert.Equal(source.Length, output.SourceUtf16Length);
        Assert.True(output.NormalizedUtf16Length < source.Length);
        Assert.Equal(source, Encoding.UTF8.GetString(parsed.SourcePackage.RawMarkdown.AsSpan()));
        Assert.Equal(fixture.Request.PackageDigest, parsed.SourcePackage.PackageDigest);
        Assert.Equal(RevisionCompareSourceKind.CurrentRevision, parsed.SourcePackage.SourceKind);
        Assert.Equal(output.Nodes.Length, output.ProjectionNodeCount);
        Assert.Equal(2, output.Outline.Length);
        Assert.Equal(new[] { 1, 2 }, output.Outline.Select(static heading => heading.Level));
        Assert.Contains(output.Outline, static heading => heading.Title == "Setext");
        Assert.All(output.Outline, heading => Assert.Contains(output.Nodes,
            node => node.Id == heading.Id && node.Kind == "heading" && node.RawRange == heading.Range));
        Assert.Contains(output.Nodes, static node => node.Kind == "link" && !node.RawContentRanges.IsEmpty);
        Assert.Contains(output.Nodes, static node => node.Kind == "code");
        Assert.Contains(output.Nodes, static node => node.Kind == "embed");
        var table = Assert.Single(output.Nodes.Where(static node => node.Kind == "table"));
        Assert.NotNull(table.Table);
        Assert.NotEmpty(table.Table.Rows);
        Assert.All(table.Table.Rows, static row => Assert.Equal(row.RawCellRanges.Length, row.NormalizedCellRanges.Length));
        Assert.Equal(JsonSerializer.Serialize(output), JsonSerializer.Serialize(replay.Projection));
        Assert.Equal(4, processes.Count);
        Assert.All(processes, AssertExited);
        Assert.Equal(1, output.HeldSourceSequence);
        Assert.DoesNotContain("mounted", output.ParseLifetimeId);
    }

    [Fact]
    public async Task SearchPurpose_DisposeRebuildAndDifferentBridgeInvalidateOwnershipWithoutRevisionEpochAliases()
    {
        var fixture = await SearchFixtureAsync("# Heading\n");
        using var lifetime = fixture.Bridge.BeginSearchLifetime();
        var held = await fixture.Bridge.HoldSearchSourceAsync(lifetime, fixture.Request);
        var first = await fixture.Bridge.ReadSearchAsync(held);
        string firstId = first.Projection.Outline[0].Id;
        var busy = await Assert.ThrowsAsync<ArticleRelationIndexException>(() =>
            fixture.Bridge.HoldSearchSourceAsync(lifetime, fixture.Request));
        Assert.Equal("canonical_article_search_source_already_held", busy.Message);
        var other = await SearchFixtureAsync("# Heading\n");
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => other.Bridge.ReadSearchAsync(held));
        held.Dispose();
        Assert.False(first.IsHeld);
        Assert.Throws<ArticleRelationIndexException>(() => first.Projection);
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Bridge.ReadSearchAsync(held));
        using var second = await fixture.Bridge.HoldSearchSourceAsync(lifetime, fixture.Request);
        var next = await fixture.Bridge.ReadSearchAsync(second);
        Assert.Equal(2, next.Projection.HeldSourceSequence);
        Assert.NotEqual(firstId, next.Projection.Outline[0].Id);
        using var rebuiltLifetime = fixture.Bridge.BeginSearchLifetime();
        Assert.False(next.IsHeld);
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Bridge.ReadSearchAsync(second));
        using var rebuilt = await fixture.Bridge.HoldSearchSourceAsync(rebuiltLifetime, fixture.Request);
        var rebuild = await fixture.Bridge.ReadSearchAsync(rebuilt);
        Assert.NotEqual(lifetime.Id, rebuild.Projection.ParseLifetimeId);
        Assert.Equal(1, rebuild.Projection.HeldSourceSequence);
        Assert.NotEqual(firstId, rebuild.Projection.Outline[0].Id);
        Assert.Equal(11, rebuild.SourcePackage.RevisionId);
    }

    [Theory]
    [InlineData("current-pointer")]
    [InlineData("package")]
    [InlineData("source")]
    [InlineData("authorization")]
    public async Task SearchPurpose_IndependentPersistedCurrentObservationRefusesBeforeAnotherChild(string drift)
    {
        const string source = "# Heading\n";
        var fixture = await SearchFixtureAsync(source);
        using var lifetime = fixture.Bridge.BeginSearchLifetime();
        using var held = await fixture.Bridge.HoldSearchSourceAsync(lifetime, fixture.Request);
        if (drift == "current-pointer")
            fixture.Authority.GetCurrentRevisionIdAsync(7, Arg.Any<CancellationToken>()).Returns(12L);
        if (drift == "package")
            fixture.Authority.GetRevisionAsync(7, 11, Arg.Any<CancellationToken>()).Returns(Revision(source) with
            {
                Title = "Changed"
            });
        if (drift == "source")
            fixture.Authority.GetRevisionAsync(7, 11, Arg.Any<CancellationToken>()).Returns(Revision("changed"));
        if (drift == "authorization")
            fixture.Authority.GetAuthorizedArticleAsync(fixture.Request.Reader, 7,
            Arg.Any<CancellationToken>()).Returns((AuthoringRevisionCompareArticle?)null);
        int starts = 0;
        fixture.Bridge.ProcessStarted += _ => starts++;
        var error = await Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Bridge.ReadSearchAsync(held));
        Assert.Equal("canonical_article_search_source_stale", error.Message);
        Assert.Equal(0, starts);
        Assert.False(held.IsActive);
        // Stale holds never become current again merely because the old pointer returns.
        fixture.Authority.GetCurrentRevisionIdAsync(7, Arg.Any<CancellationToken>()).Returns(11L);
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Bridge.ReadSearchAsync(held));
    }

    [Theory]
    [InlineData("current-pointer")]
    [InlineData("package")]
    public async Task SearchPurpose_CompletionRereadRefusesDriftAfterActualAuthorityExit(string drift)
    {
        const string source = "# Heading\n";
        var fixture = await SearchFixtureAsync(source);
        using var lifetime = fixture.Bridge.BeginSearchLifetime();
        using var held = await fixture.Bridge.HoldSearchSourceAsync(lifetime, fixture.Request);
        var processes = new List<int>();
        fixture.Bridge.ProcessStarted += pid =>
        {
            processes.Add(pid);
            if (processes.Count != 2)
                return;
            if (drift == "current-pointer")
                fixture.Authority.GetCurrentRevisionIdAsync(7, Arg.Any<CancellationToken>()).Returns(12L);
            else
                fixture.Authority.GetRevisionAsync(7, 11, Arg.Any<CancellationToken>()).Returns(Revision(source) with
                {
                    Title = "Changed"
                });
        };
        var error = await Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Bridge.ReadSearchAsync(held));
        Assert.Equal("canonical_article_search_source_stale", error.Message);
        Assert.Equal(2, processes.Count);
        Assert.All(processes, AssertExited);
        Assert.False(held.IsActive);
    }

    [Theory]
    [InlineData("sourceIdentity")]
    [InlineData("nodeIdentity")]
    [InlineData("blockIdentity")]
    [InlineData("headingTitle")]
    [InlineData("headingIdentity")]
    [InlineData("range")]
    [InlineData("relationReplay")]
    [InlineData("closureReplay")]
    public async Task SearchPurpose_RealProcessOutputDriftAndCrossPurposeReplayRefuse(string fault)
    {
        string directory = Path.Combine(Path.GetTempPath(), "canonical-search-control-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string executable = await CreateSearchControlExecutableAsync(directory, fault);
            var fixture = await SearchFixtureAsync("# Heading\n\n[go](/posts/a)\n", Runtime() with
            {
                NodeExecutable = executable
            });
            using var lifetime = fixture.Bridge.BeginSearchLifetime();
            using var held = await fixture.Bridge.HoldSearchSourceAsync(lifetime, fixture.Request);
            var error = await Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Bridge.ReadSearchAsync(held));
            Assert.StartsWith("canonical_article_search_", error.Message);
            if (fault is "sourceIdentity" or "nodeIdentity" or "blockIdentity" or "headingTitle" or "headingIdentity" or "range")
                Assert.Equal("canonical_article_search_identity_closure_invalid", error.Message);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData(1, 0)]
    [InlineData(1, 10)]
    [InlineData(1, 30)]
    [InlineData(1, 75)]
    [InlineData(2, 0)]
    [InlineData(2, 10)]
    [InlineData(2, 30)]
    [InlineData(2, 75)]
    public async Task SearchPurpose_CancellationInEachPhaseAwaitsActualProcessExit(int phase, int delay)
    {
        string directory = Path.Combine(Path.GetTempPath(), "canonical-search-cancel-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string executable = await CreateSearchControlExecutableAsync(directory, "delay" + phase);
            var fixture = await SearchFixtureAsync("# Heading\n", Runtime() with
            {
                NodeExecutable = executable
            });
            using var lifetime = fixture.Bridge.BeginSearchLifetime();
            using var held = await fixture.Bridge.HoldSearchSourceAsync(lifetime, fixture.Request);
            using var cancellation = new CancellationTokenSource();
            var processes = new List<int>();
            fixture.Bridge.ProcessStarted += pid =>
            {
                processes.Add(pid);
                if (processes.Count == phase)
                    cancellation.CancelAfter(delay);
            };
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Bridge.ReadSearchAsync(held, cancellation.Token));
            Assert.Equal(phase, processes.Count);
            Assert.All(processes, AssertExited);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SearchPurpose_ReleasingHeldSourceOrLifetimeCancelsAuthorityAndInvalidatesResult(bool releaseLifetime)
    {
        string directory = Path.Combine(Path.GetTempPath(), "canonical-search-release-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string executable = await CreateSearchControlExecutableAsync(directory, "delay2");
            var fixture = await SearchFixtureAsync("# Heading\n", Runtime() with
            {
                NodeExecutable = executable
            });
            using var lifetime = fixture.Bridge.BeginSearchLifetime();
            using var held = await fixture.Bridge.HoldSearchSourceAsync(lifetime, fixture.Request);
            var processes = new List<int>();
            fixture.Bridge.ProcessStarted += pid =>
            {
                processes.Add(pid);
                if (processes.Count == 2)
                {
                    if (releaseLifetime)
                        lifetime.Dispose();
                    else
                        held.Dispose();
                }
            };
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Bridge.ReadSearchAsync(held));
            Assert.Equal(2, processes.Count);
            Assert.All(processes, AssertExited);
            Assert.False(held.IsActive);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData("stdout", "canonical_article_relation_output_budget_exceeded")]
    [InlineData("stderr", "canonical_article_relation_output_budget_exceeded")]
    [InlineData("exit", "canonical_article_relation_process_refused")]
    [InlineData("sharedDeadline", "canonical_article_relation_process_timeout")]
    [InlineData("memory", "canonical_article_relation_memory_budget_exceeded")]
    public async Task SearchPurpose_RealProcessRetainsOriginalResourceRefusals(string fault, string reason)
    {
        string directory = Path.Combine(Path.GetTempPath(), "canonical-search-budget-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string executable = await CreateSearchControlExecutableAsync(directory, fault);
            var fixture = await SearchFixtureAsync("# Heading\n", Runtime() with
            {
                NodeExecutable = executable
            });
            using var lifetime = fixture.Bridge.BeginSearchLifetime();
            using var held = await fixture.Bridge.HoldSearchSourceAsync(lifetime, fixture.Request);
            var processes = new List<int>();
            fixture.Bridge.ProcessStarted += processes.Add;
            var error = await Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Bridge.ReadSearchAsync(held));
            Assert.Equal(reason, error.Message);
            Assert.All(processes, AssertExited);
            if (fault == "sharedDeadline")
                Assert.Equal(2, processes.Count);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData("input")]
    [InlineData("source")]
    [InlineData("count")]
    [InlineData("packageDigest")]
    [InlineData("revision")]
    [InlineData("module")]
    [InlineData("version")]
    public async Task SearchPurpose_SourceRequestCountInputAndRuntimePinsStayBounded(string fault)
    {
        string source = fault == "source" ? new string('a', CanonicalArticleRelationParserBridge.MaxSourceUtf16Length + 1)
            : fault == "count" ? string.Concat(Enumerable.Repeat("# H\n\n", 4200)) : "# H\n";
        var runtime = Runtime();
        if (fault == "input")
            runtime = runtime with
            {
                MaxInputBytes = 1
            };
        if (fault == "module")
            runtime = runtime with
            {
                WasmModuleDigest = new string('b', 64)
            };
        if (fault == "version")
            runtime = runtime with
            {
                Version = "drift"
            };
        var fixture = await SearchFixtureAsync(source, runtime);
        var request = fixture.Request;
        if (fault == "packageDigest")
            request = request with
            {
                PackageDigest = new string('b', 64)
            };
        if (fault == "revision")
            request = request with
            {
                RevisionId = 12
            };
        using var lifetime = fixture.Bridge.BeginSearchLifetime();
        await Assert.ThrowsAsync<ArticleRelationIndexException>(async () =>
        {
            using var held = await fixture.Bridge.HoldSearchSourceAsync(lifetime, request);
            await fixture.Bridge.ReadSearchAsync(held);
        });
    }

    [Fact]
    public async Task SearchPurpose_SharesOriginalOneProcessAdmissionWithRelationWithoutAnotherBodyRead()
    {
        var fixture = await SearchFixtureAsync("# Heading\n");
        using var lifetime = fixture.Bridge.BeginSearchLifetime();
        using var held = await fixture.Bridge.HoldSearchSourceAsync(lifetime, fixture.Request);
        var relation = Fixture("[go](/posts/post-a#anchor-a)\n");
        int starts = 0;
        fixture.Bridge.ProcessStarted += _ =>
        {
            starts++;
            var searchError = Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Bridge.ReadSearchAsync(held)).GetAwaiter().GetResult();
            var relationError = Assert.ThrowsAsync<ArticleRelationIndexException>(() => relation.Bridge.ReadAsync(relation.Request)).GetAwaiter().GetResult();
            var holdError = Assert.ThrowsAsync<ArticleRelationIndexException>(() =>
                fixture.Bridge.HoldSearchSourceAsync(lifetime, fixture.Request)).GetAwaiter().GetResult();
            Assert.Equal("canonical_article_relation_busy", searchError.Message);
            Assert.Equal("canonical_article_relation_busy", relationError.Message);
            Assert.Equal("canonical_article_relation_busy", holdError.Message);
        };
        await fixture.Bridge.ReadSearchAsync(held);
        Assert.Equal(2, starts);
        await relation.Authority.DidNotReceive().GetRevisionAsync(Arg.Any<int>(), Arg.Any<long>(), Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData("")]
    [InlineData("مرحبا 😀 plain body\r\n")]
    public async Task SearchPurpose_EmptyAndNonHeadingSourcesDoNotManufactureOutline(string source)
    {
        var fixture = await SearchFixtureAsync(source);
        using var lifetime = fixture.Bridge.BeginSearchLifetime();
        using var held = await fixture.Bridge.HoldSearchSourceAsync(lifetime, fixture.Request);
        var parsed = await fixture.Bridge.ReadSearchAsync(held);
        Assert.Empty(parsed.Projection.Outline);
        Assert.Equal(source.Length, parsed.Projection.SourceUtf16Length);
    }

    [Theory]
    [InlineData("# A ^same\n\n# B ^same\n", "anchor-duplicate")]
    [InlineData("^orphan\n", "anchor-orphan")]
    public async Task SearchPurpose_OriginalDiagnosticsRemainParseFactsWithoutRelationAdmission(string source, string code)
    {
        var fixture = await SearchFixtureAsync(source);
        using var lifetime = fixture.Bridge.BeginSearchLifetime();
        using var held = await fixture.Bridge.HoldSearchSourceAsync(lifetime, fixture.Request);
        var parsed = await fixture.Bridge.ReadSearchAsync(held);
        Assert.Contains(parsed.Projection.Diagnostics, diagnostic => diagnostic.Code == code);
    }

    private static async Task<(CanonicalArticleRelationParserBridge Bridge, CanonicalArticleSearchParseRequest Request,
        IAuthoringRevisionCompareAuthority Authority)> SearchFixtureAsync(string source, CanonicalArticleRelationParserRuntime? configuration = null)
    {
        // Synthetic package/authorization fixtures only, never Search corpus/policy/typed authority.
        var fixture = Fixture(source, configuration);
        fixture.Authority.GetCurrentRevisionIdAsync(7, Arg.Any<CancellationToken>()).Returns(11L);
        var reader = new AuthoringRevisionComparePackageReader(fixture.Authority, new AuthoringRevisionCompareDraftContextAuthority([]));
        var observed = await reader.ReadAuthorizedAsync(fixture.Request.Reader, 7,
            new(RevisionCompareSourceKind.CurrentRevision, RevisionId: 11, ExpectedSourceDigest: Digest(source)));
        Assert.Equal(RevisionComparePackageReadStatus.Available, observed.Status);
        return (fixture.Bridge, new(fixture.Request.Reader, 7, 11, observed.Package!.SourceDigest, observed.Package.PackageDigest), fixture.Authority);
    }

    private static async Task<string> CreateSearchControlExecutableAsync(string directory, string fault)
    {
        if (!OperatingSystem.IsLinux())
            throw new PlatformNotSupportedException("Executable process controls require Linux.");
        var runtime = Runtime();
        string executable = Path.Combine(directory, "search-output-control.mjs");
        await File.WriteAllTextAsync(executable, $$"""
            #!{{runtime.NodeExecutable}}
            import { spawnSync } from 'node:child_process';
            const fault = {{JsonSerializer.Serialize(fault)}};
            const chunks = [];
            for await (const chunk of process.stdin) chunks.push(chunk);
            const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const authority = input.operation === 'search-identity-closure';
            if (fault === 'delay1' && !authority || fault === 'delay2' && authority)
                await new Promise(resolve => setTimeout(resolve, 2000));
            // Each phase fits the original 10s budget separately; together they exceed it.
            if (fault === 'sharedDeadline') await new Promise(resolve => setTimeout(resolve, 6000));
            if (!authority && fault === 'stdout') {
                await new Promise(resolve => process.stdout.write(Buffer.alloc(3 * 1024 * 1024), resolve)); process.exit(0);
            }
            if (!authority && fault === 'stderr') {
                await new Promise(resolve => process.stderr.write(Buffer.alloc(8192), resolve)); process.exit(1);
            }
            if (!authority && fault === 'exit') process.exit(1);
            if (!authority && fault === 'memory') {
                const bytes = Buffer.alloc(300 * 1024 * 1024, 7);
                await new Promise(resolve => setTimeout(resolve, 2000));
                process.stdout.write(String(bytes.length)); process.exit(1);
            }
            if (!authority && fault === 'relationReplay') {
                input.schema = {{JsonSerializer.Serialize(CanonicalArticleRelationParserBridge.Schema)}};
                input.operation = 'parse'; input.documentId = input.parseLifetimeId; input.documentEpoch = input.heldSourceSequence;
            }
            if (authority && fault === 'closureReplay') input.operation = 'search-parse';
            const result = spawnSync({{JsonSerializer.Serialize(runtime.NodeExecutable)}}, process.argv.slice(2), {
                input: JSON.stringify(input), maxBuffer: 2 * 1024 * 1024, timeout: 10000, env: {},
            });
            if (result.status !== 0) {
                process.stderr.write(result.stderr ?? Buffer.alloc(0)); process.exit(result.status ?? 1);
            }
            const output = JSON.parse(result.stdout.toString('utf8'));
            if (!authority) {
                if (fault === 'sourceIdentity') output.sourceIdentity = 'synthetic-drift';
                if (fault === 'nodeIdentity') {
                    const node = output.nodes.find(node => node.kind === 'link'); node.id = 'synthetic-drift';
                }
                if (fault === 'blockIdentity') output.nodes[0].blockIdentity = 'synthetic-drift';
                if (fault === 'headingTitle') output.outline[0].title = 'synthetic-drift';
                if (fault === 'headingIdentity') {
                    output.nodes.find(node => node.id === output.outline[0].id).id = 'synthetic-drift';
                    output.outline[0].id = 'synthetic-drift';
                }
                if (fault === 'range') {
                    output.nodes[0].rawRange.end--; output.outline[0].range.end--;
                }
            }
            process.stdout.write(JSON.stringify(output));
            """ + "\n");
        File.SetUnixFileMode(executable, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        return executable;
    }

    [Theory]
    [InlineData("sourceIdentity")]
    [InlineData("nodeIdentity")]
    [InlineData("blockIdentity")]
    public async Task CapturedRealEnvelope_RejectsIndependentIdentityOutputDriftBeforeBinding(string field)
    {
        if (!OperatingSystem.IsLinux())
        {
            throw new PlatformNotSupportedException("The executable output-fault control requires Linux.");
        }
        string source = "[go](/posts/post-a#anchor-a)\n";
        var original = Fixture(source);
        var real = await original.Bridge.ReadAsync(original.Request);
        Assert.True(ArticleBlockRelationProducer.Produce(Bind(real, original.Request.Source)).Produced);
        JsonObject candidate = JsonSerializer.SerializeToNode(real.Projection,
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase })!.AsObject();
        if (field == "sourceIdentity")
        {
            candidate[field] = "markdown:synthetic-drift";
        }
        else
        {
            candidate["nodes"]!.AsArray()[0]![field] = "synthetic-drift";
        }
        string directory = Path.Combine(Path.GetTempPath(), "canonical-identity-control-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string executable = Path.Combine(directory, "captured-output.mjs");
            CanonicalArticleRelationParserRuntime runtime = Runtime();
            string encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(candidate.ToJsonString()));
            await File.WriteAllTextAsync(executable, $$"""
                #!{{runtime.NodeExecutable}}
                import { spawnSync } from 'node:child_process';
                const chunks = [];
                for await (const chunk of process.stdin) chunks.push(chunk);
                const bytes = Buffer.concat(chunks);
                const input = JSON.parse(bytes.toString('utf8'));
                if (input.operation === 'identity-closure') {
                    const result = spawnSync({{JsonSerializer.Serialize(runtime.NodeExecutable)}}, process.argv.slice(2), {
                        input: bytes, maxBuffer: 2 * 1024 * 1024, timeout: 10000, env: {},
                    });
                    process.stdout.write(result.stdout ?? Buffer.alloc(0));
                    process.stderr.write(result.stderr ?? Buffer.alloc(0));
                    process.exitCode = result.status ?? 1;
                } else {
                    process.stdout.write(Buffer.from('{{encoded}}', 'base64'));
                }
                """ + "\n");
            File.SetUnixFileMode(executable, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            var mutated = Fixture(source, runtime with
            {
                NodeExecutable = executable
            });
            ArticleRelationIndexException error = await Assert.ThrowsAsync<ArticleRelationIndexException>(async () =>
            {
                var admitted = await mutated.Bridge.ReadAsync(mutated.Request);
                // The old head reaches this real producer binding after accepting the forged identity.
                Assert.True(ArticleBlockRelationProducer.Produce(Bind(admitted, mutated.Request.Source)).Produced);
            });
            Assert.Equal("canonical_article_relation_identity_closure_invalid", error.Message);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData("delegate", null)]
    [InlineData("replay", "canonical_article_relation_identity_closure_invalid")]
    [InlineData("delay", "canonical_article_relation_process_timeout")]
    public async Task AuthorityBoundary_AdmitsUnchangedCaptureRefusesReplayAndSharesDeadline(string behavior, string? reason)
    {
        string source = "[go](/posts/post-a#anchor-a)\n";
        var original = Fixture(source);
        var real = await original.Bridge.ReadAsync(original.Request);
        string directory = Path.Combine(Path.GetTempPath(), "canonical-authority-control-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string executable = await CreateAuthorityControlExecutableAsync(directory, real.Projection, behavior);
            var controlled = Fixture(source, Runtime() with
            {
                NodeExecutable = executable,
                TimeoutMilliseconds = behavior == "delay" ? 500 : 10_000
            });
            var processes = new List<int>();
            controlled.Bridge.ProcessStarted += processes.Add;
            if (reason is null)
            {
                var parsed = await controlled.Bridge.ReadAsync(controlled.Request);
                Assert.True(ArticleBlockRelationProducer.Produce(Bind(parsed, controlled.Request.Source)).Produced);
            }
            else
            {
                var error = await Assert.ThrowsAsync<ArticleRelationIndexException>(() => controlled.Bridge.ReadAsync(controlled.Request));
                Assert.Equal(reason, error.Message);
                await controlled.Authority.Received(1).GetRevisionAsync(7, 11, Arg.Any<CancellationToken>());
            }
            Assert.Equal(2, processes.Count);
            Assert.All(processes, AssertExited);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(10)]
    [InlineData(30)]
    [InlineData(75)]
    public async Task CancellationDuringAuthority_AwaitsEveryStartedProcess(int delayMilliseconds)
    {
        string source = "[go](/posts/post-a#anchor-a)\n";
        var original = Fixture(source);
        var real = await original.Bridge.ReadAsync(original.Request);
        string directory = Path.Combine(Path.GetTempPath(), "canonical-authority-cancel-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string executable = await CreateAuthorityControlExecutableAsync(directory, real.Projection, "delay");
            var controlled = Fixture(source, Runtime() with
            {
                NodeExecutable = executable
            });
            using var cancellation = new CancellationTokenSource();
            var processes = new List<int>();
            controlled.Bridge.ProcessStarted += processId =>
            {
                processes.Add(processId);
                if (processes.Count == 2)
                {
                    cancellation.CancelAfter(delayMilliseconds);
                }
            };
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => controlled.Bridge.ReadAsync(controlled.Request, cancellation.Token));
            Assert.Equal(2, processes.Count);
            Assert.All(processes, AssertExited);
            await controlled.Authority.Received(1).GetRevisionAsync(7, 11, Arg.Any<CancellationToken>());
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static async Task<string> CreateAuthorityControlExecutableAsync(
        string directory, CanonicalArticleRelationParserBridge.ParserOutput captured, string behavior)
    {
        if (!OperatingSystem.IsLinux())
        {
            throw new PlatformNotSupportedException("The authority process control requires Linux.");
        }
        CanonicalArticleRelationParserRuntime runtime = Runtime();
        string encoded = Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(captured,
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
        string executable = Path.Combine(directory, "authority-control.mjs");
        await File.WriteAllTextAsync(executable, $$"""
            #!{{runtime.NodeExecutable}}
            import { spawnSync } from 'node:child_process';
            const behavior = {{JsonSerializer.Serialize(behavior)}};
            const chunks = [];
            for await (const chunk of process.stdin) chunks.push(chunk);
            const bytes = Buffer.concat(chunks);
            const input = JSON.parse(bytes.toString('utf8'));
            let output = Buffer.from('{{encoded}}', 'base64');
            if (input.operation === 'identity-closure' && behavior !== 'replay') {
                const result = spawnSync({{JsonSerializer.Serialize(runtime.NodeExecutable)}}, process.argv.slice(2), {
                    input: bytes, maxBuffer: 2 * 1024 * 1024, timeout: 10000, env: {},
                });
                output = result.stdout ?? Buffer.alloc(0);
                process.stderr.write(result.stderr ?? Buffer.alloc(0));
                process.exitCode = result.status ?? 1;
            }
            if (behavior === 'delay') await new Promise((resolve) => setTimeout(resolve, 250));
            process.stdout.write(output);
            """ + "\n");
        File.SetUnixFileMode(executable, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        return executable;
    }

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
        var concurrent = new List<Task<CanonicalArticleRelationParserBridge.ParsedSource>>();
        int? previousChild = null;
        int children = 0;
        fixture.Bridge.ProcessStarted += processId =>
        {
            children++;
            if (previousChild.HasValue)
            {
                AssertExited(previousChild.Value);
            }
            previousChild = processId;
            concurrent.Add(fixture.Bridge.ReadAsync(fixture.Request));
        };
        await fixture.Bridge.ReadAsync(fixture.Request);
        Assert.Equal(2, concurrent.Count);
        foreach (var attempt in concurrent)
        {
            ArticleRelationIndexException error = await Assert.ThrowsAsync<ArticleRelationIndexException>(() => attempt);
            Assert.Equal("canonical_article_relation_busy", error.Message);
        }
        Assert.Equal(2, children);
        AssertExited(previousChild!.Value);
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
