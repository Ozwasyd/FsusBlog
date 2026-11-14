create table public.author_saved_view_default (
    site_id uuid not null,
    owner_id uuid not null,
    view_id uuid not null,
    primary key (site_id, owner_id),
    foreign key (site_id, owner_id, view_id) references public.author_saved_view(site_id, owner_id, id)
);

create table public.author_saved_view_pin (
    site_id uuid not null,
    owner_id uuid not null,
    view_id uuid not null,
    pin_order integer not null check (pin_order > 0),
    primary key (site_id, owner_id, view_id),
    foreign key (site_id, owner_id, view_id) references public.author_saved_view(site_id, owner_id, id),
    unique (site_id, owner_id, pin_order) deferrable initially deferred
);

create table public.author_saved_view_placement_command (
    site_id uuid not null,
    owner_id uuid not null,
    request_id uuid not null,
    view_id uuid not null,
    revision bigint not null check (revision > 0),
    collection_revision bigint not null check (collection_revision >= revision),
    action integer not null check (action >= 4 and action <= 8),
    before_id uuid,
    fingerprint bytea not null check (octet_length(fingerprint) = 32),
    happened_at timestamptz not null,
    primary key (site_id, owner_id, request_id),
    foreign key (site_id, owner_id, view_id) references public.author_saved_view(site_id, owner_id, id),
    foreign key (site_id, owner_id, before_id) references public.author_saved_view(site_id, owner_id, id)
);
