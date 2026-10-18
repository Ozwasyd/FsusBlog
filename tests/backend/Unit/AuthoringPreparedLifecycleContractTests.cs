using System.Collections.Immutable;
using System.Reflection;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

/// <summary>Cross-owner signature compatibility only; no fake runtime or approval issuer.</summary>
public sealed class AuthoringPreparedLifecycleContractTests
{
    [Fact]
    public void ResourcePort_PreservesLegacyAuthorityAndRequiresTypedSnapshotHandoff()
    {
        Type contract = typeof(IAuthoringFencedLifecycleResourceAuthorityV1);
        Assert.True(typeof(IAuthoringLifecycleResourceAuthority).IsAssignableFrom(contract));
        MethodInfo prepare = Assert.Single(contract.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly));
        Assert.Equal(nameof(IAuthoringFencedLifecycleResourceAuthorityV1.PrepareAsync), prepare.Name);
        Assert.Equal(typeof(ValueTask<IAuthoringPreparedLifecycleGenerationV1>), prepare.ReturnType);
        Assert.Equal(
            [typeof(VerifiedAuthoringPackage), typeof(ImmutableArray<AuthoringExecutionTarget>),
                typeof(AuthoringStateSnapshot), typeof(long), typeof(CancellationToken)],
            prepare.GetParameters().Select(static parameter => parameter.ParameterType));
        Assert.True(prepare.IsAbstract);
    }

    [Fact]
    public void PreparedLifetime_RequiresCurrentVerificationExactReceiptPublicationAndAbortReport()
    {
        Type contract = typeof(IAuthoringPreparedLifecycleGenerationV1);
        Assert.True(typeof(IAsyncDisposable).IsAssignableFrom(contract));
        Assert.Equal(3, contract.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly).Length);
        AssertSignature(contract, nameof(IAuthoringPreparedLifecycleGenerationV1.VerifyCurrentAsync),
            typeof(ValueTask), typeof(CancellationToken));
        AssertSignature(contract, nameof(IAuthoringPreparedLifecycleGenerationV1.PublishAsync),
            typeof(ValueTask), typeof(AuthoringLifecycleReceipt), typeof(CancellationToken));
        AssertSignature(contract, nameof(IAuthoringPreparedLifecycleGenerationV1.AbortAsync),
            typeof(ValueTask<AuthoringLifecycleResourceReport>), typeof(CancellationToken));
    }

    private static void AssertSignature(Type contract, string name, Type result, params Type[] parameters)
    {
        MethodInfo method = Assert.IsAssignableFrom<MethodInfo>(contract.GetMethod(name));
        Assert.Equal(result, method.ReturnType);
        Assert.Equal(parameters, method.GetParameters().Select(static parameter => parameter.ParameterType));
        Assert.True(method.IsAbstract);
    }
}
