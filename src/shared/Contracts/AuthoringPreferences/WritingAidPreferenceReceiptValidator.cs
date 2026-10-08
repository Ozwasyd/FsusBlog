using System.Security.Cryptography;
using System.Text.Json;

namespace FsusBlog.Shared.Contracts.AuthoringPreferences;

public static class WritingAidPreferenceReceiptValidator
{
    public static bool IsDeviceScope(string? deviceScope)
        => deviceScope is not null && deviceScope.StartsWith("device:", StringComparison.Ordinal)
            && deviceScope.Length == 71 && deviceScope.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;

    public static bool Validate(WritingAidPreferenceReceipt? receipt, WritingAidPreferenceOwner owner)
        => receipt is not null && receipt.OperationId != Guid.Empty && IsDeviceScope(receipt.DeviceScope)
            && receipt.Action is "update" or "initialize"
            && receipt.Status == "committed"
            && receipt.Previous is not null && receipt.Committed is not null
            && WritingAidPreferenceValidator.ValidateSnapshot(receipt.Previous, owner) == WritingAidPreferenceValidation.Valid
            && WritingAidPreferenceValidator.ValidateSnapshot(receipt.Committed, owner) == WritingAidPreferenceValidation.Valid
            && receipt.Committed.Revision == receipt.Previous.Revision + 1
            && (receipt.Action != "initialize" || receipt.Previous.Revision == 0
                && receipt.Committed.Values == WritingAidPreferenceContract.Defaults)
            && receipt.ContentDigest == ComputeDigest(receipt with { ContentDigest = string.Empty });

    public static string ComputeDigest(WritingAidPreferenceReceipt receipt)
    {
        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartArray();
            writer.WriteStringValue("fsusblog.writing-aid-receipt.v1");
            writer.WriteStringValue(receipt.OperationId);
            writer.WriteStringValue(receipt.DeviceScope);
            writer.WriteStringValue(receipt.Previous.ContentDigest);
            writer.WriteStringValue(receipt.Committed.ContentDigest);
            writer.WriteStringValue(receipt.Action);
            writer.WriteStringValue(receipt.Status);
            writer.WriteEndArray();
        }
        return Convert.ToHexStringLower(SHA256.HashData(output.ToArray()));
    }
}
