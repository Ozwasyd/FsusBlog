using System.Collections.Immutable;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringPrepublishDiagnosticContractTests
{
    private static readonly DateTimeOffset s_now = new(2026, 10, 17, 0, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData(AuthoringDiagnosticSeverity.Info)]
    [InlineData(AuthoringDiagnosticSeverity.Warning)]
    [InlineData(AuthoringDiagnosticSeverity.Blocking)]
    public void Result_ClosedFactsRetainHostRequirednessAndExactInput(AuthoringDiagnosticSeverity severity)
    {
        Fixture fixture = CreateFixture();
        fixture = fixture with
        {
            Policy = fixture.Policy with
            {
                Codes = [new("link-risk", severity)]
            }
        };
        AuthoringPrepublishDiagnosticRegistry registry = fixture.Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        AuthoringPrepublishDiagnosticResponse response = Response(input, severity);

        AuthoringPrepublishDiagnosticResult result = registry.ParseResult(input, JsonSerializer.SerializeToUtf8Bytes(response), s_now);

        Assert.Same(input, result.Input);
        Assert.True(result.Required);
        Assert.Equal(AuthoringDiagnosticOutcomeStatus.Findings, result.Status);
        Assert.Null(result.UnavailableReason);
        AuthoringDiagnosticFact fact = Assert.Single(result.Facts);
        Assert.Equal(severity, fact.Severity);
        Assert.Equal(new AuthoringTextRange(2, 4), Assert.Single(fact.Ranges));
        Assert.Equal("fix.link", fact.FixCommandReference);
        Assert.Equal("evidence.link", Assert.Single(fact.Evidence).Reference);
        Assert.Equal(fixture.Core, Assert.Single(registry.CoreResults));
    }

    [Fact]
    public void NoFindings_IsExplicitAndDoesNotManufactureCorePass()
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        AuthoringPrepublishDiagnosticResult result = registry.ValidateResult(input, Response(input) with
        {
            Completion = AuthoringDiagnosticCompletion.NoFindings,
            Facts = []
        }, s_now);

        Assert.Equal(AuthoringDiagnosticOutcomeStatus.NoFindings, result.Status);
        Assert.Empty(result.Facts);
        Assert.Equal(input.CoreResultsSha256, registry.CoreResultsSha256);
        Assert.Equal(Digest('f'), Assert.Single(registry.CoreResults).ResultSha256);
        Assert.True(result.Required);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Unavailable_AllHostFailureReasonsPreserveRequiredness(bool required)
    {
        Fixture fixture = CreateFixture();
        fixture = fixture with
        {
            Policy = fixture.Policy with
            {
                Required = required
            }
        };
        AuthoringPrepublishDiagnosticRegistry registry = fixture.Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);

        foreach (AuthoringDiagnosticUnavailableReason reason in Enum.GetValues<AuthoringDiagnosticUnavailableReason>())
        {
            AuthoringPrepublishDiagnosticResult result = registry.Unavailable(input, reason);
            Assert.Equal(required, result.Required);
            Assert.Equal(required ? AuthoringDiagnosticOutcomeStatus.RequiredUnavailable :
                AuthoringDiagnosticOutcomeStatus.OptionalNotEvaluable, result.Status);
            Assert.Equal(reason, result.UnavailableReason);
            Assert.Empty(result.Facts);
        }

        Assert.Throws<AuthoringExtensionContractException>(() => registry.Unavailable(input, (AuthoringDiagnosticUnavailableReason)999));
    }

    [Fact]
    public void Registry_JoinsExistingManifestAndHasDeterministicIdentity()
    {
        Fixture fixture = CreateFixture();
        AuthoringPrepublishDiagnosticContribution parsed = AuthoringPrepublishDiagnosticRegistry.ParseContribution(
            JsonSerializer.SerializeToUtf8Bytes(fixture.Contribution));
        AuthoringPrepublishDiagnosticRegistry first = fixture.Registry();
        AuthoringPrepublishDiagnosticRegistry second = (fixture with
        {
            Contribution = parsed
        }).Registry();

        Assert.Equal(first.RegistrySha256, second.RegistrySha256);
        Assert.Equal(first.CoreResultsSha256, second.CoreResultsSha256);
        Assert.Equal(fixture.Contribution, first.Get(fixture.Contribution.DiagnosticId));
        Assert.Throws<AuthoringExtensionContractException>(() => first.Get("unknown.diagnostic"));
        Assert.Throws<AuthoringExtensionContractException>(() => new AuthoringPrepublishDiagnosticRegistry(
            fixture.Extensions with
            {
                RegistryIdentity = Digest('0')
            }, [fixture.Contribution], [fixture.Policy], [fixture.Core]));
    }

    [Fact]
    public void Registry_CoreSetAndHostRequirednessChangesInvalidateOldResults()
    {
        Fixture fixture = CreateFixture();
        AuthoringPrepublishDiagnosticRegistry original = fixture.Registry();
        AuthoringPrepublishDiagnosticInput input = Input(original);
        AuthoringPrepublishDiagnosticResponse response = Response(input);
        Fixture[] changed =
        [
            fixture with { Core = fixture.Core with { Required = false } },
            fixture with { Core = fixture.Core with { Severity = AuthoringDiagnosticSeverity.Info } },
            fixture with { Core = fixture.Core with { ResultSha256 = Digest('0') } },
            fixture with { Policy = fixture.Policy with { Required = false } },
            fixture with { Contribution = fixture.Contribution with { Version = "2.0.0" } }
        ];

        foreach (Fixture change in changed)
        {
            AuthoringPrepublishDiagnosticRegistry current = change.Registry();
            Assert.NotEqual(original.RegistrySha256, current.RegistrySha256);
            Assert.Throws<AuthoringExtensionContractException>(() => current.ValidateResult(input, response, s_now));
        }
    }

    [Fact]
    public void Registry_RejectsMissingDuplicateUnknownAndCoreIdentities()
    {
        Fixture fixture = CreateFixture();
        Assert.Throws<AuthoringExtensionContractException>(() => new AuthoringPrepublishDiagnosticRegistry(
            fixture.Extensions, default, [], []));
        Assert.Throws<AuthoringExtensionContractException>(() => new AuthoringPrepublishDiagnosticRegistry(
            fixture.Extensions, [fixture.Contribution], [], [fixture.Core]));
        Assert.Throws<AuthoringExtensionContractException>(() => new AuthoringPrepublishDiagnosticRegistry(
            fixture.Extensions, [], [], []));
        Assert.Throws<AuthoringExtensionContractException>(() => new AuthoringPrepublishDiagnosticRegistry(
            fixture.Extensions, [fixture.Contribution], [fixture.Policy], default));
        Assert.Throws<AuthoringExtensionContractException>(() => new AuthoringPrepublishDiagnosticRegistry(
            fixture.Extensions, [fixture.Contribution], [fixture.Policy], [fixture.Core, fixture.Core]));
        Assert.Throws<AuthoringExtensionContractException>(() => new AuthoringPrepublishDiagnosticRegistry(
            fixture.Extensions, [fixture.Contribution, fixture.Contribution], [fixture.Policy, fixture.Policy], [fixture.Core]));
        Assert.Throws<AuthoringExtensionContractException>(() => (fixture with
        {
            Core = fixture.Core with
            {
                CheckId = fixture.Contribution.DiagnosticId
            }
        }).Registry());
        Assert.Throws<AuthoringExtensionContractException>(() => (fixture with
        {
            Contribution = fixture.Contribution with
            {
                DiagnosticId = "fsusblog.core.security"
            }
        }).Registry());
    }

    [Theory]
    [InlineData("version")]
    [InlineData("schema")]
    [InlineData("content")]
    [InlineData("extension")]
    [InlineData("contribution")]
    [InlineData("class")]
    [InlineData("permission")]
    [InlineData("full")]
    [InlineData("related")]
    [InlineData("network")]
    [InlineData("filesystem")]
    [InlineData("policy")]
    [InlineData("scope")]
    [InlineData("metadata")]
    public void Registry_RejectsUnboundOrOverbroadDeclaration(string mutation)
    {
        Fixture fixture = CreateFixture();
        AuthoringPrepublishDiagnosticContribution value = fixture.Contribution;
        value = mutation switch
        {
            "version" => value with { Version = "1.0.0\n" },
            "schema" => value with { SchemaVersion = 2 },
            "content" => value with { ContentSha256 = Digest('0') },
            "extension" => value with { ExtensionId = "unknown.extension" },
            "contribution" => value with { ContributionId = "unknown.contribution" },
            "class" => value with { ExecutionClass = AuthoringExecutionClass.TrustedHostAdapter },
            "permission" => value with { Permissions = [AuthoringCapability.DocumentRangeRead] },
            "full" => value with { Permissions = [.. value.Permissions, AuthoringCapability.DocumentFullRead] },
            "related" => value with { Permissions = [.. value.Permissions, AuthoringCapability.ArticleQuery] },
            "network" => value with { Permissions = [.. value.Permissions, AuthoringCapability.NetworkDestination] },
            "filesystem" => value with { Permissions = [.. value.Permissions, AuthoringCapability.FileSystemRootRead] },
            "policy" => value with { PolicyReference = "policy.unknown" },
            "scope" => value with { InputSchema = value.InputSchema with { Scope = (AuthoringDiagnosticReadScope)999 } },
            "metadata" => value with { InputSchema = value.InputSchema with { MetadataKeys = ["title", "title"] } },
            _ => throw new ArgumentOutOfRangeException(nameof(mutation))
        };

        Assert.Throws<AuthoringExtensionContractException>(() => (fixture with { Contribution = value }).Registry());
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    [InlineData(7)]
    [InlineData(8)]
    [InlineData(9)]
    public void Registry_EachBudgetDimensionHasRealLowerAndUpperBounds(int dimension)
    {
        Fixture fixture = CreateFixture();
        AuthoringDiagnosticBudget budget = fixture.Contribution.Budget;
        AuthoringDiagnosticBudget[] invalid =
        [
            ChangeBudget(budget, dimension, false),
            ChangeBudget(budget, dimension, true)
        ];
        foreach (AuthoringDiagnosticBudget value in invalid)
        {
            Assert.Throws<AuthoringExtensionContractException>(() => (fixture with
            {
                Contribution = fixture.Contribution with
                {
                    Budget = value
                }
            }).Registry());
            Assert.Throws<AuthoringExtensionContractException>(() => (fixture with
            {
                Policy = fixture.Policy with
                {
                    Budget = value
                }
            }).Registry());
        }
    }

    [Fact]
    public void Registry_HostCannotExpandManifestOrDeclaredBudget()
    {
        Fixture fixture = CreateFixture();
        Assert.Throws<AuthoringExtensionContractException>(() => (fixture with
        {
            Contribution = fixture.Contribution with
            {
                Budget = fixture.Contribution.Budget with
                {
                    MemoryBytes = 128 * 1024 * 1024
                }
            }
        }).Registry());
        Assert.Throws<AuthoringExtensionContractException>(() => (fixture with
        {
            Policy = fixture.Policy with
            {
                Budget = fixture.Policy.Budget with
                {
                    ConcurrentCalls = 3
                }
            }
        }).Registry());
        Assert.Throws<AuthoringExtensionContractException>(() => (fixture with
        {
            Policy = fixture.Policy with
            {
                Codes = [fixture.Policy.Codes[0], fixture.Policy.Codes[0]]
            }
        }).Registry());
        Assert.Throws<AuthoringExtensionContractException>(() => (fixture with
        {
            Policy = fixture.Policy with
            {
                Codes = [new("link-risk", (AuthoringDiagnosticSeverity)999)]
            }
        }).Registry());
    }

    [Theory]
    [InlineData("facts")]
    [InlineData("ranges")]
    [InlineData("evidence")]
    [InlineData("bytes")]
    public void Result_EnforcesEffectiveHostPayloadAndItemBudgets(string dimension)
    {
        Fixture fixture = CreateFixture();
        AuthoringDiagnosticBudget budget = fixture.Policy.Budget;
        budget = dimension switch
        {
            "facts" => budget with { MaximumFacts = 1 },
            "ranges" => budget with { MaximumRanges = 1 },
            "evidence" => budget with { MaximumEvidence = 1 },
            "bytes" => budget with { OutputBytes = 100 },
            _ => throw new ArgumentOutOfRangeException(nameof(dimension))
        };
        AuthoringPrepublishDiagnosticRegistry registry = (fixture with
        {
            Policy = fixture.Policy with
            {
                Budget = budget
            }
        }).Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        AuthoringPrepublishDiagnosticResponse response = Response(input);
        AuthoringDiagnosticFact fact = response.Facts[0];
        response = dimension switch
        {
            "facts" => response with { Facts = [fact, fact with { Id = "acme.check.links.second" }] },
            "ranges" => response with { Facts = [fact with { Ranges = [new(2, 3), new(3, 4)] }] },
            "evidence" => response with { Facts = [fact with { Evidence = [fact.Evidence[0], new("evidence.second", Digest('d'))] }] },
            "bytes" => response,
            _ => throw new ArgumentOutOfRangeException(nameof(dimension))
        };

        Assert.Throws<AuthoringExtensionContractException>(() => registry.ValidateResult(input, response, s_now));
    }

    [Fact]
    public void Input_EnforcesSerializedBudgetBeforePublishingValue()
    {
        Fixture fixture = CreateFixture();
        AuthoringPrepublishDiagnosticRegistry registry = (fixture with
        {
            Policy = fixture.Policy with
            {
                Budget = fixture.Policy.Budget with
                {
                    InputBytes = 100
                }
            }
        }).Registry();

        Assert.Throws<AuthoringExtensionContractException>(() => Input(registry));
    }

    [Fact]
    public void Fact_CannotForgeCoreIdEvenInsideItsOwnDiagnosticNamespace()
    {
        Fixture fixture = CreateFixture();
        AuthoringPrepublishDiagnosticRegistry registry = (fixture with
        {
            Core = fixture.Core with
            {
                CheckId = "acme.check.links.finding"
            }
        }).Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);

        Assert.Throws<AuthoringExtensionContractException>(() => registry.ValidateResult(input, Response(input), s_now));
        Assert.Equal("acme.check.links.finding", Assert.Single(registry.CoreResults).CheckId);
    }

    [Theory]
    [InlineData("unknown")]
    [InlineData("missing")]
    [InlineData("duplicate")]
    [InlineData("nested-unknown")]
    [InlineData("nested-missing")]
    [InlineData("null")]
    public void ContributionJson_RejectsNonClosedShapes(string mutation)
    {
        Fixture fixture = CreateFixture();
        string json = JsonSerializer.Serialize(fixture.Contribution);
        JsonObject root = JsonNode.Parse(json)!.AsObject();
        switch (mutation)
        {
            case "unknown":
                root["Required"] = false;
                break;
            case "missing":
                root.Remove("SchemaVersion");
                break;
            case "nested-unknown":
                root["InputSchema"]!["FullDocument"] = true;
                break;
            case "nested-missing":
                root["Budget"]!.AsObject().Remove("CpuTime");
                break;
            case "duplicate":
                json = json.Replace("\"SchemaVersion\":1", "\"SchemaVersion\":1,\"SchemaVersion\":1", StringComparison.Ordinal);
                break;
            case "null":
                json = "null";
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(mutation));
        }

        byte[] bytes = Encoding.UTF8.GetBytes(mutation is "duplicate" or "null" ? json : root.ToJsonString());
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringPrepublishDiagnosticRegistry.ParseContribution(bytes));
    }

    [Theory]
    [InlineData("Required")]
    [InlineData("CoreResults")]
    [InlineData("PassOverride")]
    [InlineData("Html")]
    [InlineData("Dom")]
    [InlineData("Component")]
    [InlineData("SourcePatch")]
    [InlineData("Executable")]
    public void ResultJson_RejectsCoreOverrideRequirednessHtmlAndPatchMembers(string member)
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        JsonObject root = JsonSerializer.SerializeToNode(Response(input))!.AsObject();
        root[member] = false;
        Assert.Throws<AuthoringExtensionContractException>(() => registry.ParseResult(input,
            Encoding.UTF8.GetBytes(root.ToJsonString()), s_now));
        root.Remove(member);
        root["Facts"]![0]![member] = "payload";
        Assert.Throws<AuthoringExtensionContractException>(() => registry.ParseResult(input,
            Encoding.UTF8.GetBytes(root.ToJsonString()), s_now));
    }

    [Fact]
    public void ResultJson_RejectsMissingImplicitDuplicateOversizedAndDeepPayloads()
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        JsonObject root = JsonSerializer.SerializeToNode(Response(input))!.AsObject();
        root.Remove("Completion");
        Assert.Throws<AuthoringExtensionContractException>(() => registry.ParseResult(input,
            Encoding.UTF8.GetBytes(root.ToJsonString()), s_now));
        string duplicate = JsonSerializer.Serialize(Response(input)).Replace("\"Code\":\"link-risk\"",
            "\"Code\":\"link-risk\",\"Code\":\"link-risk\"", StringComparison.Ordinal);
        Assert.Throws<AuthoringExtensionContractException>(() => registry.ParseResult(input, Encoding.UTF8.GetBytes(duplicate), s_now));
        Assert.Throws<AuthoringExtensionContractException>(() => registry.ParseResult(input, new byte[65537], s_now));
        Assert.Throws<AuthoringExtensionContractException>(() => registry.ParseResult(input,
            Encoding.UTF8.GetBytes(new string('[', 17) + "0" + new string(']', 17)), s_now));
    }

    [Theory]
    [InlineData("core")]
    [InlineData("namespace")]
    [InlineData("code")]
    [InlineData("upgrade")]
    [InlineData("downgrade")]
    [InlineData("html")]
    [InlineData("fix")]
    [InlineData("range")]
    [InlineData("duplicate-range")]
    [InlineData("evidence")]
    [InlineData("duplicate-evidence")]
    [InlineData("null")]
    [InlineData("unicode")]
    public void ResultFacts_RejectSemanticMutations(string mutation)
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        AuthoringPrepublishDiagnosticResponse response = Response(input);
        AuthoringDiagnosticFact fact = response.Facts[0];
        fact = mutation switch
        {
            "core" => fact with { Id = "security.authoring" },
            "namespace" => fact with { Id = "other.check.finding" },
            "code" => fact with { Code = "unknown" },
            "upgrade" => fact with { Severity = AuthoringDiagnosticSeverity.Blocking },
            "downgrade" => fact with { Severity = AuthoringDiagnosticSeverity.Info },
            "html" => fact with { Message = "<script>execute()</script>" },
            "fix" => fact with { FixCommandReference = "execute.arbitrary" },
            "range" => fact with { Ranges = [new(0, 8)] },
            "duplicate-range" => fact with { Ranges = [new(2, 4), new(2, 4)] },
            "evidence" => fact with { Evidence = [new("https://attacker", Digest('e'))] },
            "duplicate-evidence" => fact with { Evidence = [fact.Evidence[0], fact.Evidence[0]] },
            "null" => null!,
            "unicode" => fact with { Message = "invalid\ud800" },
            _ => throw new ArgumentOutOfRangeException(nameof(mutation))
        };

        Assert.Throws<AuthoringExtensionContractException>(() => registry.ValidateResult(input, response with { Facts = [fact] }, s_now));
    }

    [Fact]
    public void Result_RejectsDuplicateFactsEmptyPassAndUnknownCompletion()
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        AuthoringPrepublishDiagnosticResponse response = Response(input);
        AuthoringPrepublishDiagnosticResponse[] invalid =
        [
            response with { Facts = [response.Facts[0], response.Facts[0]] },
            response with { Facts = [] },
            response with { Facts = default },
            response with { Completion = AuthoringDiagnosticCompletion.NoFindings },
            response with { Completion = (AuthoringDiagnosticCompletion)999 },
            response with { SchemaVersion = 2 },
            response with { DiagnosticId = "unknown.diagnostic" }
        ];
        foreach (AuthoringPrepublishDiagnosticResponse value in invalid)
        {
            Assert.Throws<AuthoringExtensionContractException>(() => registry.ValidateResult(input, value, s_now));
        }
    }

    [Fact]
    public void Input_RejectsOverbroadUnknownDuplicateAndUnboundReadScopes()
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        Assert.Throws<AuthoringExtensionContractException>(() => registry.CreateInput("acme.check.links", Context(),
            [new("related-article", "secret")], [], s_now));
        Assert.Throws<AuthoringExtensionContractException>(() => registry.CreateInput("acme.check.links", Context(),
            [new("title", "a"), new("title", "b")], [], s_now));
        Assert.Throws<AuthoringExtensionContractException>(() => registry.CreateInput("acme.check.links", Context(),
            [], [new("node.one", new(0, 10), "0123456789")], s_now));
        Assert.Throws<AuthoringExtensionContractException>(() => registry.CreateInput("acme.check.links", Context(),
            [], [new("node.one", new(0, 5), "01234"), new("node.two", new(5, 10), "56789")], s_now));
        Assert.Throws<AuthoringExtensionContractException>(() => registry.CreateInput("acme.check.links", Context(),
            [], [new("node.one", new(2, 5), "xx")], s_now));
        Assert.Throws<AuthoringExtensionContractException>(() => registry.CreateInput("acme.check.links", Context(),
            [], [new("node.one", new(2, 5), "abc"), new("node.two", new(4, 6), "de")], s_now));
    }

    [Fact]
    public void MetadataOnly_InputDoesNotReceiveSourceOrDefaultFullDocumentPermission()
    {
        Fixture fixture = CreateFixture();
        AuthoringContributionDeclaration declaration = fixture.Extensions.Contracts[0].Manifest.Contributions[0] with
        {
            Capabilities = [AuthoringCapability.DiagnosticReport]
        };
        AuthoringExtensionManifest manifest = fixture.Extensions.Contracts[0].Manifest with
        {
            Contributions = [declaration]
        };
        fixture = fixture with
        {
            Extensions = ExtensionRegistry(manifest),
            Contribution = fixture.Contribution with
            {
                Permissions = [AuthoringCapability.DiagnosticReport],
                InputSchema = fixture.Contribution.InputSchema with
                {
                    Scope = AuthoringDiagnosticReadScope.Metadata
                }
            }
        };
        AuthoringPrepublishDiagnosticRegistry registry = fixture.Registry();
        AuthoringPrepublishDiagnosticInput input = registry.CreateInput("acme.check.links", Context(), [new("title", "Title")], [], s_now);
        Assert.Empty(input.SourceRanges);
        Assert.Throws<AuthoringExtensionContractException>(() => registry.CreateInput("acme.check.links", Context(),
            [], [new("node.one", new(2, 5), "abc")], s_now));
    }

    [Fact]
    public void Result_SourceArticleEpochConfigGrantRuntimeAndRequestChangesRejectOldOutput()
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateFixture().Registry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        AuthoringPrepublishDiagnosticResponse response = Response(input);
        AuthoringDiagnosticHostContext context = Context();
        AuthoringDiagnosticHostContext[] changed =
        [
            context with { ArticleId = 2 },
            context with { DocumentId = "document.two" },
            context with { DocumentEpoch = 2 },
            context with { SourceRevision = 2 },
            context with { SourceSha256 = Digest('0') },
            context with { ConfigSha256 = Digest('0') },
            context with { GrantSha256 = Digest('0') },
            context with { RuntimeVersion = "2.0.0" },
            context with { RequestId = "request.two" },
            context with { Deadline = context.Deadline - TimeSpan.FromSeconds(1) }
        ];
        foreach (AuthoringDiagnosticHostContext current in changed)
        {
            AuthoringPrepublishDiagnosticInput newInput = registry.CreateInput(input.DiagnosticId, current, input.Metadata, input.SourceRanges, s_now);
            Assert.NotEqual(input.InputSha256, newInput.InputSha256);
            Assert.Throws<AuthoringExtensionContractException>(() => registry.ValidateResult(newInput, response, s_now));
        }

        Assert.Throws<AuthoringExtensionContractException>(() => registry.ValidateResult(input, response, context.Deadline));
        Assert.Throws<AuthoringExtensionContractException>(() => registry.ValidateResult(input with
        {
            Metadata = [new("title", "tampered")]
        }, response, s_now));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(100)]
    [InlineData(1000)]
    public void Registry_AdmitsExactBoundedRosterAndRejectsOverflow(int count)
    {
        Fixture fixture = CreateFixture();
        AuthoringExtensionManifest manifest = fixture.Extensions.Contracts[0].Manifest;
        ImmutableArray<AuthoringPrepublishDiagnosticContribution> contributions =
        [
            .. Enumerable.Range(0, count).Select(index => fixture.Contribution with
            {
                DiagnosticId = $"acme.check.item{index}",
                ContributionId = $"acme.check.item{index}"
            })
        ];
        if (count == 0)
        {
            var empty = new AuthoringPrepublishDiagnosticRegistry(
                AuthoringExtensionContractValidator.CreateRegistry([], new([], [], [], [], [])), [], [], []);
            Assert.Empty(empty.CoreResults);
            Assert.Empty(empty.ExpectedDiagnostics.Registrations);
            Assert.Empty(empty.ValidateOutcomeCoverage(empty.ExpectedDiagnostics, [], s_now).Slots);
            return;
        }

        manifest = manifest with
        {
            Contributions = [.. contributions.Select(value => manifest.Contributions[0] with { Id = value.ContributionId })]
        };
        ImmutableArray<AuthoringDiagnosticHostPolicy> policies =
            [.. contributions.Select(value => fixture.Policy with { DiagnosticId = value.DiagnosticId })];
        AuthoringExtensionRegistrySnapshot extensions = ExtensionRegistry(manifest);
        var registry = new AuthoringPrepublishDiagnosticRegistry(extensions, contributions, policies, [fixture.Core]);
        Assert.Equal(contributions[^1], registry.Get(contributions[^1].DiagnosticId));
        Assert.Equal(count, registry.ExpectedDiagnostics.Registrations.Length);
        AuthoringDiagnosticOutcomeCoverage coverage = registry.ValidateOutcomeCoverage(registry.ExpectedDiagnostics, [], s_now);
        Assert.Equal(count, coverage.Slots.Length);
        Assert.All(coverage.Slots, static slot => Assert.Equal(AuthoringDiagnosticOutcomeStatus.RequiredUnavailable, slot.Status));
        if (count == 1000)
        {
            Assert.Throws<AuthoringExtensionContractException>(() => new AuthoringPrepublishDiagnosticRegistry(
                extensions, [.. contributions, contributions[0]], [.. policies, policies[0]], [fixture.Core]));
        }
    }

    [Fact]
    public void ExpectedRoster_IsCompleteCanonicalAndBoundToHostPolicy()
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateRosterRegistry();
        AuthoringDiagnosticExpectedRoster roster = registry.ExpectedDiagnostics;
        Assert.Equal(1, roster.SchemaVersion);
        Assert.Equal(registry.RegistrySha256, roster.RegistrySha256);
        Assert.Equal(64, roster.RosterSha256.Length);
        Assert.Equal(["acme.check.links", "acme.check.optional"], roster.Registrations.Select(static entry => entry.DiagnosticId));
        Assert.Equal([true, false], roster.Registrations.Select(static entry => entry.Required));
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        Assert.Equal(input.ContributionSha256, roster.Registrations[0].ContributionSha256);
        Assert.Equal(input.PolicySha256, roster.Registrations[0].PolicySha256);

        AuthoringDiagnosticExpectedRoster reorderedConstruction = CreateRosterRegistry(reverse: true).ExpectedDiagnostics;
        Assert.Equal(roster.RosterSha256, reorderedConstruction.RosterSha256);
        Assert.Equal(roster.Registrations, reorderedConstruction.Registrations);

        ImmutableArray<AuthoringDiagnosticExpectedRegistration> changed = roster.Registrations.SetItem(0,
            roster.Registrations[0] with
            {
                Required = false
            });
        Assert.True(registry.ExpectedDiagnostics.Registrations[0].Required);
        Assert.False(changed[0].Required);
        AuthoringDiagnosticOutcomeCoverage copied = registry.ValidateOutcomeCoverage(roster with
        {
            Registrations = [.. roster.Registrations]
        }, [], s_now);
        Assert.Same(roster, copied.ExpectedDiagnostics);
    }

    [Fact]
    public void Coverage_EmptyRegisteredRosterIsDifferentFromMissingRegisteredOutcomes()
    {
        var empty = new AuthoringPrepublishDiagnosticRegistry(
            AuthoringExtensionContractValidator.CreateRegistry([], new([], [], [], [], [])), [], [], []);
        AuthoringDiagnosticOutcomeCoverage noRegistrations = empty.ValidateOutcomeCoverage(empty.ExpectedDiagnostics, [], s_now);
        Assert.Empty(noRegistrations.ExpectedDiagnostics.Registrations);
        Assert.Empty(noRegistrations.Slots);
        Assert.True(noRegistrations.HasAllOutcomes);

        AuthoringPrepublishDiagnosticRegistry registry = CreateRosterRegistry();
        AuthoringDiagnosticOutcomeCoverage missing = registry.ValidateOutcomeCoverage(registry.ExpectedDiagnostics, [], s_now);
        Assert.False(missing.HasAllOutcomes);
        Assert.Equal(2, missing.Slots.Length);
        Assert.All(missing.Slots, static slot =>
        {
            Assert.True(slot.IsAbsent);
            Assert.Null(slot.Outcome);
        });
        Assert.True(missing.Slots[0].Registration.Required);
        Assert.Equal(AuthoringDiagnosticOutcomeStatus.RequiredUnavailable, missing.Slots[0].Status);
        Assert.False(missing.Slots[1].Registration.Required);
        Assert.Equal(AuthoringDiagnosticOutcomeStatus.OptionalNotEvaluable, missing.Slots[1].Status);
        Assert.Equal(Digest('f'), Assert.Single(registry.CoreResults).ResultSha256);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Coverage_OmittedRequiredAndOptionalUseOriginalHostRequiredness(bool omitRequired)
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateRosterRegistry();
        string suppliedId = omitRequired ? "acme.check.optional" : "acme.check.links";
        AuthoringPrepublishDiagnosticResult supplied = NoFindings(registry, suppliedId);
        AuthoringDiagnosticOutcomeCoverage coverage = registry.ValidateOutcomeCoverage(registry.ExpectedDiagnostics, [supplied], s_now);
        AuthoringDiagnosticOutcomeSlot missing = Assert.Single(coverage.Slots, static slot => slot.IsAbsent);
        Assert.Equal(omitRequired, missing.Registration.Required);
        Assert.Equal(omitRequired ? AuthoringDiagnosticOutcomeStatus.RequiredUnavailable :
            AuthoringDiagnosticOutcomeStatus.OptionalNotEvaluable, missing.Status);
        Assert.Null(missing.Outcome);
        Assert.False(coverage.HasAllOutcomes);
        Assert.Equal(AuthoringDiagnosticOutcomeStatus.NoFindings,
            Assert.Single(coverage.Slots, static slot => !slot.IsAbsent).Status);
    }

    [Fact]
    public void Coverage_CompleteResultsAreCanonicalAndPresenceDoesNotMeanSuccess()
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateRosterRegistry();
        AuthoringPrepublishDiagnosticResult required = NoFindings(registry, "acme.check.links");
        AuthoringPrepublishDiagnosticResult optional = NoFindings(registry, "acme.check.optional");
        AuthoringDiagnosticOutcomeCoverage complete = registry.ValidateOutcomeCoverage(
            registry.ExpectedDiagnostics, [optional, required], s_now);
        Assert.True(complete.HasAllOutcomes);
        Assert.Equal(registry.ExpectedDiagnostics.Registrations,
            complete.Slots.Select(static slot => slot.Registration).ToImmutableArray());
        Assert.All(complete.Slots, static slot => Assert.False(slot.IsAbsent));

        AuthoringPrepublishDiagnosticResult failedRequired = registry.Unavailable(required.Input, AuthoringDiagnosticUnavailableReason.Crashed);
        AuthoringPrepublishDiagnosticResult failedOptional = registry.Unavailable(optional.Input, AuthoringDiagnosticUnavailableReason.Disabled);
        AuthoringDiagnosticOutcomeCoverage failures = registry.ValidateOutcomeCoverage(
            registry.ExpectedDiagnostics, [failedRequired, failedOptional], required.Input.Context.Deadline);
        Assert.True(failures.HasAllOutcomes);
        Assert.Equal(AuthoringDiagnosticOutcomeStatus.RequiredUnavailable, failures.Slots[0].Status);
        Assert.Equal(AuthoringDiagnosticOutcomeStatus.OptionalNotEvaluable, failures.Slots[1].Status);
        Assert.All(failures.Slots, static slot => Assert.Empty(slot.Outcome!.Facts));
    }

    [Theory]
    [InlineData("schema")]
    [InlineData("registry")]
    [InlineData("digest")]
    [InlineData("default")]
    [InlineData("empty")]
    [InlineData("missing-required")]
    [InlineData("duplicate")]
    [InlineData("unknown")]
    [InlineData("order")]
    [InlineData("requiredness")]
    [InlineData("contribution")]
    [InlineData("policy")]
    [InlineData("null")]
    public void Coverage_RejectsIncompleteDuplicateOrTamperedExpectedRoster(string mutation)
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateRosterRegistry();
        AuthoringDiagnosticExpectedRoster roster = registry.ExpectedDiagnostics;
        AuthoringDiagnosticExpectedRegistration required = roster.Registrations[0];
        AuthoringDiagnosticExpectedRegistration optional = roster.Registrations[1];
        AuthoringDiagnosticExpectedRoster changed = mutation switch
        {
            "schema" => roster with { SchemaVersion = 2 },
            "registry" => roster with { RegistrySha256 = Digest('0') },
            "digest" => roster with { RosterSha256 = Digest('0') },
            "default" => roster with { Registrations = default },
            "empty" => roster with { Registrations = [] },
            "missing-required" => roster with { Registrations = [optional] },
            "duplicate" => roster with { Registrations = [required, required] },
            "unknown" => roster with { Registrations = [required with { DiagnosticId = "unknown.diagnostic" }, optional] },
            "order" => roster with { Registrations = [optional, required] },
            "requiredness" => roster with { Registrations = [required with { Required = false }, optional] },
            "contribution" => roster with { Registrations = [required with { ContributionSha256 = Digest('0') }, optional] },
            "policy" => roster with { Registrations = [required with { PolicySha256 = Digest('0') }, optional] },
            "null" => roster with { Registrations = [null!, optional] },
            _ => throw new ArgumentOutOfRangeException(nameof(mutation))
        };

        Assert.Throws<AuthoringExtensionContractException>(() => registry.ValidateOutcomeCoverage(changed, [], s_now));
    }

    [Fact]
    public void Coverage_HostPolicyChangeInvalidatesRosterAndPreviousOutcomes()
    {
        Fixture fixture = CreateFixture();
        AuthoringPrepublishDiagnosticRegistry previous = fixture.Registry();
        AuthoringPrepublishDiagnosticRegistry current = (fixture with
        {
            Policy = fixture.Policy with
            {
                Required = false
            }
        }).Registry();
        Assert.NotEqual(previous.ExpectedDiagnostics.RosterSha256, current.ExpectedDiagnostics.RosterSha256);
        Assert.Throws<AuthoringExtensionContractException>(() => current.ValidateOutcomeCoverage(previous.ExpectedDiagnostics, [], s_now));
        Assert.Throws<AuthoringExtensionContractException>(() => current.ValidateOutcomeCoverage(previous.ExpectedDiagnostics with
        {
            RegistrySha256 = current.RegistrySha256,
            RosterSha256 = current.ExpectedDiagnostics.RosterSha256
        }, [], s_now));
        Assert.Throws<AuthoringExtensionContractException>(() => current.ValidateOutcomeCoverage(current.ExpectedDiagnostics,
            [NoFindings(previous, fixture.Contribution.DiagnosticId)], s_now));
    }

    [Fact]
    public void Coverage_RejectsDefaultNullDuplicateUnknownAndExpiredOutcomes()
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateRosterRegistry();
        AuthoringPrepublishDiagnosticResult result = NoFindings(registry, "acme.check.links");
        Assert.Throws<AuthoringExtensionContractException>(() => registry.ValidateOutcomeCoverage(null!, [], s_now));
        Assert.Throws<AuthoringExtensionContractException>(() => registry.ValidateOutcomeCoverage(registry.ExpectedDiagnostics, default, s_now));
        Assert.Throws<AuthoringExtensionContractException>(() => registry.ValidateOutcomeCoverage(registry.ExpectedDiagnostics, [null!], s_now));
        Assert.Throws<AuthoringExtensionContractException>(() => registry.ValidateOutcomeCoverage(registry.ExpectedDiagnostics, [result, result], s_now));
        Assert.Throws<AuthoringExtensionContractException>(() => registry.ValidateOutcomeCoverage(registry.ExpectedDiagnostics,
            [new(result.Input with { DiagnosticId = "unknown.diagnostic" }, true,
                AuthoringDiagnosticOutcomeStatus.NoFindings, [], null)], s_now));
        Assert.Throws<AuthoringExtensionContractException>(() => registry.ValidateOutcomeCoverage(registry.ExpectedDiagnostics,
            [result], result.Input.Context.Deadline));
    }

    [Theory]
    [InlineData("requiredness")]
    [InlineData("downgraded-unavailable")]
    [InlineData("unknown-status")]
    [InlineData("completed-with-reason")]
    [InlineData("unavailable-with-facts")]
    [InlineData("empty-findings")]
    [InlineData("default-facts")]
    [InlineData("input")]
    [InlineData("severity")]
    public void Coverage_RevalidatesTypedOutcomesInsteadOfTrustingTheirLabels(string mutation)
    {
        AuthoringPrepublishDiagnosticRegistry registry = CreateRosterRegistry();
        AuthoringPrepublishDiagnosticInput input = Input(registry);
        AuthoringPrepublishDiagnosticResult valid = registry.ValidateResult(input, Response(input), s_now);
        AuthoringPrepublishDiagnosticResult changed = mutation switch
        {
            "requiredness" => new(input, false, valid.Status, valid.Facts, null),
            "downgraded-unavailable" => new(input, true, AuthoringDiagnosticOutcomeStatus.OptionalNotEvaluable, [],
                AuthoringDiagnosticUnavailableReason.Crashed),
            "unknown-status" => new(input, true, (AuthoringDiagnosticOutcomeStatus)999, [], AuthoringDiagnosticUnavailableReason.Crashed),
            "completed-with-reason" => new(input, true, valid.Status, valid.Facts, AuthoringDiagnosticUnavailableReason.Crashed),
            "unavailable-with-facts" => new(input, true, AuthoringDiagnosticOutcomeStatus.RequiredUnavailable, valid.Facts,
                AuthoringDiagnosticUnavailableReason.Crashed),
            "empty-findings" => new(input, true, AuthoringDiagnosticOutcomeStatus.Findings, [], null),
            "default-facts" => new(input, true, AuthoringDiagnosticOutcomeStatus.NoFindings, default, null),
            "input" => new(input with { PolicySha256 = Digest('0') }, true, valid.Status, valid.Facts, null),
            "severity" => new(input, true, valid.Status, [valid.Facts[0] with { Severity = AuthoringDiagnosticSeverity.Info }], null),
            _ => throw new ArgumentOutOfRangeException(nameof(mutation))
        };

        Assert.Throws<AuthoringExtensionContractException>(() => registry.ValidateOutcomeCoverage(registry.ExpectedDiagnostics, [changed], s_now));
    }

    private static AuthoringPrepublishDiagnosticRegistry CreateRosterRegistry(bool reverse = false)
    {
        Fixture fixture = CreateFixture();
        AuthoringExtensionManifest manifest = fixture.Extensions.Contracts[0].Manifest;
        AuthoringPrepublishDiagnosticContribution optional = fixture.Contribution with
        {
            DiagnosticId = "acme.check.optional",
            ContributionId = "acme.check.optional"
        };
        ImmutableArray<AuthoringPrepublishDiagnosticContribution> contributions = [fixture.Contribution, optional];
        ImmutableArray<AuthoringDiagnosticHostPolicy> policies =
            [fixture.Policy, fixture.Policy with { DiagnosticId = optional.DiagnosticId, Required = false }];
        manifest = manifest with
        {
            Contributions = [.. contributions.Select(value => manifest.Contributions[0] with { Id = value.ContributionId })]
        };
        if (reverse)
        {
            contributions = [.. contributions.Reverse()];
            policies = [.. policies.Reverse()];
        }

        return new AuthoringPrepublishDiagnosticRegistry(ExtensionRegistry(manifest), contributions, policies, [fixture.Core]);
    }

    private static AuthoringPrepublishDiagnosticResult NoFindings(AuthoringPrepublishDiagnosticRegistry registry, string diagnosticId)
    {
        AuthoringPrepublishDiagnosticInput input = registry.CreateInput(diagnosticId, Context(), [new("title", "Title")],
            [new("node.one", new(2, 5), "abc")], s_now);
        return registry.ValidateResult(input, new(1, diagnosticId, input.InputSha256, AuthoringDiagnosticCompletion.NoFindings, []), s_now);
    }

    private static AuthoringDiagnosticBudget ChangeBudget(AuthoringDiagnosticBudget value, int dimension, bool upper) => dimension switch
    {
        0 => value with { CpuTime = upper ? TimeSpan.FromMinutes(6) : TimeSpan.Zero },
        1 => value with { WallTime = upper ? TimeSpan.FromMinutes(6) : TimeSpan.Zero },
        2 => value with { MemoryBytes = upper ? 536_870_913 : 0 },
        3 => value with { InputBytes = upper ? 1_048_577 : 0 },
        4 => value with { OutputBytes = upper ? 1_048_577 : 0 },
        5 => value with { ConcurrentCalls = upper ? 33 : 0 },
        6 => value with { QueueDepth = upper ? 1025 : 0 },
        7 => value with { MaximumFacts = upper ? 1001 : 0 },
        8 => value with { MaximumRanges = upper ? 1001 : 0 },
        9 => value with { MaximumEvidence = upper ? 101 : 0 },
        _ => throw new ArgumentOutOfRangeException(nameof(dimension))
    };

    private static AuthoringPrepublishDiagnosticInput Input(AuthoringPrepublishDiagnosticRegistry registry) =>
        registry.CreateInput("acme.check.links", Context(), [new("title", "Title")],
            [new("node.one", new(2, 5), "abc")], s_now);

    private static AuthoringPrepublishDiagnosticResponse Response(
        AuthoringPrepublishDiagnosticInput input,
        AuthoringDiagnosticSeverity severity = AuthoringDiagnosticSeverity.Warning) => new(
            1, input.DiagnosticId, input.InputSha256, AuthoringDiagnosticCompletion.Findings,
            [new("acme.check.links.finding", "link-risk", severity, "Link requires review", [new(2, 4)],
                [new("evidence.link", Digest('e'))], "fix.link")]);

    private static AuthoringDiagnosticHostContext Context() => new(
        1, "document.one", 1, 1, 10, Digest('1'), Digest('2'), Digest('3'), Digest('4'), "1.0.0", Digest('5'),
        "request.one", s_now + TimeSpan.FromSeconds(4));

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
        var contribution = new AuthoringPrepublishDiagnosticContribution(1, declaration.Id, "1.0.0", manifest.Id,
            declaration.Id, declaration.Entrypoint.ContentSha256, declaration.ExecutionClass, declaration.Capabilities,
            new(1, AuthoringDiagnosticReadScope.SourceRanges, "read-model.markdown.v1", ["title"]), "policy.links.v1", budget);
        var policy = new AuthoringDiagnosticHostPolicy(declaration.Id, "policy.links.v1", true,
            [new("link-risk", AuthoringDiagnosticSeverity.Warning)], ["fix.link"], budget);
        return new Fixture(ExtensionRegistry(manifest), contribution, policy,
            new("security.authoring", true, AuthoringDiagnosticSeverity.Blocking, Digest('f')));
    }

    private static AuthoringExtensionRegistrySnapshot ExtensionRegistry(AuthoringExtensionManifest manifest) =>
        AuthoringExtensionContractValidator.CreateRegistry([AuthoringExtensionContractValidator.Verify(manifest)],
            new([], [], [], [], ["security.authoring"]));

    private static string Digest(char character) => new(character, 64);

    private sealed record Fixture(
        AuthoringExtensionRegistrySnapshot Extensions,
        AuthoringPrepublishDiagnosticContribution Contribution,
        AuthoringDiagnosticHostPolicy Policy,
        AuthoringDiagnosticCoreResult Core)
    {
        public AuthoringPrepublishDiagnosticRegistry Registry() => new(Extensions, [Contribution], [Policy], [Core]);
    }
}
