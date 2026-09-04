using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Modules.Endpoints;

using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace FsusBlog.OpenApiObservation;

internal static class CompiledEndpointContractObserver
{
    private const string BinaryContentType = "application/octet-stream";
    private const string BinaryResultPlacement = "aeds.frame.payload";
    private static readonly IReadOnlyDictionary<short, OpCode> s_opCodes = typeof(OpCodes)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where(static field => field.FieldType == typeof(OpCode))
        .Select(static field => (OpCode)field.GetValue(null)!)
        .ToDictionary(static code => code.Value);

    public static CompiledEndpointContract Observe(RouteEndpoint endpoint, string method, string path)
    {
        string operationId = endpoint.Metadata.GetMetadata<IEndpointNameMetadata>()?.EndpointName
            ?? OperationIdFor(method, path);
        if (TryResolveRegisteredRoute(method, path, out AedsFrameType? requestFrame, out AedsFrameType responseFrame, out string resolver))
        {
            return BinaryContract(
                operationId,
                requestFrame,
                responseFrame,
                StatusCodes.Status200OK,
                [$"compiled-route-resolver:{resolver}"]);
        }

        MethodInfo? handler = endpoint.Metadata.GetMetadata<MethodInfo>();
        if (handler is null)
        {
            return new CompiledEndpointContract(
                operationId,
                null,
                null,
                null,
                null,
                "unknown",
                "unknown",
                ["compiled-endpoint:missing-handler"]);
        }

        var facts = new IlEndpointFacts();
        ObserveMethod(handler, facts, [], 0);
        if (facts.JsonResults.Count > 0 && facts.BinaryResults.Count == 0)
        {
            return new CompiledEndpointContract(
                operationId,
                null,
                null,
                null,
                null,
                "application/json",
                "json.body",
                facts.JsonResults.Order(StringComparer.Ordinal).ToArray());
        }

        AedsFrameType? observedRequest = SingleFrame(facts.RequestFrames, "request", method, path, allowEmpty: true);
        AedsFrameType? observedResponse = SingleFrame(facts.ResponseFrames, "response", method, path, allowEmpty: true);
        int? successStatus = StatusCodes.Status200OK;
        if (observedResponse is null && facts.ExplicitErrorStatuses.Count == 1)
        {
            observedResponse = AedsFrameType.ApiError;
            successStatus = facts.ExplicitErrorStatuses.Single();
        }
        if (observedResponse is null || facts.BinaryResults.Count == 0)
        {
            return new CompiledEndpointContract(
                operationId,
                observedRequest?.ToString(),
                observedResponse?.ToString(),
                facts.BinaryResults.Count == 0 ? null : ObserveErrorFrame(),
                observedResponse is null ? null : successStatus,
                facts.BinaryResults.Count == 0 ? "unknown" : BinaryContentType,
                facts.BinaryResults.Count == 0 ? "unknown" : BinaryResultPlacement,
                facts.Evidence());
        }

        return BinaryContract(
            operationId,
            observedRequest,
            observedResponse.Value,
            successStatus.Value,
            facts.Evidence());
    }

    internal static string OperationIdFor(string method, string path)
    {
        string body = path
            .Replace("/api/binary/", string.Empty, StringComparison.Ordinal)
            .Replace("/api/binary", string.Empty, StringComparison.Ordinal);
        string slug = System.Text.RegularExpressions.Regex.Replace(body, @"[{}:.?=&/\-]+", "_");
        slug = System.Text.RegularExpressions.Regex.Replace(slug.Trim('_'), @"_+", "_");
        return $"binary_{method.ToLowerInvariant()}_{slug}";
    }

    private static CompiledEndpointContract BinaryContract(
        string operationId,
        AedsFrameType? requestFrame,
        AedsFrameType responseFrame,
        int successStatus,
        IReadOnlyList<string> evidence)
        => new(
            operationId,
            requestFrame?.ToString(),
            responseFrame.ToString(),
            ObserveErrorFrame(),
            successStatus,
            ObserveBinaryContentType(),
            BinaryResultPlacement,
            evidence);

    private static bool TryResolveRegisteredRoute(
        string method,
        string path,
        out AedsFrameType? requestFrame,
        out AedsFrameType responseFrame,
        out string resolver)
    {
        const string AuthorPrefix = "/api/binary/author";
        if (path.StartsWith(AuthorPrefix, StringComparison.Ordinal)
            && AuthoringEndpoints.TryResolveRoute(method, new PathString(path[AuthorPrefix.Length..]), out AuthoringEndpoints.AuthoringAedsRoute author))
        {
            requestFrame = author.RequestFrame;
            responseFrame = author.ResponseFrame;
            resolver = "FsusBlog.Server.Modules.Endpoints.AuthoringEndpoints.TryResolveRoute";
            return true;
        }

        const string SecurityPrefix = "/api/binary/admin/security";
        if (path.StartsWith(SecurityPrefix, StringComparison.Ordinal)
            && SecurityEndpoints.TryResolveRoute(method, new PathString(path[SecurityPrefix.Length..]), out SecurityEndpoints.SecurityAedsRoute security))
        {
            requestFrame = security.RequestFrame;
            responseFrame = security.ResponseFrame;
            resolver = "FsusBlog.Server.Modules.Endpoints.SecurityEndpoints.TryResolveRoute";
            return true;
        }

        requestFrame = null;
        responseFrame = default;
        resolver = string.Empty;
        return false;
    }

