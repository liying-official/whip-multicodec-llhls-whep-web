#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'release packaging failed: %s\n' "$*" >&2
  exit 1
}

for command_name in awk basename cat chmod cmp comm cp dirname find grep gzip mkdir mktemp mv readlink rm sed sha256sum sort stat tar tr; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name"
done
export LC_ALL=C

if [[ $# -ne 1 ]]; then
  fail "usage: SOURCE_DATE_EPOCH=<unix-seconds> $0 <output.tar.gz>"
fi

if [[ ! ${SOURCE_DATE_EPOCH:-} =~ ^[0-9]+$ ]]; then
  fail "SOURCE_DATE_EPOCH must be a non-negative integer"
fi

script_path=$(readlink -f -- "$0")
source_dir=$(readlink -f -- "$(dirname -- "$script_path")/..")
output_archive=$(readlink -m -- "$1")
output_dir=$(dirname -- "$output_archive")
archive_name=$(basename -- "$output_archive")

# Reject special metadata before any content read or temporary output. The
# source manifest/config may be absent: staging regenerates/normalizes them.
require_regular_metadata() {
  [[ -f "$source_dir/$1" && ! -L "$source_dir/$1" ]] \
    || fail "$1 must be a regular, non-symlink file"
}
for metadata in tools/release-basename.txt README.md README.en.md BUILDING.md \
  VERSION.txt certs/README.txt tools/release-managed-files.txt; do
  require_regular_metadata "$metadata"
done
for metadata in SHA256SUMS config.env; do
  if [[ -e "$source_dir/$metadata" || -L "$source_dir/$metadata" ]]; then
    require_regular_metadata "$metadata"
  fi
done

[[ $archive_name == *.tar.gz ]] || fail "output name must end in .tar.gz"
release_root=${archive_name%.tar.gz}
[[ $release_root =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]] || fail "unsafe release root name"
expected_root=$(cat "$source_dir/tools/release-basename.txt")
[[ $release_root == "$expected_root" ]] || fail "output basename differs from tools/release-basename.txt"
for document in README.md README.en.md BUILDING.md; do
  documented_roots=$(grep -Eo 'obs-whip-multicodec-llhls-web-debian13-v[0-9.]+-weak-network-fix[0-9]+(-repaired-v[0-9]+)?' "$source_dir/$document" | sort -u)
  [[ $documented_roots == "$expected_root" ]] || fail "$document release basename does not match current release"
done
case "$output_archive" in
  "$source_dir"/*) fail "output archive must be outside the source tree" ;;
esac

[[ -f "$source_dir/VERSION.txt" ]] || fail "VERSION.txt is missing"
[[ $(tr -d '\r\n' < "$source_dir/VERSION.txt") == V1.35 ]] || fail "expected VERSION.txt to contain V1.35"
[[ -f "$source_dir/certs/README.txt" && ! -L "$source_dir/certs/README.txt" ]] \
  || fail "certs/README.txt must be a regular, non-symlink file"

mkdir -p -- "$output_dir"
[[ ! -e "$output_archive" ]] || fail "output already exists: $output_archive"
[[ ! -e "$output_archive.sha256" ]] || fail "sidecar already exists: $output_archive.sha256"

stage_parent=$(mktemp -d "${TMPDIR:-/tmp}/obs-release-stage.XXXXXX")
stage_release="$stage_parent/$release_root"
tmp_archive=$(mktemp "$output_dir/.${archive_name}.tmp.XXXXXX")
tmp_sidecar=$(mktemp "$output_dir/.${archive_name}.sha256.tmp.XXXXXX")
cleanup() {
  rm -rf -- "$stage_parent"
  rm -f -- "$tmp_archive" "$tmp_sidecar"
}
trap cleanup EXIT

mkdir -p -- "$stage_release"
tar -C "$source_dir" \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='logs' \
  --exclude='runtime' \
  --exclude='certs' \
  --exclude='config.local.env' \
  --exclude='CHANGELOG*' \
  --exclude='RELEASE_NOTES*' \
  --exclude='local-only' \
  --exclude='bin/.gitkeep' \
  -cf - . | tar -C "$stage_release" -xf -
mkdir -p -- "$stage_release/certs"
cp -p -- "$source_dir/certs/README.txt" "$stage_release/certs/README.txt"

# Never distribute a machine's configured hostnames, addresses or port mapping.
# Emit an unconfigured public template without changing the source deployment.
cat > "$stage_release/config.env" <<'PUBLIC_CONFIG'
PUBLIC_DOMAIN=
PUBLIC_HTTPS_PORT=443
TLS_CERT=certs/fullchain.pem
TLS_KEY=certs/privkey.pem
WHIP_IP=
INGEST_ALLOW_CIDRS=
PUBLIC_HOST=
PUBLIC_CONFIG

while IFS= read -r -d '' path; do
  [[ ! -L $path && -f $path ]] || fail "unsupported archive member: ${path#"$stage_release/"}"
done < <(find "$stage_release" ! -type d -print0)

forbidden_path=$(find "$stage_release" \
  \( -name .git -o -name node_modules -o -name logs -o -name runtime -o -name local-only \) \
  -print -quit)
if [[ -n $forbidden_path ]]; then
  fail "excluded build/runtime directory reached staging"
fi

forbidden_path=$(find "$stage_release" -type f \
  \( -iname 'CHANGELOG*' -o -iname 'RELEASE_NOTES*' -o -iname '*debug*report*' \
     -o -name '*.tar' -o -name '*.tar.gz' -o -name '*.tgz' -o -name '*.sha256' -o -name '*.log' \
     -o -name 'core' -o -name 'core.*' -o -name '*.tmp' -o -name '*.swp' -o -name '*~' \) \
  -print -quit)
if [[ -n $forbidden_path ]]; then
  fail "forbidden release artifact reached staging"
fi

find "$stage_release" -type d -exec chmod 0755 {} +
find "$stage_release" -type f -exec chmod 0644 {} +

executable_files=(
  bin/caddy_linux_amd64
  bin/caddy_linux_arm64
  bin/helper_linux_amd64
  bin/helper_linux_arm64
  bin/mediamtx_linux_amd64
  bin/mediamtx_linux_arm64
  diagnose.sh
  install-systemd.sh
  mediamtx-supervisor.sh
  service-manager.sh
  show-credentials.sh
  start.sh
  status.sh
  stop.sh
  uninstall.sh
  tests/caddy-authority.test.sh
  tests/control-plane-repair.test.sh
  tests/diagnose-exit-status.test.sh
  tests/dns-resolution.test.sh
  tests/install-systemd-trust.test.sh
  tests/package-release-preflight.test.sh
  tests/stop-clear-authorization.test.sh
  tests/whep-runtime.test.sh
  tools/package-release.sh
)
for relative_path in "${executable_files[@]}"; do
  [[ -f "$stage_release/$relative_path" ]] || fail "required executable is missing: $relative_path"
  chmod 0755 -- "$stage_release/$relative_path"
done

managed_list="$stage_release/tools/release-managed-files.txt"
actual_list="$stage_parent/actual-managed-files.txt"
[[ -f "$managed_list" && ! -L "$managed_list" ]] \
  || fail "tools/release-managed-files.txt must be a regular, non-symlink file"

managed_path_is_canonical() {
  local managed_path=$1 component
  [[ -n $managed_path && $managed_path != /* && $managed_path != ./* && $managed_path != -* ]]
  [[ $managed_path =~ ^[A-Za-z0-9_./-]+$ ]]
  [[ $managed_path != */ && $managed_path != *//* ]]
  IFS=/ read -r -a components <<< "$managed_path"
  for component in "${components[@]}"; do
    [[ -n $component && $component != . && $component != .. ]] || return 1
  done
}

while IFS= read -r managed_path || [[ -n $managed_path ]]; do
  [[ $managed_path != *$'\r'* ]] || fail "managed-file list contains CR"
  managed_path_is_canonical "$managed_path" \
    || fail "non-canonical managed path: $managed_path"
done < "$managed_list"
[[ -s "$managed_list" ]] || fail "managed-file list is empty"
sort -c -u -- "$managed_list" >/dev/null 2>&1 \
  || fail "managed-file list must be bytewise sorted and unique"

(
  cd "$stage_release"
  find . -type f ! -path './SHA256SUMS' -printf '%P\n' | sort
) > "$actual_list"
if ! cmp -s -- "$managed_list" "$actual_list"; then
  comm -23 -- "$managed_list" "$actual_list" \
    | sed 's/^/missing staged managed file: /' >&2
  comm -13 -- "$managed_list" "$actual_list" \
    | sed 's/^/unexpected staged managed file: /' >&2
  fail "staged file set does not match tools/release-managed-files.txt"
fi

(
  cd "$stage_release"
  while IFS= read -r managed_path; do
    sha256sum -- "$managed_path"
  done < tools/release-managed-files.txt
) > "$stage_release/SHA256SUMS"
chmod 0644 -- "$stage_release/SHA256SUMS"

(
  cd "$stage_release"
  exec 7<tools/release-managed-files.txt
  while IFS= read -r manifest_line || [[ -n $manifest_line ]]; do
    IFS= read -r expected_path <&7 || fail "SHA256SUMS has an extra entry"
    [[ $manifest_line =~ ^([0-9a-f]{64})\ \ ([A-Za-z0-9_./-]+)$ ]] \
      || fail "SHA256SUMS has malformed syntax"
    [[ ${BASH_REMATCH[2]} == "$expected_path" ]] \
      || fail "SHA256SUMS path order/set mismatch"
  done < SHA256SUMS
  if IFS= read -r expected_path <&7; then
    fail "SHA256SUMS is missing an entry"
  fi
  sha256sum -c SHA256SUMS >/dev/null
)

while IFS= read -r -d '' path; do
  mode=$(stat -c '%a' -- "$path")
  case "$mode" in
    644|755) ;;
    *) fail "unexpected regular-file mode $mode: ${path#"$stage_release/"}" ;;
  esac
  (( (8#$mode & 8#022) == 0 )) || fail "group/other-writable file: ${path#"$stage_release/"}"
done < <(find "$stage_release" -type f -print0)

while IFS= read -r -d '' path; do
  [[ $(stat -c '%a' -- "$path") == 755 ]] \
    || fail "unexpected directory mode: ${path#"$stage_release/"}"
done < <(find "$stage_release" -type d -print0)

LC_ALL=C tar \
  --sort=name \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --mtime="@$SOURCE_DATE_EPOCH" \
  --pax-option=delete=atime,delete=ctime \
  -C "$stage_parent" \
  -cf - "$release_root" | gzip -n -9 > "$tmp_archive"

archive_hash=$(sha256sum "$tmp_archive" | awk '{print $1}')
printf '%s  %s\n' "$archive_hash" "$archive_name" > "$tmp_sidecar"
chmod 0644 -- "$tmp_archive" "$tmp_sidecar"
mv -- "$tmp_archive" "$output_archive"
mv -- "$tmp_sidecar" "$output_archive.sha256"

printf 'release archive: %s\n' "$output_archive"
printf 'sha256: %s\n' "$archive_hash"
