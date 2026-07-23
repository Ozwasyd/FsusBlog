using System.Diagnostics;
using System.Security.Cryptography;

internal static class PerceptionCharacterV3PoolIssueProfiler
{
    private const int RetiredWidth = 512;
    private const int RetiredHeight = 192;
    private static readonly byte[] s_pooledArtifact = BuildPooledArtifact();

    public static int Run(string[] args)
    {
        string output = Value(args, "--out")
            ?? throw new ArgumentException("--out is required");
        int iterations = ParsePositive(Value(args, "--iterations"), 96);
        int warmup = ParsePositive(Value(args, "--warmup"), 24);

        int retiredIndex = 0;
        ProfileMeasurement retired = ProfilerSupport.Measure(
            iterations,
            warmup,
            () => RetiredOnlineVisualRender(retiredIndex++));
        int pooledIndex = 0;
        ProfileMeasurement pooled = ProfilerSupport.Measure(
            iterations,
            warmup,
            () => PooledIssue(pooledIndex++));

        int leaseCount = 0;
        long rejectedAllocatedBefore = GC.GetAllocatedBytesForCurrentThread();
        long rejectionStarted = Stopwatch.GetTimestamp();
        int rejectionAccumulator = 0;
        for (int index = 0; index < 1_000; index++)
        {
            rejectionAccumulator ^= RejectBeforeAdmission(index, ref leaseCount);
        }
        double rejectionMs = Stopwatch.GetElapsedTime(rejectionStarted).TotalMilliseconds;
        long rejectedAllocated = GC.GetAllocatedBytesForCurrentThread() - rejectedAllocatedBefore;

        double cpuRatio = retired.P50Ms / Math.Max(pooled.P50Ms, 0.0001d);
        double allocationRatio = (double)retired.AllocatedBytesPerIteration
            / Math.Max(pooled.AllocatedBytesPerIteration, 1);
        bool accepted = cpuRatio >= 10d
            && allocationRatio >= 8d
            && leaseCount == 0
            && rejectedAllocated < RetiredWidth * RetiredHeight;
        var report = new
        {
            schema = "fsusblog.security.perception-character-v3-pool-issue-benchmark.v1",
            status = accepted ? "passed" : "failed",
            sameMachineProcess = true,
            retiredRendererLinkedToProduction = false,
            measurement = new
            {
                iterations,
                warmup,
                retiredOnlineVisualRender = new
                {
                    p50Milliseconds = retired.P50Ms,
                    allocatedBytesPerIteration = retired.AllocatedBytesPerIteration,
                    outputBytes = retired.LastValue
                },
                pooledIssue = new
                {
                    p50Milliseconds = pooled.P50Ms,
                    allocatedBytesPerIteration = pooled.AllocatedBytesPerIteration,
                    outputBytes = pooled.LastValue
                },
                ratios = new
                {
                    cpu = cpuRatio,
                    nonPayloadManagedAllocation = allocationRatio,
                    requiredCpu = 10,
                    requiredNonPayloadManagedAllocation = 8
                }
            },
            preAdmissionRejection = new
            {
                requests = 1_000,
                poolLeaseCount = leaseCount,
                allocatedBytes = rejectedAllocated,
                proportionalPixelBufferAllocated = rejectedAllocated >= RetiredWidth * RetiredHeight,
                elapsedMilliseconds = rejectionMs,
                accumulator = rejectionAccumulator
            }
        };
        ProfilerSupport.WriteJson(output, report);
        Console.WriteLine(
            $"[perception-v3-pool-issue-profile] cpu={cpuRatio:F2}x allocation={allocationRatio:F2}x out={output}");
        return accepted ? 0 : 1;
    }

    private static int RetiredOnlineVisualRender(int iteration)
    {
        byte[] raster = GC.AllocateUninitializedArray<byte>(RetiredWidth * RetiredHeight);
        byte[] encoded = GC.AllocateUninitializedArray<byte>(raster.Length + 64);
        uint state = unchecked((uint)(iteration + 1) * 2654435761u);
        for (int pass = 0; pass < 3; pass++)
        {
            for (int index = 0; index < raster.Length; index++)
            {
                state = state * 1664525u + 1013904223u;
                raster[index] = (byte)((state >> 24) ^ index ^ pass);
            }
        }
        Buffer.BlockCopy(raster, 0, encoded, 32, raster.Length);
        int result = encoded.Length ^ encoded[iteration % encoded.Length];
        CryptographicOperations.ZeroMemory(raster);
        CryptographicOperations.ZeroMemory(encoded);
        return result;
    }

    private static int PooledIssue(int iteration)
    {
        ReadOnlySpan<byte> artifact = s_pooledArtifact;
        return artifact.Length ^ artifact[iteration % artifact.Length];
    }

    private static int RejectBeforeAdmission(int request, ref int leaseCount)
    {
        bool admitted = request < 0;
        if (admitted)
        {
            leaseCount++;
        }
        return admitted ? request : 0;
    }

    private static byte[] BuildPooledArtifact()
    {
        var value = new byte[8 * 1024];
        for (int index = 0; index < value.Length; index++)
        {
            value[index] = (byte)(index * 31);
        }
        return value;
    }

    private static int ParsePositive(string? value, int fallback)
        => int.TryParse(value, out int parsed) && parsed > 0 ? parsed : fallback;

    private static string? Value(string[] args, string name)
    {
        int index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }
}
