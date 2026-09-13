using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicHotReadHitRateAccountingTests
{
    [Fact]
    public void SampledMode_UsesWeightedHitsAgainstExactMissesAndCannotInflate()
    {
        var counters = new PublicHotReadCounters(Options.Create(new PublicHotReadOptions
        {
            CounterMode = PublicHotReadCounterMode.Sampled,
            CounterSampleRate = 8
        }));
        const int TrueHits = 43;
        const int TrueMisses = 10;
        for (int i = 0; i < TrueHits; i++)
        {
            counters.ArticleHit(4);
        }

        for (int i = 0; i < TrueMisses; i++)
        {
            counters.ArticleMiss();
        }

        PublicHotReadCounterSnapshot snapshot = counters.Snapshot();
        PublicHotReadHitRateReceipt receipt = snapshot.HitRate;
        const int ExpectedSamples = 5;
        const int CalibratedHits = ExpectedSamples * 8;

        Assert.Equal(ExpectedSamples, receipt.ObservedHitSamples);
        Assert.Equal(CalibratedHits, snapshot.ArticleHit);
        Assert.Equal(CalibratedHits, receipt.CalibratedHits);
        Assert.Equal(TrueMisses, snapshot.ArticleMiss);
        Assert.Equal(TrueMisses, receipt.ExactMisses);
        Assert.Equal(PublicHotReadHitRateAccounting.WeightedSamples, receipt.HitAccounting);
        Assert.Equal(PublicHotReadHitRateAccounting.FullFidelity, receipt.MissAccounting);
        Assert.Equal(PublicHotReadHitRateAccounting.FormulaId, receipt.FormulaId);
        Assert.Equal(PublicHotReadHitRateAccounting.FormulaId, AlignsWithL1CapacityFormula());
        Assert.Equal(CalibratedHits / (double)(CalibratedHits + TrueMisses), receipt.CapacityHitRate);
        Assert.True(CalibratedHits <= TrueHits);
        Assert.True(receipt.CapacityHitRate <= TrueHits / (double)(TrueHits + TrueMisses));

        double naiveMixed = ExpectedSamples / (double)(ExpectedSamples + TrueMisses);
        Assert.True(naiveMixed < receipt.CapacityHitRate);
        Assert.NotEqual(naiveMixed, receipt.CapacityHitRate);
    }

    [Fact]
    public void SampledMode_DoesNotSampleMissesSoFullHitsAgainstSampledMissesCannotOccur()
    {
        var counters = new PublicHotReadCounters(Options.Create(new PublicHotReadOptions
        {
            CounterMode = PublicHotReadCounterMode.Sampled,
            CounterSampleRate = 10
        }));
        for (int i = 0; i < 100; i++)
        {
            counters.ArticleHit(1);
            counters.ListHit(1);
            counters.HtmlHit(1);
            counters.ArticleMiss();
            counters.ListMiss();
            counters.HtmlMiss();
        }

        PublicHotReadCounterSnapshot snapshot = counters.Snapshot();
        Assert.Equal(100, snapshot.ArticleMiss);
        Assert.Equal(100, snapshot.ListMiss);
        Assert.Equal(100, snapshot.HtmlMiss);
        Assert.Equal(300, snapshot.HitRate.ExactMisses);
        Assert.Equal(30, snapshot.HitRate.ObservedHitSamples);
        Assert.Equal(300, snapshot.HitRate.CalibratedHits);
        Assert.Equal(0.5, snapshot.HitRate.CapacityHitRate);

        double inflatedIfMissesWereSampled = 300 / (300 + 30.0);
        Assert.True(snapshot.HitRate.CapacityHitRate < inflatedIfMissesWereSampled);
    }

    [Fact]
    public void StripedMode_UsesFullFidelityCountsForTheSameFormula()
    {
        var counters = new PublicHotReadCounters(Options.Create(new PublicHotReadOptions
        {
            CounterMode = PublicHotReadCounterMode.Striped,
            CounterSampleRate = 64
        }));
        counters.ArticleHit(8);
        counters.ArticleHit(8);
        counters.ArticleHit(8);
        counters.ArticleMiss();

        PublicHotReadCounterSnapshot snapshot = counters.Snapshot();
        Assert.Equal(3, snapshot.ArticleHit);
        Assert.Equal(1, snapshot.ArticleMiss);
        Assert.Equal(PublicHotReadHitRateAccounting.FullFidelity, snapshot.HitRate.HitAccounting);
        Assert.Equal(PublicHotReadHitRateAccounting.FullFidelity, snapshot.HitRate.MissAccounting);
        Assert.Equal(PublicHotReadHitRateAccounting.L1HitAccounting, snapshot.HitRate.HitAccounting);
        Assert.Equal(PublicHotReadHitRateAccounting.L1MissAccounting, snapshot.HitRate.MissAccounting);
        Assert.Equal(0.75, snapshot.HitRate.CapacityHitRate);
        Assert.Equal(PublicHotReadHitRateAccounting.FormulaId, snapshot.HitRate.FormulaId);
    }

    [Fact]
    public void OffMode_WithholdsHitRateEvenWhenMissesAreRecorded()
    {
        var counters = new PublicHotReadCounters(Options.Create(new PublicHotReadOptions
        {
            CounterMode = PublicHotReadCounterMode.Off,
            CounterSampleRate = 64
        }));
        counters.ArticleHit(8);
        counters.ArticleMiss();
        counters.ArticleMiss();

        PublicHotReadCounterSnapshot snapshot = counters.Snapshot();
        Assert.Equal(0, snapshot.ArticleHit);
        Assert.Equal(2, snapshot.ArticleMiss);
        Assert.Null(snapshot.HitRate.CapacityHitRate);
        Assert.Equal("counter-mode-off", snapshot.HitRate.WithheldReason);
        Assert.Equal(PublicHotReadHitRateAccounting.Unavailable, snapshot.HitRate.HitAccounting);
    }

    [Fact]
    public void AccountingReceipt_WithholdsWhenThereAreNoObservations()
    {
        PublicHotReadHitRateReceipt receipt = PublicHotReadHitRateAccounting.Create(
            PublicHotReadCounterMode.Striped,
            64,
            0,
            0,
            0);

        Assert.Null(receipt.CapacityHitRate);
        Assert.Equal("no-observations", receipt.WithheldReason);
        Assert.Equal(PublicHotReadHitRateAccounting.FormulaId, receipt.FormulaId);
    }

    [Fact]
    public void CollectAndReset_KeepsAttemptTicketsSoCalibratedHitsDoNotDropRemainders()
    {
        var counters = new PublicHotReadCounters(Options.Create(new PublicHotReadOptions
        {
            CounterMode = PublicHotReadCounterMode.Sampled,
            CounterSampleRate = 8
        }));
        for (int i = 0; i < 12; i++)
        {
            counters.ArticleHit(1);
        }

        PublicHotReadCounterSnapshot first = counters.CollectAndReset();
        Assert.Equal(8, first.ArticleHit);
        for (int i = 0; i < 4; i++)
        {
            counters.ArticleHit(1);
        }

        PublicHotReadCounterSnapshot second = counters.CollectAndReset();
        Assert.Equal(8, second.ArticleHit);
        Assert.Equal(16, first.ArticleHit + second.ArticleHit);
    }

    [Fact]
    public void SampledMode_LeavesFreshnessPathCountersFullFidelity()
    {
        var counters = new PublicHotReadCounters(Options.Create(new PublicHotReadOptions
        {
            CounterMode = PublicHotReadCounterMode.Sampled,
            CounterSampleRate = 8
        }));
        for (int i = 0; i < 3; i++)
        {
            counters.FreshL0Hit();
            counters.LastGoodHit();
            counters.LastGoodWhileRebuild();
        }

        PublicHotReadCounterSnapshot snapshot = counters.Snapshot();
        Assert.Equal(3, snapshot.FreshL0Hit);
        Assert.Equal(3, snapshot.LastGoodHit);
        Assert.Equal(3, snapshot.LastGoodWhileRebuild);
        Assert.Equal(0, snapshot.HitRate.CalibratedHits);
    }

    [Fact]
    public void ExactMultipleOfSampleRate_MatchesGroundTruth()
    {
        var counters = new PublicHotReadCounters(Options.Create(new PublicHotReadOptions
        {
            CounterMode = PublicHotReadCounterMode.Sampled,
            CounterSampleRate = 8
        }));
        for (int i = 0; i < 40; i++)
        {
            counters.ArticleHit(2);
        }

        for (int i = 0; i < 10; i++)
        {
            counters.ArticleMiss();
        }

        PublicHotReadCounterSnapshot snapshot = counters.Snapshot();
        Assert.Equal(40, snapshot.ArticleHit);
        Assert.Equal(0.8, snapshot.HitRate.CapacityHitRate);
    }

    private static string AlignsWithL1CapacityFormula()
        => PublicHotReadHitRateAccounting.FormulaId;
}
