using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Services.Fixtures;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuditFixtureProducerTests
{
    private static readonly DateTimeOffset s_epoch = new(2026, 8, 20, 12, 0, 0, TimeSpan.Zero);
    private static readonly byte[] s_tamperKey = Encoding.UTF8.GetBytes(
        "audit-fixture-test-tamper-key-with-sufficient-entropy");

    [Fact]
    public void BuildPlan_UsesOnlyProductionCatalogActionsAndTemporalAuthority()
    {
        AuditFixturePlan plan = AuditFixtureProducer.BuildPlan(new AuditFixtureRequest(
            "namespace-a",
            "run-a",
            s_epoch,
            [
                AuditFixtureCapabilities.ChainMultiRecord,
                AuditFixtureCapabilities.HighValue,
                AuditFixtureCapabilities.InvestigationPage,
                AuditFixtureCapabilities.LegalHoldEligible,
                AuditFixtureCapabilities.PseudonymRetention,
                AuditFixtureCapabilities.SingleValid
            ]));

        Assert.Equal(AuditFixtureProducer.ProducerId, "audit-records");
        Assert.All(plan.Records, record => Assert.Equal(
            record.Action,
            AuditRetentionCatalog.GetRequired(record.Action).Action));
        Assert.Contains(plan.Records, static record => record.IsHighValue);
        Assert.Contains(plan.Records, static record => record.ContextPayload is { Length: > 0 });
        Assert.Contains(plan.Records, record => record.OccurredAtUtc.Date > s_epoch.UtcDateTime.Date);
        Assert.Equal(
            2,
            plan.Records.Count(record => record.ReasonCode == AuditFixtureCapabilities.ChainMultiRecord
                && record.OccurredAtUtc == s_epoch.UtcDateTime.AddSeconds(10)));
    }

    [Fact]
    public void BuildPlan_EmptyIsZeroMutationAndCannotMix()
    {
        AuditFixturePlan empty = AuditFixtureProducer.BuildPlan(new AuditFixtureRequest(
            "namespace-a",
            "run-a",
            s_epoch,
            [AuditFixtureCapabilities.Empty]));

        Assert.Empty(empty.Records);
        Assert.Throws<InvalidOperationException>(() => AuditFixtureProducer.BuildPlan(
            new AuditFixtureRequest(
                "namespace-a",
                "run-a",
                s_epoch,
                [AuditFixtureCapabilities.Empty, AuditFixtureCapabilities.SingleValid])));
    }

    [Fact]
    public void BuildPlan_UnknownActionIsRejectedBeforeAnyPositiveAppend()
    {
        AuditFixturePlan plan = AuditFixtureProducer.BuildPlan(new AuditFixtureRequest(
            "namespace-a",
            "run-a",
            s_epoch,
            [AuditFixtureCapabilities.UnknownActionNegative]));

        Assert.Empty(plan.Records);
        Assert.Throws<InvalidOperationException>(() => AuditRetentionCatalog.GetRequired("fixture.unknown-action"));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(1000)]
    public void BuildPlan_ScaleCountIsExactAndBounded(int count)
    {
        AuditFixturePlan plan = AuditFixtureProducer.BuildPlan(new AuditFixtureRequest(
            "namespace-a",
            "run-a",
            s_epoch,
            [AuditFixtureCapabilities.ChainMultiRecord],
            count));

        Assert.Equal(count == 0 ? 4 : count, plan.Records.Count);
        Assert.Throws<ArgumentOutOfRangeException>(() => AuditFixtureProducer.BuildPlan(
            new AuditFixtureRequest(
                "namespace-a",
                "run-a",
                s_epoch,
                [AuditFixtureCapabilities.ChainMultiRecord],
                1001)));
    }

    [Fact]
    public void NegativeCorpus_MutatesExactlyOneFieldAndReturnsStableReason()
    {
        AuditLog source = CreateSignedSource();

        var cases = AuditFixtureNegativeCorpus.Create(source);

        Assert.Equal(6, cases.Count);
        Assert.Equal(6, cases.Select(static item => item.Field).Distinct(StringComparer.Ordinal).Count());
        foreach ((string _, string field, AuditLog mutated, string expectedReason) in cases)
        {
            Assert.Equal([field], AuditFixtureNegativeCorpus.ChangedFields(source, mutated));
            Assert.Equal(
                expectedReason,
                AuditFixtureNegativeCorpus.Verify(source, mutated, s_tamperKey, field));
            Assert.True(AuditTamperEvidence.Verify(source, s_tamperKey));
        }
    }

    [Fact]
    public void NegativeCorpus_RejectsMultipleFieldMutation()
    {
        AuditLog source = CreateSignedSource();
        AuditLog mutated = AuditFixtureNegativeCorpus.Create(source)[0].Record;
        mutated.RecordHash = new string('a', 64);

        Assert.Equal(
            "negative_case_multiple_fields",
            AuditFixtureNegativeCorpus.Verify(source, mutated, s_tamperKey, "record_body"));
    }

    private static AuditLog CreateSignedSource()
    {
        var record = new AuditRecord(
            AuditSourceCatalog.Security,
            AuditTypeCatalog.Security,
            s_epoch.UtcDateTime,
            "synthetic protected fixture body",
            Encoding.UTF8.GetBytes("protected-envelope"),
            Action: AuditActionCatalog.PasskeyCounterRollback,
            Outcome: AuditOutcomeCatalog.Success,
            Severity: AuditSeverityCatalog.Warning,
            ActorType: AuditActorTypeCatalog.System,
            TargetType: "fixture-audit-record",
            TargetId: "audit-fixture:test",
            IsHighValue: true,
            ChainId: "20260820");
        AuditTamperEvidenceResult evidence = AuditTamperEvidence.Sign(record, s_tamperKey);
        return new AuditLog
        {
            Id = 1,
            Source = record.Source,
            Type = record.Type,
            OccurredAtUtc = record.OccurredAtUtc,
            ActorType = record.ActorType,
            ActorId = record.ActorId,
            ActorRole = record.ActorRole,
            Action = record.Action,
            TargetType = record.TargetType,
            TargetId = record.TargetId,
            Outcome = record.Outcome,
            Severity = record.Severity,
            IsHighValue = record.IsHighValue,
            ReasonCode = record.ReasonCode,
            EventInfo = record.EventInfo,
            ContextPayload = record.ContextPayload?.ToArray(),
            ContextJson = record.ContextJson,
            ChainId = evidence.ChainId,
            PrevHash = record.PrevHash,
            RecordHash = evidence.RecordHash,
            RecordMac = evidence.RecordMac
        };
    }
}
