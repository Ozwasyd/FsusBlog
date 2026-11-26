namespace FsusBlog.V2.Integration.Tests;

internal static class TypedPropertyFixture
{
    internal static (PropertyFieldKind Kind, PropertyFieldValue Value)[] Samples(int target, Guid selected,
        IReadOnlyList<Guid> selections, string text, string url = "https://example.net/guide", decimal number = 9007199254740993.1234567m) =>
    [
        (PropertyFieldKind.Text, new PropertyFieldValue.Text(text)),
        (PropertyFieldKind.Number, new PropertyFieldValue.Number(number)),
        (PropertyFieldKind.Boolean, new PropertyFieldValue.Boolean(false)),
        (PropertyFieldKind.Date, new PropertyFieldValue.Date(DateTimeOffset.FromUnixTimeMilliseconds(1794669740123))),
        (PropertyFieldKind.SingleSelect, new PropertyFieldValue.SingleSelect(selected)),
        (PropertyFieldKind.MultiSelect, new PropertyFieldValue.MultiSelect(selections)),
        (PropertyFieldKind.ArticleReference, new PropertyFieldValue.ArticleReference([target])),
        (PropertyFieldKind.Url, new PropertyFieldValue.Url(url)),
    ];

    internal static async Task<Guid[]> CreateDefinitions(IReadOnlyList<(PropertyFieldKind Kind, PropertyFieldValue Value)> samples,
        IReadOnlyList<PropertyFieldOption> options, Func<int, (string Key, string Label)> name, Func<byte[], Task<byte[]>> send,
        Action<PropertyDefinitionCommand, byte[]>? assertReceipt = null)
    {
        var definitions = new Guid[samples.Count];
        for (var index = 0; index < definitions.Length; index++)
        {
            var (key, label) = name(index);
            var kind = samples[index].Kind;
            var definition = definitions[index] = Guid.NewGuid();
            var command = new PropertyDefinitionCommand(1, definition, Guid.NewGuid(), index, 0, key, label);
            var choices = kind is PropertyFieldKind.SingleSelect or PropertyFieldKind.MultiSelect ? options : [];
            var receipt = await send(Wire.EncodePropertySchemaInput(new(command, kind, choices)));
            assertReceipt?.Invoke(command, receipt);
        }
        return definitions;
    }

    internal static void AssertCreated(PropertyDefinitionCommand command, byte[] receipt) =>
        Assert.Equal(new PropertyCommandReceipt(command.DefinitionId, command.SchemaRevision + 1, 1),
            Wire.DecodePropertyCommandReceipt(receipt));
}
