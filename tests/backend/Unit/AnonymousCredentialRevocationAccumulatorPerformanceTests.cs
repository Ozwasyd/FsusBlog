using System.Runtime.CompilerServices;
using FsusBlog.Core.Common;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCredentialRevocationAccumulatorPerformanceTests
{
    private static readonly string IssuerPublicKeyHash = new('f', 64);

    [Fact]
    public void CircuitFriendlyRoot_UsesEpochScopedCacheAndBinarySearchNeighbors()
    {
        string source = ReadRepoFile("src/backend/Services/Security/AnonymousCredentialRevocationAccumulator.cs");
        string resolveNeighbors = ExtractMethodBlock(source, "private static (string Previous, string Next) ResolveNeighbors");

        Assert.Contains("ConcurrentDictionary<CircuitFriendlyTreeCacheKey", source, StringComparison.Ordinal);
        Assert.Contains("GetOrBuildCircuitFriendlySparseTree", source, StringComparison.Ordinal);
        Assert.Contains("TryEvictCircuitFriendlyTreeCacheEpoch", source, StringComparison.Ordinal);
        Assert.Contains("CircuitFriendlyRootCacheMaxEntries", source, StringComparison.Ordinal);
        Assert.Contains("ClearCircuitFriendlyRootCacheForTests", source, StringComparison.Ordinal);
        Assert.Contains("Array.BinarySearch", resolveNeighbors, StringComparison.Ordinal);
        Assert.Contains("~index", resolveNeighbors, StringComparison.Ordinal);
        Assert.DoesNotContain("foreach (string current in sortedHandles)", resolveNeighbors, StringComparison.Ordinal);
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

    private static string ReadRepoFile(string relativePath, [CallerFilePath] string sourceFile = "")
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static string ExtractMethodBlock(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing method signature: {signature}");
        int brace = source.IndexOf('{', start);
        Assert.True(brace >= 0, $"Missing method body: {signature}");
        int depth = 0;
        for (int index = brace; index < source.Length; index++)
        {
            if (source[index] == '{')
            {
                depth++;
            }
            else if (source[index] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return source[start..(index + 1)];
                }
            }
        }

        throw new InvalidOperationException($"Could not extract method block: {signature}");
    }
}
