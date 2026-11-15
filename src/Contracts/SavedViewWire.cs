using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.V2.Contracts;

public enum SavedViewAction { Save = 1, Rename = 2, Retire = 3 }
public sealed record SavedViewCommand(SavedViewAction Action, Guid Id, long Revision, long CollectionRevision,
    Guid RequestId, string Name, PropertyArticleQueryGroup? Query);
public sealed record SavedViewReceipt(Guid Id, long Revision, long CollectionRevision, bool Retired);
public sealed record SavedViewSummary(Guid Id, long Revision, string Name);
public sealed record SavedViewCatalog(long CollectionRevision, Guid NextId, IReadOnlyList<SavedViewSummary> Views);
public sealed record SavedViewExecute(Guid Id, long Revision, string Cursor);
public sealed record SavedViewCondition(Guid DefinitionId, PropertyFieldKind Kind, PropertyComparison Comparison, PropertyFieldValue Value,
    bool AnyOf = false);
public sealed record SavedViewDefinition(IReadOnlyList<SavedViewCondition> Conditions, string Keyword);

public static partial class Wire
{
    public static string NormalizeSavedViewName(string name)
    {
        var value = name.Trim().Normalize(NormalizationForm.FormC);
        if (value.Length is 0 or > 128 || value.Any(char.IsControl) || Utf8.GetByteCount(value) > WireLimits.SavedViewNameBytes)
            throw InvalidSavedView();
        return value;
    }

    public static byte[] EncodeSavedViewCommand(SavedViewCommand command)
    {
        Validate(command);
        var writer = new Writer();
        writer.I32((int)command.Action);
        writer.Uuid(command.Id);
        writer.I64(command.Revision);
        writer.I64(command.CollectionRevision);
        writer.Uuid(command.RequestId);
        writer.Text(command.Name, WireLimits.SavedViewNameBytes);
        writer.Bytes(command.Query is null ? [] : EncodePropertyArticleQueryGroup(command.Query));
        return Aeds.Encode(FrameType.SavedViewCommand, writer.Written);
    }

    public static SavedViewCommand DecodeSavedViewCommand(ReadOnlySpan<byte> frame)
    {
        if (frame.Length > WireLimits.SavedViewKeywordCommandFrameBytes) throw InvalidSavedView();
        var reader = new Reader(Aeds.Decode(frame, FrameType.SavedViewCommand));
        var action = (SavedViewAction)reader.I32();
        var id = reader.Uuid();
        var revision = reader.I64();
        var collection = reader.I64();
        var request = reader.Uuid();
        var name = reader.Text(WireLimits.SavedViewNameBytes);
        var query = reader.Bytes(WireLimits.PropertyKeywordQueryFrameBytes);
        var result = new SavedViewCommand(action, id, revision, collection, request, name,
            query.IsEmpty ? null : DecodePropertyArticleQueryGroup(query));
        reader.Finish();
        Validate(result);
        if (result.Query is not { Keyword.Length: > 0 } && frame.Length > WireLimits.SavedViewCommandFrameBytes)
            throw InvalidSavedView();
        return result;
    }

    public static byte[] EncodeSavedViewReceipt(SavedViewReceipt receipt)
    {
        var writer = new Writer();
        writer.Uuid(receipt.Id);
        writer.I64(receipt.Revision);
        writer.I64(receipt.CollectionRevision);
        writer.Bool(receipt.Retired);
        return Aeds.Encode(FrameType.SavedViewReceipt, writer.Written);
    }

