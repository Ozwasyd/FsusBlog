namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public static class PublicHotReadHitRateAccounting
{
    public const string FormulaId = "calibrated-hits / (calibrated-hits + exact-misses)";
    public const string FullFidelity = "full-fidelity";
    public const string WeightedSamples = "weighted-samples";
    public const string Unavailable = "unavailable";
    public const string L1HitAccounting = FullFidelity;
    public const string L1MissAccounting = FullFidelity;

    public static PublicHotReadHitRateReceipt Create(
        PublicHotReadCounterMode mode,
        int sampleRate,
        long observedHitSamples,
        long calibratedHits,
        long exactMisses)
    {
        string hitAccounting = mode switch
        {
            PublicHotReadCounterMode.Off => Unavailable,
            PublicHotReadCounterMode.Sampled => WeightedSamples,
            _ => FullFidelity
        };
        string missAccounting = mode == PublicHotReadCounterMode.Off ? Unavailable : FullFidelity;
        string? withheldReason = null;
        double? capacityHitRate = null;
        if (mode == PublicHotReadCounterMode.Off)
        {
            withheldReason = "counter-mode-off";
        }
        else if (calibratedHits + exactMisses <= 0)
        {
            withheldReason = "no-observations";
        }
        else
        {
            capacityHitRate = (double)calibratedHits / (calibratedHits + exactMisses);
        }

        return new PublicHotReadHitRateReceipt(
            ModeName(mode),
            sampleRate,
            hitAccounting,
            missAccounting,
            observedHitSamples,
            calibratedHits,
            exactMisses,
            capacityHitRate,
            FormulaId,
            withheldReason);
    }

    public static long ScaleHitSamples(long samples, PublicHotReadCounterMode mode, int sampleRate)
    {
        if (samples <= 0 || mode != PublicHotReadCounterMode.Sampled || sampleRate <= 1)
        {
            return samples;
        }

        return samples * (long)sampleRate;
    }

    public static string ModeName(PublicHotReadCounterMode mode)
        => mode switch
        {
            PublicHotReadCounterMode.Off => "off",
            PublicHotReadCounterMode.Sampled => "sampled",
            _ => "striped"
        };
}

public readonly record struct PublicHotReadHitRateReceipt(
    string CounterMode,
    int SampleRate,
    string HitAccounting,
    string MissAccounting,
    long ObservedHitSamples,
    long CalibratedHits,
    long ExactMisses,
    double? CapacityHitRate,
    string FormulaId,
    string? WithheldReason);
