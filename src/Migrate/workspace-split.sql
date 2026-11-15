alter table public.authoring_workspace
    add column secondary_active_article_id integer not null default 0 check (secondary_active_article_id >= 0),
    add column secondary_tabs integer[] not null default '{}'::integer[],
    add column focused_group integer not null default 0 check (focused_group >= 0 and focused_group <= 1),
    add check (cardinality(tabs) + cardinality(secondary_tabs) <= 100),
    add check (focused_group = 0 or secondary_active_article_id > 0);
