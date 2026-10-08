using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

namespace FsusBlog.Shared.Contracts.AuthoringPreferences;

/// <summary>Validates facts, not authentication. Admission and persistence remain with the canonical service.</summary>
public static class WritingAidPreferenceValidator
{
    public static bool IsValidOwner(WritingAidPreferenceOwner? owner)
    {
        if (owner is null || !IsCoordinate(owner.SiteScope) || !IsCoordinate(owner.UserScope))
        {
            return false;
        }
        string[] parts = owner.UserScope.Split(':');
        return parts.Length == 2
            && parts[0] is "account" or "admin"
            && long.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out long id)
            && id > 0
            && id <= WritingAidPreferenceContract.MaximumExactRevision
            && parts[1] == id.ToString(CultureInfo.InvariantCulture);
    }

    public static WritingAidPreferenceValidation ValidateUpdate(WritingAidPreferenceUpdate? update)
    {
        if (update?.Values is null || update.Values.SchemaVersion != WritingAidPreferenceContract.SchemaVersion)
        {
            return WritingAidPreferenceValidation.InvalidSchema;
        }
        if (!IsRevision(update.ExpectedRevision) || update.ExpectedRevision == WritingAidPreferenceContract.MaximumExactRevision)
        {
            return WritingAidPreferenceValidation.InvalidRevision;
        }
        return update.OperationId == Guid.Empty
            ? WritingAidPreferenceValidation.InvalidOperation
            : WritingAidPreferenceValidation.Valid;
    }

    public static WritingAidPreferenceValidation ValidateSnapshot(
        WritingAidPreferenceSnapshot? snapshot,
        WritingAidPreferenceOwner expectedOwner)
    {
        if (!IsValidOwner(expectedOwner) || !IsValidOwner(snapshot?.Owner))
        {
            return WritingAidPreferenceValidation.InvalidOwner;
        }
        if (snapshot!.Owner != expectedOwner)
        {
            return WritingAidPreferenceValidation.OwnerMismatch;
        }
        if (!IsRevision(snapshot.Revision))
        {
            return WritingAidPreferenceValidation.InvalidRevision;
        }
        if (snapshot.Values is null
            || snapshot.Values.SchemaVersion != WritingAidPreferenceContract.SchemaVersion
            || snapshot.Revision == 0 && snapshot.Values != WritingAidPreferenceContract.Defaults)
        {
            return WritingAidPreferenceValidation.InvalidSchema;
        }
        return string.Equals(snapshot.ContentDigest, ComputeDigest(snapshot.Owner, snapshot.Revision, snapshot.Values), StringComparison.Ordinal)
            ? WritingAidPreferenceValidation.Valid
            : WritingAidPreferenceValidation.DigestMismatch;
    }

    public static string ComputeDigest(WritingAidPreferenceOwner owner, long revision, WritingAidPreferenceValues values)
    {
        if (!IsValidOwner(owner) || !IsRevision(revision)
            || values is null || values.SchemaVersion != WritingAidPreferenceContract.SchemaVersion)
        {
            throw new ArgumentException("writing aid preference digest input is invalid");
        }
        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartArray();
            writer.WriteStringValue("fsusblog.writing-aid-preference.v1");
            writer.WriteStringValue(owner.UserScope);
            writer.WriteStringValue(owner.SiteScope);
            writer.WriteNumberValue(revision);
            writer.WriteNumberValue(values.SchemaVersion);
            writer.WriteBooleanValue(values.FocusEnabled);
            writer.WriteBooleanValue(values.TypewriterEnabled);
            writer.WriteBooleanValue(values.ImmersiveEnabled);
            writer.WriteEndArray();
        }
        return Convert.ToHexStringLower(SHA256.HashData(output.ToArray()));
    }

    /// <summary>Strict internal value validation. This is not a text HTTP transport or legacy reader.</summary>
    public static bool TryReadValues(ReadOnlyMemory<byte> encoded, out WritingAidPreferenceValues? values)
    {
        values = null;
        if (encoded.Length > 256)
        {
            return false;
        }
        try
        {
            using JsonDocument document = JsonDocument.Parse(encoded, new JsonDocumentOptions { MaxDepth = 2 });
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                return false;
            }
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in document.RootElement.EnumerateObject())
            {
                if (!names.Add(property.Name))
                {
                    return false;
                }
                if (property.Name == "schemaVersion")
                {
                    if (!property.Value.TryGetInt32(out int version) || version != WritingAidPreferenceContract.SchemaVersion)
                    {
                        return false;
                    }
                }
                else if (property.Name is not ("focusEnabled" or "typewriterEnabled" or "immersiveEnabled")
                    || property.Value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                {
                    return false;
                }
            }
            if (names.Count != 4 || !names.Contains("schemaVersion"))
            {
                return false;
            }
            values = new WritingAidPreferenceValues(
                WritingAidPreferenceContract.SchemaVersion,
                document.RootElement.GetProperty("focusEnabled").GetBoolean(),
                document.RootElement.GetProperty("typewriterEnabled").GetBoolean(),
                document.RootElement.GetProperty("immersiveEnabled").GetBoolean());
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    private static bool IsCoordinate(string? value)
        => !string.IsNullOrWhiteSpace(value) && value.Length <= 128
            && value == value.Trim() && !value.Any(char.IsControl);

    private static bool IsRevision(long revision)
        => revision >= 0 && revision <= WritingAidPreferenceContract.MaximumExactRevision;
}
