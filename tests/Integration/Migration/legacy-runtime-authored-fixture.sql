-- Apply before the production rollback overlay so it clones the exact original responsibility disclosure.
UPDATE public.article_responsibility_snapshot
SET authors_json='[{"name":"  Lead Writer  ","profileUrl":" HTTPS://AUTHORS.EXAMPLE:443/lead "},{"name":" Contributor ","profileUrl":null}]',
    reviewer_json='{"name":" Review Lead ","profileUrl":"https://127.0.0.1/reviewer"}',
    sources_json='[{"title":" Public source A ","url":" HTTPS://SOURCES.EXAMPLE:443/study-a ","sourceType":" report ","accessedOn":"2026-09-29","version":" 2.1 ","citationNote":" Author notes ","isPublic":true},{"title":"PRIVATE_CUSTODY_SENTINEL","url":"https://internal.example/private-custody-sentinel","sourceType":"record","accessedOn":null,"version":null,"citationNote":"Retain only in raw custody","isPublic":false},{"title":" Local address source ","url":"http://127.0.0.1/local","sourceType":"dataset","accessedOn":null,"version":null,"citationNote":null,"isPublic":true},{"title":" Public source B ","url":"https://sources.example/study-b","sourceType":"  ","accessedOn":null,"version":null,"citationNote":null}]',
    update_summary='  First revision reviewed  ', update_reason='  Verified sources  ',
    effective_at='2026-10-02 12:34:56.123456', conclusion_impact=' ClArIfIeD ',
    methodology='  Comparison protocol  ', applicability='  Public samples  ', limitations='  Limited coverage  '
WHERE id=799;

\if :malformed_disclosure
UPDATE public.article_responsibility_snapshot
SET authors_json='[{"name":true,"profileUrl":null}]'
WHERE id=799;
\endif
