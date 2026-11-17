using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal static partial class AuthorTextIndex
{
    internal static async Task<AuthorTextFacetedPage> ReadPropertyText(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        AuthorTextFacetedQuery input, AuthorTextPropertyTextQuery query, AuthorTextRankKey? after, byte[]? expectedGeneration,
        CancellationToken ct, PropertyStore.FacetSelection? facet = null, PropertyStore.SortSelection? sort = null,
        bool mixed = false, bool includeHeading = false)
    {
        AuthorTextContinuation.Validate(after, expectedGeneration);
        var properties = new PropertyStore(db, tx, actor);
        var search = query.Search;
        var (conditions, facetDefinition, sortDefinition, text) = await ResolvePropertySearch(
            db, tx, actor, properties, search.SchemaRevision, search.Conditions, after, ct, facet, sort, query);

        if (after is null)
        {
            if (mixed) await Reconcile(db, tx, actor.Id, ct, includeSummary: true, includeHeading: includeHeading);
            await properties.ReconcileTextProjection(text!, ct);
        }
        return await ReadFacets(db, tx, actor, input, after, expectedGeneration, ct,
            new(search.UpdatedFromUnixMs, search.UpdatedUntilUnixMs, conditions, facetDefinition, sortDefinition, text, mixed),
            includeSummary: mixed, includeHeading: includeHeading);
    }

    // Resolves the shared property/search lock boundary before either query reads its result cohort.
    private static async Task<(PropertyStore.Condition[] Conditions, PropertyStore.FacetDefinition? Facet,
        PropertyStore.SortDefinition? Sort, AuthorTextPropertyScope? Text)> ResolvePropertySearch(
        NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, PropertyStore properties, long schemaRevision,
        IReadOnlyList<PropertyCondition> input, AuthorTextRankKey? after, CancellationToken ct,
        PropertyStore.FacetSelection? facet, PropertyStore.SortSelection? sort, AuthorTextPropertyTextQuery? textQuery = null)
    {
        try
        {
            var (conditions, facetDefinition, sortDefinition, text) = await properties.ResolveSearchAdmission(
                schemaRevision, input, facet, sort, textQuery, ct);
            await Store.LockCommand(db, tx, actor.Id, Scope, ct);
            if (conditions.Length != 0) await properties.ValidateQueryReferences(conditions, ct);
            return (conditions, facetDefinition, sortDefinition, text);
        }
        catch (BusinessException error) when (after.HasValue && error.Rejection is Rejection.NotFound or Rejection.Conflict or Rejection.Invalid)
        {
            throw AuthorTextContinuation.Invalid();
        }
        catch (PropertyValidationException)
        {
            throw after.HasValue ? AuthorTextContinuation.Invalid() : new BusinessException(Rejection.Invalid, "Invalid article property.");
        }
        catch (PropertySchemaException)
        {
            throw after.HasValue ? AuthorTextContinuation.Invalid() : new BusinessException(Rejection.Conflict, "The property definition changed or cannot be updated.");
        }
    }

    private readonly record struct PropertyTextParameters(int Definition, int Revision);

    private static PropertyTextParameters? AddPropertyTextParameters(List<object> parameters, AuthorTextPropertyScope? text)
    {
        if (text is null) return null;
        parameters.Add(text.Definition.Id);
        parameters.Add(text.Definition.Revision);
        return new(parameters.Count - 1, parameters.Count);
    }

    private static string FacetedSourceGeneration(List<object> parameters, QualifiedFilters? qualification, PropertyTextParameters? text)
    {
        var generation = SourceGeneration(parameters, qualification);
        return text is { } projected
            ? $"select pg_catalog.sha256(({generation}) || ({AuthorTextPropertyIndex.Witness(projected.Definition, projected.Revision)}))"
            : generation;
    }

    private static string PropertyTextClauseHits(int definition) => $$"""
            select e.id as article_id,q.clause,q.phrase,q.field,p.ordinal,p.start_u16,p.end_u16,p.start_u8,p.end_u8,{{MatchCoordinates("e", true)}}
            from eligible e
            join requirements q on q.step=0 and q.field={{(int)AuthorTextField.PropertyText}}
            cross join lateral (
                select c.ordinal,c.start_u16,c.end_u16,c.start_u8,c.end_u8
                from public.author_text_property_posting c
                where c.owner_id=$1 and c.definition_id=${{definition}} and c.term=q.term and c.article_id=e.id
                  and not exists (
                    select from requirements rest where rest.clause=q.clause and rest.step>0 and not exists (
                        select from public.author_text_property_posting n
                        where n.owner_id=$1 and n.definition_id=${{definition}} and n.term=rest.term and n.article_id=e.id
                          and (not q.phrase or n.ordinal=c.ordinal+rest.step)
                    )
                  )
                order by c.ordinal limit 1
            ) p
            where (select admitted from witness)
            """;

    private static string PropertyTextSourceJoins(int definition) => $$"""
        left join property_text_source s on s.article_id=p.article_id
        left join public.property_value v on v.owner_id=$1 and v.article_id=p.article_id and v.definition_id=${{definition}}
        left join public.author_text_property_document pd on pd.owner_id=$1 and pd.article_id=p.article_id and pd.definition_id=${{definition}}
            and pd.definition_revision=s.definition_revision and pd.value_revision=s.value_revision
        """;
}
