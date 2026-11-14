create table public.taxonomy_epoch (
    singleton boolean primary key check (singleton),
    revision bigint not null check (revision >= 0)
);
insert into public.taxonomy_epoch values (true, 0);

create table public.admin_tag_metadata_command (
    principal_id uuid not null references public.admin_principal(id),
    request_id uuid not null,
    tag_id integer not null references public.tag(id),
    revision bigint not null check (revision >= 0),
    old_name text not null,
    old_description text not null,
    name text not null,
    description text not null,
    changed boolean not null,
    fingerprint bytea not null check (octet_length(fingerprint) = 32),
    session_reference bytea not null check (octet_length(session_reference) = 32),
    happened_at timestamptz not null,
    primary key (principal_id, request_id)
);
create index admin_tag_metadata_revision on public.admin_tag_metadata_command(tag_id, revision desc) where changed;
