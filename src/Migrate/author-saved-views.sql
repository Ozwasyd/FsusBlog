create table public.author_saved_view_collection (
    site_id uuid not null,
    owner_id uuid not null references public.blog_user(id),
    revision bigint not null check (revision > 0),
    primary key (site_id, owner_id)
);

create table public.author_saved_view (
    site_id uuid not null,
    owner_id uuid not null,
    id uuid not null,
    revision bigint not null check (revision > 0),
    name text not null check (octet_length(name) <= 512),
    name_key bytea not null,
    definition bytea not null check (octet_length(definition) <= 262288),
    digest bytea not null check (octet_length(digest) = 32),
    retired boolean not null,
    primary key (site_id, owner_id, id),
    foreign key (site_id, owner_id) references public.author_saved_view_collection(site_id, owner_id)
);

create unique index author_saved_view_live_name on public.author_saved_view(site_id, owner_id, name_key) where not retired;

create table public.author_saved_view_command (
    site_id uuid not null,
    owner_id uuid not null,
    request_id uuid not null,
    view_id uuid not null,
    revision bigint not null check (revision > 0),
    collection_revision bigint not null check (collection_revision >= revision),
    action integer not null check (action >= 1 and action <= 3),
    fingerprint bytea not null check (octet_length(fingerprint) = 32),
    happened_at timestamptz not null,
    primary key (site_id, owner_id, request_id),
    foreign key (site_id, owner_id, view_id) references public.author_saved_view(site_id, owner_id, id)
);
