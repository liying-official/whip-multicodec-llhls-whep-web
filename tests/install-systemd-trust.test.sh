#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

if [ "$(id -u)" -ne 0 ]; then
  echo "SKIP: install-systemd trust tests require root" >&2
  exit 77
fi

SOURCE_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
TEST_ROOT=$(mktemp -d /opt/obs-whip-install-trust.XXXXXX)
case "$TEST_ROOT" in
  /opt/obs-whip-install-trust.*) ;;
  *) echo "unsafe test root: $TEST_ROOT" >&2; exit 1 ;;
esac
cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

make_case() {
  case_path=$TEST_ROOT/$1
  mkdir -p "$case_path"
  cp -a "$SOURCE_ROOT/." "$case_path/"
  chown -R root:root "$case_path"
  chmod -R go-w "$case_path"
  printf '%s\n' "$case_path"
}

expect_reject() {
  case_name=$1
  case_path=$2
  expected_reason=$3
  if /bin/sh "$case_path/install-systemd.sh" --check-only \
    >"$TEST_ROOT/$case_name.stdout" 2>"$TEST_ROOT/$case_name.stderr"; then
    echo "FAIL: $case_name was accepted" >&2
    exit 1
  fi
  if ! grep -F -- "$expected_reason" "$TEST_ROOT/$case_name.stderr" >/dev/null 2>&1; then
    echo "FAIL: $case_name returned the wrong rejection reason" >&2
    sed -n '1,5p' "$TEST_ROOT/$case_name.stderr" >&2
    exit 1
  fi
  echo "PASS: $case_name rejected"
}

case_a=$(make_case case-a-owner)
chown -R 65534:65534 "$case_a"
expect_reject "ordinary-user-owner" "$case_a" "必须由 root 所有且不可被组/其他用户写入"

mkdir -p "$TEST_ROOT/case-b-parent"
chmod 0777 "$TEST_ROOT/case-b-parent"
case_b=$(make_case case-b-parent/project)
expect_reject "writable-parent" "$case_b" "必须由 root 所有且不可被组/其他用户写入"
chmod 0755 "$TEST_ROOT/case-b-parent"

case_c=$(make_case case-c-real)
ln -s "$case_c" "$TEST_ROOT/case-c-link"
expect_reject "symlink-root" "$TEST_ROOT/case-c-link" "项目路径包含符号链接"

case_d=$(make_case case-d-manager-link)
rm -f -- "$case_d/service-manager.sh"
ln -s /bin/true "$case_d/service-manager.sh"
expect_reject "service-manager-symlink" "$case_d" "service-manager.sh 是符号链接"

case_d2=$(make_case case-d2-ownership-helper-link)
rm -f -- "$case_d2/lib/systemd-unit-ownership.sh"
ln -s /bin/true "$case_d2/lib/systemd-unit-ownership.sh"
expect_reject "ownership-helper-symlink" "$case_d2" "systemd-unit-ownership.sh 是符号链接"

case_d3=$(make_case case-d3-managed-list-link)
rm -f -- "$case_d3/tools/release-managed-files.txt"
ln -s /dev/null "$case_d3/tools/release-managed-files.txt"
expect_reject "managed-list-symlink" "$case_d3" "release-managed-files.txt 是符号链接"

case_d4=$(make_case case-d4-managed-list-writable)
chmod g+w "$case_d4/tools/release-managed-files.txt"
expect_reject "managed-list-group-writable" "$case_d4" "必须由 root 所有且不可被组/其他用户写入"

case_e=$(make_case case-e-group-writable)
chmod g+w "$case_e"
expect_reject "group-writable-root" "$case_e" "必须由 root 所有且不可被组/其他用户写入"

case_f=$(make_case case-f-other-writable)
chmod o+w "$case_f"
expect_reject "other-writable-root" "$case_f" "必须由 root 所有且不可被组/其他用户写入"