    private static void ObserveMethod(
        MethodBase method,
        IlEndpointFacts facts,
        HashSet<MethodBase> visited,
        int depth)
    {
        if (depth > 8 || !visited.Add(method))
        {
            return;
        }
        if (method is MethodInfo methodInfo)
        {
            MethodInfo? moveNext = methodInfo.GetCustomAttribute<AsyncStateMachineAttribute>()?.StateMachineType.GetMethod(
                nameof(IAsyncStateMachine.MoveNext),
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (moveNext is not null)
            {
                ObserveMethod(moveNext, facts, visited, depth + 1);
            }
        }

        byte[]? il = method.GetMethodBody()?.GetILAsByteArray();
        if (il is null)
        {
            return;
        }

        var recentIntegers = new Queue<(int Value, int Offset)>();
        int offset = 0;
        int instruction = 0;
        while (offset < il.Length)
        {
            int instructionOffset = offset;
            short value = il[offset++];
            if (value == 0xfe)
            {
                value = (short)(0xfe00 | il[offset++]);
            }
            if (!s_opCodes.TryGetValue(value, out OpCode opCode))
            {
                return;
            }

            if (ReadIntegerConstant(opCode, il, offset) is int constant)
            {
                recentIntegers.Enqueue((constant, instruction));
            }
            while (recentIntegers.TryPeek(out (int Value, int Offset) candidate)
                && instruction - candidate.Offset > 24)
            {
                recentIntegers.Dequeue();
            }

            if (opCode.OperandType == OperandType.InlineMethod
                && ResolveMethod(method, BitConverter.ToInt32(il, offset)) is MethodBase called)
            {
                string evidence = $"compiled-il:{MethodIdentity(method)}->{MethodIdentity(called)}@{instructionOffset}";
                if (IsRequestFrameReader(called)
                    && ClosestFrame(recentIntegers) is AedsFrameType requestFrame)
                {
                    facts.AddRequest(requestFrame, evidence);
                }
                if (IsBinarySuccessFactory(called))
                {
                    facts.BinaryResults.Add(evidence);
                    if (called.GetParameters().Any(static parameter => parameter.ParameterType == typeof(AedsFrameType))
                        && ClosestFrame(recentIntegers) is AedsFrameType responseFrame)
                    {
                        facts.AddResponse(responseFrame, evidence);
                    }
                }
                else if (IsBinaryErrorFactory(called))
                {
                    facts.BinaryResults.Add(evidence);
                    int? status = ClosestHttpStatus(recentIntegers);
                    if (status is >= 400 and <= 599)
                    {
                        facts.ExplicitErrorStatuses.Add(status.Value);
                    }
                }
                else if (IsJsonFactory(called))
                {
                    facts.JsonResults.Add(evidence);
                }

                if (ShouldRecurse(called))
                {
                    ObserveMethod(called, facts, visited, depth + 1);
                }
            }
            offset += OperandSize(opCode, il, offset);
            instruction++;
        }
    }

    private static bool IsRequestFrameReader(MethodBase method)
        => method.GetParameters().Any(static parameter =>
                (Nullable.GetUnderlyingType(parameter.ParameterType) ?? parameter.ParameterType) == typeof(AedsFrameType))
            && (method.Name.StartsWith("Read", StringComparison.Ordinal)
                || method.Name.StartsWith("TryRead", StringComparison.Ordinal));

    private static bool IsBinarySuccessFactory(MethodBase method)
    {
        string declaring = method.DeclaringType?.FullName ?? string.Empty;
        return declaring switch
        {
            "FsusBlog.Server.Infrastructure.Results.BinaryResults" => method.Name is "Frame" or "FrameRaw" or "FromResult" or "PreencodedFrame",
            "FsusBlog.Server.Infrastructure.Results.AedsJsonResults" => method.Name is "Ok" or "OkNull",
            "FsusBlog.Server.Infrastructure.Results.BinaryFrameResult" => method.IsConstructor,
            "FsusBlog.Server.Infrastructure.Results.BinaryFramePayloadResult" => method.IsConstructor,
            _ => method.Name == "BuildCachedFrame"
                && method is MethodInfo { ReturnType: { } returnType }
                && returnType == typeof(OwnedAedsFrame)
                && method.GetParameters().Any(static parameter => parameter.ParameterType == typeof(AedsFrameType))
        };
    }

    private static bool IsBinaryErrorFactory(MethodBase method)
    {
        string declaring = method.DeclaringType?.FullName ?? string.Empty;
        return declaring switch
        {
            "FsusBlog.Server.Infrastructure.Results.BinaryResults" => method.Name == "FromError",
            "FsusBlog.Server.Infrastructure.Results.AedsJsonResults" => method.Name is "BadRequest" or "Unauthorized" or "NotFound" or "PreconditionRequired" or "Error",
            _ => false
        };
    }

    private static bool IsJsonFactory(MethodBase method)
    {
        string declaring = method.DeclaringType?.FullName ?? string.Empty;
        return declaring is "Microsoft.AspNetCore.Http.Results" or "Microsoft.AspNetCore.Http.TypedResults"
            || declaring.StartsWith("Microsoft.AspNetCore.Http.HttpResults.", StringComparison.Ordinal);
    }

    private static bool ShouldRecurse(MethodBase method)
        => method.DeclaringType?.Assembly == typeof(AuthoringEndpoints).Assembly
            && (method.DeclaringType.Namespace?.StartsWith("FsusBlog.Server.Modules.Endpoints", StringComparison.Ordinal) ?? false)
            && !method.Name.StartsWith("Map", StringComparison.Ordinal)
            && method.Name is not "TryResolveRoute" and not "Found";

    private static AedsFrameType? ClosestFrame(IEnumerable<(int Value, int Offset)> values)
    {
        foreach (int value in values.Reverse().Select(static item => item.Value))
        {
            if (value < ushort.MinValue || value > ushort.MaxValue)
            {
                continue;
            }
            var frame = (AedsFrameType)value;
            if (frame != AedsFrameType.Unknown && Enum.IsDefined(frame))
            {
                return frame;
            }
        }
        return null;
    }

    private static int? ClosestHttpStatus(IEnumerable<(int Value, int Offset)> values)
        => values.Reverse().Select(static item => item.Value).FirstOrDefault(static value => value is >= 100 and <= 599) is int status
            && status is >= 100 and <= 599
                ? status
                : null;

    private static AedsFrameType? SingleFrame(
        IReadOnlyDictionary<AedsFrameType, HashSet<string>> frames,
        string direction,
        string method,
        string path,
        bool allowEmpty)
    {
        if (frames.Count == 1)
        {
            return frames.Keys.Single();
        }
        if (frames.Count == 0 && allowEmpty)
        {
            return null;
        }
        throw new InvalidOperationException(
            $"{method} {path} has {(frames.Count == 0 ? "no" : "ambiguous")} compiled {direction} frame evidence: "
            + string.Join(',', frames.Keys.OrderBy(static value => value)));
    }

    private static string ObserveErrorFrame()
    {
        MethodInfo method = typeof(BinaryResults).GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Single(static candidate => candidate.Name == nameof(BinaryResults.FromError));
        byte[] il = method.GetMethodBody()?.GetILAsByteArray()
            ?? throw new InvalidOperationException("BinaryResults.FromError has no compiled body");
        if (!IntegerConstants(il).Select(static value => (AedsFrameType)value).Contains(AedsFrameType.ApiError))
        {
            throw new InvalidOperationException("BinaryResults.FromError does not compile an ApiError frame");
        }
        return AedsFrameType.ApiError.ToString();
    }

    private static string ObserveBinaryContentType()
    {
        Type envelope = typeof(BinaryResults).Assembly.GetType(
            "FsusBlog.Server.Infrastructure.Binary.BinaryEnvelopePolicy",
            throwOnError: true)!;
        string value = envelope.GetField("BinaryContentType", BindingFlags.Static | BindingFlags.NonPublic)?.GetRawConstantValue() as string
            ?? throw new InvalidOperationException("BinaryEnvelopePolicy.BinaryContentType compiled constant missing");
        if (!string.Equals(value, BinaryContentType, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"unexpected compiled binary content type {value}");
        }
        return value;
    }

    private static IEnumerable<int> IntegerConstants(byte[] il)
    {
        int offset = 0;
        while (offset < il.Length)
        {
            short value = il[offset++];
            if (value == 0xfe)
            {
                value = (short)(0xfe00 | il[offset++]);
            }
            if (!s_opCodes.TryGetValue(value, out OpCode opCode))
            {
                yield break;
            }
            if (ReadIntegerConstant(opCode, il, offset) is int constant)
            {
                yield return constant;
            }
            offset += OperandSize(opCode, il, offset);
        }
    }

    private static int? ReadIntegerConstant(OpCode opCode, byte[] il, int operandOffset)
    {
        if (opCode == OpCodes.Ldc_I4_M1)
            return -1;
        if (opCode == OpCodes.Ldc_I4_0)
            return 0;
        if (opCode == OpCodes.Ldc_I4_1)
            return 1;
        if (opCode == OpCodes.Ldc_I4_2)
            return 2;
        if (opCode == OpCodes.Ldc_I4_3)
            return 3;
        if (opCode == OpCodes.Ldc_I4_4)
            return 4;
        if (opCode == OpCodes.Ldc_I4_5)
            return 5;
        if (opCode == OpCodes.Ldc_I4_6)
            return 6;
        if (opCode == OpCodes.Ldc_I4_7)
            return 7;
        if (opCode == OpCodes.Ldc_I4_8)
            return 8;
        if (opCode == OpCodes.Ldc_I4_S)
            return (sbyte)il[operandOffset];
        if (opCode == OpCodes.Ldc_I4)
            return BitConverter.ToInt32(il, operandOffset);
        return null;
    }

    private static MethodBase? ResolveMethod(MethodBase owner, int token)
    {
        try
        {
            Type[]? declaringArguments = owner.DeclaringType?.IsGenericType == true
                ? owner.DeclaringType.GetGenericArguments()
                : null;
            Type[]? methodArguments = owner.IsGenericMethod ? owner.GetGenericArguments() : null;
            return owner.Module.ResolveMethod(token, declaringArguments, methodArguments);
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    private static string MethodIdentity(MethodBase method)
        => $"{method.DeclaringType?.FullName}.{method.Name}";

    private static int OperandSize(OpCode opCode, byte[] il, int operandOffset)
        => opCode.OperandType switch
        {
            OperandType.InlineNone => 0,
            OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
            OperandType.InlineVar => 2,
            OperandType.InlineBrTarget or OperandType.InlineField or OperandType.InlineI
                or OperandType.InlineMethod or OperandType.InlineSig or OperandType.InlineString
                or OperandType.InlineTok or OperandType.InlineType or OperandType.ShortInlineR => 4,
            OperandType.InlineI8 or OperandType.InlineR => 8,
            OperandType.InlineSwitch => 4 + (BitConverter.ToInt32(il, operandOffset) * 4),
            _ => throw new InvalidOperationException($"unsupported IL operand type {opCode.OperandType}")
        };

    private sealed class IlEndpointFacts
    {
        public Dictionary<AedsFrameType, HashSet<string>> RequestFrames { get; } = [];

        public Dictionary<AedsFrameType, HashSet<string>> ResponseFrames { get; } = [];

        public HashSet<int> ExplicitErrorStatuses { get; } = [];

        public HashSet<string> BinaryResults { get; } = new(StringComparer.Ordinal);

        public HashSet<string> JsonResults { get; } = new(StringComparer.Ordinal);

        public void AddRequest(AedsFrameType frame, string evidence)
            => Add(RequestFrames, frame, evidence);

        public void AddResponse(AedsFrameType frame, string evidence)
            => Add(ResponseFrames, frame, evidence);

        public IReadOnlyList<string> Evidence()
            => BinaryResults.Concat(JsonResults)
                .Concat(RequestFrames.Values.SelectMany(static value => value))
                .Concat(ResponseFrames.Values.SelectMany(static value => value))
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal)
                .ToArray();

        private static void Add(
            IDictionary<AedsFrameType, HashSet<string>> target,
            AedsFrameType frame,
            string evidence)
        {
            if (!target.TryGetValue(frame, out HashSet<string>? sources))
            {
                sources = new HashSet<string>(StringComparer.Ordinal);
                target[frame] = sources;
            }
            sources.Add(evidence);
        }
    }
}

internal static class CompiledEndpointContractCensus
{
    public static void Validate(IReadOnlyList<(string Key, CompiledEndpointContract Contract)> routes)
    {
        string[] nonAeds = routes
            .Where(static item => !item.Contract.IsAeds)
            .Select(static item => $"{item.Key} requestFrame={item.Contract.RequestFrame ?? "none"} "
                + $"responseFrame={item.Contract.ResponseFrame ?? "none"} errorFrame={item.Contract.ErrorFrame ?? "none"} "
                + $"successStatus={item.Contract.SuccessStatus?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "none"} "
                + $"contentType={item.Contract.ContentType} resultPlacement={item.Contract.ResultPlacement} "
                + $"evidence={string.Join('|', item.Contract.Evidence)}")
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (nonAeds.Length > 0)
        {
            throw new InvalidOperationException(
                $"production /api/binary census found {nonAeds.Length} non-AEDS route(s):\n"
                + string.Join('\n', nonAeds));
        }
    }
}
