using System.Linq.Expressions;
using System.Reflection;
using System.Reflection.Emit;

using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.ArticleVault;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class PublicHotReadDbAdmissionTests
{
    private static readonly IReadOnlyDictionary<ushort, OpCode> s_opCodes = typeof(OpCodes)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where(static field => field.FieldType == typeof(OpCode))
        .Select(static field => (OpCode)field.GetValue(null)!)
        .GroupBy(static opCode => unchecked((ushort)opCode.Value))
        .ToDictionary(static group => group.Key, static group => group.First());

    [Theory]
    [InlineData("public-hot-read-delta")]
    [InlineData("public-hot-read-view-delta")]
    [InlineData("public-hot-read-taxonomy-delta")]
    [InlineData("public-hot-read-rebuild")]
    [InlineData("public-hot-read-refresh")]
    [InlineData("public-article-projection-build")]
    public void BackgroundRefreshOperations_ClassifyAsBackgroundProjection(string operation)
    {
        Assert.Equal(DbWorkloadClass.BackgroundProjection, DbConcurrencyGate.Classify(operation));
        Assert.NotEqual(DbWorkloadClass.PublicShortRead, DbConcurrencyGate.Classify(operation));
    }

    [Theory]
    [InlineData("article-detail")]
    [InlineData("article-list")]
    [InlineData("article-hot-seed")]
    public void PublicServingOperations_ClassifyAsPublicShortRead(string operation)
    {
        Assert.Equal(DbWorkloadClass.PublicShortRead, DbConcurrencyGate.Classify(operation));
    }

    [Theory]
    [InlineData("article-vault-write")]
    [InlineData("article-publication-write")]
    public void WriteOperations_ClassifyAsForegroundWrite(string operation)
    {
        Assert.Equal(DbWorkloadClass.ForegroundWrite, DbConcurrencyGate.Classify(operation));
    }

    [Fact]
    public async Task SaturatedPublicShortRead_DoesNotAdmitUngatedArticleDetailDbLoad()
    {
        DbConcurrencyGate gate = CreateClassifiedGate(publicShortReadLimit: 1, publicQueueLimit: 1, publicWaitMs: 50);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int projectionDbReads = 0;
        int detailDbLoads = 0;

        Task<string> holder = gate.ExecuteClassifiedAsync(
            DbWorkloadClass.PublicShortRead,
            "public-article-projection-read",
            async _ =>
            {
                entered.TrySetResult();
                await release.Task;
                return "held";
            },
            _ => Task.FromResult("holder-timeout"));
        await entered.Task;

        string projection = await gate.ExecuteClassifiedAsync(
            DbWorkloadClass.PublicShortRead,
            "public-article-projection-read",
            _ =>
            {
                Interlocked.Increment(ref projectionDbReads);
                return Task.FromResult("projection-db");
            },
            _ => Task.FromResult("db-gate-timeout"));
        string detail = await gate.ExecuteAsync(
            "article-detail",
            _ =>
            {
                Interlocked.Increment(ref detailDbLoads);
                return Task.FromResult("detail-db");
            },
            _ => Task.FromResult("db-gate-timeout"));
        string delta = await gate.ExecuteAsync(
            "public-hot-read-delta",
            _ => Task.FromResult("delta"),
            _ => Task.FromResult("delta-timeout"));

        Assert.Equal("db-gate-timeout", projection);
        Assert.Equal("db-gate-timeout", detail);
        Assert.Equal(0, projectionDbReads);
        Assert.Equal(0, detailDbLoads);
        Assert.Equal("delta", delta);

        release.TrySetResult();
        Assert.Equal("held", await holder);
    }

    [Fact]
    public async Task SaturatedForegroundWrite_RejectsVaultAndPublicationWritesWithoutDbWork()
    {
        DbConcurrencyGate gate = CreateClassifiedGate(publicShortReadLimit: 1, publicQueueLimit: 1, publicWaitMs: 50);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int vaultDbWork = 0;
        int publicationDbWork = 0;

        Task<string> holder = gate.ExecuteClassifiedAsync(
            DbWorkloadClass.ForegroundWrite,
            "article-vault-write",
            async _ =>
            {
                entered.TrySetResult();
                await release.Task;
                return "held";
            },
            _ => Task.FromResult("holder-timeout"));
        await entered.Task;

        await Assert.ThrowsAsync<TimeoutException>(() =>
            gate.ExecuteClassifiedAsync(
                DbWorkloadClass.ForegroundWrite,
                "article-vault-write",
                _ =>
                {
                    Interlocked.Increment(ref vaultDbWork);
                    return Task.FromResult("vault-db");
                },
                _ => Task.FromException<string>(new TimeoutException("db-gate-timeout:article-vault-write"))));
        await Assert.ThrowsAsync<TimeoutException>(() =>
            gate.ExecuteClassifiedAsync(
                DbWorkloadClass.ForegroundWrite,
                "article-publication-write",
                _ =>
                {
                    Interlocked.Increment(ref publicationDbWork);
                    return Task.FromResult("publication-db");
                },
                _ => Task.FromException<string>(new TimeoutException("db-gate-timeout:article-publication-write"))));

        Assert.Equal(0, vaultDbWork);
        Assert.Equal(0, publicationDbWork);

        release.TrySetResult();
        Assert.Equal("held", await holder);
    }

    [Fact]
    public void PublicDetailFallback_IsGatedAndLeavesNoUngatedCompatPath()
    {
        string getById = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleService),
            nameof(ArticleService.GetByIdAsync),
            "LoadArticleDetailFromDbAsync",
            "TryReadArticleDetailCacheAsync");
        MethodInfo artifactMethod = GetEndpointMethod(nameof(IArticleEndpointService.GetPublicArtifactBackedDetailAsync));
        MethodInfo fallbackMethod = GetEndpointMethod(nameof(IArticleEndpointService.GetByIdAsync));
        IReadOnlyList<MethodInstruction> detailInstructions = Assert.Single(
            EnumerateDeclaredMethods(typeof(BinaryEndpoints))
                .Select(ReadMethodInstructions),
            instructions => instructions.Any(instruction => IsCallTo(instruction, artifactMethod))
                && instructions.Any(instruction => IsCallTo(instruction, fallbackMethod)));
        IReadOnlyList<string> detailReferences = RuntimeMetadataInspection.DescribeDeclaredMemberReferencesInOrderContaining(
            typeof(BinaryEndpoints),
            nameof(IArticleEndpointService.GetPublicArtifactBackedDetailAsync),
            nameof(IArticleEndpointService.GetByIdAsync));
        string binaryArticles = string.Join('\n', detailReferences);
        string vaultWriter = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleService),
            typeof(ArticleService).GetInterfaceMap(typeof(IArticleVaultCanonicalGroupWriter)).TargetMethods.Single().Name);
        string vaultTransaction = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleService),
            "ExecuteArticleMutationTransactionAsync",
            "ExecuteForegroundWriteAsync");
        MethodInfo gateMethod = Assert.IsAssignableFrom<MethodInfo>(typeof(ArticleService).GetMethod(
            "ExecuteForegroundWriteAsync",
            BindingFlags.Instance | BindingFlags.NonPublic));

        Assert.Contains("IDbConcurrencyGate.ExecuteAsync", getById, StringComparison.Ordinal);
        Assert.Contains("article-detail", getById, StringComparison.Ordinal);
        Assert.Contains("db-gate-timeout:article-detail", getById, StringComparison.Ordinal);
        Assert.Contains("LoadArticleDetailFromDbAsync", getById, StringComparison.Ordinal);
        Assert.DoesNotContain("compat", getById, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("ungated", getById, StringComparison.OrdinalIgnoreCase);

        Assert.Contains("GetPublicArtifactBackedDetailAsync", binaryArticles, StringComparison.Ordinal);
        Assert.Contains("GetByIdAsync", binaryArticles, StringComparison.Ordinal);
        // Linear IL order establishes this body shape, not every branch or argument dataflow.
        Assert.True(
            HasArtifactBeforeFallback(detailInstructions),
            "The compiled article route must try the public artifact before its database fallback.");
        Assert.DoesNotContain("compat", binaryArticles, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("LoadArticleDetailFromDbAsync", binaryArticles, StringComparison.Ordinal);

        Assert.Contains("ExecuteForegroundWriteAsync", vaultWriter, StringComparison.Ordinal);
        Assert.Contains("article-vault-write", vaultWriter, StringComparison.Ordinal);
        Assert.Contains("UseTranAsync", vaultWriter, StringComparison.Ordinal);
        Assert.Contains("ExecuteClassifiedAsync", vaultTransaction, StringComparison.Ordinal);
        Assert.Contains(
            (int)DbWorkloadClass.ForegroundWrite,
            RuntimeMetadataInspection.DescribeInt32Constants(gateMethod));
        Assert.Contains("article-publication-write", vaultTransaction, StringComparison.Ordinal);
        Assert.Contains("UseTranAsync", vaultTransaction, StringComparison.Ordinal);
        Assert.DoesNotContain("compat", vaultWriter, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("compat", vaultTransaction, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void PublicDetailCallOrder_RejectsNonCallsForeignMembersAndReversedCalls()
    {
        MethodInfo artifactMethod = GetEndpointMethod(nameof(IArticleEndpointService.GetPublicArtifactBackedDetailAsync));
        MethodInfo fallbackMethod = GetEndpointMethod(nameof(IArticleEndpointService.GetByIdAsync));
        IReadOnlyList<MethodInstruction> references = ReadFixtureInstructions(nameof(ReferenceOnlyDetailMethods));
        Assert.Contains(references, instruction => SameMethod(instruction.Method, artifactMethod)
            && !IsCall(instruction.OpCode));
        Assert.Contains(references, instruction => SameMethod(instruction.Method, fallbackMethod)
            && !IsCall(instruction.OpCode));
        Assert.DoesNotContain(references, instruction => IsCallTo(instruction, artifactMethod)
            || IsCallTo(instruction, fallbackMethod));
        Assert.False(HasArtifactBeforeFallback(references));

        IReadOnlyList<MethodInstruction> tokens = ReadFixtureInstructions(nameof(ReferenceOnlyDetailMethodTokens));
        Assert.Contains(tokens, instruction => SameMethod(instruction.Method, artifactMethod)
            && instruction.OpCode == OpCodes.Ldtoken);
        Assert.Contains(tokens, instruction => SameMethod(instruction.Method, fallbackMethod)
            && instruction.OpCode == OpCodes.Ldtoken);
        Assert.DoesNotContain(tokens, instruction => IsCallTo(instruction, artifactMethod)
            || IsCallTo(instruction, fallbackMethod));
        Assert.False(HasArtifactBeforeFallback(tokens));

        IReadOnlyList<MethodInstruction> foreign = ReadFixtureInstructions(nameof(CallForeignDetailMethods));
        MethodInstruction foreignArtifact = Assert.Single(foreign, instruction => IsCall(instruction.OpCode)
            && instruction.Method.Name == artifactMethod.Name);
        MethodInstruction foreignFallback = Assert.Single(foreign, instruction => IsCall(instruction.OpCode)
            && instruction.Method.Name == fallbackMethod.Name);
        Assert.Equal(typeof(ForeignDetailMethods), foreignArtifact.Method.DeclaringType);
        Assert.Equal(typeof(ForeignDetailMethods), foreignFallback.Method.DeclaringType);
        Assert.True(foreignArtifact.Offset < foreignFallback.Offset);
        Assert.False(HasArtifactBeforeFallback(foreign));

        IReadOnlyList<MethodInstruction> reversed = ReadFixtureInstructions(nameof(CallFallbackBeforeArtifact));
        MethodInstruction reversedArtifact = Assert.Single(reversed, instruction => IsCallTo(instruction, artifactMethod));
        MethodInstruction reversedFallback = Assert.Single(reversed, instruction => IsCallTo(instruction, fallbackMethod));
        Assert.True(reversedFallback.Offset < reversedArtifact.Offset);
        Assert.False(HasArtifactBeforeFallback(reversed));
    }

    [Fact]
    public void PublicDetailCallOrder_AcceptsActualInterfaceCallsWithUnrelatedInstructions()
    {
        MethodInfo artifactMethod = GetEndpointMethod(nameof(IArticleEndpointService.GetPublicArtifactBackedDetailAsync));
        MethodInfo fallbackMethod = GetEndpointMethod(nameof(IArticleEndpointService.GetByIdAsync));
        IReadOnlyList<MethodInstruction> instructions = ReadFixtureInstructions(nameof(CallArtifactBeforeFallback));
        MethodInstruction artifact = Assert.Single(instructions, instruction => IsCallTo(instruction, artifactMethod));
        MethodInstruction fallback = Assert.Single(instructions, instruction => IsCallTo(instruction, fallbackMethod));
        Assert.True(artifact.Offset < fallback.Offset);
        Assert.Contains(instructions, static instruction => instruction.Method.DeclaringType == typeof(GC));
        Assert.True(HasArtifactBeforeFallback(instructions));
    }

    private static bool HasArtifactBeforeFallback(IReadOnlyList<MethodInstruction> instructions)
    {
        MethodInfo artifactMethod = GetEndpointMethod(nameof(IArticleEndpointService.GetPublicArtifactBackedDetailAsync));
        MethodInfo fallbackMethod = GetEndpointMethod(nameof(IArticleEndpointService.GetByIdAsync));
        MethodInstruction? artifact = instructions.FirstOrDefault(instruction => IsCallTo(instruction, artifactMethod));
        MethodInstruction? fallback = instructions.FirstOrDefault(instruction => IsCallTo(instruction, fallbackMethod));
        return artifact is not null && fallback is not null && artifact.Offset < fallback.Offset;
    }

    private static bool IsCallTo(MethodInstruction instruction, MethodInfo method)
        => IsCall(instruction.OpCode) && SameMethod(instruction.Method, method);

    private static bool IsCall(OpCode opCode)
        => opCode == OpCodes.Call || opCode == OpCodes.Callvirt;

    private static bool SameMethod(MethodInfo actual, MethodInfo expected)
        => actual.Module == expected.Module
            && actual.MetadataToken == expected.MetadataToken
            && actual.DeclaringType == expected.DeclaringType;

    private static MethodInfo GetEndpointMethod(string name)
        => Assert.IsAssignableFrom<MethodInfo>(typeof(IArticleEndpointService).GetMethod(name));

    private static IReadOnlyList<MethodInstruction> ReadFixtureInstructions(string name)
        => ReadMethodInstructions(Assert.IsAssignableFrom<MethodInfo>(typeof(PublicHotReadDbAdmissionTests).GetMethod(
            name,
            BindingFlags.Static | BindingFlags.NonPublic)));

    private static IEnumerable<MethodInfo> EnumerateDeclaredMethods(Type type)
    {
        foreach (MethodInfo method in type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic
            | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly))
        {
            yield return method;
        }
        foreach (Type nested in type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic))
        {
            foreach (MethodInfo method in EnumerateDeclaredMethods(nested))
            {
                yield return method;
            }
        }
    }

    private static IReadOnlyList<MethodInstruction> ReadMethodInstructions(MethodInfo method)
    {
        byte[]? il = method.GetMethodBody()?.GetILAsByteArray();
        if (il is null)
        {
            return [];
        }

        Type[] typeArguments = method.DeclaringType?.IsGenericType == true
            ? method.DeclaringType.GetGenericArguments()
            : Type.EmptyTypes;
        Type[] methodArguments = method.IsGenericMethod ? method.GetGenericArguments() : Type.EmptyTypes;
        var instructions = new List<MethodInstruction>();
        for (int offset = 0; offset < il.Length;)
        {
            int instructionOffset = offset;
            ushort value = il[offset++];
            if (value == 0xfe)
            {
                Assert.True(offset < il.Length);
                value = (ushort)(0xfe00 | il[offset++]);
            }
            Assert.True(s_opCodes.TryGetValue(value, out OpCode opCode));
            int operandOffset = offset;
            int operandSize = opCode.OperandType switch
            {
                OperandType.InlineNone => 0,
                OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
                OperandType.InlineVar => 2,
                OperandType.InlineBrTarget or OperandType.InlineField or OperandType.InlineI or OperandType.InlineMethod
                    or OperandType.InlineSig or OperandType.InlineString or OperandType.InlineTok or OperandType.InlineType
                    or OperandType.ShortInlineR => 4,
                OperandType.InlineI8 or OperandType.InlineR => 8,
                OperandType.InlineSwitch when operandOffset + 4 <= il.Length
                    => checked(4 + (BitConverter.ToInt32(il, operandOffset) * 4)),
                _ => -1
            };
            Assert.True(operandSize >= 0 && operandOffset + operandSize <= il.Length);
            if (opCode.OperandType is OperandType.InlineMethod or OperandType.InlineTok)
            {
                MemberInfo? member = method.Module.ResolveMember(
                    BitConverter.ToInt32(il, operandOffset),
                    typeArguments,
                    methodArguments);
                if (member is MethodInfo referencedMethod)
                {
                    instructions.Add(new MethodInstruction(instructionOffset, opCode, referencedMethod));
                }
            }
            offset += operandSize;
        }

        return instructions;
    }

    private static void ReferenceOnlyDetailMethods(IArticleEndpointService articles)
    {
        var artifact = articles.GetPublicArtifactBackedDetailAsync;
        var fallback = articles.GetByIdAsync;
        GC.KeepAlive(artifact);
        GC.KeepAlive(fallback);
    }

    private static void CallForeignDetailMethods()
    {
        ForeignDetailMethods.GetPublicArtifactBackedDetailAsync();
        ForeignDetailMethods.GetByIdAsync();
    }

    private static void ReferenceOnlyDetailMethodTokens()
    {
        Expression<Action<IArticleEndpointService>> artifact = articles => GC.KeepAlive(
            articles.GetPublicArtifactBackedDetailAsync(1, CancellationToken.None));
        Expression<Action<IArticleEndpointService>> fallback = articles => GC.KeepAlive(
            articles.GetByIdAsync(1, false, CancellationToken.None));
        GC.KeepAlive(artifact);
        GC.KeepAlive(fallback);
    }

    private static void CallFallbackBeforeArtifact(IArticleEndpointService articles)
    {
        GC.KeepAlive(articles.GetByIdAsync(1, false, CancellationToken.None));
        GC.KeepAlive(articles.GetPublicArtifactBackedDetailAsync(1, CancellationToken.None));
    }

    private static void CallArtifactBeforeFallback(IArticleEndpointService articles)
    {
        GC.KeepAlive(articles.GetPublicArtifactBackedDetailAsync(1, CancellationToken.None));
        GC.KeepAlive(typeof(IArticleEndpointService));
        GC.KeepAlive(articles.GetByIdAsync(1, false, CancellationToken.None));
    }

    private sealed record MethodInstruction(int Offset, OpCode OpCode, MethodInfo Method);

    private static class ForeignDetailMethods
    {
        public static void GetPublicArtifactBackedDetailAsync()
        {
        }

        public static void GetByIdAsync()
        {
        }
    }

    private static DbConcurrencyGate CreateClassifiedGate(int publicShortReadLimit, int publicQueueLimit, int publicWaitMs)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:DefaultConnection"] = "Host=localhost;Database=fsus;Username=fsus;Password=fsus;Maximum Pool Size=4",
                ["Database:PublicArticleProjection:MaxPoolSize"] = "1",
                ["Database:ConcurrencyGate:PublicShortRead:Limit"] = publicShortReadLimit.ToString(),
                ["Database:ConcurrencyGate:PublicShortRead:QueueLimit"] = publicQueueLimit.ToString(),
                ["Database:ConcurrencyGate:PublicShortRead:WaitTimeoutMs"] = publicWaitMs.ToString(),
                ["Database:ConcurrencyGate:AdminHeavyRead:Limit"] = "1",
                ["Database:ConcurrencyGate:ForegroundWrite:Limit"] = "1",
                ["Database:ConcurrencyGate:ForegroundWrite:QueueLimit"] = "1",
                ["Database:ConcurrencyGate:ForegroundWrite:WaitTimeoutMs"] = publicWaitMs.ToString(),
                ["Database:ConcurrencyGate:BackgroundProjection:Limit"] = "1"
            })
            .Build();
        return new DbConcurrencyGate(configuration, NullLogger<DbConcurrencyGate>.Instance);
    }
}