case_g=$(make_case case-g-safe)
# The installer rejects an unconfigured config.env, so the safe fixture needs
# the mandatory fields filled in exactly like a real deployment.
printf 'PUBLIC_DOMAIN=live.example.com\nPUBLIC_HOST=rtc.example.com\n' > "$case_g/config.env"
/bin/sh "$case_g/install-systemd.sh" --check-only
echo "PASS: safe root-owned tree accepted"

# Build a deliberately minimal chroot that has only the commands needed for
# source-tree trust validation. It has no /run/systemd/system, systemctl,
# systemd-analyze, mktemp, or flock. --check-only must still succeed there.
case_minimal=$TEST_ROOT/case-g-minimal-root
mkdir -p "$case_minimal/opt" "$case_minimal/bin" "$case_minimal/usr/bin" "$case_minimal/dev"
cp -a "$case_g" "$case_minimal/opt/project"
: > "$case_minimal/dev/null"
chmod 0666 "$case_minimal/dev/null"

copy_chroot_binary() {
  source_binary=$(readlink -f -- "$1")
  destination=$2
  mkdir -p "$case_minimal$(dirname -- "$destination")"
  cp -- "$source_binary" "$case_minimal$destination"
  ldd "$source_binary" | while IFS= read -r dependency_line; do
    # Intentional field splitting: ldd emits one dependency record per line.
    # shellcheck disable=SC2086
    set -- $dependency_line
    dependency=
    if [ "${2:-}" = "=>" ]; then
      dependency=${3:-}
    else
      case "${1:-}" in /*) dependency=$1 ;; esac
    fi
    case "$dependency" in
      /*)
        mkdir -p "$case_minimal$(dirname -- "$dependency")"
        cp -- "$dependency" "$case_minimal$dependency"
        ;;
    esac
  done
}

copy_chroot_binary /bin/sh /bin/sh
for minimal_command in id realpath stat dirname; do
  command_path=$(command -v "$minimal_command")
  copy_chroot_binary "$command_path" "/usr/bin/$minimal_command"
done
chown -R root:root "$case_minimal"
chmod -R go-w "$case_minimal"
chroot "$case_minimal" /bin/sh /opt/project/install-systemd.sh --check-only
echo "PASS: check-only accepted a trusted tree without a systemd runtime"

case_h=$(make_case case-h-wrong-type)
rm -f -- "$case_h/web/app.js"
mkdir "$case_h/web/app.js"
expect_reject "critical-file-is-directory" "$case_h" "web/app.js 不是普通文件"

case_i=$(make_case case-i-no-exec)
chmod a-x "$case_i/bin/helper_linux_amd64"
expect_reject "bundled-binary-not-executable" "$case_i" "helper_linux_amd64 不可执行"

case_j=$(make_case case-j-unconfigured)
# A deployed source tree can already be configured; make this negative fixture explicit.
printf 'PUBLIC_DOMAIN=\nPUBLIC_HOST=\n' > "$case_j/config.env"
expect_reject "unconfigured-config-env" "$case_j" "config.env 尚未配置"
echo "PASS: unconfigured config.env rejected"

case_k=$(make_case case-k-manifest-missing)
rm -f -- "$case_k/SHA256SUMS"
expect_reject "manifest-missing" "$case_k" "缺少 $case_k/SHA256SUMS"
echo "PASS: missing SHA256SUMS rejected"

case_l=$(make_case case-l-manifest-symlink)
rm -f -- "$case_l/SHA256SUMS"
ln -s /dev/null "$case_l/SHA256SUMS"
expect_reject "manifest-symlink" "$case_l" "SHA256SUMS 是符号链接"
echo "PASS: symlinked SHA256SUMS rejected"

case_m=$(make_case case-m-manifest-directory)
rm -f -- "$case_m/SHA256SUMS"
mkdir "$case_m/SHA256SUMS"
expect_reject "manifest-is-directory" "$case_m" "SHA256SUMS 不是普通文件"
echo "PASS: directory SHA256SUMS rejected"
