# Sourced only by legacy-cover-import.sh --prepare, using its synthetic source and private output tree.
seed_cover_images() {
    python3 tests/Integration/Migration/legacy-image-fixture.py "$scratch/public/illustration/$historical_leaf" "$scratch/public/illustration/$current_leaf"
    local name type extension
    for name in "$historical_leaf" "$current_leaf"; do
        type=image/png; extension=.png
        if [[ "$name" == "$current_leaf" ]]; then type=image/jpeg; extension=.jpeg; fi
        pg source "$source" -c "UPDATE content_asset SET media_type='$type',extension='$extension',width=2,height=2,
            byte_length=$(wc -c < "$scratch/public/illustration/$name"),sha256='$(sha "$scratch/public/illustration/$name")'
            WHERE storage_key='illustration/$name'"
    done
}

prove_cover_preparation() {
    local server="${FSUSBLOG_SERVER_DLL:-$PWD/src/Server/bin/Release/net10.0/FsusBlog.V2.Server.dll}" request_sha normalizer_sha prepared_sha leaf
    local -a input=("$scratch/import.json" "$plan_sha" "$baseline" "$baseline_sha" "$scratch/packages/media" "$media_sha" "$scratch/proof.json" "$(sha "$scratch/proof.json")")
    local -a request=("${migrate[@]}" legacy covers prepare-request "${input[@]}")
    local -a normalizer=("$dotnet_bin" "$server" legacy-media)
    mkdir -m 700 "$scratch/prepared"
    FSUSBLOG_V1_DB= "${request[@]}" > "$scratch/cover-request.json"
    "${request[@]}" > "$scratch/cover-repeat.json"
    cmp "$scratch/cover-request.json" "$scratch/cover-repeat.json"
    request_sha="$(sha "$scratch/cover-request.json")"
    "${normalizer[@]}" normalizer > "$scratch/normalizer.json"
    normalizer_sha="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["normalizerSha256"])' "$scratch/normalizer.json")"
    # Neither a changed checkpoint nor a changed public baseline may produce a request.
    pg target "$target" -c "UPDATE fsus_legacy_candidate.checkpoint SET digest='$zeros' WHERE phase=1"
    refuse prepare-checkpoint "${request[@]}"
    pg target "$target" -c "UPDATE fsus_legacy_candidate.checkpoint SET digest='$checkpoint' WHERE phase=1; UPDATE public.blog_user SET name='Changed'"
    refuse prepare-baseline "${request[@]}"
    pg target "$target" -c "UPDATE public.blog_user SET name='Cover fixture'"
    refuse private-request-mode "${normalizer[@]}" prepare "$scratch/cover-request.json" "$request_sha" "$scratch/packages/media" "$normalizer_sha" "$scratch/prepared" wrong-mode
    refuse wrong-normalizer "${normalizer[@]}" prepare-cover "$scratch/cover-request.json" "$request_sha" "$scratch/packages/media" "$zeros" "$scratch/prepared" wrong-normalizer
    for name in first repeat; do
        "${normalizer[@]}" prepare-cover "$scratch/cover-request.json" "$request_sha" "$scratch/packages/media" "$normalizer_sha" "$scratch/prepared" "$name" > "$scratch/prepared-$name.json"
    done
    cmp "$scratch/prepared/first/manifest.json" "$scratch/prepared/repeat/manifest.json"
    prepared_sha="$(sha "$scratch/prepared/first/manifest.json")"
    local -a verify=("${migrate[@]}" legacy covers prepare-verify "${input[@]}" "$scratch/prepared/first" "$prepared_sha" "$normalizer_sha")
    "${verify[@]}" > "$scratch/prepared-verified.json"
    "${verify[@]}" > "$scratch/prepared-verified-repeat.json"
    cmp "$scratch/prepared-verified.json" "$scratch/prepared-verified-repeat.json"
    refuse existing-output "${normalizer[@]}" prepare-cover "$scratch/cover-request.json" "$request_sha" "$scratch/packages/media" "$normalizer_sha" "$scratch/prepared" first
    python3 - "$scratch/cover-request.json" "$scratch/prepared/first" "$scratch/prepared/repeat" <<'PYPAYLOAD'
import hashlib,json,pathlib,sys
request=json.load(open(sys.argv[1])); root=pathlib.Path(sys.argv[2]); repeat=pathlib.Path(sys.argv[3]); result=json.loads((root/'manifest.json').read_text())
assert result['format']=='fsusblog.legacy-cover-preparation-result.v1'
assert {r['format'] for r in result['assets']}=={1,2}
assert len(request['references'])==4 and all(r['role']=='cover' for r in request['references'])
assert any(r['rawSha256']!=r['normalizedSha256'] for r in result['assets'])
for row in result['assets']:
    leaf=row['assetId'].replace('-','')+'.blob'; data=(root/leaf).read_bytes()
    assert data==(repeat/leaf).read_bytes() and len(data)==row['length']
    assert hashlib.sha256(data).hexdigest()==row['normalizedSha256'] and (row['width'],row['height'])==(2,2)
PYPAYLOAD
    leaf="${asset//-/}.blob"
    chmod 0600 "$scratch/prepared/first/$leaf"; printf bad > "$scratch/prepared/first/$leaf"; chmod 0400 "$scratch/prepared/first/$leaf"
    refuse prepared-byte-tamper "${verify[@]}"
    chmod 0600 "$scratch/prepared/first/$leaf"; cat "$scratch/prepared/repeat/$leaf" > "$scratch/prepared/first/$leaf"; chmod 0400 "$scratch/prepared/first/$leaf"
    "${verify[@]}" > "$scratch/prepared-repaired.json"
    # Canonical altered requests with their actual hashes still cannot exceed bounds or misassign ownership.
    for mutation in owner dimensions pixels bytes; do
        python3 - "$scratch/cover-request.json" "$scratch/request-$mutation.json" "$mutation" <<'PYBAD'
import json,pathlib,sys
v=json.load(open(sys.argv[1])); kind=sys.argv[3]
if kind=='owner': v['assets'][0]['targetOwnerId']='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
elif kind=='dimensions': v['assets'][0]['width']=8193
elif kind=='pixels': v['assets'][0]['width']=8192;v['assets'][0]['height']=8192
else: v['assets'][0]['rawBytes']=20971521
pathlib.Path(sys.argv[2]).write_text(json.dumps(v,separators=(',',':')))
PYBAD
        refuse "request-$mutation" "${normalizer[@]}" prepare-cover "$scratch/request-$mutation.json" "$(sha "$scratch/request-$mutation.json")" "$scratch/packages/media" "$normalizer_sha" "$scratch/prepared" "bad-$mutation"
    done
    "${request[@]}" > "$scratch/cover-final.json"; cmp "$scratch/cover-request.json" "$scratch/cover-final.json"
    [[ "$(pg target "$target" -Atc 'SELECT count(*) FROM public.private_media')" == 0 ]]
    [[ "$(pg target "$target" -Atc 'SELECT count(*) FROM public.article_revision_cover')" == 0 ]]
    [[ "$(pg target "$target" -Atc 'SELECT version FROM public.v2_schema WHERE singleton')" == -1 ]]
    printf 'PASS: real pinned PNG/JPEG normalization, exact request/checkpoints/owners, independent payload rehash, deterministic isolated output, tamper/bounds/replay refusal; no database or serving writes.\n'
}
