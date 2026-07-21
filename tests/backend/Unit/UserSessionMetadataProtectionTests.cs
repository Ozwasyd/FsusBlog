using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

public sealed class UserSessionMetadataProtectionTests
{
    private static readonly byte[] s_firstKey = Enumerable.Range(1, 32).Select(static value => (byte)value).ToArray();
    private static readonly byte[] s_secondKey = Enumerable.Range(33, 32).Select(static value => (byte)value).ToArray();

    [Fact]
    public void Capture_StoresOnlyAccountScopedRotatingPseudonymsAndCoarseLabels()
    {
        var protector = new UserSessionMetadataProtector(new SecurityRiskPseudonymizer(7, s_firstKey));

        UserSessionMetadataSnapshot first = protector.Capture(
            42,
            "203.0.113.187",
            "Client-Supplied-Fingerprint",
            "Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/124.0 Safari/537.36");
        UserSessionMetadataSnapshot repeated = protector.Capture(
            42,
            "203.0.113.9",
            " client-supplied-fingerprint ",
            "Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/124.0 Safari/537.36");
        UserSessionMetadataSnapshot otherAccount = protector.Capture(
            43,
            "203.0.113.187",
            "Client-Supplied-Fingerprint",
            "Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/124.0 Safari/537.36");

        Assert.Equal(7, first.DeviceSignalEpoch);
        Assert.Equal(first.DeviceSignalHash, repeated.DeviceSignalHash);
        Assert.Equal(first.NetworkSignalHash, repeated.NetworkSignalHash);
        Assert.NotEqual(first.DeviceSignalHash, otherAccount.DeviceSignalHash);
        Assert.NotEqual(first.NetworkSignalHash, otherAccount.NetworkSignalHash);
        Assert.NotEqual("Client-Supplied-Fingerprint", first.DeviceSignalHash);
        Assert.NotEqual("203.0.113.187", first.NetworkSignalHash);
        Assert.Equal("Chrome / Windows / Desktop", first.DeviceLabel);
    }

    [Fact]
    public void ProtectForRead_AcceptsBoundedPreviousEpochThenExpiresIt()
    {
        DateTimeOffset now = new(2026, 7, 20, 0, 0, 0, TimeSpan.Zero);
        var oldProtector = new UserSessionMetadataProtector(new SecurityRiskPseudonymizer(1, s_firstKey));
        string oldHash = Assert.IsType<string>(oldProtector.Capture(9, null, "device-a", null).DeviceSignalHash);
        var overlapProtector = new UserSessionMetadataProtector(new SecurityRiskPseudonymizer(
            2,
            s_secondKey,
            previousEpoch: 1,
            previousKey: s_firstKey,
            previousAcceptUntilUtc: now.AddDays(7),
            timeProvider: new FixedTimeProvider(now)));
        var expiredProtector = new UserSessionMetadataProtector(new SecurityRiskPseudonymizer(
            2,
            s_secondKey,
            previousEpoch: 1,
            previousKey: s_firstKey,
            previousAcceptUntilUtc: now.AddDays(-1),
            timeProvider: new FixedTimeProvider(now)));

        Assert.Contains(overlapProtector.ProtectDeviceForRead(9, "device-a"), value => value.Epoch == 1 && value.Hash == oldHash);
        Assert.DoesNotContain(expiredProtector.ProtectDeviceForRead(9, "device-a"), value => value.Epoch == 1);
    }

    [Theory]
    [InlineData("203.0.113.187", "203.0.113.0/24")]
    [InlineData("::ffff:203.0.113.187", "203.0.113.0/24")]
    [InlineData("2001:db8:abcd:1234::1", "2001:db8:abcd::/48")]
    [InlineData("not-an-ip", null)]
    public void MinimizeNetwork_AppliesConsistentIpv4AndIpv6Prefixes(string input, string? expected)
        => Assert.Equal(expected, UserSessionMetadataProtector.MinimizeNetwork(input));

    [Theory]
    [InlineData(null, "Unknown", "Unknown", "Unknown")]
    [InlineData("", "Unknown", "Unknown", "Unknown")]
    [InlineData("Mozilla/5.0 (X11; Linux x86_64) Firefox/126.0", "Firefox", "Linux", "Desktop")]
    [InlineData("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) AppleWebKit Safari/604.1 Mobile", "Safari", "iOS", "Mobile")]
    [InlineData("Mozilla/5.0 (Linux; Android 14; Tablet) Chrome/124.0", "Chrome", "Android", "Tablet")]
    public void ParseUserAgent_ReturnsOnlyLowCardinalityFamilies(
        string? userAgent,
        string browser,
        string operatingSystem,
        string formFactor)
        => Assert.Equal(
            (browser, operatingSystem, formFactor),
            UserSessionMetadataProtector.ParseUserAgent(userAgent));

    [Fact]
    public void MissingSignals_RemainOptionalForPasskeyCompatibleLogin()
    {
        var protector = new UserSessionMetadataProtector(new SecurityRiskPseudonymizer(1, s_firstKey));

        UserSessionMetadataSnapshot snapshot = protector.Capture(42, null, null, null);

        Assert.Null(snapshot.DeviceSignalHash);
        Assert.Null(snapshot.NetworkSignalHash);
        Assert.Empty(protector.ProtectDeviceForRead(42, null));
        Assert.Empty(protector.ProtectNetworkForRead(42, null));
    }

