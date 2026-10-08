using System.Text.Json;

using FsusBlog.Shared.Contracts.AuthoringPreferences;
using FsusBlog.Shared.Contracts.AuthorTypography;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorTypographyHandoffTests
{
    // Synthetic domain vectors, never authenticated persistence or AEDS codec receipts.
    private static readonly AuthorTypographyScope s_scope = new(42, "site:test");
    private static readonly AuthorTypographyProfile s_profile = new(1, "system-sans", "standard", "standard", "standard", "standard");
    private static readonly JsonSerializerOptions s_projectionOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    [Fact]
    public void SetAndResetGolden_ContainNoClientActorSiteDeviceDefaultOrArticleState()
    {
        var set = new AuthorTypographyMutationRequest(Guid.Parse("00000000-0000-0000-0000-000000000123"),
            new(0, AuthorTypographyMutation.SetProfile, s_profile));
        var reset = new AuthorTypographyMutationRequest(Guid.Parse("00000000-0000-0000-0000-000000000124"),
            new(7, AuthorTypographyMutation.Reset, null));
        Assert.Equal("{\"requestId\":\"00000000-0000-0000-0000-000000000123\",\"command\":{\"expectedRevision\":0,\"mutation\":1,\"profile\":{\"schemaVersion\":1,\"fontFamily\":\"system-sans\",\"fontSize\":\"standard\",\"lineHeight\":\"standard\",\"canvasWidth\":\"standard\",\"paragraphSpacing\":\"standard\"}}}",
            JsonSerializer.Serialize(set, s_projectionOptions));
        Assert.Equal("{\"requestId\":\"00000000-0000-0000-0000-000000000124\",\"command\":{\"expectedRevision\":7,\"mutation\":2,\"profile\":null}}",
            JsonSerializer.Serialize(reset, s_projectionOptions));
        Assert.True(AuthorTypographyContractValidator.ValidateMutationRequest(s_scope, set));
        Assert.True(AuthorTypographyContractValidator.ValidateMutationRequest(s_scope, reset));
    }

    [Fact]
    public void DomainResultGolden_BindsScopedObservationAndExplicitFiniteOutcomeValues()
    {
        var snapshot = new AuthorTypographySnapshot(s_scope, 0, s_profile,
            "5de42521f542d965d3aafdc9fa70ec67752b626f5c3a106091c459a1a60e9761");
        var result = new AuthorTypographyPreferenceReadResult(AuthorTypographyPreferenceReadOutcome.CurrentDesignDefault, snapshot);
        Assert.True(AuthorTypographyPreferenceResultValidator.ValidateRead(result, s_scope));
        Assert.Equal("{\"outcome\":2,\"snapshot\":{\"scope\":{\"accountId\":42,\"siteIdentity\":\"site:test\"},\"revision\":0,\"profile\":{\"schemaVersion\":1,\"fontFamily\":\"system-sans\",\"fontSize\":\"standard\",\"lineHeight\":\"standard\",\"canvasWidth\":\"standard\",\"paragraphSpacing\":\"standard\"},\"contentDigest\":\"5de42521f542d965d3aafdc9fa70ec67752b626f5c3a106091c459a1a60e9761\"}}",
            JsonSerializer.Serialize(result, s_projectionOptions));
        Assert.Equal(new byte[] { 1, 2, 3, 4, 5 }, Enum.GetValues<AuthorTypographyPreferenceReadOutcome>().Select(value => (byte)value));
        Assert.Equal(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 }, Enum.GetValues<AuthorTypographyPreferenceWriteOutcome>().Select(value => (byte)value));
        Assert.Equal(typeof(AuthorTypographyProfile).Assembly, typeof(AuthorTypographyPreferenceWriteResult).Assembly);
    }

    [Theory]
    [InlineData(AuthorTypographyPreferenceReadOutcome.Forbidden)]
    [InlineData(AuthorTypographyPreferenceReadOutcome.CurrentDesignDefaultUnavailable)]
    [InlineData(AuthorTypographyPreferenceReadOutcome.Unavailable)]
    [InlineData((AuthorTypographyPreferenceReadOutcome)0)]
    [InlineData((AuthorTypographyPreferenceReadOutcome)255)]
    public void ReadRefusals_CannotCarryProfileOrUnknownOutcome(AuthorTypographyPreferenceReadOutcome outcome)
    {
        bool known = outcome is AuthorTypographyPreferenceReadOutcome.Forbidden
            or AuthorTypographyPreferenceReadOutcome.CurrentDesignDefaultUnavailable
            or AuthorTypographyPreferenceReadOutcome.Unavailable;
        Assert.Equal(known, AuthorTypographyPreferenceResultValidator.ValidateRead(new(outcome, null), s_scope));
        Assert.False(AuthorTypographyPreferenceResultValidator.ValidateRead(new(outcome, Snapshot(0)), s_scope));
    }

    [Fact]
    public void ReadObservation_RejectsStoredAbsenceWrongScopeCorruptionAndUnsafeRevision()
    {
        Assert.False(AuthorTypographyPreferenceResultValidator.ValidateRead(new(AuthorTypographyPreferenceReadOutcome.Stored, Snapshot(0)), s_scope));
        Assert.True(AuthorTypographyPreferenceResultValidator.ValidateRead(new(AuthorTypographyPreferenceReadOutcome.Stored, Snapshot(1)), s_scope));
        Assert.True(AuthorTypographyPreferenceResultValidator.ValidateRead(new(AuthorTypographyPreferenceReadOutcome.CurrentDesignDefault, Snapshot(1)), s_scope));
        Assert.False(AuthorTypographyPreferenceResultValidator.ValidateRead(new(AuthorTypographyPreferenceReadOutcome.Stored, Snapshot(1)), s_scope with
        {
            AccountId = 43
        }));
        Assert.False(AuthorTypographyPreferenceResultValidator.ValidateRead(new(AuthorTypographyPreferenceReadOutcome.Stored, Snapshot(1) with
        {
            ContentDigest = "bad"
        }), s_scope));
        Assert.False(AuthorTypographyPreferenceResultValidator.ValidateRead(new(AuthorTypographyPreferenceReadOutcome.Stored,
            Snapshot(WritingAidPreferenceContract.MaximumExactRevision + 1)), s_scope));
        Assert.False(AuthorTypographyPreferenceResultValidator.ValidateRead(null, s_scope));
    }

    [Theory]
    [InlineData(AuthorTypographyPreferenceWriteOutcome.RequestIdentityConflict)]
    [InlineData(AuthorTypographyPreferenceWriteOutcome.InvalidRequest)]
    [InlineData(AuthorTypographyPreferenceWriteOutcome.Forbidden)]
    [InlineData(AuthorTypographyPreferenceWriteOutcome.CurrentDesignDefaultUnavailable)]
    [InlineData(AuthorTypographyPreferenceWriteOutcome.Unavailable)]
    [InlineData((AuthorTypographyPreferenceWriteOutcome)0)]
    [InlineData((AuthorTypographyPreferenceWriteOutcome)255)]
    public void WriteRefusals_CannotCarrySuccessOrUnknownOutcome(AuthorTypographyPreferenceWriteOutcome outcome)
    {
        bool known = (byte)outcome is >= 4 and <= 8;
        Assert.Equal(known, AuthorTypographyPreferenceResultValidator.ValidateWrite(new(outcome, null, null), s_scope));
        Assert.False(AuthorTypographyPreferenceResultValidator.ValidateWrite(new(outcome, Record(), Snapshot(1)), s_scope));
        Assert.False(AuthorTypographyPreferenceResultValidator.ValidateWrite(new(outcome, null, Snapshot(1)), s_scope));
    }

    [Fact]
    public void ReplayResult_ContainsOriginalCommitRatherThanClaimingLatestRow()
    {
        AuthorTypographyRecordedRequest record = Record();
        var replay = new AuthorTypographyPreferenceWriteResult(AuthorTypographyPreferenceWriteOutcome.Replayed, record, record.CommittedSnapshot);
        Assert.True(AuthorTypographyPreferenceResultValidator.ValidateWrite(replay, s_scope));
        Assert.True(AuthorTypographyPreferenceResultValidator.ValidateWrite(replay with
        {
            Outcome = AuthorTypographyPreferenceWriteOutcome.Committed
        }, s_scope));
        Assert.False(AuthorTypographyPreferenceResultValidator.ValidateWrite(replay with
        {
            CurrentSnapshot = Snapshot(2)
        }, s_scope));
        Assert.False(AuthorTypographyPreferenceResultValidator.ValidateWrite(replay with
        {
            Record = record with
            {
                ContentDigest = "bad"
            }
        }, s_scope));
        Assert.False(AuthorTypographyPreferenceResultValidator.ValidateWrite(replay, s_scope with
        {
            SiteIdentity = "site:other"
        }));
        Assert.False(AuthorTypographyPreferenceResultValidator.ValidateWrite(null, s_scope));
        Assert.True(AuthorTypographyPreferenceResultValidator.ValidateWrite(new(AuthorTypographyPreferenceWriteOutcome.RevisionConflict, null, null), s_scope));
        Assert.True(AuthorTypographyPreferenceResultValidator.ValidateWrite(new(AuthorTypographyPreferenceWriteOutcome.RevisionConflict, null, Snapshot(2)), s_scope));
        Assert.False(AuthorTypographyPreferenceResultValidator.ValidateWrite(new(AuthorTypographyPreferenceWriteOutcome.RevisionConflict, record, Snapshot(2)), s_scope));
    }

    private static AuthorTypographySnapshot Snapshot(long revision)
    {
        var snapshot = new AuthorTypographySnapshot(s_scope, revision, s_profile, string.Empty);
        return snapshot with
        {
            ContentDigest = AuthorTypographyContractValidator.ComputeSnapshotDigest(snapshot)
        };
    }

    private static AuthorTypographyRecordedRequest Record()
    {
        var request = new AuthorTypographyMutationRequest(Guid.Parse("00000000-0000-0000-0000-000000000123"),
            new(0, AuthorTypographyMutation.SetProfile, s_profile));
        var record = new AuthorTypographyRecordedRequest(request, Snapshot(1), string.Empty);
        return record with
        {
            ContentDigest = AuthorTypographyContractValidator.ComputeRecordedRequestDigest(record, s_scope)
        };
    }
}
