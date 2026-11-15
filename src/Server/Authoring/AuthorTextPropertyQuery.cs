using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal static partial class AuthorTextIndex
{
    internal static async Task<AuthorTextFacetedPage> ReadPropertyText(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        AuthorTextFacetedQuery input, AuthorTextPropertyTextQuery query, AuthorTextRankKey? after, byte[]? expectedGeneration,
        CancellationToken ct)
    {
        ValidateContinuation(after, expectedGeneration);
        var properties = new PropertyStore(db, tx, actor);
        var search = query.Search;
        AuthorTextPropertyScope text;
        PropertyStore.Condition[] conditions = [];
        try
        {
            // Hold the property scope before any reference or result article locks.
            text = await properties.ResolveTextProjection(search.SchemaRevision, query.DefinitionId, query.DefinitionRevision, ct);
            if (search.Conditions.Count != 0)
                conditions = await properties.ResolveQuery(search.SchemaRevision, search.Conditions, ct);
            await Store.LockCommand(db, tx, actor.Id, Scope, ct);
            if (conditions.Length != 0) await properties.ValidateQueryReferences(conditions, ct);
        }
        catch (BusinessException error) when (after.HasValue && error.Rejection is Rejection.NotFound or Rejection.Conflict or Rejection.Invalid)
        {
            throw AuthorTextCursor.Invalid();
        }
        catch (PropertyValidationException)
        {
            throw after.HasValue ? AuthorTextCursor.Invalid() : new BusinessException(Rejection.Invalid, "Invalid article property.");
        }
        catch (PropertySchemaException)
        {
            throw after.HasValue ? AuthorTextCursor.Invalid() : new BusinessException(Rejection.Conflict, "The property definition changed or cannot be updated.");
        }

        if (after is null) await properties.ReconcileTextProjection(text, ct);
        return await ReadFacets(db, tx, actor, input, after, expectedGeneration, ct,
            new(search.UpdatedFromUnixMs, search.UpdatedUntilUnixMs, conditions, null, PropertyText: text));
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

    private static string PropertyTextMatchCtes(int definition) => $$"""
        requirements as (
            select * from unnest($2::integer[],$3::integer[],$4::boolean[],$5::integer[],$6::bytea[])
                q(clause,field,phrase,step,term)
        ),
        clause_hits as materialized (
            select e.id as article_id,q.clause,q.phrase,q.field,p.start_u16,p.end_u16,p.start_u8,p.end_u8,{{MatchCoordinates("e", true)}}
            from eligible e
            join requirements q on q.step=0 and q.field={{(int)AuthorTextField.PropertyText}}
            cross join lateral (
                select c.start_u16,c.end_u16,c.start_u8,c.end_u8
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
        ),
        ranked_hits as (
            select h.article_id,{{MatchCoordinates("h", true)}},
                count(*) filter (where h.phrase)::integer as phrase_rank,count(*)::integer as field_rank
            from clause_hits h
            group by h.article_id,{{MatchCoordinates("h", true)}} having count(*)=$7
        )
        """;

    private static string PropertyTextSourceJoins(int definition) => $$"""
        left join property_text_source s on s.article_id=p.article_id
        left join public.property_value v on v.owner_id=$1 and v.article_id=p.article_id and v.definition_id=${{definition}}
        left join public.author_text_property_document d on d.owner_id=$1 and d.article_id=p.article_id and d.definition_id=${{definition}}
            and d.definition_revision=s.definition_revision and d.value_revision=s.value_revision
        """;
}
