# Sourced by the cover proof and import runners, after their owned-resource cleanup trap is installed.
export PGUSER=cover_fixture PGPORT=54995
unset PGSERVICE PGSERVICEFILE PGPASSWORD PGPASSFILE PGOPTIONS PGHOSTADDR
for lane in source target; do
    mkdir -m 700 "$scratch/$lane-s"
    initdb --no-locale --encoding=UTF8 --auth=trust -D "$scratch/$lane" -U "$PGUSER" > "$scratch/$lane-init.log"
    pg_ctl -D "$scratch/$lane" -l "$scratch/$lane.log" -o "-k $scratch/$lane-s -p $PGPORT -c listen_addresses=''" -w start
 done
pg() { local lane="$1" db="$2"; shift 2; psql -Xq --no-password -v ON_ERROR_STOP=1 -h "$scratch/$lane-s" -p "$PGPORT" -U "$PGUSER" -d "$db" "$@"; }
dsn() { printf 'Host=%s/%s-s;Port=%s;Username=%s;Database=%s;SSL Mode=Disable' "$scratch" "$1" "$PGPORT" "$PGUSER" "$2"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
source=fsusv2_cover_source
target=fsusv2_import_cover
owner=968ffb2b-77ef-4868-89ec-6a0a19b28b95
asset=1a550000-0000-4000-8000-000000000001
pg source postgres -c "CREATE DATABASE $source TEMPLATE template0"
pg target postgres -c "CREATE DATABASE $target TEMPLATE template0"
pg source "$source" -f tests/Integration/Migration/legacy-source-fixture.sql -f tests/Integration/Migration/legacy-shared-rights-fixture.sql -f tests/Integration/Migration/legacy-assets-fixture.sql
