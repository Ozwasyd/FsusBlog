namespace FsusBlog.Server.Services.Authoring;

public static partial class ArticlePropertyDefinitionContract
{
    /// <summary>
    /// Reuses the canonical definition's payload/constraint policies for a typed article value.
    /// This does not validate article-reference target visibility, lifecycle or cycles.
    /// </summary>
    internal static void ValidateArticleValuePayload(
        ArticlePropertyDefinition definition,
        ArticlePropertyDefaultValue payload)
    {
        if (definition.ValueType == ArticlePropertyValueType.ArticleReference
            && definition.Cardinality == ArticlePropertyCardinality.Multiple
            && payload.Kind == ArticlePropertyDefaultKind.ArticleIds
            && payload.ArticleIds.Count == 0)
        {
            ValidateDefaultConstraints(definition, payload);
            return;
        }
        ValidateDefault(definition with
        {
            DefaultValue = payload
        });
    }
}
