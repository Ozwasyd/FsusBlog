using System.Reflection;

using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Tests;

public sealed class RoundingConsistencyTests
{
    [Fact]
    public void Round2_UsesAwayFromZeroAtMidpoint()
    {
        Assert.Equal(1.13d, RoundingHelper.Round2(1.125d));
        Assert.Equal(-1.13d, RoundingHelper.Round2(-1.125d));
    }

    [Fact]
    public void ProductionMathRoundCalls_UseExplicitMidpointMode()
    {
        MethodInfo[] callers = typeof(RoundingHelper).Assembly
            .GetTypes()
            .SelectMany(static type => type.GetMethods(
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance))
            .ToArray();
        var roundCalls = new List<(MethodInfo Caller, MethodBase Callee)>();
        foreach (MethodInfo caller in callers)
        {
            foreach (MethodBase callee in ReadCalledMethods(caller))
            {
                if (callee.DeclaringType == typeof(Math) && callee.Name == nameof(Math.Round))
                {
                    roundCalls.Add((caller, callee));
                }
            }
        }

        Assert.NotEmpty(roundCalls);
        Assert.All(roundCalls, static call => Assert.Contains(
            call.Callee.GetParameters(),
            static parameter => parameter.ParameterType == typeof(MidpointRounding)));
    }

    private static IEnumerable<MethodBase> ReadCalledMethods(MethodInfo method)
    {
        byte[]? il = method.GetMethodBody()?.GetILAsByteArray();
        if (il is null)
        {
            yield break;
        }

        for (int offset = 0; offset <= il.Length - 5; offset++)
        {
            if (il[offset] is not (0x28 or 0x6F))
            {
                continue;
            }

            MethodBase? called = null;
            try
            {
                called = method.Module.ResolveMethod(
                    BitConverter.ToInt32(il, offset + 1),
                    method.DeclaringType?.GetGenericArguments(),
                    method.GetGenericArguments());
            }
            catch (ArgumentException)
            {
            }

            if (called is not null)
            {
                yield return called;
            }
        }
    }
}