    [Fact]
    public void PersistenceAndResponseShapes_CannotReintroduceRawSessionMetadata()
    {
        string[] forbiddenProperties = ["DeviceFingerprint", "LastIp", "UserAgent"];
        PropertyInfo[] sessionProperties = typeof(UserSession).GetProperties(BindingFlags.Public | BindingFlags.Instance);
        PropertyInfo[] responseProperties = typeof(UserSessionSummaryDto).GetProperties(BindingFlags.Public | BindingFlags.Instance);

        Assert.DoesNotContain(sessionProperties, property => forbiddenProperties.Contains(property.Name, StringComparer.Ordinal));
        Assert.DoesNotContain(responseProperties, property => forbiddenProperties.Contains(property.Name, StringComparer.Ordinal));

        AssertPersistenceUsesProtectedSnapshot(typeof(UserLoginWorkflowService));
        AssertPersistenceUsesProtectedSnapshot(typeof(AccountEnrollmentService));

        MethodBase[] sessionCommands = ReadCompiledCalls(typeof(UserSessionCommandService)).ToArray();
        Assert.DoesNotContain(
            sessionCommands,
            method => method.DeclaringType == typeof(UserSession)
                && forbiddenProperties.Any(property => method.Name == $"set_{property}"));

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            item => item.MigrationId == UserSessionMetadataMinimizationMigrationDefinitions.MigrationId);
        string migration = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));
        Assert.Contains("SET devicefingerprint = NULL", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("SET lastip = NULL", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("SET useragent = NULL", migration, StringComparison.OrdinalIgnoreCase);
    }

    private static void AssertPersistenceUsesProtectedSnapshot(Type serviceType)
    {
        MethodBase[] calls = ReadCompiledCalls(serviceType).ToArray();
        Assert.Contains(
            calls,
            static method => method.DeclaringType == typeof(IUserSessionMetadataProtector)
                && method.Name == nameof(IUserSessionMetadataProtector.Capture));
        foreach (string property in new[]
                 {
                     nameof(UserSession.DeviceSignalHash),
                     nameof(UserSession.DeviceSignalEpoch),
                     nameof(UserSession.NetworkSignalHash),
                     nameof(UserSession.NetworkSignalEpoch),
                     nameof(UserSession.BrowserFamily),
                     nameof(UserSession.OperatingSystemFamily),
                     nameof(UserSession.FormFactor)
                 })
        {
            Assert.Contains(
                calls,
                method => method.DeclaringType == typeof(UserSession) && method.Name == $"set_{property}");
        }
    }

    private static IEnumerable<MethodBase> ReadCompiledCalls(Type root)
    {
        foreach (Type type in DescendantsAndSelf(root))
        {
            foreach (MethodInfo method in type.GetMethods(
                         BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
            {
                MethodInfo runtimeMethod = method.GetCustomAttribute<AsyncStateMachineAttribute>() is { } stateMachine
                    ? stateMachine.StateMachineType.GetMethod(
                        "MoveNext",
                        BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!
                    : method;
                foreach (MethodBase called in ReadCalledMethods(runtimeMethod))
                {
                    yield return called;
                }
            }
        }
    }

    private static IEnumerable<Type> DescendantsAndSelf(Type type)
    {
        yield return type;
        foreach (Type nested in type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic))
        {
            foreach (Type descendant in DescendantsAndSelf(nested))
            {
                yield return descendant;
            }
        }
    }

    private static IEnumerable<MethodBase> ReadCalledMethods(MethodInfo method)
    {
        byte[] il = method.GetMethodBody()?.GetILAsByteArray() ?? [];
        for (int offset = 0; offset < il.Length;)
        {
            OpCode operation = ReadOpCode(il, ref offset);
            int operandOffset = offset;
            int operandSize = OperandSize(operation, il, operandOffset);
            if ((operation == OpCodes.Call || operation == OpCodes.Callvirt || operation == OpCodes.Newobj)
                && operandSize == sizeof(int))
            {
                MethodBase? called = null;
                try
                {
                    called = method.Module.ResolveMethod(
                        BitConverter.ToInt32(il, operandOffset),
                        method.DeclaringType?.GetGenericArguments(),
                        method.GetGenericArguments());
                }
                catch (ArgumentException)
                {
                    // An unresolved generic token is irrelevant to the persistence boundary assertions.
                }

                if (called is not null)
                {
                    yield return called;
                }
            }

            offset += operandSize;
        }
    }

    private static OpCode ReadOpCode(byte[] il, ref int offset)
    {
        byte first = il[offset++];
        if (first != 0xFE)
        {
            return s_singleByteOpCodes[first];
        }

        return s_multiByteOpCodes[il[offset++]];
    }

    private static int OperandSize(OpCode operation, byte[] il, int operandOffset)
        => operation.OperandType switch
        {
            OperandType.InlineNone => 0,
            OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
            OperandType.InlineVar => 2,
            OperandType.InlineI or OperandType.InlineBrTarget or OperandType.InlineField
                or OperandType.InlineMethod or OperandType.InlineSig or OperandType.InlineString
                or OperandType.InlineTok or OperandType.InlineType or OperandType.ShortInlineR => 4,
            OperandType.InlineI8 or OperandType.InlineR => 8,
            OperandType.InlineSwitch => 4 + (BitConverter.ToInt32(il, operandOffset) * 4),
            _ => throw new InvalidOperationException($"Unsupported IL operand type: {operation.OperandType}")
        };

    private static readonly OpCode[] s_singleByteOpCodes = BuildOpCodeTable(multiByte: false);
    private static readonly OpCode[] s_multiByteOpCodes = BuildOpCodeTable(multiByte: true);

    private static OpCode[] BuildOpCodeTable(bool multiByte)
    {
        var result = new OpCode[256];
        foreach (FieldInfo field in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static))
        {
            var operation = (OpCode)field.GetValue(null)!;
            ushort value = unchecked((ushort)operation.Value);
            if ((value > byte.MaxValue) == multiByte)
            {
                result[value & byte.MaxValue] = operation;
            }
        }

        return result;
    }

    private sealed class FixedTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}
