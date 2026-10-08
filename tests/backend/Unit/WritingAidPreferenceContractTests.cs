using System.Text;

using FsusBlog.Shared.Contracts.AuthoringPreferences;

namespace FsusBlog.Server.Tests.Unit;

public sealed class WritingAidPreferenceContractTests
{
    [Fact]
    public void Defaults_AreIndependentAndDisabled()
        => Assert.Equal(new WritingAidPreferenceValues(1, false, false, false), WritingAidPreferenceContract.Defaults);

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(false, false, true)]
    [InlineData(false, true, false)]
    [InlineData(false, true, true)]
    [InlineData(true, false, false)]
    [InlineData(true, false, true)]
    [InlineData(true, true, false)]
    [InlineData(true, true, true)]
    public void AllCombinations_ValidateWithoutSurfaceOrDocumentFields(bool focus, bool typewriter, bool immersive)
    {
        string json = $$"""{"schemaVersion":1,"focusEnabled":{{focus.ToString().ToLowerInvariant()}},"typewriterEnabled":{{typewriter.ToString().ToLowerInvariant()}},"immersiveEnabled":{{immersive.ToString().ToLowerInvariant()}}}""";
        Assert.True(WritingAidPreferenceValidator.TryReadValues(Encoding.UTF8.GetBytes(json), out WritingAidPreferenceValues? values));
        Assert.Equal(new WritingAidPreferenceValues(1, focus, typewriter, immersive), values);
        var update = new WritingAidPreferenceUpdate(2, Guid.NewGuid(), values!);
        Assert.Equal(WritingAidPreferenceValidation.Valid, WritingAidPreferenceValidator.ValidateUpdate(update));
    }

    [Theory]
    [InlineData("{\"schemaVersion\":2,\"focusEnabled\":false,\"typewriterEnabled\":false,\"immersiveEnabled\":false}")]
    [InlineData("{\"schemaVersion\":1,\"focusEnabled\":\"true\",\"typewriterEnabled\":false,\"immersiveEnabled\":false}")]
    [InlineData("{\"schemaVersion\":1,\"focusEnabled\":1,\"typewriterEnabled\":false,\"immersiveEnabled\":false}")]
    [InlineData("{\"schemaVersion\":1,\"focusEnabled\":true,\"typewriterEnabled\":false,\"immersiveEnabled\":false,\"surface\":\"source\"}")]
    [InlineData("{\"schemaVersion\":1,\"focusEnabled\":true,\"typewriterEnabled\":false,\"immersiveEnabled\":false,\"articleId\":1}")]
    [InlineData("{\"schemaVersion\":1,\"focusEnabled\":true,\"typewriterEnabled\":false,\"immersiveEnabled\":false,\"focusEnabled\":false}")]
    [InlineData("{\"schemaVersion\":1,\"focusEnabled\":false,\"immersiveEnabled\":false}")]
    [InlineData("{\"writingMode\":\"zen\"}")]
    [InlineData("{\"schemaVersion\":\"1\",\"focusEnabled\":false,\"typewriterEnabled\":false,\"immersiveEnabled\":false}")]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("{not json}")]
    public void NormalReader_RejectsUnknownLegacyCorruptAndInexactFields(string json)
    {
        Assert.False(WritingAidPreferenceValidator.TryReadValues(Encoding.UTF8.GetBytes(json), out WritingAidPreferenceValues? values));
        Assert.Null(values);
    }

    [Theory]
    [InlineData("account:1", true)]
    [InlineData("admin:1", true)]
    [InlineData("account:01", false)]
    [InlineData("account:0", false)]
    [InlineData("account:-1", false)]
    [InlineData("guest:1", false)]
    [InlineData("article:1", false)]
    [InlineData("account:9007199254740992", false)]
    public void OwnerNamespace_SeparatesAccountAdminAndRejectsAnonymousOrInexactIds(string scope, bool valid)
        => Assert.Equal(valid, WritingAidPreferenceValidator.IsValidOwner(new(scope, "site:test")));

    [Fact]
    public void SnapshotDigest_BindsOwnerRevisionAndEachAidAndRejectsTamper()
    {
        var owner = new WritingAidPreferenceOwner("account:1", "site:test");
        var values = new WritingAidPreferenceValues(1, true, false, true);
        var snapshot = new WritingAidPreferenceSnapshot(owner, 3, values,
            WritingAidPreferenceValidator.ComputeDigest(owner, 3, values));
        Assert.Equal(WritingAidPreferenceValidation.Valid, WritingAidPreferenceValidator.ValidateSnapshot(snapshot, owner));
        Assert.Equal(WritingAidPreferenceValidation.OwnerMismatch,
            WritingAidPreferenceValidator.ValidateSnapshot(snapshot, owner with { UserScope = "account:2" }));
        Assert.Equal(WritingAidPreferenceValidation.OwnerMismatch,
            WritingAidPreferenceValidator.ValidateSnapshot(snapshot, owner with { SiteScope = "site:other" }));
        Assert.Equal(WritingAidPreferenceValidation.DigestMismatch,
            WritingAidPreferenceValidator.ValidateSnapshot(snapshot with { Revision = 4 }, owner));
        Assert.Equal(WritingAidPreferenceValidation.DigestMismatch,
            WritingAidPreferenceValidator.ValidateSnapshot(snapshot with { Values = values with { TypewriterEnabled = true } }, owner));
        Assert.Equal(WritingAidPreferenceValidation.InvalidSchema,
            WritingAidPreferenceValidator.ValidateSnapshot(snapshot with { Revision = 0 }, owner));
        Assert.Equal(WritingAidPreferenceValidation.InvalidSchema,
            WritingAidPreferenceValidator.ValidateSnapshot(snapshot with { Values = values with { SchemaVersion = 2 } }, owner));
    }

    [Fact]
    public void Command_RejectsOverflowAndMissingIdempotencyIdentity()
    {
        var update = new WritingAidPreferenceUpdate(0, Guid.NewGuid(), WritingAidPreferenceContract.Defaults);
        Assert.Equal(WritingAidPreferenceValidation.InvalidOperation,
            WritingAidPreferenceValidator.ValidateUpdate(update with { OperationId = Guid.Empty }));
        Assert.Equal(WritingAidPreferenceValidation.InvalidRevision,
            WritingAidPreferenceValidator.ValidateUpdate(update with { ExpectedRevision = WritingAidPreferenceContract.MaximumExactRevision }));
        Assert.Equal(WritingAidPreferenceValidation.InvalidRevision,
            WritingAidPreferenceValidator.ValidateUpdate(update with { ExpectedRevision = -1 }));
    }
}
