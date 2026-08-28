using System.Buffers;
using System.Reflection;
using System.Reflection.Emit;

using FsusBlog.Server.Infrastructure.NotificationStream;

namespace FsusBlog.Server.Tests.Unit;

public sealed class NotificationStreamFrameContractTests
{
    [Fact]
    public void NotificationStreamUserTarget_StoresAccountId()
    {
        var target = new NotificationStreamUserTarget("user-123");
        Assert.Equal("user-123", target.AccountId);
    }

    [Fact]
    public void NotificationStreamGroupTarget_StoresGroupName()
    {
        var target = new NotificationStreamGroupTarget("admin-group");
        Assert.Equal("admin-group", target.GroupName);
    }

    [Fact]
    public void NotificationStreamMultiUserTarget_StoresUserIds()
    {
        var ids = new List<string> { "user1", "user2", "user3" };
        var target = new NotificationStreamMultiUserTarget(ids);
        Assert.Equal(3, target.UserIds.Count);
    }

    [Fact]
    public void NotificationStreamTargetCollections_AllCollectionsAreDistinct()
    {
        var groups = new[] { NotificationStreamTargetCollections.ContentFeed, NotificationStreamTargetCollections.AdminUsers };
        Assert.Equal(groups.Length, groups.Distinct().Count());
    }

    [Fact]
    public void NotificationStreamTargetCollections_AllNonEmpty()
    {
        Assert.NotEmpty(NotificationStreamTargetCollections.ContentFeed);
        Assert.NotEmpty(NotificationStreamTargetCollections.AdminUsers);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// SharedNotificationStreamFrame tests
// ──────────────────────────────────────────────────────────────────────────────

public class SharedNotificationStreamFrameExtendedTests
{
    [Fact]
    public void FromArray_StoresPayload()
    {
        var payload = new byte[] { 1, 2, 3, 4, 5 };
        var frame = SharedNotificationStreamFrame.FromArray(payload);
        Assert.Equal(5, frame.Length);
        frame.Release();
    }

    [Fact]
    public void FromArray_MemoryMatchesPayload()
    {
        var payload = new byte[] { 10, 20, 30 };
        var frame = SharedNotificationStreamFrame.FromArray(payload);
        var memory = frame.Memory;
        Assert.Equal(10, memory.Span[0]);
        Assert.Equal(20, memory.Span[1]);
        Assert.Equal(30, memory.Span[2]);
        frame.Release();
    }

    [Fact]
    public void FromOwnedBuffer_HasCorrectLength()
    {
        // FromOwnedBuffer requires a pool-rented buffer for release
        var buffer = System.Buffers.ArrayPool<byte>.Shared.Rent(100);
        var frame = SharedNotificationStreamFrame.FromOwnedBuffer(buffer, 50);
        Assert.Equal(50, frame.Length);
        frame.Release();
    }

    [Fact]
    public void FromOwnedBuffer_PublicFactoryBindsSharedPool()
    {
        MethodInfo publicFactory = Assert.Single(
            typeof(SharedNotificationStreamFrame)
                .GetMethods(BindingFlags.Public | BindingFlags.Static),
            static method =>
            {
                ParameterInfo[] parameters = method.GetParameters();
                return method.Name == nameof(SharedNotificationStreamFrame.FromOwnedBuffer)
                    && parameters.Length == 2
                    && parameters[0].ParameterType == typeof(byte[])
                    && parameters[1].ParameterType == typeof(int);
            });
        MethodInfo sharedGetter = typeof(ArrayPool<byte>)
            .GetProperty(nameof(ArrayPool<byte>.Shared), BindingFlags.Public | BindingFlags.Static)!
            .GetMethod!;

        IReadOnlyList<MethodBase> callTargets = ResolveCallTargets(publicFactory);

        Assert.Contains(
            callTargets,
            target => target.Module == sharedGetter.Module
                && target.MetadataToken == sharedGetter.MetadataToken);
    }

    [Fact]
    public void FromOwnedBuffer_RetainDefersPoolReturnUntilFinalRelease()
    {
        var pool = new TrackingArrayPool();
        byte[] buffer = pool.Rent(3);
        buffer[0] = 1;
        buffer[1] = 2;
        buffer[2] = 3;
        SharedNotificationStreamFrame frame =
            SharedNotificationStreamFrame.FromOwnedBuffer(buffer, 3, pool);

        Assert.Equal(1, pool.RentCount);
        Assert.Equal(3, pool.MinimumLength);

        frame.Retain();
        frame.Release();

        Assert.Equal(0, pool.ReturnCount);
        Assert.Equal([1, 2, 3], frame.Memory.ToArray());

        frame.Release();

        Assert.Equal(1, pool.ReturnCount);
        Assert.Same(buffer, pool.ReturnedBuffer);
        Assert.True(pool.ClearArray);
        Assert.All(buffer, static value => Assert.Equal(0, value));
        Assert.Throws<InvalidOperationException>(() => frame.Release());
        Assert.Equal(1, pool.ReturnCount);
    }

    [Fact]
    public void Release_WhenCalledMoreThanRetain_Throws()
    {
        var frame = SharedNotificationStreamFrame.FromArray([1, 2, 3]);

        frame.Release();

        Assert.Throws<InvalidOperationException>(() => frame.Release());
    }

    [Fact]
    public void Retain_AfterRelease_Throws()
    {
        var frame = SharedNotificationStreamFrame.FromArray([1, 2, 3]);

        frame.Release();

        Assert.Throws<ObjectDisposedException>(() => frame.Retain());
    }

    private sealed class TrackingArrayPool : ArrayPool<byte>
    {
        public int RentCount
        {
            get; private set;
        }

        public int MinimumLength
        {
            get; private set;
        }

        public int ReturnCount
        {
            get; private set;
        }

        public byte[]? ReturnedBuffer
        {
            get; private set;
        }

        public bool ClearArray
        {
            get; private set;
        }

        public override byte[] Rent(int minimumLength)
        {
            RentCount++;
            MinimumLength = minimumLength;
            return new byte[Math.Max(1, minimumLength)];
        }

        public override void Return(byte[] array, bool clearArray = false)
        {
            ReturnCount++;
            ReturnedBuffer = array;
            ClearArray = clearArray;
            if (clearArray)
            {
                Array.Clear(array);
            }
        }
    }

    private static IReadOnlyList<MethodBase> ResolveCallTargets(MethodInfo method)
    {
        byte[] body = method.GetMethodBody()?.GetILAsByteArray()
            ?? throw new InvalidOperationException("Expected a managed method body.");
        var targets = new List<MethodBase>();
        for (int index = 0; index <= body.Length - sizeof(int) - 1; index++)
        {
            if (body[index] != (byte)OpCodes.Call.Value)
            {
                continue;
            }

            int token = BitConverter.ToInt32(body, index + 1);
            try
            {
                MethodBase? target = method.Module.ResolveMethod(token);
                if (target is not null)
                {
                    targets.Add(target);
                }
            }
            catch (ArgumentException)
            {
                // A metadata token payload can contain the call opcode byte.
            }
        }

        return targets;
    }
}
