using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] AuthorTextPropertyIndexColumns =
    [
        "author_text_property_document owner_id:uuid definition_id:uuid article_id:int4 definition_revision:int8 value_revision:int8 source_digest:bytea",
        "author_text_property_posting owner_id:uuid definition_id:uuid article_id:int4 ordinal:int4 term:bytea start_u16:int4 end_u16:int4 start_u8:int4 end_u8:int4"
    ];

    private static readonly string[] AuthorTextPropertyIndexConstraints =
    [
        "author_text_property_document p owner_id,definition_id,article_id",
        "author_text_property_document f owner_id,definition_id public.property_definition:owner_id,id",
        "author_text_property_document f article_id,owner_id public.property_article:article_id,owner_id",
        "author_text_property_document c definition_revision definition_revision>0",
        "author_text_property_document c value_revision value_revision>0",
        "author_text_property_document c source_digest octet_length(source_digest)=32",
        "author_text_property_posting p owner_id,definition_id,term,article_id,ordinal",
        "author_text_property_posting u owner_id,definition_id,article_id,ordinal",
        "author_text_property_posting f owner_id,definition_id,article_id public.author_text_property_document:owner_id,definition_id,article_id",
        "author_text_property_posting c ordinal ordinal>=0ANDordinal<=16383",
        "author_text_property_posting c term octet_length(term)>=1ANDoctet_length(term)<=512",
        "author_text_property_posting c start_u16 start_u16>=0",
        "author_text_property_posting c end_u16 end_u16<=16384",
        "author_text_property_posting c start_u8 start_u8>=0",
        "author_text_property_posting c end_u8 end_u8<=65536",
        "author_text_property_posting c start_u16,end_u16 start_u16<end_u16",
        "author_text_property_posting c start_u8,end_u8 start_u8<end_u8"
    ];

    private static readonly string[] AuthorTextPropertyIndexRelations =
        ["public.author_text_property_document", "public.author_text_property_posting"];

    internal static async Task<bool> HasAuthorTextPropertyIndexAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            select case when count(obj.oid)=0 then 0
                        when count(*) filter (where obj.relkind='r')=2 then 1
                        else 2 end
            from (values (pg_catalog.to_regclass('public.author_text_property_document')),
                         (pg_catalog.to_regclass('public.author_text_property_posting'))) expected(oid)
            left join pg_catalog.pg_class obj on obj.oid=expected.oid
            """, db, tx);
        return Complete(await query.ExecuteScalarAsync(ct), 1,
            "The author full-text property index schema is incomplete.");
    }

    private static bool HasAuthorTextPropertyIndex(CatalogPresenceSnapshot catalog)
    {
        var present = 0;
        var matched = 0;
        foreach (var relation in AuthorTextPropertyIndexRelations)
        {
            if (catalog.GetRelationKind(relation) is not { } actualKind) continue;
            present++;
            if (actualKind == 'r') matched++;
        }
        var state = present == 0 ? 0 : matched == AuthorTextPropertyIndexRelations.Length ? 1 : 2;
        return Complete(state, 1, "The author full-text property index schema is incomplete.");
    }
}
