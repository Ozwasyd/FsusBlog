using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.DiagnosticContractReview;

internal static class Program
{
    private static readonly DateTimeOffset s_now = new(2026, 10, 17, 0, 0, 0, TimeSpan.Zero);
    private static readonly List<object> s_results = [];
    private static int s_failures;

    private static int Main()
    {
        foreach (bool required in new[] { false, true })
        {
            foreach (AuthoringDiagnosticSeverity severity in Enum.GetValues<AuthoringDiagnosticSeverity>())
            {
                Check($"positive-required-{required}-severity-{severity}", () =>
                {
                    Fixture fixture = CreateFixture(required, severity);
                    var registry = fixture.Registry();
                    var input = Input(registry);
                    var result = registry.ParseResult(input, Bytes(Response(input, severity)), s_now);
                    Ensure(result.Required == required && result.Facts[0].Severity == severity, "Host policy changed.");
                    Ensure(registry.CoreResults.Single() == fixture.Core, "Core observation changed.");
                    foreach (var reason in Enum.GetValues<AuthoringDiagnosticUnavailableReason>())
                    {
                        var unavailable = registry.Unavailable(input, reason);
                        Ensure(unavailable.Required == required && unavailable.UnavailableReason == reason &&
                            unavailable.Status == (required ? AuthoringDiagnosticOutcomeStatus.RequiredUnavailable :
                                AuthoringDiagnosticOutcomeStatus.OptionalNotEvaluable), "Unavailable became success.");
                    }
                });
            }
        }

        var original = CreateFixture();
        var host = original.Registry();
        var admitted = Input(host);
        var response = Response(admitted);
        foreach (string field in new[] { "Required", "CoreResults", "PassOverride", "Html", "Dom", "SourcePatch", "Executable", "Budget" })
        {
            foreach (bool nested in new[] { false, true })
            {
                Check($"closed-output-{field}-nested-{nested}", () =>
                {
                    var root = JsonSerializer.SerializeToNode(response)!.AsObject();
                    (nested ? root["Facts"]![0]!.AsObject() : root)[field] = "untrusted";
                    Reject(() => host.ParseResult(admitted, Bytes(root), s_now));
                });
            }
        }

        Check("duplicate-decoded-json-property", () => Reject(() => host.ParseResult(admitted,
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(response).Replace("\"Code\":\"review\"",
                "\"Code\":\"review\",\"\\u0043ode\":\"review\"", StringComparison.Ordinal)), s_now)));
        Check("missing-nullable-output-member", () =>
        {
            var root = JsonSerializer.SerializeToNode(response)!;
            root["Facts"]![0]!.AsObject().Remove("FixCommandReference");
            Reject(() => host.ParseResult(admitted, Bytes(root), s_now));
        });
        Check("unknown-output-schema", () => Reject(() => host.ValidateResult(admitted, response with { SchemaVersion = 2 }, s_now)));
        Check("unknown-completion", () => Reject(() => host.ValidateResult(admitted,
            response with
            {
                Completion = (AuthoringDiagnosticCompletion)99
            }, s_now)));
        Check("empty-findings", () => Reject(() => host.ValidateResult(admitted, response with { Facts = [] }, s_now)));
        Check("nofindings-with-facts", () => Reject(() => host.ValidateResult(admitted,
            response with
            {
                Completion = AuthoringDiagnosticCompletion.NoFindings
            }, s_now)));
        Check("explicit-nofindings", () => Ensure(host.ValidateResult(admitted,
            response with
            {
                Completion = AuthoringDiagnosticCompletion.NoFindings,
                Facts = []
            }, s_now).Status ==
                AuthoringDiagnosticOutcomeStatus.NoFindings, "NoFindings lost its explicit status."));
        Check("html-escaped-json", () => Reject(() => host.ParseResult(admitted,
            Bytes(response with
            {
                Facts = [response.Facts[0] with { Message = "<img src=x onerror=x>" }]
            }), s_now)));
        Check("unknown-code", () => RejectFact(response.Facts[0] with { Code = "unregistered" }));
        Check("severity-downgrade", () => RejectFact(response.Facts[0] with { Severity = AuthoringDiagnosticSeverity.Info }));
        Check("severity-upgrade", () => RejectFact(response.Facts[0] with { Severity = AuthoringDiagnosticSeverity.Blocking }));
        Check("duplicate-facts", () => Reject(() => host.ValidateResult(admitted,
            response with
            {
                Facts = [response.Facts[0], response.Facts[0]]
            }, s_now)));
        Check("core-fact-namespace", () => RejectFact(response.Facts[0] with { Id = "security.publication" }));
        Check("core-fact-already-in-diagnostic-namespace", () =>
        {
            var registry = (original with
            {
                Core = original.Core with
                {
                    CheckId = response.Facts[0].Id
                }
            }).Registry();
            var input = Input(registry);
            Reject(() => registry.ValidateResult(input, Response(input), s_now));
        });
        Check("whole-document", () => Reject(() => host.CreateInput(original.Contribution.DiagnosticId, Context(), [],
            [new("node.one", new(0, 10), "0123456789")], s_now)));
        Check("split-whole-document", () => Reject(() => host.CreateInput(original.Contribution.DiagnosticId, Context(), [],
            [new("node.one", new(0, 4), "0123"), new("node.two", new(4, 10), "456789")], s_now)));
        Check("unknown-metadata", () => Reject(() => host.CreateInput(original.Contribution.DiagnosticId, Context(),
            [new("related-article", "secret")], [], s_now)));
        Check("duplicate-metadata", () => Reject(() => host.CreateInput(original.Contribution.DiagnosticId, Context(),
            [new("title", "one"), new("title", "two")], [], s_now)));
        Check("fact-range-outside-admitted-read", () => RejectFact(response.Facts[0] with { Ranges = [new(0, 2)] }));
        Check("deadline-exact-boundary", () => Reject(() => host.ValidateResult(admitted, response, admitted.Context.Deadline)));
        Check("foreign-registry-core-digest", () => Reject(() =>
            (original with
            {
                Core = original.Core with
                {
                    ResultSha256 = Digest('e')
                }
            }).Registry().ValidateResult(admitted, response, s_now)));
        Check("foreign-registry-requiredness", () => Reject(() =>
            (original with
            {
                Policy = original.Policy with
                {
                    Required = false
                }
            }).Registry().ValidateResult(admitted, response, s_now)));
        Check("changed-document-epoch", () => Reject(() => host.ValidateResult(admitted with
        {
            Context = admitted.Context with
            {
                DocumentEpoch = 2
            }
        }, response, s_now)));
        Check("changed-config", () => Reject(() => host.ValidateResult(admitted with
        {
            Context = admitted.Context with
            {
                ConfigSha256 = Digest('e')
            }
        }, response, s_now)));
        Check("changed-range-text", () => Reject(() => host.ValidateResult(admitted with
        {
            SourceRanges = [admitted.SourceRanges[0] with { Text = "xyz" }]
        }, response, s_now)));
        Check("unknown-declaration-member", () =>
        {
            var root = JsonSerializer.SerializeToNode(original.Contribution)!;
            root["InputSchema"]!["FullDocument"] = true;
            Reject(() => AuthoringPrepublishDiagnosticRegistry.ParseContribution(Bytes(root)));
        });
        foreach (var permission in new[] { AuthoringCapability.DocumentFullRead, AuthoringCapability.ArticleQuery,
            AuthoringCapability.NetworkDestination, AuthoringCapability.FileSystemRootRead, AuthoringCapability.DocumentMutationRequest })
        {
            Check($"capability-{permission}", () => Reject(() => (original with
            {
                Contribution = original.Contribution with
                {
                    Permissions = [.. original.Contribution.Permissions, permission]
                }
            }).Registry()));
        }
        Check("host-effective-output-byte-boundary", () =>
        {
            int size = Bytes(response).Length;
            var tight = (original with
            {
                Policy = original.Policy with
                {
                    Budget = original.Policy.Budget with
                    {
                        OutputBytes = size
                    }
                }
            }).Registry();
            var input = Input(tight);
            tight.ParseResult(input, Bytes(Response(input)), s_now);
            var exceeded = (original with
            {
                Policy = original.Policy with
                {
                    Budget = original.Policy.Budget with
                    {
                        OutputBytes = size - 1
                    }
                }
            }).Registry();
            var other = Input(exceeded);
            Reject(() => exceeded.ParseResult(other, Bytes(Response(other)), s_now));
        });
        Check("host-cannot-expand-declared-budget", () => Reject(() => (original with
        {
            Policy = original.Policy with
            {
                Budget = original.Policy.Budget with
                {
                    ConcurrentCalls = 2
                }
            }
        }).Registry()));
        Check("duplicate-host-policy", () => Reject(() => new AuthoringPrepublishDiagnosticRegistry(original.Extensions,
            [original.Contribution], [original.Policy, original.Policy], [original.Core])));

