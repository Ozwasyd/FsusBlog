using System.Collections.Immutable;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringPrepublishDiagnosticCombinerTests
{
    private static readonly DateTimeOffset s_now = new(2026, 10, 18, 0, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData(AuthoringDiagnosticSeverity.Info)]
    [InlineData(AuthoringDiagnosticSeverity.Warning)]
    [InlineData(AuthoringDiagnosticSeverity.Blocking)]
    public void Findings_OnlyAddHostApprovedFactsAndPreserveEveryCoreObservation(AuthoringDiagnosticSeverity severity)
    {
        AuthoringPrepublishDiagnosticRegistry registry = Registry();
        ImmutableArray<AuthoringPrepublishDiagnosticResult> outcomes =
            [.. registry.ExpectedDiagnostics.Registrations.Select(registration => Finding(registry, registration.DiagnosticId, severity))];

        AuthoringPrepublishDiagnosticCombiner.Combination combined = Combine(registry, outcomes);

        Assert.Equal(severity == AuthoringDiagnosticSeverity.Blocking, combined.HasBlockingPluginDiagnostics);
        Assert.True(combined.Coverage.HasAllOutcomes);
        Assert.Equal(registry.CoreResultsSha256, combined.CoreResultsSha256);
        Assert.Equal(registry.CoreResults, combined.CoreResults);
        for (int index = 0; index < registry.CoreResults.Length; index++)
        {
            Assert.Same(registry.CoreResults[index], combined.CoreResults[index]);
        }

        Assert.Equal(outcomes.Select(outcome => outcome.Required), combined.Coverage.Slots.Select(slot => slot.Registration.Required));
        Assert.All(combined.Coverage.Slots, slot => Assert.Equal(severity, Assert.Single(slot.Outcome!.Facts).Severity));
        Assert.Equal(Context(), combined.Context);
    }

    [Fact]
    public void ExplicitNoFindings_DoesNotRemoveOrDowngradeCoreAndDoesNotCreatePublicationPass()
    {
        AuthoringPrepublishDiagnosticRegistry registry = Registry();
        ImmutableArray<AuthoringPrepublishDiagnosticResult> outcomes =
            [.. registry.ExpectedDiagnostics.Registrations.Select(registration => NoFindings(registry, registration.DiagnosticId))];

        AuthoringPrepublishDiagnosticCombiner.Combination combined = Combine(registry, outcomes);

        Assert.False(combined.HasBlockingPluginDiagnostics);
        Assert.True(combined.Coverage.HasAllOutcomes);
        Assert.Equal(registry.CoreResults, combined.CoreResults);
        Assert.Contains(combined.CoreResults, core => core.Required && core.Severity == AuthoringDiagnosticSeverity.Blocking);
        Assert.All(combined.Coverage.Slots, slot =>
        {
            Assert.False(slot.IsAbsent);
            Assert.Equal(AuthoringDiagnosticOutcomeStatus.NoFindings, slot.Status);
            Assert.Empty(slot.Outcome!.Facts);
        });
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(100)]
    [InlineData(1000)]
    public void MissingOutcomes_AccountForCompleteBoundedRosterWithoutFabricatingResults(int count)
    {
        AuthoringPrepublishDiagnosticRegistry registry = Registry(count);

        AuthoringPrepublishDiagnosticCombiner.Combination combined = Combine(registry, []);

        Assert.Equal(count, combined.Coverage.Slots.Length);
        Assert.Equal(count == 0, combined.Coverage.HasAllOutcomes);
        Assert.Equal(count > 0, combined.HasBlockingPluginDiagnostics);
        Assert.All(combined.Coverage.Slots, slot =>
        {
            Assert.True(slot.IsAbsent);
            Assert.Null(slot.Outcome);
            Assert.Equal(slot.Registration.Required ? AuthoringDiagnosticOutcomeStatus.RequiredUnavailable :
                AuthoringDiagnosticOutcomeStatus.OptionalNotEvaluable, slot.Status);
        });
        Assert.Equal(registry.CoreResults, combined.CoreResults);
    }

    [Fact]
    public void MissingOptional_StaysNotEvaluableWithoutPluginVetoOrEmptySuccess()
    {
        AuthoringPrepublishDiagnosticRegistry registry = Registry(optionalOnly: true);
        AuthoringPrepublishDiagnosticCombiner.Combination combined = Combine(registry, []);
        Assert.False(combined.HasBlockingPluginDiagnostics);
        Assert.False(combined.Coverage.HasAllOutcomes);
        Assert.All(combined.Coverage.Slots, slot =>
        {
            Assert.Equal(AuthoringDiagnosticOutcomeStatus.OptionalNotEvaluable, slot.Status);
            Assert.True(slot.IsAbsent);
            Assert.Null(slot.Outcome);
        });
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(100)]
    [InlineData(1000)]
    public void CompleteBoundedRoster_PreservesAllFindingsAndCoreReferences(int count)
    {
        AuthoringPrepublishDiagnosticRegistry registry = Registry(count);
        ImmutableArray<AuthoringPrepublishDiagnosticResult> outcomes =
            [.. registry.ExpectedDiagnostics.Registrations.Select(item => Finding(registry, item.DiagnosticId))];
        AuthoringPrepublishDiagnosticCombiner.Combination combined = Combine(registry, outcomes);
        Assert.True(combined.Coverage.HasAllOutcomes);
        Assert.False(combined.HasBlockingPluginDiagnostics);
        Assert.Equal(count, combined.Coverage.Slots.Sum(slot => slot.Outcome!.Facts.Length));
        Assert.Equal(registry.CoreResults, combined.CoreResults);
    }

    [Fact]
    public void FactBudget_AcceptsExactLimitAndRejectsForgedOverflow()
    {
        AuthoringPrepublishDiagnosticRegistry registry = Registry();
        AuthoringPrepublishDiagnosticResult original = Finding(registry, "acme.check.item0");
        ImmutableArray<AuthoringDiagnosticFact> facts =
            [.. Enumerable.Range(0, 10).Select(index => original.Facts[0] with { Id = $"acme.check.item0.finding{index}" })];
        AuthoringPrepublishDiagnosticResult exact = registry.ValidateResult(original.Input, new(1, original.Input.DiagnosticId,
            original.Input.InputSha256, AuthoringDiagnosticCompletion.Findings, facts), s_now);
        Assert.Equal(10, Combine(registry, [exact]).Coverage.Slots[0].Outcome!.Facts.Length);
        var overflow = new AuthoringPrepublishDiagnosticResult(original.Input, true, original.Status,
            [.. facts, original.Facts[0]], null);
        Assert.Throws<AuthoringExtensionContractException>(() => Combine(registry, [overflow]));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void MissingOneSlot_UsesOriginalHostRequiredness(bool omitRequired)
    {
        AuthoringPrepublishDiagnosticRegistry registry = Registry();
        AuthoringDiagnosticExpectedRegistration supplied = registry.ExpectedDiagnostics.Registrations.Single(item => item.Required != omitRequired);
        AuthoringPrepublishDiagnosticCombiner.Combination combined = Combine(registry, [NoFindings(registry, supplied.DiagnosticId)]);
        Assert.Equal(omitRequired, combined.HasBlockingPluginDiagnostics);
        AuthoringDiagnosticOutcomeSlot missing = Assert.Single(combined.Coverage.Slots.Where(slot => slot.IsAbsent));
        Assert.Equal(omitRequired, missing.Registration.Required);
        Assert.Null(missing.Outcome);
    }

    [Theory]
    [InlineData(AuthoringDiagnosticUnavailableReason.Disabled)]
    [InlineData(AuthoringDiagnosticUnavailableReason.Incompatible)]
    [InlineData(AuthoringDiagnosticUnavailableReason.Crashed)]
    [InlineData(AuthoringDiagnosticUnavailableReason.TimedOut)]
    [InlineData(AuthoringDiagnosticUnavailableReason.Cancelled)]
    [InlineData(AuthoringDiagnosticUnavailableReason.ResourceExceeded)]
    [InlineData(AuthoringDiagnosticUnavailableReason.Stale)]
    [InlineData(AuthoringDiagnosticUnavailableReason.PermissionRevoked)]
    [InlineData(AuthoringDiagnosticUnavailableReason.Uninstalled)]
    public void Unavailable_PreservesHostStatusReasonAndRequiredVeto(AuthoringDiagnosticUnavailableReason reason)
    {
        AuthoringPrepublishDiagnosticRegistry registry = Registry();
        ImmutableArray<AuthoringPrepublishDiagnosticResult> outcomes =
            [.. registry.ExpectedDiagnostics.Registrations.Select(item => registry.Unavailable(Input(registry, item.DiagnosticId), reason))];
        AuthoringPrepublishDiagnosticCombiner.Combination combined = Combine(registry, outcomes);
        Assert.True(combined.HasBlockingPluginDiagnostics);
        Assert.True(combined.Coverage.HasAllOutcomes);
        Assert.All(combined.Coverage.Slots, slot =>
        {
            Assert.False(slot.IsAbsent);
            Assert.Equal(reason, slot.Outcome!.UnavailableReason);
            Assert.Empty(slot.Outcome.Facts);
            Assert.Equal(slot.Registration.Required ? AuthoringDiagnosticOutcomeStatus.RequiredUnavailable :
                AuthoringDiagnosticOutcomeStatus.OptionalNotEvaluable, slot.Status);
        });
        AuthoringPrepublishDiagnosticRegistry optional = Registry(optionalOnly: true);
        Assert.False(Combine(optional,
            [.. optional.ExpectedDiagnostics.Registrations.Select(item => optional.Unavailable(Input(optional, item.DiagnosticId), reason))])
            .HasBlockingPluginDiagnostics);
    }

    [Theory]
    [InlineData("core-id")]
    [InlineData("other-plugin-id")]
    [InlineData("requiredness")]
    [InlineData("unavailable-downgrade")]
    [InlineData("severity-downgrade")]
    [InlineData("severity-upgrade")]
    [InlineData("empty-findings")]
    [InlineData("default-facts")]
    [InlineData("unknown-status")]
    [InlineData("unknown-reason")]
    [InlineData("completed-with-reason")]
    [InlineData("unavailable-with-facts")]
    [InlineData("duplicate-facts")]
    [InlineData("unknown-code")]
    [InlineData("tampered-input")]
    public void ForgedTypedOutcomes_AreRevalidatedBeforeCombination(string mutation)
    {
        AuthoringPrepublishDiagnosticRegistry registry = Registry();
        AuthoringPrepublishDiagnosticResult valid = Finding(registry, "acme.check.item0");
        AuthoringDiagnosticFact fact = valid.Facts[0];
        AuthoringPrepublishDiagnosticResult forged = mutation switch
        {
            "core-id" => new(valid.Input, true, valid.Status, [fact with { Id = "security.authoring" }], null),
            "other-plugin-id" => new(valid.Input, true, valid.Status, [fact with { Id = "acme.check.item1.finding" }], null),
            "requiredness" => new(valid.Input, false, valid.Status, valid.Facts, null),
            "unavailable-downgrade" => new(valid.Input, false, AuthoringDiagnosticOutcomeStatus.OptionalNotEvaluable, [],
                AuthoringDiagnosticUnavailableReason.Crashed),
            "severity-downgrade" => new(valid.Input, true, valid.Status, [fact with { Severity = AuthoringDiagnosticSeverity.Info }], null),
            "severity-upgrade" => new(valid.Input, true, valid.Status, [fact with { Severity = AuthoringDiagnosticSeverity.Blocking }], null),
            "empty-findings" => new(valid.Input, true, valid.Status, [], null),
            "default-facts" => new(valid.Input, true, AuthoringDiagnosticOutcomeStatus.NoFindings, default, null),
            "unknown-status" => new(valid.Input, true, (AuthoringDiagnosticOutcomeStatus)999, [], AuthoringDiagnosticUnavailableReason.Crashed),
            "unknown-reason" => new(valid.Input, true, AuthoringDiagnosticOutcomeStatus.RequiredUnavailable, [],
                (AuthoringDiagnosticUnavailableReason)999),
            "completed-with-reason" => new(valid.Input, true, valid.Status, valid.Facts, AuthoringDiagnosticUnavailableReason.Crashed),
            "unavailable-with-facts" => new(valid.Input, true, AuthoringDiagnosticOutcomeStatus.RequiredUnavailable, valid.Facts,
                AuthoringDiagnosticUnavailableReason.Crashed),
            "duplicate-facts" => new(valid.Input, true, valid.Status, [fact, fact], null),
            "unknown-code" => new(valid.Input, true, valid.Status, [fact with { Code = "unknown" }], null),
            "tampered-input" => new(valid.Input with { ExtensionId = "other.author-tools" }, true, valid.Status, valid.Facts, null),
            _ => throw new ArgumentOutOfRangeException(nameof(mutation))
        };

        Assert.Throws<AuthoringExtensionContractException>(() => Combine(registry, [forged]));
        Assert.Equal(valid.Facts[0], fact);
        Assert.Equal(3, registry.CoreResults.Length);
    }

    [Fact]
    public void NestedDiagnosticNamespaces_RejectCrossPluginDuplicateFactIdentity()
    {
        AuthoringPrepublishDiagnosticRegistry registry = Registry(nested: true);
        AuthoringPrepublishDiagnosticResult first = Finding(registry, "acme.check");
        AuthoringPrepublishDiagnosticResult second = Finding(registry, "acme.check.nested");
        first = registry.ValidateResult(first.Input, new(1, first.Input.DiagnosticId, first.Input.InputSha256,
            AuthoringDiagnosticCompletion.Findings, [first.Facts[0] with { Id = second.Facts[0].Id }]), s_now);
        Assert.NotEqual(first.Input.ExtensionId, second.Input.ExtensionId);
        Assert.Throws<AuthoringExtensionContractException>(() => Combine(registry, [first, second]));
        Assert.Throws<AuthoringExtensionContractException>(() => Combine(registry, [second, first]));
    }

    [Theory]
    [InlineData("acme.author-tools")]
    [InlineData("acme.check.item0")]
    public void IdentityNegativeControls_CoreCannotAliasPluginExtensionOrContributionBeforeCombination(string coreCheckId)
    {
        AuthoringExtensionContractException refusal = Assert.Throws<AuthoringExtensionContractException>(() =>
            Combine(Registry(coreCheckId: coreCheckId), []));

        Assert.Equal("Manifest extension or contribution identity conflicts with a core check.", refusal.Message);
    }

    [Theory]
    [InlineData("article")]
    [InlineData("document")]
    [InlineData("epoch")]
    [InlineData("revision")]
    [InlineData("length")]
    [InlineData("source")]
    [InlineData("config")]
    [InlineData("grant")]
    [InlineData("runtime")]
    [InlineData("runtime-version")]
    [InlineData("api")]
    [InlineData("request")]
    [InlineData("deadline")]
    public void ValidButDifferentInvocation_IsRejectedEvenWhenRegistryAcceptsIt(string mutation)
    {
        AuthoringPrepublishDiagnosticRegistry registry = Registry();
        AuthoringDiagnosticHostContext context = Context();
        AuthoringDiagnosticHostContext changed = mutation switch
        {
            "article" => context with { ArticleId = 2 },
            "document" => context with { DocumentId = "document.two" },
            "epoch" => context with { DocumentEpoch = 2 },
            "revision" => context with { SourceRevision = 2 },
            "length" => context with { DocumentLength = 11 },
            "source" => context with { SourceSha256 = Digest('0') },
            "config" => context with { ConfigSha256 = Digest('0') },
            "grant" => context with { GrantSha256 = Digest('0') },
            "runtime" => context with { RuntimeIdentity = Digest('0') },
            "runtime-version" => context with { RuntimeVersion = "2.0.0" },
            "api" => context with { HostApiSha256 = Digest('0') },
            "request" => context with { RequestId = "request.two" },
            "deadline" => context with { Deadline = context.Deadline - TimeSpan.FromSeconds(1) },
            _ => throw new ArgumentOutOfRangeException(nameof(mutation))
        };
        AuthoringPrepublishDiagnosticInput input = registry.CreateInput("acme.check.item0", changed, [], [], s_now);
        AuthoringPrepublishDiagnosticResult result = registry.ValidateResult(input, new(1, input.DiagnosticId,
            input.InputSha256, AuthoringDiagnosticCompletion.NoFindings, []), s_now);
        Assert.Throws<AuthoringExtensionContractException>(() => Combine(registry, [result]));
        Assert.Throws<AuthoringExtensionContractException>(() => Combine(registry,
            [registry.Unavailable(input, AuthoringDiagnosticUnavailableReason.Crashed)]));
    }

    [Fact]
    public void BoundaryCollections_RejectNullDefaultDuplicateUnknownForeignAndExpired()
    {
        AuthoringPrepublishDiagnosticRegistry registry = Registry();
        AuthoringPrepublishDiagnosticResult result = Finding(registry, "acme.check.item0");
        Assert.Throws<ArgumentNullException>(() => AuthoringPrepublishDiagnosticCombiner.Combine(null!, registry.ExpectedDiagnostics, Context(), [], s_now));
        Assert.Throws<ArgumentNullException>(() => AuthoringPrepublishDiagnosticCombiner.Combine(registry, registry.ExpectedDiagnostics, null!, [], s_now));
        Assert.Throws<AuthoringExtensionContractException>(() => Combine(registry, default));
        Assert.Throws<AuthoringExtensionContractException>(() => Combine(registry, [null!]));
        Assert.Throws<AuthoringExtensionContractException>(() => Combine(registry, [result, result]));
        Assert.Throws<AuthoringExtensionContractException>(() => Combine(registry, [result, result, result]));
        Assert.Throws<AuthoringExtensionContractException>(() => Combine(registry, [Finding(Registry(3), "acme.check.item2")]));
        Assert.Throws<AuthoringExtensionContractException>(() => Combine(registry, [Finding(Registry(optionalOnly: true), "acme.check.item0")]));
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringPrepublishDiagnosticCombiner.Combine(registry,
            registry.ExpectedDiagnostics, Context(), [result], Context().Deadline));
        AuthoringPrepublishDiagnosticCombiner.Combination expired = AuthoringPrepublishDiagnosticCombiner.Combine(registry,
            registry.ExpectedDiagnostics, Context(), [registry.Unavailable(result.Input, AuthoringDiagnosticUnavailableReason.TimedOut)], Context().Deadline);
        Assert.True(expired.HasBlockingPluginDiagnostics);
        Assert.Equal(AuthoringDiagnosticOutcomeStatus.RequiredUnavailable, expired.Coverage.Slots[0].Status);
    }

    [Theory]
    [InlineData("null")]
    [InlineData("missing")]
    [InlineData("duplicate")]
    [InlineData("requiredness")]
    [InlineData("digest")]
    [InlineData("foreign")]
    public void Roster_RejectsSubstitutionInsteadOfAcceptingEmptySuccess(string mutation)
    {
        AuthoringPrepublishDiagnosticRegistry registry = Registry();
        AuthoringDiagnosticExpectedRoster roster = registry.ExpectedDiagnostics;
        AuthoringDiagnosticExpectedRoster forged = mutation switch
        {
            "null" => null!,
            "missing" => roster with { Registrations = [] },
            "duplicate" => roster with { Registrations = [roster.Registrations[0], roster.Registrations[0]] },
            "requiredness" => roster with { Registrations = [roster.Registrations[0] with { Required = false }, roster.Registrations[1]] },
            "digest" => roster with { RegistrySha256 = Digest('0') },
            "foreign" => Registry(optionalOnly: true).ExpectedDiagnostics,
            _ => throw new ArgumentOutOfRangeException(nameof(mutation))
        };
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringPrepublishDiagnosticCombiner.Combine(registry, forged, Context(), [], s_now));
    }

    [Fact]
    public void OutcomeOrdering_IsCanonicalAndDoesNotMutateCallerCollections()
    {
        AuthoringPrepublishDiagnosticRegistry registry = Registry();
        ImmutableArray<AuthoringPrepublishDiagnosticResult> reversed =
            [.. registry.ExpectedDiagnostics.Registrations.Reverse().Select(item => Finding(registry, item.DiagnosticId))];
        AuthoringPrepublishDiagnosticCombiner.Combination combined = Combine(registry, reversed);
        Assert.Equal(registry.ExpectedDiagnostics.Registrations.Select(item => item.DiagnosticId),
            combined.Coverage.Slots.Select(slot => slot.Registration.DiagnosticId));
        Assert.Equal("acme.check.item1", reversed[0].Input.DiagnosticId);
        Assert.Equal("acme.check.item0", reversed[1].Input.DiagnosticId);
        Assert.Same(reversed[1].Facts[0], combined.Coverage.Slots[0].Outcome!.Facts[0]);
    }

    private static AuthoringPrepublishDiagnosticCombiner.Combination Combine(
        AuthoringPrepublishDiagnosticRegistry registry,
        ImmutableArray<AuthoringPrepublishDiagnosticResult> outcomes) =>
        AuthoringPrepublishDiagnosticCombiner.Combine(registry, registry.ExpectedDiagnostics, Context(), outcomes, s_now);

    private static AuthoringPrepublishDiagnosticInput Input(AuthoringPrepublishDiagnosticRegistry registry, string id) =>
        registry.CreateInput(id, Context(), [], [], s_now);

    private static AuthoringPrepublishDiagnosticResult Finding(
        AuthoringPrepublishDiagnosticRegistry registry,
        string id,
        AuthoringDiagnosticSeverity severity = AuthoringDiagnosticSeverity.Warning)
    {
        AuthoringPrepublishDiagnosticInput input = Input(registry, id);
        return registry.ValidateResult(input, new(1, id, input.InputSha256, AuthoringDiagnosticCompletion.Findings,
            [new(id + ".finding", $"code-{(int)severity}", severity, "Review item", [], [], null)]), s_now);
    }

    private static AuthoringPrepublishDiagnosticResult NoFindings(AuthoringPrepublishDiagnosticRegistry registry, string id)
    {
        AuthoringPrepublishDiagnosticInput input = Input(registry, id);
        return registry.ValidateResult(input, new(1, id, input.InputSha256, AuthoringDiagnosticCompletion.NoFindings, []), s_now);
    }

    private static AuthoringPrepublishDiagnosticRegistry Registry(
        int count = 2,
        bool optionalOnly = false,
        bool nested = false,
        string coreCheckId = "security.authoring")
    {
        AuthoringExtensionManifest original = AuthoringExtensionContractsTests.CreateManifest();
        var budget = new AuthoringDiagnosticBudget(TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(5),
            64 * 1024 * 1024, 65536, 65536, 2, 8, 10, 10, 10);
        var contributions = ImmutableArray.CreateBuilder<AuthoringPrepublishDiagnosticContribution>();
        var policies = ImmutableArray.CreateBuilder<AuthoringDiagnosticHostPolicy>();
        var manifests = ImmutableArray.CreateBuilder<VerifiedAuthoringExtensionContract>();
        for (int owner = 0; owner < 2; owner++)
        {
            var declarations = ImmutableArray.CreateBuilder<AuthoringContributionDeclaration>();
            string extensionId = owner == 0 ? "acme.author-tools" : "other.author-tools";
            for (int index = owner; index < count; index += 2)
            {
                string id = nested ? index == 0 ? "acme.check" : "acme.check.nested" : $"acme.check.item{index}";
                AuthoringContributionDeclaration declaration = original.Contributions[0] with
                {
                    Id = id,
                    Kind = AuthoringContributionKind.PrepublishDiagnostic,
                    Capabilities = [AuthoringCapability.DiagnosticReport]
                };
                declarations.Add(declaration);
                contributions.Add(new(1, id, "1.0.0", extensionId, id, declaration.Entrypoint.ContentSha256,
                    declaration.ExecutionClass, declaration.Capabilities,
                    new(1, AuthoringDiagnosticReadScope.Metadata, "read-model.metadata.v1", []), "policy.diagnostic.v1", budget));
                policies.Add(new(id, "policy.diagnostic.v1", !optionalOnly && index % 2 == 0,
                    [.. Enum.GetValues<AuthoringDiagnosticSeverity>().Select(severity => new AuthoringDiagnosticCodePolicy($"code-{(int)severity}", severity))], [], budget));
            }

            if (declarations.Count > 0)
            {
                manifests.Add(AuthoringExtensionContractValidator.Verify(original with
                {
                    Id = extensionId,
                    Contributions = declarations.ToImmutable()
                }));
            }
        }

        AuthoringExtensionRegistrySnapshot extensions = AuthoringExtensionContractValidator.CreateRegistry(manifests.ToImmutable(),
            new([], [], [], [], ["security.authoring", "rights.authoring", "publication.authoring"]));
        return new(extensions, contributions.ToImmutable(), policies.ToImmutable(),
            [new(coreCheckId, true, AuthoringDiagnosticSeverity.Blocking, Digest('a')),
                new("rights.authoring", false, AuthoringDiagnosticSeverity.Warning, Digest('b')),
                new("publication.authoring", true, AuthoringDiagnosticSeverity.Info, Digest('c'))]);
    }

    private static AuthoringDiagnosticHostContext Context() => new(1, "document.one", 1, 1, 10,
        Digest('1'), Digest('2'), Digest('3'), Digest('4'), "1.0.0", Digest('5'), "request.one", s_now + TimeSpan.FromSeconds(4));

    private static string Digest(char character) => new(character, 64);
}