    public static SavedViewReceipt DecodeSavedViewReceipt(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.SavedViewReceipt));
        var result = new SavedViewReceipt(reader.Uuid(), reader.I64(), reader.I64(), reader.Bool());
        reader.Finish();
        if (result.Id == Guid.Empty || result.Revision <= 0 || result.Revision > result.CollectionRevision) throw InvalidSavedView();
        return result;
    }

    public static byte[] EncodeSavedViewCatalog(SavedViewCatalog catalog)
    {
        var writer = new Writer();
        writer.I64(catalog.CollectionRevision);
        writer.Uuid(catalog.NextId);
        writer.I32(catalog.Views.Count);
        foreach (var view in catalog.Views)
        {
            writer.Uuid(view.Id);
            writer.I64(view.Revision);
            writer.Text(view.Name, WireLimits.SavedViewNameBytes);
        }
        return Aeds.Encode(FrameType.SavedViewCatalog, writer.Written);
    }

    public static SavedViewCatalog DecodeSavedViewCatalog(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.SavedViewCatalog));
        var revision = reader.I64();
        var next = reader.Uuid();
        var count = reader.I32();
        if (revision < 0 || count is < 0 or > WireLimits.SavedViewPageSize) throw InvalidSavedView();
        var views = new SavedViewSummary[count];
        for (var i = 0; i < count; i++)
        {
            var entry = views[i] = new(reader.Uuid(), reader.I64(), reader.Text(WireLimits.SavedViewNameBytes));
            if (entry.Id == Guid.Empty || entry.Revision <= 0 || entry.Revision > revision || entry.Name != NormalizeSavedViewName(entry.Name) ||
                i > 0 && entry.Id.CompareTo(views[i - 1].Id) <= 0) throw InvalidSavedView();
        }
        reader.Finish();
        if (next != Guid.Empty && (count != WireLimits.SavedViewPageSize || next != views[^1].Id)) throw InvalidSavedView();
        return new(revision, next, views);
    }

    public static byte[] EncodeSavedViewExecute(SavedViewExecute value)
    {
        Validate(value);
        var writer = new Writer();
        writer.Uuid(value.Id);
        writer.I64(value.Revision);
        writer.Text(value.Cursor, WireLimits.PropertyQueryCursorChars);
        return Aeds.Encode(FrameType.SavedViewExecute, writer.Written);
    }

    public static SavedViewExecute DecodeSavedViewExecute(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.SavedViewExecute));
        var result = new SavedViewExecute(reader.Uuid(), reader.I64(), reader.Text(WireLimits.PropertyQueryCursorChars));
        reader.Finish();
        Validate(result);
        return result;
    }

    public static byte[] EncodeSavedViewDefinition(IReadOnlyList<SavedViewCondition> conditions, string keyword = "")
    {
        Validate(new PropertyArticleQueryGroup(1, conditions.Select(item => new PropertyCondition(item.DefinitionId, 1,
            item.Comparison, item.Value, item.AnyOf)).ToArray(), "", keyword));
        var version = conditions.Any(item => item.AnyOf) ? 7 : keyword.Length != 0 ? 6 : conditions.Max(item => item.Comparison switch
        {
            PropertyComparison.ReferenceAnyOf => 5,
            PropertyComparison.SingleSelectAnyOf => 4,
            PropertyComparison.MultiSelectAnyOf => 3,
            PropertyComparison.IsPresent => 2,
            _ => 1,
        });
        var writer = new Writer();
        writer.I32(version);
        if (version >= 6) writer.Text(keyword, WireLimits.AuthorArticleKeywordChars * 4);
        writer.I32(conditions.Count);
        foreach (var item in conditions.OrderBy(item => item.DefinitionId).ThenBy(item => item.Comparison)
                     .ThenBy(item => item.AnyOf ? PropertyOperandKey(item.Value) : "", StringComparer.Ordinal))
        {
            writer.Uuid(item.DefinitionId);
            writer.I32((int)item.Kind);
            writer.I32(PropertyComparisonCode(item.Comparison, item.AnyOf));
            if (item.Comparison is PropertyComparison.SingleSelectAnyOf or PropertyComparison.MultiSelectAnyOf)
            {
                var expectedKind = item.Comparison == PropertyComparison.SingleSelectAnyOf ? PropertyFieldKind.SingleSelect : PropertyFieldKind.MultiSelect;
                if (item.Kind != expectedKind || item.Value is not PropertyFieldValue.MultiSelect options ||
                    options.Value.Count > WireLimits.PropertyOptionCount)
                    throw InvalidSavedView();
                WriteValue(writer, new PropertyFieldValue.MultiSelect(options.Value.Order().ToArray()));
            }
            else if (item.Comparison == PropertyComparison.ReferenceAnyOf)
            {
                if (item.Kind != PropertyFieldKind.ArticleReference || item.Value is not PropertyFieldValue.ArticleReference references ||
                    references.Value.Count > WireLimits.PropertyOptionCount)
                    throw InvalidSavedView();
                WriteValue(writer, new PropertyFieldValue.ArticleReference(references.Value.Order().ToArray()));
            }
            else WriteValue(writer, item.Value);
        }
        return writer.Written.ToArray();
    }

    public static SavedViewDefinition DecodeSavedViewDefinition(ReadOnlySpan<byte> encoded, byte[] digest)
    {
        if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(encoded), digest)) throw InvalidSavedView();
        var reader = new Reader(encoded);
        var version = reader.I32();
        if (version is < 1 or > 7) throw InvalidSavedView();
        var keyword = version >= 6 ? reader.Text(WireLimits.AuthorArticleKeywordChars * 4) : "";
        var count = reader.I32();
        if (count is < 1 or > WireLimits.PropertyQueryConditionCount) throw InvalidSavedView();
        var conditions = new SavedViewCondition[count];
        for (var i = 0; i < count; ++i)
        {
            var definition = reader.Uuid();
            var kind = ReadKind(ref reader);
            var (comparison, anyOf) = ReadPropertyComparison(ref reader);
            conditions[i] = new(definition, kind, comparison, ReadValue(ref reader), anyOf);
        }
        reader.Finish();
        if (!encoded.SequenceEqual(EncodeSavedViewDefinition(conditions, keyword))) throw InvalidSavedView();
        return new(conditions, keyword);
    }

    private static void Validate(SavedViewExecute value)
    {
        if (value.Id == Guid.Empty || value.Revision <= 0 || !ValidCursor(value.Cursor)) throw InvalidSavedView();
    }

    private static void Validate(SavedViewCommand value)
    {
        if (value.Id == Guid.Empty || value.RequestId == Guid.Empty || value.Revision < 0 || value.CollectionRevision < value.Revision ||
            !Enum.IsDefined(value.Action) || value.Action != SavedViewAction.Save && value.Revision == 0 ||
            (value.Action == SavedViewAction.Save) != (value.Query is not null) || value.Query is { Cursor.Length: > 0 })
            throw InvalidSavedView();
        if (value.Action == SavedViewAction.Retire)
        {
            if (value.Name.Length != 0) throw InvalidSavedView();
        }
        else NormalizeSavedViewName(value.Name);
    }

    private static ProtocolException InvalidSavedView() => new("Invalid saved view.");
}