        // Expected refusal controls: these must stay red if the exact reviewed head admits a core identity collision.
        Check("core-check-alias-through-contribution-id", () =>
        {
            var collision = original with
            {
                Contribution = original.Contribution with
                {
                    DiagnosticId = "review.alias"
                },
                Policy = original.Policy with
                {
                    DiagnosticId = "review.alias"
                },
                Core = original.Core with
                {
                    CheckId = original.Contribution.ContributionId
                }
            };
            Reject(() => collision.Registry());
        });
        Check("core-check-alias-through-extension-id", () => Reject(() =>
            (original with
            {
                Core = original.Core with
                {
                    CheckId = original.Contribution.ExtensionId
                }
            }).Registry()));

        string assembly = typeof(AuthoringPrepublishDiagnosticRegistry).Assembly.Location;
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            ReviewedHead = "8fe951bd802f4907e90c33f57feef2d7d0e59a47",
            AssemblySha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly))),
            Total = s_results.Count,
            Passed = s_results.Count - s_failures,
            Failed = s_failures,
            Results = s_results
        }, new JsonSerializerOptions { WriteIndented = true }));
        return s_failures > 0 ? 1 : 0;

        void RejectFact(AuthoringDiagnosticFact fact) => Reject(() => host.ValidateResult(admitted,
            response with
            {
                Facts = [fact]
            }, s_now));
    }

    private static void Check(string name, Action assertion)
    {
        try
        {
            assertion();
            s_results.Add(new
            {
                Name = name,
                Status = "PASS"
            });
        }
        catch (Exception exception)
        {
            s_failures++;
            s_results.Add(new
            {
                Name = name,
                Status = "FAIL",
                Error = exception.Message
            });
        }
    }

    private static void Reject(Action action)
    {
        try
        {
            action();
        }
        catch (AuthoringExtensionContractException)
        {
            return;
        }
        throw new InvalidOperationException("Expected AuthoringExtensionContractException; exact-head API accepted the forbidden input.");
    }

    private static void Ensure(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private static byte[] Bytes<T>(T value) => JsonSerializer.SerializeToUtf8Bytes(value);
    private static string Digest(char character) => new(character, 64);
    private static AuthoringDiagnosticHostContext Context() => new(1, "document.one", 1, 1, 10,
        Digest('1'), Digest('2'), Digest('3'), Digest('4'), "1.0.0", Digest('5'), "request.one", s_now.AddSeconds(4));
    private static AuthoringPrepublishDiagnosticInput Input(AuthoringPrepublishDiagnosticRegistry registry) =>
        registry.CreateInput("review.check", Context(), [new("title", "Review")], [new("node.one", new(2, 5), "abc")], s_now);
    private static AuthoringPrepublishDiagnosticResponse Response(AuthoringPrepublishDiagnosticInput input,
        AuthoringDiagnosticSeverity severity = AuthoringDiagnosticSeverity.Warning) => new(1, input.DiagnosticId, input.InputSha256,
        AuthoringDiagnosticCompletion.Findings, [new("review.check.fact", "review", severity, "Review text", [new(2, 4)],
            [new("evidence.one", Digest('a'))], null)]);

    private static Fixture CreateFixture(bool required = true, AuthoringDiagnosticSeverity severity = AuthoringDiagnosticSeverity.Warning)
    {
        var declaration = new AuthoringContributionDeclaration("review.check", AuthoringContributionKind.PrepublishDiagnostic,
            AuthoringExecutionClass.IsolatedWorkerWasm, new(AuthoringEntrypointFormat.WasmModule, "worker/review.wasm", Digest('c')),
            [AuthoringCapability.DiagnosticReport, AuthoringCapability.DocumentRangeRead]);
        var manifest = new AuthoringExtensionManifest(1, 1, "review.extension", "1.0.0", Digest('a'), Digest('b'), "review",
            "sig/review", "trust/review", new(1, 1), [AuthoringHostPlatform.ServerLinux], [declaration],
            new(TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(5), 67108864, 65536, 65536, 2, 8, 8, 0, 0, 0, 0),
            1, 1, AuthoringUpdatePolicy.AtomicSwitchWithRollback, AuthoringMigrationPolicy.HostDeclarativeOnly,
            AuthoringUninstallPolicy.RemoveAuthorityRetainData, false);
        var extensions = AuthoringExtensionContractValidator.CreateRegistry([AuthoringExtensionContractValidator.Verify(manifest)],
            new([], [], [], [], []));
        var budget = new AuthoringDiagnosticBudget(TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(5), 67108864,
            65536, 65536, 1, 8, 10, 10, 10);
        var contribution = new AuthoringPrepublishDiagnosticContribution(1, declaration.Id, "1.0.0", manifest.Id, declaration.Id,
            declaration.Entrypoint.ContentSha256, declaration.ExecutionClass, declaration.Capabilities,
            new(1, AuthoringDiagnosticReadScope.SourceRanges, "markdown.v1", ["title"]), "policy.review", budget);
        return new(extensions, contribution, new(declaration.Id, "policy.review", required, [new("review", severity)], [], budget),
            new("security.publication", true, AuthoringDiagnosticSeverity.Blocking, Digest('f')));
    }

    private sealed record Fixture(AuthoringExtensionRegistrySnapshot Extensions, AuthoringPrepublishDiagnosticContribution Contribution,
        AuthoringDiagnosticHostPolicy Policy, AuthoringDiagnosticCoreResult Core)
    {
        public AuthoringPrepublishDiagnosticRegistry Registry() => new(Extensions, [Contribution], [Policy], [Core]);
    }
}
