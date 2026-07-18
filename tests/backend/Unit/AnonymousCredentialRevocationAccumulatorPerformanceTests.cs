using System.Collections.Concurrent;
using System.Reflection;

using FsusBlog.Core.Common;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCredentialRevocationAccumulatorPerformanceTests
{
    private static readonly string IssuerPublicKeyHash = new('f', 64);

    [Fact]
    public void CircuitFriendlyRoot_RuntimeUsesEpochScopedCacheAndBinarySearchNeighbors()
    {
        Type accumulator = typeof(AnonymousCredentialRevocationAccumulator);
        FieldInfo cache = accumulator.GetFields(BindingFlags.Static | BindingFlags.NonPublic)
            .Single(static field => field.Name.Contains("CircuitFriendlyTreeCache", StringComparison.Ordinal)
                && field.FieldType.IsGenericType
                && field.FieldType.GetGenericTypeDefinition() == typeof(ConcurrentDictionary<,>));
        Assert.Contains("CircuitFriendlyTreeCacheKey", cache.FieldType.GenericTypeArguments[0].Name, StringComparison.Ordinal);
        int maxEntries = (int)accumulator
            .GetField("CircuitFriendlyRootCacheMaxEntries", BindingFlags.Static | BindingFlags.NonPublic)!
            .GetRawConstantValue()!;
        Assert.InRange(maxEntries, 1, 4096);

        foreach (string methodName in new[]
        {
            "GetOrBuildCircuitFriendlySparseTree",
            "TryEvictCircuitFriendlyTreeCacheEpoch",
            "ClearCircuitFriendlyRootCacheForTests",
            "ResolveNeighbors"
        })
        {
            Assert.NotNull(accumulator.GetMethod(methodName, BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public));
        }
        IReadOnlyList<string> binarySearchCallers = RuntimeMetadataInspection.FindMethodsCallingMember(
            accumulator,
            static member => member.DeclaringType == typeof(Array) && member.Name == nameof(Array.BinarySearch));
        Assert.Contains(binarySearchCallers, static caller => caller.EndsWith(".ResolveNeighbors", StringComparison.Ordinal));
        IReadOnlyList<string> enumeratorCallers = RuntimeMetadataInspection.FindMethodsCallingMember(
            accumulator,
            static member => member.Name == "GetEnumerator");
        Assert.DoesNotContain(enumeratorCallers, static caller => caller.EndsWith(".ResolveNeighbors", StringComparison.Ordinal));
    }

    [Fact]
    public void CreateNonMembershipWitness_ReturnsExpectedNeighborsAtInsertionBoundaries()
    {
        string[] handles = [new('1', 64), new('3', 64), new('5', 64)];
        string beforeFirst = new('0', 64);
        string betweenFirstSecond = new('2', 64);
        string afterLast = new('f', 64);
        string root = Root(4096, handles);

        AnonymousCredentialNonMembershipWitness before = CreateWitness(4096, root, beforeFirst, handles);
        AnonymousCredentialNonMembershipWitness middle = CreateWitness(4096, root, betweenFirstSecond, handles);
        AnonymousCredentialNonMembershipWitness after = CreateWitness(4096, root, afterLast, handles);

        Assert.Equal(string.Empty, before.PreviousRevocationHandleHash);
        Assert.Equal(handles[0], before.NextRevocationHandleHash);
        Assert.Equal(handles[0], middle.PreviousRevocationHandleHash);
        Assert.Equal(handles[1], middle.NextRevocationHandleHash);
        Assert.Equal(handles[^1], after.PreviousRevocationHandleHash);
        Assert.Equal(string.Empty, after.NextRevocationHandleHash);
    }

    private static AnonymousCredentialNonMembershipWitness CreateWitness(long epoch, string root, string handle, string[] handles)
    {
        Result<AnonymousCredentialNonMembershipWitness> witness =
            AnonymousCredentialRevocationAccumulator.CreateNonMembershipWitness(epoch, root, IssuerPublicKeyHash, handle, handles);
        Assert.True(witness.IsSuccess, witness.Error.Message);
        return witness.Value!;
    }

    private static string Root(long epoch, string[] handles)
    {
        Result<string> root = AnonymousCredentialRevocationAccumulator.TryComputeRoot(epoch, IssuerPublicKeyHash, handles);
        Assert.True(root.IsSuccess, root.Error.Message);
        return root.Value!;
    }

}
