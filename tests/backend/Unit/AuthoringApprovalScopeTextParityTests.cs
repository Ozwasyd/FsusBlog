using System.Text.Json;

using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.AuthoringExtensions;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "GoldenContract")]
public sealed class AuthoringApprovalScopeTextParityTests
{
    private const string CorpusPath = "tests/fixtures/protocol/authoring-extension-approval-scope-text-golden.json";

    public static IEnumerable<object[]> Vectors()
    {
        using JsonDocument corpus = JsonDocument.Parse(BackendTestPaths.ReadAllTextFromRoot(CorpusPath));
        return corpus.RootElement.GetProperty("vectors").EnumerateArray()
            .Select(row => new object[] { row.GetProperty("name").GetString()! }).ToArray();
    }

    [Theory]
    [MemberData(nameof(Vectors))]
    public void ExactOriginalValidateScope_AndGeneratedEncoderDecoderAgreeForEveryField(string name)
    {
        using JsonDocument document = JsonDocument.Parse(BackendTestPaths.ReadAllTextFromRoot(CorpusPath));
        JsonElement corpus = document.RootElement;
        JsonElement vector = corpus.GetProperty("vectors").EnumerateArray()
            .Single(item => item.GetProperty("name").GetString() == name);
        byte[] baseline = Convert.FromHexString(corpus.GetProperty("basePayloadHex").GetString()!);
        Assert.True(PodBinaryCodec.TryDecodeAuthoringExtensionApprovalPreviewResponse(baseline, out var original));
        int index = 0;
        foreach (JsonElement field in corpus.GetProperty("fields").EnumerateArray())
        {
            bool expected = vector.GetProperty("expectedByField")[index++].GetBoolean();
            string fieldName = field.GetProperty("name").GetString()!;
            byte[] bytes = MutateScalar(baseline, field, vector);
            if (vector.GetProperty("hasHostValue").GetBoolean())
            {
                string? text = HostText(vector.GetProperty("utf16Hex"));
                AuthoringApprovalScopeView scope = fieldName switch
                {
                    "ExtensionId" => original.Scope with { ExtensionId = text! },
                    "ExtensionVersion" => original.Scope with { ExtensionVersion = text! },
                    "SiteId" => original.Scope with { SiteId = text! },
                    "UserId" => original.Scope with { UserId = text! },
                    "DocumentId" => original.Scope with { DocumentId = text },
                    _ => throw new InvalidDataException("scope_field_unknown")
                };
                var ownerScope = new AuthoringStateScope(scope.ExtensionId, scope.ExtensionVersion,
                    scope.SiteId, scope.UserId, scope.DocumentId, scope.SchemaVersion);
                bool ownerAccepts = Record.Exception(() => AuthoringExtensionStateContract.ValidateScope(ownerScope)) is null;
                Assert.True(ownerAccepts == expected, fieldName + ":original-owner:" + name);
                byte[]? encoded = null;
                bool encoderAccepts = Record.Exception(() => encoded = PodBinaryCodec.EncodeAuthoringExtensionApprovalPreviewResponse(
                    original with
                    {
                        Scope = scope
                    })) is null;
                Assert.True(encoderAccepts == ownerAccepts, fieldName + ":encoder:" + name);
                if (ownerAccepts)
                {
                    Assert.Equal(bytes, encoded);
                }
            }
            bool decoderAccepts = PodBinaryCodec.TryDecodeAuthoringExtensionApprovalPreviewResponse(bytes, out var decoded);
            Assert.True(decoderAccepts == expected, fieldName + ":decoder:" + name);
            if (decoderAccepts)
            {
                Assert.Equal(bytes, PodBinaryCodec.EncodeAuthoringExtensionApprovalPreviewResponse(decoded));
            }
        }
    }

    [Fact]
    public void OriginalPropertyScope_RemainsSupplementaryUnicodeCompatible()
    {
        using JsonDocument document = JsonDocument.Parse(BackendTestPaths.ReadAllTextFromRoot(CorpusPath));
        byte[] bytes = Convert.FromHexString(document.RootElement.GetProperty("retainedProperty")
            .GetProperty("payloadHex").GetString()!);
        Assert.True(PodBinaryCodec.TryDecodeArticlePropertyValueReadResponse(bytes, out var original));
        Assert.Equal("站😀", original.Scope.SiteScope);
        Assert.Equal(bytes, PodBinaryCodec.EncodeArticlePropertyValueReadResponse(original));
    }

    private static string? HostText(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Null)
        {
            return null;
        }
        byte[] bytes = Convert.FromHexString(value.GetString()!);
        var units = new char[bytes.Length / 2];
        for (int index = 0; index < units.Length; index++)
        {
            units[index] = (char)(bytes[index * 2] | bytes[index * 2 + 1] << 8);
        }
        return new string(units);
    }

    private static byte[] MutateScalar(byte[] baseline, JsonElement field, JsonElement vector)
    {
        int start = field.GetProperty("offset").GetInt32();
        int count = field.GetProperty("encodedLength").GetInt32();
        byte[] replacement;
        if (vector.GetProperty("hasHostValue").GetBoolean() && vector.GetProperty("utf16Hex").ValueKind == JsonValueKind.Null)
        {
            if (field.GetProperty("nullable").GetBoolean())
            {
                start = field.GetProperty("nullableOffset").GetInt32();
                count++;
                replacement = [0];
            }
            else
            {
                replacement = [255, 255, 255, 255];
            }
        }
        else
        {
            byte[] utf8 = Convert.FromHexString(vector.GetProperty("utf8Hex").GetString()!);
            replacement = new byte[4 + utf8.Length];
            System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(replacement, utf8.Length);
            utf8.CopyTo(replacement, 4);
        }
        return [.. baseline.AsSpan(0, start), .. replacement, .. baseline.AsSpan(start + count)];
    }
}
