using System.Collections.Immutable;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringPrepublishDiagnosticCacheTests
{
    private static readonly DateTimeOffset s_now = new(2026, 10, 18, 0, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Cache_ReusesOnlyExactVerifiedCompletionAcrossEquivalentRegistryObjects(bool noFindings)
    {
        Fixture fixture = CreateFixture();
        AuthoringPrepublishDiagnosticRegistry registry = fixture.Registry();
        var cache = Cache(new Clock());
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        AuthoringPrepublishDiagnosticCache.Ticket first = cache.SetCurrent(registry, input);
        Assert.False(cache.TryGet(first, out _));
        AuthoringPrepublishDiagnosticResult result = Result(registry, input, noFindings);
        Assert.True(cache.TryStore(first, result));
        Assert.False(cache.TryStore(first, result));
        Assert.True(cache.TryGet(first, out AuthoringPrepublishDiagnosticResult? stored));
        Assert.Equal(result.Status, stored.Status);
        Assert.Equal(result.Facts, stored.Facts);
        Assert.Equal(result.Required, stored.Required);

        AuthoringPrepublishDiagnosticRegistry equivalent = fixture.Registry();
        AuthoringPrepublishDiagnosticInput same = Input(equivalent);
        Assert.Equal(input.InputSha256, same.InputSha256);
        Assert.NotSame(input.SourceRanges[0], same.SourceRanges[0]);
        AuthoringPrepublishDiagnosticCache.Ticket current = cache.SetCurrent(equivalent, same);
        Assert.False(cache.TryGet(first, out _));
        Assert.False(cache.TryStore(first, result));
        Assert.True(cache.TryGet(current, out AuthoringPrepublishDiagnosticResult? reused));
        Assert.Equal(same.InputSha256, reused.Input.InputSha256);
        Assert.Equal(result.Status, reused.Status);
    }

    [Theory]
    [InlineData("epoch")]
    [InlineData("revision")]
    [InlineData("source")]
    [InlineData("length")]
    [InlineData("config")]
    [InlineData("grant")]
    [InlineData("runtime")]
    [InlineData("runtime-version")]
    [InlineData("host-api")]
    [InlineData("request")]
    [InlineData("deadline")]
    [InlineData("metadata")]
    [InlineData("node")]
    [InlineData("range")]
    [InlineData("text")]
    public void Currentness_RejectsOldCacheAndLateResultForEveryInputCoordinate(string dimension)
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        AuthoringPrepublishDiagnosticInput original = Input(registry);
        AuthoringDiagnosticHostContext context = original.Context;
        context = dimension switch
        {
            "epoch" => context with { DocumentEpoch = 2 },
            "revision" => context with { SourceRevision = 2 },
            "source" => context with { SourceSha256 = Digest('a') },
            "length" => context with { DocumentLength = 11 },
            "config" => context with { ConfigSha256 = Digest('a') },
            "grant" => context with { GrantSha256 = Digest('a') },
            "runtime" => context with { RuntimeIdentity = Digest('a') },
            "runtime-version" => context with { RuntimeVersion = "2.0.0" },
            "host-api" => context with { HostApiSha256 = Digest('a') },
            "request" => context with { RequestId = "request.two" },
            "deadline" => context with { Deadline = context.Deadline - TimeSpan.FromSeconds(1) },
            _ => context
        };
        ImmutableArray<AuthoringDiagnosticMetadata> metadata = dimension == "metadata"
            ? [new("title", "Changed")] : original.Metadata;
        ImmutableArray<AuthoringDiagnosticSourceRange> ranges = dimension switch
        {
            "node" => [new("node.two", new(2, 5), "abc")],
            "range" => [new("node.one", new(3, 6), "abc")],
            "text" => [new("node.one", new(2, 5), "xyz")],
            _ => original.SourceRanges
        };
        AuthoringPrepublishDiagnosticInput changed = registry.CreateInput(original.DiagnosticId, context, metadata, ranges, s_now);
        Assert.NotEqual(original.InputSha256, changed.InputSha256);
        var cache = Cache(new Clock());
        AuthoringPrepublishDiagnosticCache.Ticket old = cache.SetCurrent(registry, original);
        AuthoringPrepublishDiagnosticResult oldResult = Result(registry, original);
        Assert.True(cache.TryStore(old, oldResult));
        AuthoringPrepublishDiagnosticCache.Ticket current = cache.SetCurrent(registry, changed);
        Assert.False(cache.TryGet(old, out _));
        Assert.False(cache.TryGet(current, out _));
        Assert.False(cache.TryStore(old, oldResult));
        Assert.False(cache.TryStore(current, oldResult));
        Assert.True(cache.TryStore(current, Result(registry, changed)));
        Assert.True(cache.TryGet(current, out AuthoringPrepublishDiagnosticResult? latest));
        Assert.Equal(changed.InputSha256, latest.Input.InputSha256);
    }

    [Theory]
    [InlineData("package")]
    [InlineData("plugin-version")]
    [InlineData("content")]
    [InlineData("diagnostic-version")]
    [InlineData("read-model")]
    [InlineData("policy-required")]
    [InlineData("policy-severity")]
    [InlineData("policy-budget")]
    [InlineData("core-results")]
    public void Currentness_RejectsRegistryPluginPackagePolicyAndScopeVersionDrift(string dimension)
    {
        Fixture fixture = CreateFixture();
        AuthoringExtensionManifest manifest = fixture.Extensions.Contracts[0].Manifest;
        Fixture changed = dimension switch
        {
            "package" => fixture with { Extensions = Extensions(manifest with { PackageSha256 = Digest('d') }) },
            "plugin-version" => fixture with { Extensions = Extensions(manifest with { Version = "2.0.0" }) },
            "content" => fixture with { Extensions = Extensions(manifest with { ContentSha256 = Digest('a') }) },
            "diagnostic-version" => fixture with { Contribution = fixture.Contribution with { Version = "2.0.0" } },
            "read-model" => fixture with
            {
                Contribution = fixture.Contribution with
                {
                    InputSchema = fixture.Contribution.InputSchema with
                    {
                        ReadModelReference = "read-model.markdown.v2"
                    }
                }
            },
            "policy-required" => fixture with { Policy = fixture.Policy with { Required = false } },
            "policy-severity" => fixture with { Policy = fixture.Policy with { Codes = [new("link-risk", AuthoringDiagnosticSeverity.Blocking)] } },
            "policy-budget" => fixture with { Policy = fixture.Policy with { Budget = fixture.Policy.Budget with { MaximumFacts = 9 } } },
            "core-results" => fixture with { Core = fixture.Core with { ResultSha256 = Digest('a') } },
            _ => throw new ArgumentOutOfRangeException(nameof(dimension))
        };
        AuthoringPrepublishDiagnosticRegistry previousRegistry = fixture.Registry();
        AuthoringPrepublishDiagnosticRegistry registry = changed.Registry();
        AuthoringPrepublishDiagnosticInput previousInput = Input(previousRegistry);
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        Assert.NotEqual(previousInput.InputSha256, input.InputSha256);
        var cache = Cache(new Clock());
        AuthoringPrepublishDiagnosticCache.Ticket previous = cache.SetCurrent(previousRegistry, previousInput);
        AuthoringPrepublishDiagnosticResult oldResult = Result(previousRegistry, previousInput);
        Assert.True(cache.TryStore(previous, oldResult));
        AuthoringPrepublishDiagnosticCache.Ticket current = cache.SetCurrent(registry, input);
        Assert.False(cache.TryGet(previous, out _));
        Assert.False(cache.TryGet(current, out _));
        Assert.False(cache.TryStore(previous, oldResult));
        Assert.False(cache.TryStore(current, oldResult));
        Assert.True(cache.TryStore(current, Result(registry, input,
            severity: changed.Policy.Codes[0].Severity)));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Cache_DoesNotShareOutcomesBetweenArticlesOrDocumentsWithIdenticalText(bool differentArticle)
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        AuthoringPrepublishDiagnosticInput other = registry.CreateInput(input.DiagnosticId,
            differentArticle ? input.Context with
            {
                ArticleId = 2
            } : input.Context with
            {
                DocumentId = "document.two"
            },
            input.Metadata, input.SourceRanges, s_now);
        Assert.Equal(input.Context.SourceSha256, other.Context.SourceSha256);
        var cache = Cache(new Clock());
        AuthoringPrepublishDiagnosticCache.Ticket first = cache.SetCurrent(registry, input);
        AuthoringPrepublishDiagnosticResult result = Result(registry, input);
        Assert.True(cache.TryStore(first, result));
        AuthoringPrepublishDiagnosticCache.Ticket second = cache.SetCurrent(registry, other);
        Assert.False(cache.TryGet(second, out _));
        Assert.False(cache.TryStore(second, result));
        Assert.True(cache.TryGet(first, out _));
    }

    [Fact]
    public void Cache_RejectsCrossInstanceAndUnissuedTicketsEvenForIdenticalInput()
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        var first = Cache(new Clock());
        var second = Cache(new Clock());
        AuthoringPrepublishDiagnosticCache.Ticket ticket = first.SetCurrent(registry, input);
        AuthoringPrepublishDiagnosticCache.Ticket other = second.SetCurrent(registry, input);
        AuthoringPrepublishDiagnosticResult result = Result(registry, input);
        Assert.False(second.TryStore(ticket, result));
        Assert.False(first.TryStore(other, result));
        Assert.False(first.TryStore(new(input), result));
        Assert.True(first.TryStore(ticket, result));
        Assert.False(second.TryGet(ticket, out _));
        Assert.False(second.TryGet(other, out _));
    }

    [Fact]
    public void Currentness_RejectsLateResultAfterIdenticalRequestIsSuperseded()
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        var cache = Cache(new Clock());
        AuthoringPrepublishDiagnosticCache.Ticket old = cache.SetCurrent(registry, input);
        AuthoringPrepublishDiagnosticCache.Ticket current = cache.SetCurrent(registry, input);
        AuthoringPrepublishDiagnosticResult result = Result(registry, input);
        Assert.False(cache.TryStore(old, result));
        Assert.True(cache.TryStore(current, result));
    }

    [Theory]
    [InlineData(AuthoringDiagnosticUnavailableReason.PermissionRevoked)]
    [InlineData(AuthoringDiagnosticUnavailableReason.Disabled)]
    [InlineData(AuthoringDiagnosticUnavailableReason.Incompatible)]
    [InlineData(AuthoringDiagnosticUnavailableReason.Uninstalled)]
    public void Invalidation_RetiresAllExtensionDocumentsAndRejectsLateResultAfterReadmission(AuthoringDiagnosticUnavailableReason reason)
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        AuthoringPrepublishDiagnosticInput other = registry.CreateInput(input.DiagnosticId,
            input.Context with
            {
                ArticleId = 2
            }, input.Metadata, input.SourceRanges, s_now);
        var cache = Cache(new Clock());
        AuthoringPrepublishDiagnosticCache.Ticket first = cache.SetCurrent(registry, input);
        AuthoringPrepublishDiagnosticCache.Ticket second = cache.SetCurrent(registry, other);
        AuthoringPrepublishDiagnosticResult result = Result(registry, input);
        Assert.True(cache.TryStore(first, result));
        cache.InvalidateExtension(input.ExtensionId);
        Assert.False(cache.TryGet(first, out _));
        Assert.False(cache.TryStore(second, Result(registry, other)));
        Assert.False(cache.TryStore(first, registry.Unavailable(input, reason)));
        AuthoringPrepublishDiagnosticCache.Ticket current = cache.SetCurrent(registry, input);
        Assert.False(cache.TryStore(first, result));
        Assert.False(cache.TryGet(current, out _));
        Assert.True(cache.TryStore(current, result));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Cache_NeverStoresUnavailableAsCompletion(bool required)
    {
        Fixture fixture = CreateFixture();
        AuthoringPrepublishDiagnosticRegistry registry = (fixture with
        {
            Policy = fixture.Policy with
            {
                Required = required
            }
        }).Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        var cache = Cache(new Clock());
        AuthoringPrepublishDiagnosticCache.Ticket ticket = cache.SetCurrent(registry, input);
        foreach (AuthoringDiagnosticUnavailableReason reason in Enum.GetValues<AuthoringDiagnosticUnavailableReason>())
        {
            Assert.False(cache.TryStore(ticket, registry.Unavailable(input, reason)));
            Assert.False(cache.TryGet(ticket, out _));
        }

        Assert.True(cache.TryStore(ticket, Result(registry, input)));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Cache_RejectsExpiredReadsAndWritesAtExactOriginalDeadline(bool storeBeforeExpiry)
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        var clock = new Clock();
        var cache = Cache(clock);
        AuthoringPrepublishDiagnosticCache.Ticket ticket = cache.SetCurrent(registry, input);
        AuthoringPrepublishDiagnosticResult result = Result(registry, input);
        if (storeBeforeExpiry)
        {
            Assert.True(cache.TryStore(ticket, result));
        }

        clock.Now = input.Context.Deadline;
        Assert.False(cache.TryGet(ticket, out _));
        Assert.False(cache.TryStore(ticket, result));
        Assert.Throws<AuthoringExtensionContractException>(() => cache.SetCurrent(registry, input));
    }

    [Theory]
    [InlineData("admission")]
    [InlineData("store")]
    [InlineData("lookup")]
    public void Cache_RechecksDeadlineAfterValidationBeforePublishing(string operation)
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        var clock = new Clock();
        var cache = Cache(clock);
        if (operation == "admission")
        {
            clock.Observations = new([s_now, input.Context.Deadline]);
            Assert.Throws<AuthoringExtensionContractException>(() => cache.SetCurrent(registry, input));
            return;
        }

        AuthoringPrepublishDiagnosticCache.Ticket ticket = cache.SetCurrent(registry, input);
        AuthoringPrepublishDiagnosticResult result = Result(registry, input);
        if (operation == "lookup")
        {
            Assert.True(cache.TryStore(ticket, result));
        }

        clock.Observations = new([s_now, s_now, input.Context.Deadline]);
        if (operation == "store")
        {
            Assert.False(cache.TryStore(ticket, result));
        }
        else
        {
            Assert.False(cache.TryGet(ticket, out _));
        }
    }

    [Fact]
    public void Cache_RevalidatesTamperedInputRequirednessStatusAndFacts()
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        var cache = Cache(new Clock());
        Assert.Throws<AuthoringExtensionContractException>(() => cache.SetCurrent(registry,
            input with
            {
                PackageSha256 = Digest('0')
            }));
        AuthoringPrepublishDiagnosticCache.Ticket ticket = cache.SetCurrent(registry, input);
        AuthoringPrepublishDiagnosticResult result = Result(registry, input);
        AuthoringPrepublishDiagnosticResult[] tampered =
        [
            new(input with { PackageSha256 = Digest('0') }, true, result.Status, result.Facts, null),
            new(input, false, result.Status, result.Facts, null),
            new(input, true, AuthoringDiagnosticOutcomeStatus.NoFindings, result.Facts, null),
            new(input, true, result.Status, [result.Facts[0] with { Severity = AuthoringDiagnosticSeverity.Info }], null),
            new(input, true, result.Status, [result.Facts[0] with { Message = "<script>" }], null)
        ];
        foreach (AuthoringPrepublishDiagnosticResult changed in tampered)
        {
            Assert.Throws<AuthoringExtensionContractException>(() => cache.TryStore(ticket, changed));
            Assert.False(cache.TryGet(ticket, out _));
        }

        Assert.True(cache.TryStore(ticket, result));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Currentness_RejectsSourceOrEpochRegressionWithoutReplacingNewerTicket(bool epoch)
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        AuthoringPrepublishDiagnosticInput old = Input(registry);
        AuthoringPrepublishDiagnosticInput current = registry.CreateInput(old.DiagnosticId,
            epoch ? old.Context with
            {
                DocumentEpoch = 2
            } : old.Context with
            {
                SourceRevision = 2
            },
            old.Metadata, old.SourceRanges, s_now);
        var cache = Cache(new Clock());
        AuthoringPrepublishDiagnosticCache.Ticket ticket = cache.SetCurrent(registry, current);
        Assert.Throws<AuthoringExtensionContractException>(() => cache.SetCurrent(registry, old));
        Assert.True(cache.TryStore(ticket, Result(registry, current)));
    }

    [Fact]
    public void Cache_EnforcesAggregateEntryAndByteBoundsWithoutDroppingCurrentOutcomes()
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        var cache = new AuthoringPrepublishDiagnosticCache(1, 65536, new Clock());
        AuthoringPrepublishDiagnosticCache.Ticket ticket = cache.SetCurrent(registry, input);
        Assert.True(cache.TryStore(ticket, Result(registry, input)));
        AuthoringPrepublishDiagnosticInput other = registry.CreateInput(input.DiagnosticId, input.Context with
        {
            ArticleId = 2
        },
            input.Metadata, input.SourceRanges, s_now);
        Assert.Throws<AuthoringExtensionContractException>(() => cache.SetCurrent(registry, other));
        Assert.True(cache.TryGet(ticket, out _));
        int inputBytes = JsonSerializer.SerializeToUtf8Bytes(input).Length;
        var byteBound = new AuthoringPrepublishDiagnosticCache(2, inputBytes, new Clock());
        AuthoringPrepublishDiagnosticCache.Ticket bounded = byteBound.SetCurrent(registry, input);
        Assert.False(byteBound.TryStore(bounded, Result(registry, input)));
        Assert.Throws<AuthoringExtensionContractException>(() => byteBound.SetCurrent(registry, other));
        byteBound.InvalidateExtension(input.ExtensionId);
        Assert.NotNull(byteBound.SetCurrent(registry, input));
        Assert.Throws<ArgumentOutOfRangeException>(() => new AuthoringPrepublishDiagnosticCache(0, 1, new Clock()));
        Assert.Throws<ArgumentOutOfRangeException>(() => new AuthoringPrepublishDiagnosticCache(1001, 1, new Clock()));
        Assert.Throws<ArgumentOutOfRangeException>(() => new AuthoringPrepublishDiagnosticCache(1, 0, new Clock()));
    }

    [Fact]
    public async Task InvalidationAndLateStoreRaceCannotLeaveAReadableOutcome()
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        AuthoringPrepublishDiagnosticResult result = Result(registry, input);
        var cache = Cache(new Clock());
        for (int iteration = 0; iteration < 20; iteration++)
        {
            AuthoringPrepublishDiagnosticCache.Ticket ticket = cache.SetCurrent(registry, input);
            using var barrier = new Barrier(2);
            await Task.WhenAll(Task.Run(() =>
            {
                Assert.True(barrier.SignalAndWait(TimeSpan.FromSeconds(10)));
                cache.InvalidateExtension(input.ExtensionId);
            }), Task.Run(() =>
            {
                Assert.True(barrier.SignalAndWait(TimeSpan.FromSeconds(10)));
                cache.TryStore(ticket, result);
            }));
            Assert.False(cache.TryGet(ticket, out _));
            Assert.False(cache.TryStore(ticket, result));
        }
    }

    private static AuthoringPrepublishDiagnosticCache Cache(Clock clock) => new(100, 1024 * 1024, clock);

    private static AuthoringPrepublishDiagnosticInput Input(AuthoringPrepublishDiagnosticRegistry registry) =>
        registry.CreateInput("acme.check.links", new(1, "document.one", 1, 1, 10, Digest('1'), Digest('2'), Digest('3'),
            Digest('4'), "1.0.0", Digest('5'), "request.one", s_now + TimeSpan.FromSeconds(4)),
            [new("title", "Title")], [new("node.one", new(2, 5), "abc")], s_now);

    private static AuthoringPrepublishDiagnosticResult Result(AuthoringPrepublishDiagnosticRegistry registry,
        AuthoringPrepublishDiagnosticInput input, bool noFindings = false,
        AuthoringDiagnosticSeverity severity = AuthoringDiagnosticSeverity.Warning) => registry.ValidateResult(input,
            new(1, input.DiagnosticId, input.InputSha256,
                noFindings ? AuthoringDiagnosticCompletion.NoFindings : AuthoringDiagnosticCompletion.Findings,
                noFindings ? [] : [new("acme.check.links.finding", "link-risk", severity, "Review this link",
                    [new(input.SourceRanges[0].Range.Start, input.SourceRanges[0].Range.Start + 1)], [new("evidence.link", Digest('e'))], null)]), s_now);

    private static Fixture CreateFixture()
    {
        AuthoringExtensionManifest manifest = AuthoringExtensionContractsTests.CreateManifest();
        AuthoringContributionDeclaration declaration = manifest.Contributions[0] with
        {
            Id = "acme.check.links",
            Kind = AuthoringContributionKind.PrepublishDiagnostic,
            Capabilities = [AuthoringCapability.DiagnosticReport, AuthoringCapability.DocumentRangeRead]
        };
        manifest = manifest with
        {
            Contributions = [declaration]
        };
        var budget = new AuthoringDiagnosticBudget(TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(5),
            64 * 1024 * 1024, 65536, 65536, 2, 8, 10, 10, 10);
        return new(Extensions(manifest), new(1, declaration.Id, "1.0.0", manifest.Id, declaration.Id,
            declaration.Entrypoint.ContentSha256, declaration.ExecutionClass, declaration.Capabilities,
            new(1, AuthoringDiagnosticReadScope.SourceRanges, "read-model.markdown.v1", ["title"]), "policy.links.v1", budget),
            new(declaration.Id, "policy.links.v1", true, [new("link-risk", AuthoringDiagnosticSeverity.Warning)], [], budget),
            new("security.authoring", true, AuthoringDiagnosticSeverity.Blocking, Digest('f')));
    }

    private static AuthoringExtensionRegistrySnapshot Extensions(AuthoringExtensionManifest manifest) =>
        AuthoringExtensionContractValidator.CreateRegistry([AuthoringExtensionContractValidator.Verify(manifest)], new([], [], [], [], []));

    private static string Digest(char character) => new(character, 64);

    private sealed class Clock : TimeProvider
    {
        internal DateTimeOffset Now { get; set; } = s_now;
        internal Queue<DateTimeOffset>? Observations
        {
            get; set;
        }
        public override DateTimeOffset GetUtcNow() => Observations is { Count: > 0 } ? Observations.Dequeue() : Now;
    }

    private sealed record Fixture(AuthoringExtensionRegistrySnapshot Extensions,
        AuthoringPrepublishDiagnosticContribution Contribution, AuthoringDiagnosticHostPolicy Policy, AuthoringDiagnosticCoreResult Core)
    {
        internal AuthoringPrepublishDiagnosticRegistry Registry() => new(Extensions, [Contribution], [Policy], [Core]);
    }
}
