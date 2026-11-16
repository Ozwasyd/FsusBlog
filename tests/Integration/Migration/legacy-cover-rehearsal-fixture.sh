# Sourced by the cover proof and import runners, after their owned-resource cleanup trap is installed.
"${migrate[@]}" legacy assets rehearsal plan postgres "$scratch/public" "$scratch/private" 87bcdd48-255d-49dd-a984-dd4c4ee6f9d4 "$target_site" > "$scratch/review.json"
python3 - "$scratch/review.json" "$owner" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); v=json.loads(p.read_text()); v['owners'][0]['targetUserId']=sys.argv[2]; p.write_text(json.dumps(v))
PY
"${migrate[@]}" legacy assets rehearsal copy postgres "$scratch/public" "$scratch/private" "$scratch/review.json" "$(sha "$scratch/review.json")" "$scratch/packages" media > "$scratch/copied.json"
media_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["manifestSha256"])' "$scratch/copied.json")"
"${migrate[@]}" legacy plan postgres > "$scratch/intake.json" || [[ $? == 2 ]]
python3 - "$scratch/intake.json" "$scratch/owners.json" "$owner" <<'PY'
import json,pathlib,sys
v=json.load(open(sys.argv[1])); a=next(x for x in v['audit']['projections'] if x['table']=='article')
pathlib.Path(sys.argv[2]).write_text(json.dumps(dict(sourceArticleSha256=a['sha256'],sourceAdminIdentitySha256=v['sourceAdminIdentitySha256'],owners=[dict(articleId=42,legacyAdminId=7,v2UserId=sys.argv[3])])))
assert any(x['category']=='attachment-reference' for x in v['importAdmission']['findings'])
PY
owners_sha="$(sha "$scratch/owners.json")"
revision_sha="$(python3 -c 'import json,sys; print(next(x["sha256"] for x in json.load(open(sys.argv[1]))["audit"]["projections"] if x["table"]=="article_revision"))' "$scratch/intake.json")"
publication_sha="$(python3 -c 'import json,sys; print(next(x["sha256"] for x in json.load(open(sys.argv[1]))["audit"]["projections"] if x["table"]=="article_publication"))' "$scratch/intake.json")"
proof=("${migrate[@]}" legacy covers proof postgres "$scratch/packages/media" "$media_sha" "$scratch/owners.json" "$owners_sha" "$revision_sha" "$publication_sha")
"${proof[@]}" > "$scratch/proof.json"
"${proof[@]}" > "$scratch/repeat.json"
cmp "$scratch/proof.json" "$scratch/repeat.json"
