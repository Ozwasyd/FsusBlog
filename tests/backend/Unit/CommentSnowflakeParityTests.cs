using FsusBlog.Server.Services.Fixtures.DataScale;

using SqlSugar.DistributedSystem.Snowflake;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentSnowflakeParityTests
{
    [Fact]
    public void ProductionCore_ReplaysHundredThousandCoordinatesWithExactRollover()
    {
        SqlSugarCommentIdAuthority authority = Authority();
        var core = new SqlSugarCommentIdCore(authority);
        long epoch = new DateTimeOffset(2026, 9, 15, 12, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();
        long previous = 0;
        DirectProductionWorker? production = null;
        for (int index = 0; index < 100_000; index++)
        {
            long timestamp = epoch + index / 4096;
            int sequence = index % 4096;
            if (sequence == 0)
            {
                production = new DirectProductionWorker(timestamp);
            }
            long id = core.Encode(timestamp, 1023, sequence);
            Assert.Equal(production!.NextId(), id);
            Assert.True(id > previous);
            Assert.Equal(new SqlSugarCommentIdCoordinate(timestamp, 1023, sequence), core.Decode(id));
            previous = id;
        }
        var replay = new SqlSugarCommentIdCore(authority);
        Assert.Equal(previous, replay.Encode(epoch + 99_999 / 4096, 1023, 99_999 % 4096));
        Assert.Equal(core.Encode(epoch, 1023, 0), replay.Encode(epoch, 1023, 0));
    }

    [Fact]
    public void Authority_RequiresActualCoreEpochAndExplicitUnassignedReservedNode()
    {
        SqlSugarCommentIdAuthority authority = Authority();
        Assert.Throws<InvalidOperationException>(() => new SqlSugarCommentIdCore(authority with { Epoch = authority.Epoch.AddMilliseconds(1) }));
        Assert.Throws<InvalidOperationException>(() => new SqlSugarCommentIdCore(authority with { ProductionAssignedNodeIds = [] }));
        Assert.Throws<InvalidOperationException>(() => new SqlSugarCommentIdCore(authority with { ProductionAssignedNodeIds = [0, 1023] }));
        Assert.Throws<InvalidOperationException>(() => new SqlSugarCommentIdCore(authority with { ProductionCoreDigest = "sha256:" + new string('0', 64) }));
        Assert.Throws<InvalidOperationException>(() => new SqlSugarCommentIdCore(authority with { NodeBits = 9 }));
    }

    [Fact]
    public void Coordinate_RefusesUnassignedTimeNodeAndOverflowWithoutWallClockFallback()
    {
        var core = new SqlSugarCommentIdCore(Authority());
        long timestamp = IdWorker.Twepoch + 1;
        Assert.Throws<ArgumentOutOfRangeException>(() => core.Encode(timestamp, 0, 0));
        Assert.Throws<ArgumentOutOfRangeException>(() => core.Encode(timestamp, 1023, 4096));
        Assert.Throws<ArgumentOutOfRangeException>(() => core.Encode(IdWorker.Twepoch, 1023, 0));
        Assert.Throws<ArgumentOutOfRangeException>(() => core.Encode(long.MaxValue, 1023, 0));
        Assert.Equal(new SqlSugarCommentIdCoordinate(timestamp, 1023, 4095), core.Decode(core.Encode(timestamp, 1023, 4095)));
    }

    private static SqlSugarCommentIdAuthority Authority()
        => new(SqlSugarCommentIdCore.AlgorithmVersion, DateTimeOffset.FromUnixTimeMilliseconds(IdWorker.Twepoch),
            10, 12, 1023, [0], SqlSugarCommentIdCore.ProductionCoreDigest, "sha256:" + new string('a', 64));

    private sealed class DirectProductionWorker(long timestampMs) : IdWorker(31, 31, 0)
    {
        protected override long TimeGen() => timestampMs;

        protected override long TilNextMillis(long lastTimestamp)
            => throw new InvalidOperationException("Test requested an unplanned rollover.");
    }
}
