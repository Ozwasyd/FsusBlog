using FsusBlog.Shared.Contracts.AuthorTypography;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorTypographyCommandPolicyTests
{
    private static readonly AuthorTypographyScope s_scope = new(42, "site:primary");
    private static readonly AuthorTypographyProfile s_profile = new(1, "system-sans", "standard", "standard", "standard", "standard");

    [Fact]
    public void PayloadPreparation_RequiresAtomicWriterCasAndDoesNotInventAnObservedProfile()
    {
        var command = new AuthorTypographyCommand(0, AuthorTypographyMutation.SetProfile, s_profile);
        AuthorTypographyCommandDecision prepared = AuthorTypographyCommandPolicy.PreparePayload(s_scope, command, null);
        Assert.Equal(new AuthorTypographyPreparedMutation(s_scope, 0, s_profile), prepared.PreparedMutation);
        Assert.Equal(AuthorTypographyCommandStatus.RevisionConflict,
            AuthorTypographyCommandPolicy.Prepare(s_scope, Snapshot(1), command, null).Status);
        Assert.Equal(AuthorTypographyCommandStatus.CurrentDesignDefaultUnavailable,
            AuthorTypographyCommandPolicy.PreparePayload(s_scope, new(0, AuthorTypographyMutation.Reset, null), null).Status);
        Assert.Equal(AuthorTypographyCommandStatus.InvalidSnapshot,
            AuthorTypographyCommandPolicy.PreparePayload(s_scope with
            {
                SiteIdentity = " site:primary"
            }, command, null).Status);
    }

    [Fact]
    public void SetProfile_PreparesOnlyClosedReplacementWithoutChangingObservedFacts()
    {
        AuthorTypographySnapshot current = Snapshot(8);
        AuthorTypographyProfile requested = s_profile with
        {
            FontSize = "large"
        };
        var command = new AuthorTypographyCommand(8, AuthorTypographyMutation.SetProfile, requested);

        AuthorTypographyCommandDecision result = AuthorTypographyCommandPolicy.Prepare(s_scope, current, command, null);

        Assert.Equal(AuthorTypographyCommandStatus.Prepared, result.Status);
        Assert.Equal(new AuthorTypographyPreparedMutation(s_scope, 8, requested), result.PreparedMutation);
        Assert.Equal(Snapshot(8), current);
        Assert.Equal(s_profile, current.Profile);
    }

    [Fact]
    public void Reset_UsesOnlyTheServerProvidedCurrentDesignDefault()
    {
        AuthorTypographyProfile serverDefault = s_profile with
        {
            LineHeight = "relaxed"
        };
        var command = new AuthorTypographyCommand(8, AuthorTypographyMutation.Reset, null);

        AuthorTypographyCommandDecision result = AuthorTypographyCommandPolicy.Prepare(s_scope, Snapshot(8), command, serverDefault);

        Assert.Equal(AuthorTypographyCommandStatus.Prepared, result.Status);
        Assert.Equal(serverDefault, result.PreparedMutation!.Profile);
        Assert.Equal(8, result.PreparedMutation.ExpectedRevision);
    }

    [Fact]
    public void MissingOrInvalidDesignDefault_RefusesResetWithoutAClientDefault()
    {
        var command = new AuthorTypographyCommand(8, AuthorTypographyMutation.Reset, null);
        AssertRefusal(AuthorTypographyCommandStatus.CurrentDesignDefaultUnavailable, Snapshot(8), command);
        AuthorTypographyCommandDecision result = AuthorTypographyCommandPolicy.Prepare(
            s_scope, Snapshot(8), command, s_profile with
            {
                FontFamily = "https://fonts.example.test/font.woff2"
            });
        Assert.Equal(AuthorTypographyCommandStatus.CurrentDesignDefaultUnavailable, result.Status);
        Assert.Null(result.PreparedMutation);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(7)]
    [InlineData(9)]
    public void StaleOrFutureRevision_RefusesRatherThanOverwritingServerCurrent(long revision)
    {
        AssertRefusal(AuthorTypographyCommandStatus.RevisionConflict, Snapshot(8),
            new AuthorTypographyCommand(revision, AuthorTypographyMutation.SetProfile, s_profile));
        AssertRefusal(AuthorTypographyCommandStatus.RevisionConflict, Snapshot(8),
            new AuthorTypographyCommand(revision, AuthorTypographyMutation.Reset, null));
    }

    [Fact]
    public void RevisionChange_InvalidatesAPreviouslyPreparedProposal()
    {
        var command = new AuthorTypographyCommand(8, AuthorTypographyMutation.SetProfile, s_profile);
        Assert.Equal(AuthorTypographyCommandStatus.Prepared,
            AuthorTypographyCommandPolicy.Prepare(s_scope, Snapshot(8), command, null).Status);
        AssertRefusal(AuthorTypographyCommandStatus.RevisionConflict, Snapshot(9), command);
    }

    [Fact]
    public void RevisionZeroObservation_PreparesWithoutReportingACommit()
    {
        var command = new AuthorTypographyCommand(0, AuthorTypographyMutation.SetProfile, s_profile);
        AuthorTypographyCommandDecision result = AuthorTypographyCommandPolicy.Prepare(s_scope, Snapshot(0), command, null);
        Assert.Equal(AuthorTypographyCommandStatus.Prepared, result.Status);
        Assert.Equal(0, result.PreparedMutation!.ExpectedRevision);
    }

    [Fact]
    public void InvalidMutationOrPayload_Refuses()
    {
        AuthorTypographyCommand?[] invalid =
        [
            null,
            new(-1, AuthorTypographyMutation.SetProfile, s_profile),
            new(8, (AuthorTypographyMutation)0, s_profile),
            new(8, (AuthorTypographyMutation)255, s_profile),
            new(8, AuthorTypographyMutation.SetProfile, null),
            new(8, AuthorTypographyMutation.SetProfile, s_profile with { FontSize = "18px" }),
            new(8, AuthorTypographyMutation.SetProfile, s_profile with { SchemaVersion = 2 }),
            new(8, AuthorTypographyMutation.Reset, s_profile)
        ];
        foreach (AuthorTypographyCommand? command in invalid)
        {
            AssertRefusal(AuthorTypographyCommandStatus.InvalidCommand, Snapshot(8), command);
        }
    }

    [Fact]
    public void MissingTamperedOrCrossScopeObservation_Refuses()
    {
        var command = new AuthorTypographyCommand(8, AuthorTypographyMutation.SetProfile, s_profile);
        AssertRefusal(AuthorTypographyCommandStatus.InvalidSnapshot, null, command);
        AssertRefusal(AuthorTypographyCommandStatus.InvalidSnapshot, Snapshot(8) with
        {
            ContentDigest = string.Empty
        }, command);
        foreach (AuthorTypographyScope scope in new[] { s_scope with { AccountId = 43 }, s_scope with { SiteIdentity = "site:other" } })
        {
            AuthorTypographyCommandDecision result = AuthorTypographyCommandPolicy.Prepare(scope, Snapshot(8), command, null);
            Assert.Equal(AuthorTypographyCommandStatus.InvalidSnapshot, result.Status);
            Assert.Null(result.PreparedMutation);
        }
        Assert.Equal(AuthorTypographyCommandStatus.InvalidSnapshot,
            AuthorTypographyCommandPolicy.Prepare(null, Snapshot(8), command, null).Status);
    }

    [Fact]
    public void ExhaustedRevision_RefusesWithoutOverflowOrAProposal()
    {
        AssertRefusal(AuthorTypographyCommandStatus.RevisionExhausted, Snapshot(long.MaxValue),
            new AuthorTypographyCommand(long.MaxValue, AuthorTypographyMutation.SetProfile, s_profile));
    }

    private static void AssertRefusal(AuthorTypographyCommandStatus status, AuthorTypographySnapshot? current, AuthorTypographyCommand? command)
    {
        AuthorTypographyCommandDecision result = AuthorTypographyCommandPolicy.Prepare(s_scope, current, command, null);
        Assert.Equal(status, result.Status);
        Assert.Null(result.PreparedMutation);
    }

    private static AuthorTypographySnapshot Snapshot(long revision)
    {
        var snapshot = new AuthorTypographySnapshot(s_scope, revision, s_profile, string.Empty);
        return snapshot with
        {
            ContentDigest = AuthorTypographyContractValidator.ComputeSnapshotDigest(snapshot)
        };
    }
}
