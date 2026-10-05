using System.Text.Json;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Fixtures;

namespace FsusBlog.Server.Tests;

public sealed class PublicContentIndependentVerificationTests
{
    [Fact]
    public void PublicDetailRead_MustMatchExactOwnedPublicationCoordinates()
    {
        var row = new Article { Id = 7, CurrentRevisionId = 42, CurrentPublicationId = 41 };
        ArticleDetailCoreModel current = default(ArticleDetailCoreModel) with
        {
            Id = 7,
            Status = (int)ArticleStatus.Published,
            CurrentRevisionId = 42,
            CurrentPublicationId = 41
        };
        Assert.True(PublicContentFixtureSeeder.IsCurrentPublicDetail(row, current, 42));
        Assert.False(PublicContentFixtureSeeder.IsCurrentPublicDetail(row, null, 42));
        Assert.False(PublicContentFixtureSeeder.IsCurrentPublicDetail(row, current with
        {
            Id = 8
        }, 42));
        Assert.False(PublicContentFixtureSeeder.IsCurrentPublicDetail(row, current with
        {
            CurrentPublicationId = 40
        }, 42));
        Assert.False(PublicContentFixtureSeeder.IsCurrentPublicDetail(row, current with
        {
            CurrentRevisionId = 40
        }, 42));
        Assert.False(PublicContentFixtureSeeder.IsCurrentPublicDetail(row, current with
        {
            IsDeleted = true
        }, 42));
        Assert.False(PublicContentFixtureSeeder.IsCurrentPublicDetail(row, current with
        {
            Status = (int)ArticleStatus.Draft
        }, 42));
        Assert.False(PublicContentFixtureSeeder.IsCurrentPublicDetail(row, current, null));
        row.CurrentRevisionId = 99;
        Assert.True(PublicContentFixtureSeeder.IsCurrentPublicDetail(row, current, 42));
    }
    private static readonly PublicContentVerificationIdentity s_identity = new(
        "run", "namespace", "runtime-cache-pagination", new string('a', 40),
        "sha256:" + new string('b', 64), "sha256:" + new string('c', 64));

    [Theory]
    [InlineData("run")]
    [InlineData("namespace")]
    [InlineData("profile")]
    [InlineData("commit")]
    [InlineData("fingerprint")]
    [InlineData("variant")]
    public void SignedPrepareProof_RejectsWrongIdentity(string field)
    {
        var snapshot = new PublicContentVerificationSnapshot(s_identity, null!, [], []);
        string payload = JsonSerializer.Serialize(snapshot, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var proof = new PublicContentVerificationProof(payload,
            PublicContentFixtureSeeder.ComputeVerificationMac(payload, "task-only-key"));
        PublicContentVerificationIdentity wrong = field switch
        {
            "run" => s_identity with { RunId = "other-run" },
            "namespace" => s_identity with { Namespace = "other-namespace" },
            "profile" => s_identity with { ProfileId = "other-profile" },
            "commit" => s_identity with { SourceCommit = new string('d', 40) },
            "fingerprint" => s_identity with { SourceFingerprint = "sha256:" + new string('d', 64) },
            _ => s_identity with { VariantPlanDigest = "sha256:" + new string('d', 64) }
        };
        Assert.Throws<InvalidOperationException>(() => PublicContentFixtureSeeder.OpenVerificationProof(
            new(wrong, proof), "task-only-key"));
        Assert.Equal(s_identity, PublicContentFixtureSeeder.OpenVerificationProof(
            new(s_identity, proof), "task-only-key").Identity);
        Assert.Throws<InvalidOperationException>(() => PublicContentFixtureSeeder.OpenVerificationProof(
            new(s_identity, proof with
            {
                Payload = payload + " "
            }), "task-only-key"));
        Assert.Throws<InvalidOperationException>(() => PublicContentFixtureSeeder.OpenVerificationProof(
            new(s_identity, proof), "wrong-task-key"));
    }

    [Theory]
    [InlineData("currentPublicationId")]
    [InlineData("currentRevisionId")]
    [InlineData("publicDetailReadable")]
    [InlineData("revisionIds")]
    [InlineData("status")]
    public void FreshFacts_RejectPrepareSnapshotDrift(string field)
    {
        var expected = new Dictionary<string, object?>
        {
            ["currentPublicationId"] = 41L,
            ["currentRevisionId"] = 42L,
            ["publicDetailReadable"] = true,
            ["revisionIds"] = new[] { "42" },
            ["status"] = "published"
        };
        var current = new Dictionary<string, object?>(expected) { [field] = null };
        Assert.Throws<InvalidOperationException>(() => PublicContentFixtureSeeder.RequireVerificationEquality(
            expected, current, expected.Keys.ToArray()));
        PublicContentFixtureSeeder.RequireVerificationEquality(expected, expected, expected.Keys.ToArray());
    }
}
