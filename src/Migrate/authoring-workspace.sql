create table public.authoring_workspace (
    user_id uuid primary key references public.blog_user(id),
    schema_version integer not null check (schema_version = 1),
    revision bigint not null check (revision > 0),
    updated_at timestamptz not null,
    active_article_id integer not null check (active_article_id >= 0),
    tabs integer[] not null check (cardinality(tabs) <= 100)
);
