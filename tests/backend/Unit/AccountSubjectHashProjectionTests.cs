using System.Reflection;
using System.Reflection.Emit;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AccountSubjectHashProjectionTests
{
    private const string PersistedSubjectHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    [Fact]
    public void AccountSnapshot_UsesPhysicalProjectionWithoutRehashingMutableHandles()
    {
        var user = new User
        {
            Id = 42,
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            PublicHandle = "first-handle",
            PasskeyUserHandle = "first-passkey-handle",
            AccountSubjectHash = PersistedSubjectHash
        };

        var before = UserAccountReader.ToAccountSnapshot(user);
        user.PublicHandle = "second-handle";
        user.PasskeyUserHandle = "second-passkey-handle";
        var after = UserAccountReader.ToAccountSnapshot(user);

        Assert.Equal(PersistedSubjectHash, before.AccountSubjectHash);
        Assert.Equal(before.AccountSubjectHash, after.AccountSubjectHash);
        Assert.NotEqual(AccountSubjectHasher.Create(user), after.AccountSubjectHash);
    }

    [Fact]
    public void UserEntity_MapsRollingCompatiblePhysicalColumn()
    {
        var property = typeof(User).GetProperty(nameof(User.AccountSubjectHash));
        Assert.NotNull(property);
        SugarColumn? column = Assert.Single(
            property!.GetCustomAttributes(typeof(SugarColumn), inherit: false).Cast<SugarColumn>());

        Assert.Equal("account_subject_hash", column.ColumnName);
        Assert.Equal(AccountSubjectHashRequirement.Sha256HexLength, column.Length);
        Assert.True(column.IsNullable);
    }

    [Fact]
    public void CacheProjection_RuntimePathVersionsNamespaceAndRejectsMissingField()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(UserAccountReader),
            "GetAccountByIdAsync",
            "BuildSnapshotIdentity",
            "ToAccountSnapshot");

        Assert.Contains("account:subject-v1:", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("AccountSubjectHashRequirement.TryResolve", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("User.get_AccountSubjectHash", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("AccountSubjectHasher.Create", runtimeShape, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("abc")]
    [InlineData("gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg")]
    public void Requirement_RejectsMissingOrMalformedProjection(string? value)
    {
        Assert.False(AccountSubjectHashRequirement.TryResolve(value, out _));
    }

    [Fact]
    public void Requirement_NormalizesValidUppercaseProjection()
    {
        string uppercase = new string('A', AccountSubjectHashRequirement.Sha256HexLength);

        Assert.True(AccountSubjectHashRequirement.TryResolve(uppercase, out string normalized));
        Assert.Equal(new string('a', AccountSubjectHashRequirement.Sha256HexLength), normalized);
    }
}

internal static class RuntimeMetadataInspection
{
    private static readonly IReadOnlyDictionary<ushort, OpCode> OpCodesByValue = typeof(OpCodes)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where(static field => field.FieldType == typeof(OpCode))
        .Select(static field => (OpCode)field.GetValue(null)!)
        .GroupBy(static opCode => unchecked((ushort)opCode.Value))
        .ToDictionary(static group => group.Key, static group => group.First());

    public static string DescribeType(Type type)
        => Describe(type, type
            .GetMethods(AllDeclaredMembers)
            .Cast<MethodBase>(), followCallsWithinType: true);

    public static string DescribeMethods(Type type, params string[] methodNames)
    {
        HashSet<string> requested = methodNames.ToHashSet(StringComparer.Ordinal);
        MethodBase[] roots = type
            .GetMethods(AllDeclaredMembers)
            .Where(method => requested.Contains(method.Name))
            .Cast<MethodBase>()
            .ToArray();
        Assert.Equal(requested.Count, roots.Select(static method => method.Name).Distinct(StringComparer.Ordinal).Count());
        return Describe(type, roots, followCallsWithinType: true);
    }

    public static string DescribeMethodClosureContaining(Type type, params string[] requiredFacts)
    {
        string[] candidates = EnumerateTypeTree(type)
            .SelectMany(static candidate => candidate.GetMethods(AllDeclaredMembers))
            .Select(method => Describe(type, [method], followCallsWithinType: true))
            .Where(shape => requiredFacts.All(fact => shape.Contains(fact, StringComparison.Ordinal)))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        Assert.NotEmpty(candidates);
        return string.Join('\n', candidates);
    }

    public static string DescribeDeclaredMethodContaining(Type type, params string[] requiredFacts)
    {
        string[] candidates = EnumerateTypeTree(type)
            .SelectMany(static candidate => candidate.GetMethods(AllDeclaredMembers))
            .Select(method => Describe(type, [method], followCallsWithinType: false))
            .Where(shape => requiredFacts.All(fact => shape.Contains(fact, StringComparison.Ordinal)))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        Assert.NotEmpty(candidates);
        return string.Join('\n', candidates);
    }

    public static IReadOnlyList<string> DescribeDeclaredMemberReferencesInOrderContaining(
        Type type,
        params string[] requiredFacts)
    {
        IReadOnlyList<IReadOnlyList<string>> candidates = DescribeDeclaredMemberReferenceSequencesContaining(
            type,
            requiredFacts);
        return Assert.Single(candidates);
    }

    public static IReadOnlyList<IReadOnlyList<string>> DescribeDeclaredMemberReferenceSequencesContaining(
        Type type,
        params string[] requiredFacts)
    {
        string[][] candidates = EnumerateTypeTree(type)
            .SelectMany(static candidate => candidate.GetMethods(AllDeclaredMembers))
            .Select(DescribeMemberReferencesInOrder)
            .Where(references => requiredFacts.All(fact => references.Any(
                reference => reference.Contains(fact, StringComparison.Ordinal))))
            .ToArray();
        Assert.NotEmpty(candidates);
        return candidates;
    }

    public static string DescribeDeclaredMethodBodiesContaining(Type type, params string[] requiredFacts)
    {
        string[] candidates = EnumerateTypeTree(type)
            .SelectMany(static candidate => candidate.GetMethods(AllDeclaredMembers))
            .Select(DescribeMethodBodyFacts)
            .Where(facts => requiredFacts.All(fact => facts.Contains(fact, StringComparison.Ordinal)))
            .ToArray();
        Assert.NotEmpty(candidates);
        return string.Join('\n', candidates);
    }

    public static IReadOnlyList<string> DescribeOpCodes(MethodBase method)
    {
        MethodBody body = Assert.IsType<MethodBody>(method.GetMethodBody());
        byte[] il = Assert.IsType<byte[]>(body.GetILAsByteArray());
        var opCodes = new List<string>();
        for (int offset = 0; offset < il.Length;)
        {
            OpCode opCode = ReadOpCode(il, ref offset);
            opCodes.Add(opCode.Name ?? opCode.Value.ToString(System.Globalization.CultureInfo.InvariantCulture));
            int operandSize = OperandSize(opCode.OperandType, il, offset);
            Assert.True(operandSize >= 0 && offset + operandSize <= il.Length);
            offset += operandSize;
        }

        return opCodes;
    }

    public static IReadOnlyList<int> DescribeInt32Constants(MethodBase method)
    {
        MethodBody body = Assert.IsType<MethodBody>(method.GetMethodBody());
        byte[] il = Assert.IsType<byte[]>(body.GetILAsByteArray());
        var values = new List<int>();
        for (int offset = 0; offset < il.Length;)
        {
            OpCode opCode = ReadOpCode(il, ref offset);
            int operandOffset = offset;
            int operandSize = OperandSize(opCode.OperandType, il, operandOffset);
            Assert.True(operandSize >= 0 && operandOffset + operandSize <= il.Length);
            if (opCode == System.Reflection.Emit.OpCodes.Ldc_I4_M1)
            {
                values.Add(-1);
            }
            else if (opCode == System.Reflection.Emit.OpCodes.Ldc_I4_0)
            {
                values.Add(0);
            }
            else if (opCode == System.Reflection.Emit.OpCodes.Ldc_I4_1)
            {
                values.Add(1);
            }
            else if (opCode == System.Reflection.Emit.OpCodes.Ldc_I4_2)
            {
                values.Add(2);
            }
            else if (opCode == System.Reflection.Emit.OpCodes.Ldc_I4_3)
            {
                values.Add(3);
            }
            else if (opCode == System.Reflection.Emit.OpCodes.Ldc_I4_4)
            {
                values.Add(4);
            }
            else if (opCode == System.Reflection.Emit.OpCodes.Ldc_I4_5)
            {
                values.Add(5);
            }
            else if (opCode == System.Reflection.Emit.OpCodes.Ldc_I4_6)
            {
                values.Add(6);
            }
            else if (opCode == System.Reflection.Emit.OpCodes.Ldc_I4_7)
            {
                values.Add(7);
            }
            else if (opCode == System.Reflection.Emit.OpCodes.Ldc_I4_8)
            {
                values.Add(8);
            }
            else if (opCode == System.Reflection.Emit.OpCodes.Ldc_I4_S)
            {
                values.Add(unchecked((sbyte)il[operandOffset]));
            }
            else if (opCode == System.Reflection.Emit.OpCodes.Ldc_I4)
            {
                values.Add(BitConverter.ToInt32(il, operandOffset));
            }

            offset += operandSize;
        }

        return values;
    }

    public static IReadOnlyList<string> FindMethodsWithLiteralAndMember(
        Assembly assembly,
        Func<string, bool> literalPredicate,
        Func<MemberInfo, bool> memberPredicate)
    {
        var violations = new List<string>();
        foreach (TypeInfo type in assembly.DefinedTypes)
        {
            foreach (MethodBase method in type.GetMethods(AllDeclaredMembers).Cast<MethodBase>()
                         .Concat(type.GetConstructors(AllDeclaredMembers)))
            {
                MethodBody? body = method.GetMethodBody();
                byte[]? il = body?.GetILAsByteArray();
                if (il is null)
                {
                    continue;
                }

                bool matchedLiteral = false;
                bool matchedMember = false;
                Type[] typeArguments = method.DeclaringType?.IsGenericType == true
                    ? method.DeclaringType.GetGenericArguments()
                    : Type.EmptyTypes;
                Type[] methodArguments = method.IsGenericMethod
                    ? method.GetGenericArguments()
                    : Type.EmptyTypes;
                for (int offset = 0; offset < il.Length;)
                {
                    OpCode opCode = ReadOpCode(il, ref offset);
                    int operandOffset = offset;
                    int operandSize = OperandSize(opCode.OperandType, il, operandOffset);
                    if (operandSize < 0 || operandOffset + operandSize > il.Length)
                    {
                        throw new InvalidOperationException($"Invalid IL operand for {method.DeclaringType?.FullName}.{method.Name}.");
                    }

                    if (opCode.OperandType == OperandType.InlineString)
                    {
                        matchedLiteral |= literalPredicate(method.Module.ResolveString(BitConverter.ToInt32(il, operandOffset)));
                    }
                    else if (opCode.OperandType is OperandType.InlineField
                             or OperandType.InlineMethod
                             or OperandType.InlineTok
                             or OperandType.InlineType)
                    {
                        try
                        {
                            MemberInfo? member = method.Module.ResolveMember(
                                BitConverter.ToInt32(il, operandOffset),
                                typeArguments,
                                methodArguments);
                            matchedMember |= member is not null && memberPredicate(member);
                        }
                        catch (ArgumentException)
                        {
                            // An unresolved generic token cannot prove a violation.
                        }
                    }

                    offset += operandSize;
                }

                if (matchedLiteral && matchedMember)
                {
                    violations.Add($"{method.DeclaringType?.FullName}.{method.Name}");
                }
            }
        }

        return violations;
    }

    public static IReadOnlyList<string> FindMethodsCallingMember(
        Type rootType,
        Func<MemberInfo, bool> memberPredicate)
    {
        var matches = new List<string>();
        foreach (Type type in EnumerateTypeTree(rootType))
        {
            foreach (MethodBase method in type.GetMethods(AllDeclaredMembers).Cast<MethodBase>()
                         .Concat(type.GetConstructors(AllDeclaredMembers)))
            {
                MethodBody? body = method.GetMethodBody();
                byte[]? il = body?.GetILAsByteArray();
                if (il is null)
                {
                    continue;
                }

                Type[] typeArguments = method.DeclaringType?.IsGenericType == true
                    ? method.DeclaringType.GetGenericArguments()
                    : Type.EmptyTypes;
                Type[] methodArguments = method.IsGenericMethod
                    ? method.GetGenericArguments()
                    : Type.EmptyTypes;
                bool matched = false;
                for (int offset = 0; offset < il.Length;)
                {
                    OpCode opCode = ReadOpCode(il, ref offset);
                    int operandOffset = offset;
                    int operandSize = OperandSize(opCode.OperandType, il, operandOffset);
                    Assert.True(operandSize >= 0 && operandOffset + operandSize <= il.Length);
                    if (opCode.OperandType is OperandType.InlineField
                        or OperandType.InlineMethod
                        or OperandType.InlineTok
                        or OperandType.InlineType)
                    {
                        try
                        {
                            MemberInfo? member = method.Module.ResolveMember(
                                BitConverter.ToInt32(il, operandOffset),
                                typeArguments,
                                methodArguments);
                            matched |= member is not null && memberPredicate(member);
                        }
                        catch (ArgumentException)
                        {
                            // An unresolved generic token cannot establish a runtime call.
                        }
                    }

                    offset += operandSize;
                }

                if (matched)
                {
                    matches.Add($"{method.DeclaringType?.FullName}.{method.Name}");
                }
            }
        }

        return matches;
    }

    private const BindingFlags AllDeclaredMembers =
        BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;

    private static string Describe(
        Type rootType,
        IEnumerable<MethodBase> roots,
        bool followCallsWithinType)
    {
        Type topLevelType = TopLevelType(rootType);
        var pending = new Queue<MethodBase>(roots);
        var visited = new HashSet<MethodBase>();
        var facts = new List<string>();

        foreach (Type inspectedType in EnumerateTypeTree(rootType))
        {
            foreach (FieldInfo field in inspectedType.GetFields(AllDeclaredMembers))
            {
                facts.Add(DescribeMember(field));
                if (field.IsStatic && field.FieldType == typeof(string))
                {
                    try
                    {
                        if (field.GetValue(null) is string value)
                        {
                            facts.Add(value);
                        }
                    }
                    catch (TypeInitializationException)
                    {
                        // Method IL still exposes the field reference without executing an unsafe initializer.
                    }
                }
            }
        }

        while (pending.TryDequeue(out MethodBase? method))
        {
            if (!visited.Add(method))
            {
                continue;
            }

            facts.Add(DescribeMember(method));
            if (followCallsWithinType)
            {
                Type? stateMachineType = method
                        .GetCustomAttribute<System.Runtime.CompilerServices.AsyncStateMachineAttribute>()
                        ?.StateMachineType
                    ?? method
                        .GetCustomAttribute<System.Runtime.CompilerServices.IteratorStateMachineAttribute>()
                        ?.StateMachineType;
                MethodInfo? moveNext = stateMachineType?.GetMethod(
                    "MoveNext",
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                if (moveNext is not null && TopLevelType(moveNext.DeclaringType!) == topLevelType)
                {
                    pending.Enqueue(moveNext);
                }
            }

            MethodBody? body = method.GetMethodBody();
            byte[]? il = body?.GetILAsByteArray();
            if (il is null)
            {
                continue;
            }

            Type[] typeArguments = method.DeclaringType?.IsGenericType == true
                ? method.DeclaringType.GetGenericArguments()
                : Type.EmptyTypes;
            Type[] methodArguments = method.IsGenericMethod
                ? method.GetGenericArguments()
                : Type.EmptyTypes;

            for (int offset = 0; offset < il.Length;)
            {
                OpCode opCode = ReadOpCode(il, ref offset);
                int operandOffset = offset;
                int operandSize = OperandSize(opCode.OperandType, il, operandOffset);
                if (operandSize < 0 || operandOffset + operandSize > il.Length)
                {
                    throw new InvalidOperationException($"Invalid IL operand for {method.DeclaringType?.FullName}.{method.Name}.");
                }

                if (opCode.OperandType == OperandType.InlineString)
                {
                    int token = BitConverter.ToInt32(il, operandOffset);
                    facts.Add(method.Module.ResolveString(token));
                }
                else if (opCode.OperandType is OperandType.InlineField
                         or OperandType.InlineMethod
                         or OperandType.InlineTok
                         or OperandType.InlineType)
                {
                    int token = BitConverter.ToInt32(il, operandOffset);
                    try
                    {
                        MemberInfo? member = method.Module.ResolveMember(token, typeArguments, methodArguments);
                        if (member is not null)
                        {
                            facts.Add(DescribeMember(member));
                            if (followCallsWithinType
                                && member is MethodBase called
                                && called.DeclaringType is not null
                                && TopLevelType(called.DeclaringType) == topLevelType)
                            {
                                pending.Enqueue(called);
                            }
                        }
                    }
                    catch (ArgumentException)
                    {
                        facts.Add($"metadata-token:0x{token:x8}");
                    }
                }

                offset += operandSize;
            }
        }

        return string.Join('\n', facts.Order(StringComparer.Ordinal));
    }

    private static string[] DescribeMemberReferencesInOrder(MethodBase method)
    {
        MethodBody? body = method.GetMethodBody();
        byte[]? il = body?.GetILAsByteArray();
        if (il is null)
        {
            return [];
        }

        Type[] typeArguments = method.DeclaringType?.IsGenericType == true
            ? method.DeclaringType.GetGenericArguments()
            : Type.EmptyTypes;
        Type[] methodArguments = method.IsGenericMethod
            ? method.GetGenericArguments()
            : Type.EmptyTypes;
        var references = new List<string>();
        for (int offset = 0; offset < il.Length;)
        {
            OpCode opCode = ReadOpCode(il, ref offset);
            int operandOffset = offset;
            int operandSize = OperandSize(opCode.OperandType, il, operandOffset);
            if (operandSize < 0 || operandOffset + operandSize > il.Length)
            {
                throw new InvalidOperationException($"Invalid IL operand for {method.DeclaringType?.FullName}.{method.Name}.");
            }

            if (opCode.OperandType is OperandType.InlineField
                or OperandType.InlineMethod
                or OperandType.InlineTok
                or OperandType.InlineType)
            {
                try
                {
                    MemberInfo? member = method.Module.ResolveMember(
                        BitConverter.ToInt32(il, operandOffset),
                        typeArguments,
                        methodArguments);
                    if (member is not null)
                    {
                        references.Add(DescribeMember(member));
                    }
                }
                catch (ArgumentException)
                {
                    // An unresolved generic token cannot establish call order.
                }
            }

            offset += operandSize;
        }

        return [.. references];
    }

    private static string DescribeMethodBodyFacts(MethodBase method)
    {
        MethodBody? body = method.GetMethodBody();
        byte[]? il = body?.GetILAsByteArray();
        if (il is null)
        {
            return string.Empty;
        }

        Type[] typeArguments = method.DeclaringType?.IsGenericType == true
            ? method.DeclaringType.GetGenericArguments()
            : Type.EmptyTypes;
        Type[] methodArguments = method.IsGenericMethod
            ? method.GetGenericArguments()
            : Type.EmptyTypes;
        var facts = new List<string> { DescribeMember(method) };
        for (int offset = 0; offset < il.Length;)
        {
            OpCode opCode = ReadOpCode(il, ref offset);
            int operandOffset = offset;
            int operandSize = OperandSize(opCode.OperandType, il, operandOffset);
            Assert.True(operandSize >= 0 && operandOffset + operandSize <= il.Length);
            if (opCode.OperandType == OperandType.InlineString)
            {
                facts.Add(method.Module.ResolveString(BitConverter.ToInt32(il, operandOffset)));
            }
            else if (opCode.OperandType is OperandType.InlineField
                     or OperandType.InlineMethod
                     or OperandType.InlineTok
                     or OperandType.InlineType)
            {
                try
                {
                    MemberInfo? member = method.Module.ResolveMember(
                        BitConverter.ToInt32(il, operandOffset),
                        typeArguments,
                        methodArguments);
                    if (member is not null)
                    {
                        facts.Add(DescribeMember(member));
                    }
                }
                catch (ArgumentException)
                {
                    // An unresolved generic token does not contribute a runtime fact.
                }
            }

            offset += operandSize;
        }

        return string.Join('\n', facts);
    }

    private static IEnumerable<Type> EnumerateTypeTree(Type type)
    {
        yield return type;
        foreach (Type nested in type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic))
        {
            foreach (Type descendant in EnumerateTypeTree(nested))
            {
                yield return descendant;
            }
        }
    }

    private static Type TopLevelType(Type type)
    {
        while (type.DeclaringType is not null)
        {
            type = type.DeclaringType;
        }

        return type;
    }

    private static string DescribeMember(MemberInfo member)
        => $"{member.DeclaringType?.FullName}.{member.Name} {member}";

    private static OpCode ReadOpCode(byte[] il, ref int offset)
    {
        ushort value = il[offset++];
        if (value == 0xfe)
        {
            value = (ushort)(0xfe00 | il[offset++]);
        }

        return OpCodesByValue.TryGetValue(value, out OpCode opCode)
            ? opCode
            : throw new InvalidOperationException($"Unknown IL opcode 0x{value:x4}.");
    }

    private static int OperandSize(OperandType operandType, byte[] il, int operandOffset)
        => operandType switch
        {
            OperandType.InlineNone => 0,
            OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
            OperandType.InlineVar => 2,
            OperandType.InlineBrTarget or OperandType.InlineField or OperandType.InlineI or OperandType.InlineMethod
                or OperandType.InlineSig or OperandType.InlineString or OperandType.InlineTok or OperandType.InlineType
                or OperandType.ShortInlineR => 4,
            OperandType.InlineI8 or OperandType.InlineR => 8,
            OperandType.InlineSwitch => 4 + (BitConverter.ToInt32(il, operandOffset) * 4),
            _ => -1
        };
}
