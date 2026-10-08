using System.Numerics;

using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MemoryAllocationLayoutTests
{
    [Fact]
    public void CheckedPlansAgreeWithUnboundedIntegerOracleAtExtremeSizes()
    {
        long[] counts = [-1, 0, 1, 3, 63, 64, int.MaxValue, long.MaxValue / 2, long.MaxValue];
        long[] elements = [-1, 0, 1, 3, 16, long.MaxValue];
        long[] alignments = [0, 1, 2, 3, 8, 64, 1L << 62];
        long[] maxima = [0, 1, 64, int.MaxValue, long.MaxValue];
        foreach (long count in counts)
        {
            foreach (long element in elements)
            {
                foreach (long alignment in alignments)
                {
                    foreach (long maximum in maxima)
                    {
                        BigInteger bytes = (BigInteger)count * element;
                        bool validAlignment = alignment > 0 && BigInteger.PopCount(alignment) == 1;
                        BigInteger capacity = validAlignment ? ((bytes + alignment - 1) / alignment) * alignment : -1;
                        bool expected = count > 0 && element > 0 && maximum > 0 && validAlignment
                            && bytes <= long.MaxValue && capacity > 0 && capacity <= maximum;
                        MemoryOperationResult<MemoryAllocationLayout> result = MemoryAllocationLayout.TryPlan(count, element, alignment, maximum);
                        Assert.Equal(expected, result.Succeeded);
                        if (expected)
                        {
                            Assert.Equal((long)bytes, result.Value!.LogicalBytes);
                            Assert.Equal((long)capacity, result.Value.CapacityBytes);
                            Assert.Equal((long)(capacity - bytes), result.Value.AlignmentSlack);
                            Assert.Equal(0, result.Value.RetainedSlack);
                        }
                        else
                        {
                            Assert.Equal(MemoryFailure.BoundsViolation, result.Failure);
                        }
                    }
                }
            }
        }
    }

    [Fact]
    public void AlignmentPaddingAndRetainedCapacityAreDistinctAndInvalidLayoutsAreRefused()
    {
        MemoryAllocationLayout layout = MemoryAllocationLayout.TryCreate(9, 64, 8).Value!;
        Assert.Equal(16, layout.AlignedBytes);
        Assert.Equal(7, layout.AlignmentSlack);
        Assert.Equal(48, layout.RetainedSlack);
        Assert.True(MemoryAllocationLayout.TryCreate(0, 64, 8).Succeeded);
        Assert.Equal(MemoryFailure.BoundsViolation, MemoryAllocationLayout.TryCreate(9, 15, 8).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation, MemoryAllocationLayout.TryCreate(9, 8, 8).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation, MemoryAllocationLayout.TryCreate(1, 0, 1).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation, MemoryAllocationLayout.TryCreate(-1, 64, 1).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation, MemoryAllocationLayout.TryCreate(long.MaxValue, long.MaxValue, 8).Failure);
        Assert.Equal(long.MaxValue, MemoryAllocationLayout.TryPlan(long.MaxValue, 1, 1, long.MaxValue).Value!.CapacityBytes);
    }
}
