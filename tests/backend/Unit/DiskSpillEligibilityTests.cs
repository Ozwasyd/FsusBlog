using FsusBlog.Server.Infrastructure.Memory.Disk;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DiskSpillEligibilityTests
{
    [Theory]
    [InlineData(DiskSpillClassification.Unclassified)]
    [InlineData(DiskSpillClassification.PrivateResponse)]
    [InlineData(DiskSpillClassification.Credentials)]
    [InlineData(DiskSpillClassification.UnpublishedDraft)]
    [InlineData(DiskSpillClassification.Authoritative)]
    [InlineData((DiskSpillClassification)999)]
    public void ExcludedClassesCannotBecomeEligibleThroughAvailability(DiskSpillClassification classification)
    {
        Assert.False(DiskSpillEligibility.IsEligible(classification, dataOwnerAllows: true));
    }

    [Fact]
    public void DataOwnerDenialOverridesPublicReconstructibleClassification()
    {
        Assert.False(DiskSpillEligibility.IsEligible(DiskSpillClassification.PublicImmutableReconstructible, false));
        Assert.True(DiskSpillEligibility.IsEligible(DiskSpillClassification.PublicImmutableReconstructible, true));
    }
}
