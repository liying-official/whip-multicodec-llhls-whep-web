#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

if [ "$(id -u)" -ne 0 ]; then
  echo "SKIP: control-plane repair tests require root" >&2
  exit 77
fi

for required_command in chroot cp dirname grep ldd mkfifo mktemp python3 readlink rm sed setpriv sha256sum stat timeout; do
  command -v "$required_command" >/dev/null 2>&1 || {
    echo "SKIP: missing required test command: $required_command" >&2
    exit 77
  }
done

SOURCE_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
TEST_ROOT=$(mktemp -d /opt/obs-whip-control-plane.XXXXXX)
case "$TEST_ROOT" in
  /opt/obs-whip-control-plane.*) ;;
  *) echo "unsafe test root: $TEST_ROOT" >&2; exit 1 ;;
esac
JAIL=$TEST_ROOT/jail
TRACE=$JAIL/state/calls
UNIT=$JAIL/etc/systemd/system/obs-whip-live.service

cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

copy_binary() {
  source_binary=$(readlink -f -- "$1")
  destination=$2
  mkdir -p "$JAIL$(dirname -- "$destination")"
  cp -- "$source_binary" "$JAIL$destination"
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
        mkdir -p "$JAIL$(dirname -- "$dependency")"
        cp -- "$dependency" "$JAIL$dependency"
        ;;
    esac
  done
}

mkdir -p "$JAIL/bin" "$JAIL/usr/bin" "$JAIL/usr/sbin" "$JAIL/sbin" \
  "$JAIL/dev" "$JAIL/etc/systemd/system" "$JAIL/run/systemd/system" \
  "$JAIL/opt" "$JAIL/state" "$JAIL/tmp"
printf '%s\n' 'root:x:0:0:root:/root:/bin/sh' > "$JAIL/etc/passwd"
printf '%s\n' 'root:x:0:' > "$JAIL/etc/group"
: > "$JAIL/dev/null"
chmod 0666 "$JAIL/dev/null"
chmod 1777 "$JAIL/tmp"
copy_binary /bin/sh /bin/sh
for command_name in awk cat chmod chown cp dirname flock grep id mkdir mktemp mv readlink realpath rm sed sha256sum sleep sort stat systemd-notify timeout touch tr uname; do
  command_path=$(command -v "$command_name")
  copy_binary "$command_path" "/usr/bin/$command_name"
done

# Installer stability verification intentionally lasts longer than every
# bounded start.sh preflight. Keep production timing intact while making the
# chroot regression deterministic and fast.
mv "$JAIL/usr/bin/sleep" "$JAIL/usr/bin/sleep.real"
cat > "$JAIL/usr/bin/sleep" <<'SLEEP'
#!/bin/sh
if [ -f /state/instant-sleep ]; then
  printf 'sleep %s\n' "$*" >> /state/calls
  exit 0
fi
exec /usr/bin/sleep.real "$@"
SLEEP
chmod 0755 "$JAIL/usr/bin/sleep"
: > "$JAIL/state/instant-sleep"

cat > "$JAIL/usr/bin/systemctl" <<'SYSTEMCTL'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> /state/calls
command_name=${1:-}
case "$command_name" in
  show)
    value_query=0
    startup_snapshot_query=0
    requested_property=
    for systemctl_arg in "$@"; do
      case "$systemctl_arg" in
        --value) value_query=1 ;;
        ActiveState|SubState|Result|ControlPID|ControlGroup) requested_property=$systemctl_arg ;;
        MainPID|NRestarts) startup_snapshot_query=1; requested_property=$systemctl_arg ;;
      esac
    done
    [ "$value_query" -eq 0 ] || startup_snapshot_query=0
    state=$(cat /state/manager)
    if [ "$startup_snapshot_query" -eq 1 ] && [ -s /state/startup-sequence ]; then
      state=$(sed -n '1p' /state/startup-sequence)
      sed -n '2,$p' /state/startup-sequence > /state/startup-sequence.tmp
      mv /state/startup-sequence.tmp /state/startup-sequence
      printf '%s\n' "$state" > /state/manager
    fi
    case "$state" in
      query-error) exit 1 ;;
      not-found) printf '%s\n' 'LoadState=not-found' 'ActiveState=inactive' 'MainPID=0'; exit 0 ;;
      not-found-active) printf '%s\n' 'LoadState=not-found' 'ActiveState=active' 'MainPID=1234'; exit 0 ;;
      loaded\|*) ;;
      *) exit 1 ;;
    esac
    old_ifs=$IFS
    IFS='|'
    set -- $state
    IFS=$old_ifs
    manager_root=$2
    active_state=$3
    exec_variant=${4:-normal}
    sub_state=${5:-}
    result_state=${6:-success}
    value_variant=${7:-normal}
    main_pid=${9:-1234}
    [ "$active_state" != inactive ] || main_pid=0
    restart_count=${10:-0}
    if [ -z "$sub_state" ]; then
      case "$active_state" in
        active) sub_state=running ;;
        activating) sub_state=auto-restart ;;
        inactive) sub_state=dead ;;
        failed) sub_state=failed ;;
        *) sub_state=$active_state ;;
      esac
    fi
    if [ "$startup_snapshot_query" -eq 1 ]; then
      [ "$value_variant" != query-error ] || exit 1
      case "$value_variant" in
        empty-active) active_state= ;;
        malformed-sub) sub_state='auto-restart garbage' ;;
      esac
      printf 'ActiveState=%s\n' "$active_state"
      printf 'SubState=%s\n' "$sub_state"
      printf 'Result=%s\n' "$result_state"
      printf 'MainPID=%s\n' "$main_pid"
      printf 'NRestarts=%s\n' "$restart_count"
      exit 0
    elif [ "$value_query" -eq 1 ]; then
      [ "$value_variant" != query-error ] || exit 1
      case "$requested_property:$value_variant" in
        ActiveState:empty-active) printf '\n' ;;
        SubState:malformed-sub) printf '%s\n' 'auto-restart garbage' ;;
        ActiveState:*) printf '%s\n' "$active_state" ;;
        SubState:*) printf '%s\n' "$sub_state" ;;
        Result:*) printf '%s\n' "$result_state" ;;
        MainPID:*) printf '%s\n' "$main_pid" ;;
        ControlPID:*) printf '%s\n' 0 ;;
        ControlGroup:*) printf '\n' ;;
        *) exit 1 ;;
      esac
      exit 0
    fi
    printf '%s\n' 'LoadState=loaded'
    printf '%s\n' 'FragmentPath=/etc/systemd/system/obs-whip-live.service'
    printf 'WorkingDirectory=%s\n' "$manager_root"
    case "$exec_variant" in
      normal)
        printf 'ExecStart={ path=/bin/sh ; argv[]=/bin/sh %s/service-manager.sh ; ignore_errors=no ; }\n' "$manager_root"
        ;;
      empty) printf '%s\n' 'ExecStart=' ;;
      malformed) printf '%s\n' 'ExecStart={ malformed serialization }' ;;
      mismatch) printf '%s\n' 'ExecStart={ path=/bin/sh ; argv[]=/bin/sh /opt/missing/service-manager.sh ; ignore_errors=no ; }' ;;
    esac
    printf 'ActiveState=%s\n' "$active_state"
    printf 'MainPID=%s\n' "$main_pid"
    ;;
  daemon-reload) [ ! -e /state/reload-fails ] ;;
  enable)
    manager_root=$(sed -n 's/^WorkingDirectory=//p' /etc/systemd/system/obs-whip-live.service)
    if [ -s /state/enable-sequence ]; then
      cp /state/enable-sequence /state/startup-sequence
      sed -n '1p' /state/enable-sequence > /state/manager
    elif [ -s /state/enable-state ]; then
      cat /state/enable-state > /state/manager
    else
      printf 'loaded|%s|active|normal|running|success|normal|clean|1234|0\n' "$manager_root" > /state/manager
    fi
    ;;
  is-active)
    state=$(cat /state/manager)
    old_ifs=$IFS
    IFS='|'
    set -- $state
    IFS=$old_ifs
    case "${3:-}" in active|activating|reloading) exit 0 ;; *) exit 1 ;; esac
    ;;
  stop)
    state=$(cat /state/manager)
    old_ifs=$IFS
    IFS='|'
    set -- $state
    IFS=$old_ifs
    manager_root=$2
    exec_variant=${4:-normal}
    stop_variant=${8:-clean}
    case "$stop_variant" in
      refused) exit 4 ;;
      failed)
        printf 'loaded|%s|failed|%s|failed|exit-code|normal|failed\n' \
          "$manager_root" "$exec_variant" > /state/manager.tmp
        ;;
      query-error)
        printf 'loaded|%s|inactive|%s|dead|success|query-error|query-error\n' \
          "$manager_root" "$exec_variant" > /state/manager.tmp
        ;;
      *)
        printf 'loaded|%s|inactive|%s|dead|success|normal|clean\n' \
          "$manager_root" "$exec_variant" > /state/manager.tmp
        ;;
    esac
    mv /state/manager.tmp /state/manager
    ;;
  disable) [ ! -e /state/disable-fails ] ;;
  reset-failed) ;;
  *) exit 1 ;;
esac
SYSTEMCTL
chmod 0755 "$JAIL/usr/bin/systemctl"

cat > "$JAIL/usr/bin/systemd-analyze" <<'SYSTEMD_ANALYZE'
#!/bin/sh
set -eu
printf 'systemd-analyze %s\n' "$*" >> /state/calls
exit 0
SYSTEMD_ANALYZE
chmod 0755 "$JAIL/usr/bin/systemd-analyze"

copy_project() {
  destination=$1
  rm -rf -- "$JAIL$destination"
  mkdir -p "$JAIL$destination"
  cp -a "$SOURCE_ROOT/." "$JAIL$destination/"
  printf '%s\n' \
    'PUBLIC_DOMAIN=live.example.com' \
    'PUBLIC_HOST=rtc.example.com' \
    'WHIP_IP=192.168.50.10' > "$JAIL$destination/config.env"
  chown -R root:root "$JAIL$destination"
  chmod -R go-w "$JAIL$destination"
}

copy_project /opt/root-a
copy_project /opt/root-b
copy_project /opt/root-b2
copy_project /opt/root-b-old
ln -s /opt/root-a "$JAIL/opt/root-a-alias"
ln -s /opt/root-b "$JAIL/opt/root-b-alias"

set_manager() {
  printf '%s\n' "$1" > "$JAIL/state/manager"
}

set_disk() {
  disk_root=$1
  cat > "$UNIT" <<EOF
[Service]
WorkingDirectory=$disk_root
ExecStart=/bin/sh $disk_root/service-manager.sh
EOF
  chown root:root "$UNIT"
  chmod 0644 "$UNIT"
}

reset_absent() {
  rm -f -- "$UNIT"
  rm -f -- "$JAIL/state/enable-state" "$JAIL/state/enable-sequence" \
    "$JAIL/state/startup-sequence"
  set_manager not-found
  : > "$TRACE"
  rm -rf -- "$JAIL/opt/root-a/runtime" "$JAIL/opt/root-a/logs"
}

reset_trace() {
  : > "$TRACE"
}

unit_file_snapshot() {
  if [ -e "$UNIT" ] || [ -L "$UNIT" ]; then
    sha256sum "$UNIT" | sed 's/ .*//'
  else
    printf '%s\n' ABSENT
  fi
}

run_jail() {
  output_name=$1
  shift
  if timeout 12 chroot "$JAIL" "$@" \
    > "$TEST_ROOT/$output_name.stdout" 2> "$TEST_ROOT/$output_name.stderr"; then
    RUN_RC=0
  else
    RUN_RC=$?
  fi
}

expect_rc() {
  expected=$1
  case_name=$2
  [ "$RUN_RC" -eq "$expected" ] || {
    sed -n '1,12p' "$TEST_ROOT/$case_name.stderr" >&2 || true
    fail "$case_name expected RC=$expected actual RC=$RUN_RC"
  }
}

assert_no_global_side_effect() {
  case_name=$1
  if grep -E '(^| )(daemon-reload|enable|stop|disable|reset-failed)( |$)|^systemd-analyze ' "$TRACE" >/dev/null 2>&1; then
    sed -n '1,30p' "$TRACE" >&2
    fail "$case_name produced a forbidden global side effect"
  fi
}

assert_trace_has() {
  pattern=$1
  case_name=$2
  grep -E "$pattern" "$TRACE" >/dev/null 2>&1 \
    || fail "$case_name missing expected trace: $pattern"
}

set_enable_state() {
  printf '%s\n' "$1" > "$JAIL/state/enable-state"
}

set_enable_sequence() {
  : > "$JAIL/state/enable-sequence"
  for startup_state in "$@"; do
    printf '%s\n' "$startup_state" >> "$JAIL/state/enable-sequence"
  done
}

assert_success_absent() {
  case_name=$1
  if grep -F 'systemd 服务已安全安装并启用：obs-whip-live.service' \
    "$TEST_ROOT/$case_name.stdout" "$TEST_ROOT/$case_name.stderr" >/dev/null 2>&1; then
    fail "$case_name printed the installer success message"
  fi
}

f1_install_reject() {
  case_name=$1
  enable_state=$2
  expected_diagnostic=$3
  reset_absent
  set_enable_state "$enable_state"
  run_jail "$case_name" /bin/sh /opt/root-a/install-systemd.sh
  expect_rc 1 "$case_name"
  assert_success_absent "$case_name"
  grep -F "$expected_diagnostic" "$TEST_ROOT/$case_name.stderr" >/dev/null \
    || fail "$case_name did not report expected state/query diagnostic"
  echo "PASS: F-1 $case_name RC=1 success-message=absent diagnostic=$expected_diagnostic"
}

fa01_install_reject_sequence() {
  case_name=$1
  expected_diagnostic=$2
  shift 2
  reset_absent
  set_enable_sequence "$@"
  run_jail "$case_name" /bin/sh /opt/root-a/install-systemd.sh
  expect_rc 1 "$case_name"
  assert_success_absent "$case_name"
  grep -F "$expected_diagnostic" "$TEST_ROOT/$case_name.stderr" >/dev/null \
    || fail "$case_name did not report expected stability diagnostic"
  sample_sleep_count=$(grep -c '^sleep 2$' "$TRACE" || true)
  [ "$sample_sleep_count" -ge 1 ] \
    || fail "$case_name did not enter the bounded stability window"
  echo "PASS: F-A-01 $case_name RC=1 success-message=absent sample-sleeps=$sample_sleep_count diagnostic=$expected_diagnostic"
}

ownership_install_fail() {
  case_name=$1
  reset_trace
  rm -rf -- "$JAIL/opt/root-a/runtime" "$JAIL/opt/root-a/logs"
  unit_hash_before=$(unit_file_snapshot)
  run_jail "$case_name" /bin/sh /opt/root-a/install-systemd.sh
  expect_rc 1 "$case_name"
  assert_no_global_side_effect "$case_name"
  unit_hash_after=$(unit_file_snapshot)
  [ "$unit_hash_after" = "$unit_hash_before" ] \
    || fail "$case_name changed the global unit before rejecting ownership"
  [ ! -e "$JAIL/opt/root-a/runtime" ] || fail "$case_name created runtime before rejecting ownership"
  echo "PASS: ownership $case_name RC=1 unit-sha256=$unit_hash_after no-global-side-effect"
}

# A failure after t=4 seconds proves that a one-shot or two-second resample is
# insufficient. Production must keep observing until the full 152-second
# bounded window ends; the fixture makes each two-second sleep instantaneous.
fa01_install_reject_sequence fa01-delayed-restart 'ActiveState=failed' \
  'loaded|/opt/root-a|active|normal|running|success|normal|clean|1234|0' \
  'loaded|/opt/root-a|active|normal|running|success|normal|clean|1234|0' \
  'loaded|/opt/root-a|active|normal|running|success|normal|clean|1234|0' \
  'loaded|/opt/root-a|failed|normal|auto-restart|exit-code|normal|clean|1234|1'
[ "$sample_sleep_count" -eq 3 ] \
  || fail "FA01 delayed failure was not sampled at t=6 after stable t=2/t=4 controls"

# Installer allow/deny matrix.
reset_absent
run_jail own-install-first /bin/sh /opt/root-a/install-systemd.sh
expect_rc 0 own-install-first
assert_trace_has '^daemon-reload$' own-install-first
assert_trace_has '^enable --now obs-whip-live.service$' own-install-first
success_count=$(grep -Fc 'systemd 服务已安全安装并启用：obs-whip-live.service' \
  "$TEST_ROOT/own-install-first.stdout")
[ "$success_count" -eq 1 ] || fail "F1-A expected exactly one installer success message"
stability_sleep_count=$(grep -c '^sleep 2$' "$TRACE" || true)
[ "$stability_sleep_count" -eq 76 ] \
  || fail "FA01 stable install did not complete the 152-second observation window"
echo "PASS: ownership install-first / F1-A / FA01-A stable-window RC=0 success-message-count=1 sample-sleeps=$stability_sleep_count"

reset_trace
run_jail own-install-same /bin/sh /opt/root-a/install-systemd.sh
expect_rc 0 own-install-same
echo "PASS: ownership install-same-root RC=0"

fa01_install_reject_sequence fa01-mainpid-changed 'MainPID=5678' \
  'loaded|/opt/root-a|active|normal|running|success|normal|clean|1234|0' \
  'loaded|/opt/root-a|active|normal|running|success|normal|clean|5678|0'
fa01_install_reject_sequence fa01-restarts-increased 'NRestarts=1' \
  'loaded|/opt/root-a|active|normal|running|success|normal|clean|1234|0' \
  'loaded|/opt/root-a|active|normal|running|success|normal|clean|1234|1'
fa01_install_reject_sequence fa01-result-exit-code 'Result=exit-code' \
  'loaded|/opt/root-a|active|normal|running|success|normal|clean|1234|0' \
  'loaded|/opt/root-a|active|normal|running|exit-code|normal|clean|1234|0'
fa01_install_reject_sequence fa01-mid-query-error '无法确认' \
  'loaded|/opt/root-a|active|normal|running|success|normal|clean|1234|0' \
  query-error

f1_install_reject f1-activating-auto-restart \
  'loaded|/opt/root-a|activating|normal|auto-restart|exit-code|normal|clean' \
  'ActiveState=activating SubState=auto-restart'
if chroot "$JAIL" /usr/bin/systemctl is-active --quiet obs-whip-live.service; then
  :
else
  fail "F1-B fixture did not reproduce is-active accepting activating/auto-restart"
fi
f1_install_reject f1-failed \
  'loaded|/opt/root-a|failed|normal|failed|exit-code|normal|clean' \
  'ActiveState=failed SubState=failed'
f1_install_reject f1-inactive-dead \
  'loaded|/opt/root-a|inactive|normal|dead|success|normal|clean' \
  'ActiveState=inactive SubState=dead'
f1_install_reject f1-show-query-error query-error '无法确认'
f1_install_reject f1-empty-active \
  'loaded|/opt/root-a|active|normal|running|success|empty-active|clean' \
  'ActiveState= SubState=running'
f1_install_reject f1-malformed-sub \
  'loaded|/opt/root-a|active|normal|running|success|malformed-sub|clean' \
  'ActiveState=active SubState=auto-restart garbage'
rm -f -- "$JAIL/state/enable-state"

for repeat in 1 2; do
  set_disk /opt/root-b
  set_manager 'loaded|/opt/root-b|active|normal'
  ownership_install_fail "own-install-foreign-active-$repeat"
done
set_disk /opt/root-b
set_manager 'loaded|/opt/root-b|inactive|normal'
ownership_install_fail own-install-foreign-inactive
for foreign_root in /opt/root-b2 /opt/root-b-old; do
  set_disk "$foreign_root"
  set_manager "loaded|$foreign_root|active|normal"
  ownership_install_fail "own-install-prefix-$(basename "$foreign_root")"
done
rm -f -- "$UNIT"
set_manager query-error
ownership_install_fail own-install-query-error
for variant in empty malformed mismatch; do
  set_disk /opt/root-a
  set_manager "loaded|/opt/root-a|active|$variant"
  ownership_install_fail "own-install-manager-$variant"
done
rm -f -- "$UNIT"
set_manager 'loaded|/opt/root-b|active|normal'
ownership_install_fail own-install-disk-absent-foreign-manager
rm -f -- "$UNIT"
set_manager 'loaded|/opt/root-a|active|normal'
ownership_install_fail own-install-disk-absent-same-manager
set_disk /opt/root-a
set_manager not-found
ownership_install_fail own-install-disk-same-manager-not-found

set_disk /opt/root-a-alias
set_manager 'loaded|/opt/root-a-alias|inactive|normal'
reset_trace
run_jail own-install-physical-same /bin/sh /opt/root-a/install-systemd.sh
expect_rc 0 own-install-physical-same
echo "PASS: ownership install-physical-alias-same RC=0"
set_disk /opt/root-b-alias
set_manager 'loaded|/opt/root-b-alias|inactive|normal'
ownership_install_fail own-install-physical-alias-foreign

# A pristine tree is a successful local no-op, but only after the manager
# ownership query has established NOT_FOUND.
rm -f -- "$UNIT"
set_manager not-found
rm -rf -- "$JAIL/opt/root-a/runtime" "$JAIL/opt/root-a/logs"
reset_trace
run_jail fa02-pristine-bare-tree /bin/sh /opt/root-a/stop.sh
expect_rc 0 fa02-pristine-bare-tree
assert_trace_has '^show obs-whip-live.service ' fa02-pristine-bare-tree
assert_no_global_side_effect fa02-pristine-bare-tree
[ ! -e "$JAIL/opt/root-a/runtime" ] \
  || fail "FA02 pristine stop created runtime"
[ ! -e "$JAIL/opt/root-a/logs" ] \
  || fail "FA02 pristine stop created logs"
if grep -F '清理不完整' "$TEST_ROOT/fa02-pristine-bare-tree.stdout" \
  "$TEST_ROOT/fa02-pristine-bare-tree.stderr" >/dev/null 2>&1; then
  fail "FA02 pristine stop printed cleanup-incomplete warning"
fi
echo "PASS: F-A-02 pristine-bare-tree RC=0 runtime-before=absent runtime-after=absent logs=absent destructive-systemctl=no"

# stop.sh ownership behavior and credential lifecycle.
set_disk /opt/root-a
set_manager 'loaded|/opt/root-a|active|normal'
mkdir -p "$JAIL/opt/root-a/runtime"
printf '%s\n' 'key=old-dummy-value' 'hash=old-dummy-hash' > "$JAIL/opt/root-a/runtime/publish.credentials"
chmod 0600 "$JAIL/opt/root-a/runtime/publish.credentials"
old_credential_hash=$(sha256sum "$JAIL/opt/root-a/runtime/publish.credentials" | sed 's/ .*//')
reset_trace
run_jail cred-default /bin/sh /opt/root-a/stop.sh
expect_rc 0 cred-default
[ -f "$JAIL/opt/root-a/runtime/publish.credentials" ] || fail "default stop deleted credential"
[ "$(sha256sum "$JAIL/opt/root-a/runtime/publish.credentials" | sed 's/ .*//')" = "$old_credential_hash" ] \
  || fail "default stop changed credential"
assert_trace_has '^stop obs-whip-live.service$' cred-default
grep -F 'systemd 直播服务已停止；持久推流凭据已保留。' \
  "$TEST_ROOT/cred-default.stdout" >/dev/null \
  || fail "W1-A clean stop did not print the normal success message"
echo "PASS: credential default-preserve / W1-A clean-stop RC=0 sha256=$old_credential_hash"

set_disk /opt/root-a
set_manager 'loaded|/opt/root-a|active|normal|running|success|normal|failed'
reset_trace
run_jail w1-inner-cleanup-failure /bin/sh /opt/root-a/stop.sh
expect_rc 1 w1-inner-cleanup-failure
if grep -F 'systemd 直播服务已停止；持久推流凭据已保留。' \
  "$TEST_ROOT/w1-inner-cleanup-failure.stdout" >/dev/null 2>&1; then
  fail "W1-B printed the full clean-stop success message"
fi
grep -F 'systemd 报告停止/清理结果异常' \
  "$TEST_ROOT/w1-inner-cleanup-failure.stderr" >/dev/null \
  || fail "W1-B lacked the abnormal stop/cleanup diagnostic"
[ "$(sha256sum "$JAIL/opt/root-a/runtime/publish.credentials" | sed 's/ .*//')" = "$old_credential_hash" ] \
  || fail "W1-B changed the default-preserved credential"
echo "PASS: W-1 inner-cleanup-failure RC=1 full-success=absent credential-preserved=yes"

set_disk /opt/root-a
set_manager 'loaded|/opt/root-a|active|normal|running|success|normal|query-error'
reset_trace
run_jail w1-show-query-error /bin/sh /opt/root-a/stop.sh
expect_rc 1 w1-show-query-error
if grep -F 'systemd 直播服务已停止；持久推流凭据已保留。' \
  "$TEST_ROOT/w1-show-query-error.stdout" >/dev/null 2>&1; then
  fail "W1-C printed the full clean-stop success message"
fi
grep -F '无法确认' "$TEST_ROOT/w1-show-query-error.stderr" >/dev/null \
  || fail "W1-C lacked the manager-query diagnostic"
echo "PASS: W-1 post-stop-show-query-error RC=1 full-success=absent"

reset_trace
run_jail cred-explicit-preserve /bin/sh /opt/root-a/stop.sh --preserve-credentials
expect_rc 0 cred-explicit-preserve
[ "$(sha256sum "$JAIL/opt/root-a/runtime/publish.credentials" | sed 's/ .*//')" = "$old_credential_hash" ] \
  || fail "explicit preserve changed credential"
assert_no_global_side_effect cred-explicit-preserve
echo "PASS: credential explicit-preserve RC=0 sha256=$old_credential_hash"

set_manager 'loaded|/opt/root-a|inactive|normal'
reset_trace
run_jail cred-clear /bin/sh /opt/root-a/stop.sh --clear-credentials
expect_rc 0 cred-clear
[ ! -e "$JAIL/opt/root-a/runtime/publish.credentials" ] || fail "clear did not delete credential"
echo "PASS: credential explicit-clear RC=0 exists=no"

mkdir -p "$JAIL/opt/root-a/runtime"
printf '%s\n' 'key=foreign-clear-sentinel' 'hash=foreign-clear-sentinel' > "$JAIL/opt/root-a/runtime/publish.credentials"
chmod 0600 "$JAIL/opt/root-a/runtime/publish.credentials"
foreign_clear_hash=$(sha256sum "$JAIL/opt/root-a/runtime/publish.credentials" | sed 's/ .*//')
set_disk /opt/root-b
set_manager 'loaded|/opt/root-b|active|normal'
reset_trace
run_jail cred-foreign-clear /bin/sh /opt/root-a/stop.sh --clear-credentials
expect_rc 1 cred-foreign-clear
assert_no_global_side_effect cred-foreign-clear
[ "$(sha256sum "$JAIL/opt/root-a/runtime/publish.credentials" | sed 's/ .*//')" = "$foreign_clear_hash" ] \
  || fail "foreign clear modified current-root credential"
echo "PASS: credential foreign-clear-fail-closed RC=1 sha256=$foreign_clear_hash"

rm -f -- "$UNIT"
set_manager not-found
reset_trace
run_jail own-stop-absent-not-found /bin/sh /opt/root-a/stop.sh
expect_rc 0 own-stop-absent-not-found
assert_no_global_side_effect own-stop-absent-not-found
echo "PASS: ownership stop-absent-not-found RC=0 local-only"

rm -f -- "$UNIT"
set_manager 'loaded|/opt/root-a|active|normal'
reset_trace
run_jail own-stop-disk-absent-same /bin/sh /opt/root-a/stop.sh
expect_rc 0 own-stop-disk-absent-same
assert_trace_has '^stop obs-whip-live.service$' own-stop-disk-absent-same
echo "PASS: ownership stop-disk-absent-same-manager RC=0"

for state in active inactive; do
  set_disk /opt/root-b
  set_manager "loaded|/opt/root-b|$state|normal"
  reset_trace
  unit_hash_before=$(unit_file_snapshot)
  run_jail "own-stop-foreign-$state" /bin/sh /opt/root-a/stop.sh
  expect_rc 1 "own-stop-foreign-$state"
  assert_no_global_side_effect "own-stop-foreign-$state"
  unit_hash_after=$(unit_file_snapshot)
  [ "$unit_hash_after" = "$unit_hash_before" ] \
    || fail "own-stop-foreign-$state changed the foreign global unit"
  echo "PASS: ownership stop-foreign-$state RC=1 unit-sha256=$unit_hash_after no-stop"
done

# uninstall.sh matrix, including the disk-absent/manager-loaded gap.
set_disk /opt/root-a
set_manager 'loaded|/opt/root-a|inactive|normal'
reset_trace
run_jail own-uninstall-same /bin/sh /opt/root-a/uninstall.sh
expect_rc 0 own-uninstall-same
[ ! -e "$UNIT" ] || fail "same-root uninstall did not remove disk unit"
for expected_call in '^stop ' '^disable ' '^daemon-reload$' '^reset-failed '; do
  assert_trace_has "$expected_call" own-uninstall-same
done
echo "PASS: ownership uninstall-same-root RC=0"

rm -f -- "$UNIT"
set_manager 'loaded|/opt/root-a|inactive|normal'
reset_trace
run_jail own-uninstall-disk-absent-same /bin/sh /opt/root-a/uninstall.sh
expect_rc 0 own-uninstall-disk-absent-same
assert_trace_has '^stop ' own-uninstall-disk-absent-same
assert_trace_has '^disable ' own-uninstall-disk-absent-same
assert_trace_has '^reset-failed ' own-uninstall-disk-absent-same
echo "PASS: ownership uninstall-disk-absent-same-manager RC=0"

set_disk /opt/root-a
set_manager not-found
reset_trace
run_jail own-uninstall-disk-same-not-found /bin/sh /opt/root-a/uninstall.sh
expect_rc 0 own-uninstall-disk-same-not-found
[ ! -e "$UNIT" ] || fail "disk-same manager-not-found uninstall did not remove unit"
assert_trace_has '^daemon-reload$' own-uninstall-disk-same-not-found
if grep -E '^(stop|disable|reset-failed) ' "$TRACE" >/dev/null 2>&1; then
  fail "disk-same manager-not-found performed manager cleanup"
fi
echo "PASS: ownership uninstall-disk-same-manager-not-found RC=0"

for uninstall_case in foreign-active foreign-inactive disk-absent-foreign query-error malformed; do
  case "$uninstall_case" in
    foreign-active) set_disk /opt/root-b; set_manager 'loaded|/opt/root-b|active|normal' ;;
    foreign-inactive) set_disk /opt/root-b; set_manager 'loaded|/opt/root-b|inactive|normal' ;;
    disk-absent-foreign) rm -f -- "$UNIT"; set_manager 'loaded|/opt/root-b|active|normal' ;;
    query-error) rm -f -- "$UNIT"; set_manager query-error ;;
    malformed) rm -f -- "$UNIT"; set_manager 'loaded|/opt/root-a|inactive|malformed' ;;
  esac
  reset_trace
  unit_hash_before=$(unit_file_snapshot)
  run_jail "own-uninstall-$uninstall_case" /bin/sh /opt/root-a/uninstall.sh
  expect_rc 1 "own-uninstall-$uninstall_case"
  assert_no_global_side_effect "own-uninstall-$uninstall_case"
  unit_hash_after=$(unit_file_snapshot)
  [ "$unit_hash_after" = "$unit_hash_before" ] \
    || fail "own-uninstall-$uninstall_case changed the global unit"
  echo "PASS: ownership uninstall-$uninstall_case RC=1 unit-sha256=$unit_hash_after no-global-side-effect"
done

copy_project /opt/purge-root
rm -f -- "$UNIT"
set_manager not-found
reset_trace
run_jail own-uninstall-absent-purge /bin/sh /opt/purge-root/uninstall.sh --purge
expect_rc 0 own-uninstall-absent-purge
[ ! -e "$JAIL/opt/purge-root" ] || fail "absent/not-found purge contract failed"
assert_no_global_side_effect own-uninstall-absent-purge
echo "PASS: ownership uninstall-absent-not-found-purge RC=0 no-global-side-effect"

# Hostile manifest matrix. Each variant starts from a fresh release copy.
manifest_case_path=
prepare_manifest_case() {
  manifest_name=$1
  manifest_case_path=/opt/manifest-$manifest_name
  copy_project "$manifest_case_path"
  rm -f -- "$UNIT"
  set_manager not-found
  reset_trace
}

manifest_expect() {
  manifest_name=$1
  expected_rc=$2
  run_jail "manifest-$manifest_name" /bin/sh "$manifest_case_path/install-systemd.sh"
  expect_rc "$expected_rc" "manifest-$manifest_name"
  if [ "$expected_rc" -ne 0 ]; then
    assert_no_global_side_effect "manifest-$manifest_name"
  fi
  echo "PASS: manifest $manifest_name RC=$RUN_RC expected=$expected_rc"
}

prepare_manifest_case clean
manifest_expect clean 0

prepare_manifest_case missing
rm -f -- "$JAIL$manifest_case_path/SHA256SUMS"
manifest_expect missing 1

prepare_manifest_case symlink
rm -f -- "$JAIL$manifest_case_path/SHA256SUMS"
ln -s /dev/null "$JAIL$manifest_case_path/SHA256SUMS"
manifest_expect symlink 1

prepare_manifest_case directory
rm -f -- "$JAIL$manifest_case_path/SHA256SUMS"
mkdir "$JAIL$manifest_case_path/SHA256SUMS"
manifest_expect directory 1

prepare_manifest_case group-writable
chmod g+w "$JAIL$manifest_case_path/SHA256SUMS"
manifest_expect group-writable 1

prepare_manifest_case listed-tamper
printf '%s\n' tampered >> "$JAIL$manifest_case_path/README.md"
manifest_expect listed-tamper 1

prepare_manifest_case omitted-one-tampered
sed -i '/  README.md$/d' "$JAIL$manifest_case_path/SHA256SUMS"
printf '%s\n' tampered >> "$JAIL$manifest_case_path/README.md"
manifest_expect omitted-one-tampered 1

prepare_manifest_case omitted-two-tampered
sed -i -e '/  README.md$/d' -e '/  README.en.md$/d' "$JAIL$manifest_case_path/SHA256SUMS"
printf '%s\n' tampered >> "$JAIL$manifest_case_path/README.md"
manifest_expect omitted-two-tampered 1

prepare_manifest_case minimal-three
sed -n '1,3p' "$JAIL$manifest_case_path/SHA256SUMS" > "$JAIL$manifest_case_path/SHA256SUMS.tmp"
mv "$JAIL$manifest_case_path/SHA256SUMS.tmp" "$JAIL$manifest_case_path/SHA256SUMS"
manifest_expect minimal-three 1

prepare_manifest_case duplicate
sed -n '1p' "$JAIL$manifest_case_path/SHA256SUMS" >> "$JAIL$manifest_case_path/SHA256SUMS"
manifest_expect duplicate 1

prepare_manifest_case malformed-text
printf '%s\n' 'malformed extra text' >> "$JAIL$manifest_case_path/SHA256SUMS"
manifest_expect malformed-text 1

escape_manifest_case() {
  escape_name=$1
  escape_path=$2
  fifo_path=$3
  prepare_manifest_case "$escape_name"
  rm -f -- "$JAIL$fifo_path"
  mkfifo "$JAIL$fifo_path"
  first_hash=$(sed -n '1s/  .*//p' "$JAIL$manifest_case_path/SHA256SUMS")
  sed "1s#.*#$first_hash  $escape_path#" "$JAIL$manifest_case_path/SHA256SUMS" \
    > "$JAIL$manifest_case_path/SHA256SUMS.tmp"
  mv "$JAIL$manifest_case_path/SHA256SUMS.tmp" "$JAIL$manifest_case_path/SHA256SUMS"
  manifest_expect "$escape_name" 1
  [ "$RUN_RC" -ne 124 ] || fail "$escape_name attempted to read ROOT-outside FIFO"
  rm -f -- "$JAIL$fifo_path"
}
escape_manifest_case absolute /outside-absolute /outside-absolute
escape_manifest_case parent-dotdot ../outside-parent /opt/outside-parent

for entry_spec in 'internal-dotdot|a/../b' 'leading-dot|./README.md' \
  'leading-dash|-README.md' 'leading-space| README.md' 'unicode|RÉADME.md'; do
  entry_name=${entry_spec%%|*}
  entry_path=${entry_spec#*|}
  prepare_manifest_case "$entry_name"
  first_hash=$(sed -n '1s/  .*//p' "$JAIL$manifest_case_path/SHA256SUMS")
  sed "1s#.*#$first_hash  $entry_path#" "$JAIL$manifest_case_path/SHA256SUMS" \
    > "$JAIL$manifest_case_path/SHA256SUMS.tmp"
  mv "$JAIL$manifest_case_path/SHA256SUMS.tmp" "$JAIL$manifest_case_path/SHA256SUMS"
  manifest_expect "$entry_name" 1
done

prepare_manifest_case extra-in-tree
printf '%s\n' extra > "$JAIL$manifest_case_path/extra.txt"
extra_hash=$(sha256sum "$JAIL$manifest_case_path/extra.txt" | sed 's/ .*//')
printf '%s  %s\n' "$extra_hash" extra.txt >> "$JAIL$manifest_case_path/SHA256SUMS"
manifest_expect extra-in-tree 1

prepare_manifest_case extra-missing
printf '%064d  missing.txt\n' 0 >> "$JAIL$manifest_case_path/SHA256SUMS"
manifest_expect extra-missing 1

prepare_manifest_case crlf
sed 's/$/\r/' "$JAIL$manifest_case_path/SHA256SUMS" > "$JAIL$manifest_case_path/SHA256SUMS.tmp"
mv "$JAIL$manifest_case_path/SHA256SUMS.tmp" "$JAIL$manifest_case_path/SHA256SUMS"
manifest_expect crlf 1

prepare_manifest_case config-mutable
printf '%s\n' \
  'PUBLIC_DOMAIN=changed.example.com' \
  'PUBLIC_HOST=changed-host.example.com' \
  'WHIP_IP=192.168.50.10' > "$JAIL$manifest_case_path/config.env"
manifest_expect config-mutable 0

# Run start.sh --service only until the deliberate Caddy validate failure. This
# exercises the real credential creation path without starting network daemons.
copy_project /opt/credential-root
credential_root=$JAIL/opt/credential-root
printf '%s\n' \
  'PUBLIC_DOMAIN=live.example.com' \
  'PUBLIC_HOST=rtc.example.com' \
  'WHIP_IP=192.168.50.10' \
  'TLS_CERT=certs/fullchain.pem' \
  'TLS_KEY=certs/privkey.pem' > "$credential_root/config.env"
printf '%s\n' certificate > "$credential_root/certs/fullchain.pem"
printf '%s\n' private-key > "$credential_root/certs/privkey.pem"
chmod 0600 "$credential_root/certs/privkey.pem"
mv "$credential_root/bin/helper_linux_amd64" "$credential_root/bin/helper.real"
cat > "$credential_root/bin/helper_linux_amd64" <<'HELPER'
#!/bin/sh
case "${1:-}" in
  public-ips) printf '%s\n' '8.8.8.8' ;;
  private-cidrs) printf '%s\n' '["192.168.50.10/24","192.168.50.10/32"]' ;;
  check-cert) exit 0 ;;
  tcp) exit 1 ;;
  genkey) exec /opt/credential-root/bin/helper.real genkey ;;
  *) exit 1 ;;
esac
HELPER
cat > "$credential_root/bin/caddy_linux_amd64" <<'CADDY'
#!/bin/sh
echo 'deliberate fixture validate failure' >&2
exit 1
CADDY
cat > "$credential_root/bin/mediamtx_linux_amd64" <<'MEDIAMTX'
#!/bin/sh
exit 1
MEDIAMTX
chmod 0755 "$credential_root/bin/helper_linux_amd64" \
  "$credential_root/bin/helper.real" "$credential_root/bin/caddy_linux_amd64" \
  "$credential_root/bin/mediamtx_linux_amd64"
cat > "$JAIL/usr/bin/getent" <<'GETENT'
#!/bin/sh
case "${1:-}" in
  ahostsv4) printf '%s\n' '8.8.8.8 STREAM rtc.example.com' ;;
  ahostsv6) exit 2 ;;
  *) exit 2 ;;
esac
GETENT
cat > "$JAIL/usr/sbin/ip" <<'IP'
#!/bin/sh
case "$*" in
  '-o -4 addr show up scope global') printf '%s\n' '2: eth0    inet 192.168.50.10/24 brd 192.168.50.255 scope global eth0' ;;
  *) exit 1 ;;
esac
IP
cat > "$JAIL/usr/bin/ss" <<'SS'
#!/bin/sh
exit 0
SS
chmod 0755 "$JAIL/usr/bin/getent" "$JAIL/usr/sbin/ip" "$JAIL/usr/bin/ss"
chown -R root:root "$credential_root"
chmod -R go-w "$credential_root"
rm -rf -- "$credential_root/runtime" "$credential_root/logs"
run_jail credential-new-service /bin/sh /opt/credential-root/start.sh --service
expect_rc 1 credential-new-service
new_credential=$credential_root/runtime/publish.credentials
if [ ! -f "$new_credential" ]; then
  echo "credential fixture RC=$RUN_RC runtime/log snapshot:" >&2
  find "$credential_root" -maxdepth 2 -type f \
    \( -path '*/runtime/*' -o -path '*/logs/*' \) -printf '%P %m %u:%g\n' >&2 || true
  sed -n '1,80p' "$TEST_ROOT/credential-new-service.stdout" >&2 || true
  sed -n '1,80p' "$TEST_ROOT/credential-new-service.stderr" >&2 || true
  for diagnostic_log in "$credential_root"/logs/*.log; do
    [ -f "$diagnostic_log" ] || continue
    echo "diagnostic log: ${diagnostic_log#"$credential_root/"}" >&2
    sed -n '1,40p' "$diagnostic_log" >&2 || true
  done
  fail "service mode did not create a persistent credential"
fi
new_credential_hash=$(sha256sum "$new_credential" | sed 's/ .*//')
[ "$new_credential_hash" != "$old_credential_hash" ] || fail "new credential matched old credential"
[ "$(stat -c %a "$new_credential")" = 600 ] || fail "new credential mode is not 0600"
[ "$(stat -c %u:%g "$new_credential")" = 0:0 ] || fail "new credential is not root-owned"
[ "$(grep -c '^key=[0-9a-f]\{32\}$' "$new_credential")" -eq 1 ] || fail "new key format is invalid"
[ "$(grep -c '^hash=.' "$new_credential")" -eq 1 ] || fail "new hash format is invalid"
new_key=$(sed -n 's/^key=//p' "$new_credential")
if grep -F -- "$new_key" "$TEST_ROOT/credential-new-service.stdout" \
  "$TEST_ROOT/credential-new-service.stderr" "$TRACE" >/dev/null 2>&1; then
  fail "credential plaintext appeared in simulated journal/command output"
fi
echo "PASS: credential service-create RC=1-after-create mode=600 uid_gid=0:0 sha256=$new_credential_hash plaintext_in_output=no"

# Supplement stop safety fixtures run as uid/gid 65534 so the product script
# takes its local-process path and can never address the host systemd unit.
chmod 0755 "$TEST_ROOT"
STOP_FIX=$TEST_ROOT/local-stop
STOP_UID=65534
STOP_GID=65534
STOP_LAUNCHERS=

prepare_stop_fixture() {
  rm -rf -- "$STOP_FIX"
  mkdir -p "$STOP_FIX/bin" "$STOP_FIX/runtime" "$STOP_FIX/test-bin"
  cp "$SOURCE_ROOT/stop.sh" "$STOP_FIX/stop.sh"
  cp /bin/sh "$STOP_FIX/bin/caddy_linux_amd64"
  cp /bin/sh "$STOP_FIX/bin/helper_linux_amd64"
  cp /bin/sh "$STOP_FIX/bin/mediamtx_linux_amd64"
  cat > "$STOP_FIX/mediamtx-supervisor.sh" <<'SUPERVISOR'
#!/bin/sh
trap 'exit 0' TERM
while :; do sleep 1; done
SUPERVISOR
  cat > "$STOP_FIX/test-bin/rm" <<'FAKE_RM'
#!/bin/sh
for remove_arg in "$@"; do
  case "$remove_arg" in
    *"${FAIL_REMOVE_SUFFIX:-/never-match}")
      printf 'fixture denied unlink: %s\n' "$remove_arg" >&2
      exit 1
      ;;
  esac
done
exec /usr/bin/rm "$@"
FAKE_RM
  chmod 0755 "$STOP_FIX/stop.sh" "$STOP_FIX/mediamtx-supervisor.sh" \
    "$STOP_FIX/bin/"* "$STOP_FIX/test-bin/rm"
  chown -R "$STOP_UID:$STOP_GID" "$STOP_FIX"
  chmod 0755 "$STOP_FIX" "$STOP_FIX/bin" "$STOP_FIX/runtime" "$STOP_FIX/test-bin"
  STOP_LAUNCHERS=
}

launch_managed_binary() {
  managed_binary=$1
  managed_pidfile=$2
  managed_behavior=$3
  setpriv --reuid="$STOP_UID" --regid="$STOP_GID" --clear-groups \
    /bin/sh -c '
      binary=$1
      pidfile=$2
      behavior=$3
      "$binary" -c "$behavior" &
      child=$!
      printf "%s\n" "$child" > "$pidfile"
      wait "$child" || true
    ' fixture-launcher "$managed_binary" "$managed_pidfile" "$managed_behavior" &
  STOP_LAUNCHERS="$STOP_LAUNCHERS $!"
}

launch_supervisor() {
  setpriv --reuid="$STOP_UID" --regid="$STOP_GID" --clear-groups \
    /bin/sh -c '
      script=$1
      pidfile=$2
      /bin/sh "$script" &
      child=$!
      printf "%s\n" "$child" > "$pidfile"
      wait "$child" || true
    ' fixture-launcher "$STOP_FIX/mediamtx-supervisor.sh" \
      "$STOP_FIX/runtime/mediamtx-supervisor.pid" &
  STOP_LAUNCHERS="$STOP_LAUNCHERS $!"
}

wait_for_pidfiles() {
  for wait_attempt in 1 2 3 4 5 6 7 8 9 10; do
    if [ -s "$STOP_FIX/runtime/caddy.pid" ] \
       && [ -s "$STOP_FIX/runtime/gateway.pid" ] \
       && [ -s "$STOP_FIX/runtime/mediamtx-supervisor.pid" ] \
       && [ -s "$STOP_FIX/runtime/mediamtx.pid" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "managed process pidfiles were not created"
}

launch_all_managed() {
  normal_behavior="trap 'exit 0' TERM; while :; do sleep 1; done"
  launch_managed_binary "$STOP_FIX/bin/caddy_linux_amd64" "$STOP_FIX/runtime/caddy.pid" "$normal_behavior"
  launch_managed_binary "$STOP_FIX/bin/helper_linux_amd64" "$STOP_FIX/runtime/gateway.pid" "$normal_behavior"
  launch_supervisor
  launch_managed_binary "$STOP_FIX/bin/mediamtx_linux_amd64" "$STOP_FIX/runtime/mediamtx.pid" "$normal_behavior"
  wait_for_pidfiles
  CADDY_TEST_PID=$(cat "$STOP_FIX/runtime/caddy.pid")
  GATEWAY_TEST_PID=$(cat "$STOP_FIX/runtime/gateway.pid")
  SUPERVISOR_TEST_PID=$(cat "$STOP_FIX/runtime/mediamtx-supervisor.pid")
  MEDIAMTX_TEST_PID=$(cat "$STOP_FIX/runtime/mediamtx.pid")
}

collect_managed_processes() {
  alive_count=0
  sleep 0.2
  for managed_pid in "$CADDY_TEST_PID" "$GATEWAY_TEST_PID" "$SUPERVISOR_TEST_PID" "$MEDIAMTX_TEST_PID"; do
    if kill -0 "$managed_pid" 2>/dev/null; then
      alive_count=$((alive_count + 1))
      kill -9 "$managed_pid" 2>/dev/null || true
    fi
  done
  for launcher_pid in $STOP_LAUNCHERS; do
    wait "$launcher_pid" 2>/dev/null || true
  done
}

write_dummy_credential() {
  printf '%s\n' 'key=stop-fixture-dummy' 'hash=stop-fixture-dummy' \
    > "$STOP_FIX/runtime/publish.credentials"
  chown "$STOP_UID:$STOP_GID" "$STOP_FIX/runtime/publish.credentials"
  chmod 0600 "$STOP_FIX/runtime/publish.credentials"
}

prepare_stop_fixture
set +e
setpriv --reuid="$STOP_UID" --regid="$STOP_GID" --clear-groups \
  /bin/sh "$STOP_FIX/stop.sh" > "$TEST_ROOT/fa02-empty-runtime.stdout" \
  2> "$TEST_ROOT/fa02-empty-runtime.stderr"
stop_rc=$?
set -e
[ "$stop_rc" -eq 0 ] || fail "FA02 empty writable runtime RC=$stop_rc"
[ -d "$STOP_FIX/runtime" ] || fail "FA02 empty runtime was removed"
[ ! -e "$STOP_FIX/runtime/mediamtx.stop" ] \
  || fail "FA02 empty runtime left the sentinel behind"
if grep -F '清理不完整' "$TEST_ROOT/fa02-empty-runtime.stdout" \
  "$TEST_ROOT/fa02-empty-runtime.stderr" >/dev/null 2>&1; then
  fail "FA02 empty runtime printed cleanup-incomplete warning"
fi
echo "PASS: F-A-02 empty-runtime RC=0 sentinel=absent warning=no"

prepare_stop_fixture
launch_all_managed
write_dummy_credential
stop_old_hash=$(sha256sum "$STOP_FIX/runtime/publish.credentials" | sed 's/ .*//')
set +e
setpriv --reuid="$STOP_UID" --regid="$STOP_GID" --clear-groups \
  /bin/sh "$STOP_FIX/stop.sh" > "$TEST_ROOT/stop-normal.stdout" 2> "$TEST_ROOT/stop-normal.stderr"
stop_rc=$?
set -e
collect_managed_processes
[ "$stop_rc" -eq 0 ] || fail "normal writable stop RC=$stop_rc"
[ "$alive_count" -eq 0 ] || fail "normal writable stop left $alive_count managed processes"
[ "$(sha256sum "$STOP_FIX/runtime/publish.credentials" | sed 's/ .*//')" = "$stop_old_hash" ] \
  || fail "normal default stop changed credential"
[ ! -e "$STOP_FIX/runtime/caddy.pid" ] \
  && [ ! -e "$STOP_FIX/runtime/gateway.pid" ] \
  && [ ! -e "$STOP_FIX/runtime/mediamtx-supervisor.pid" ] \
  && [ ! -e "$STOP_FIX/runtime/mediamtx.pid" ] \
  || fail "normal writable stop left pidfiles"
echo "PASS: stop normal-writable RC=0 all-processes-dead credential-sha256=$stop_old_hash"

prepare_stop_fixture
launch_all_managed
write_dummy_credential
set +e
PATH="$STOP_FIX/test-bin:$PATH" FAIL_REMOVE_SUFFIX=/caddy.pid \
  setpriv --reuid="$STOP_UID" --regid="$STOP_GID" --clear-groups \
  /bin/sh "$STOP_FIX/stop.sh" > "$TEST_ROOT/stop-unlink.stdout" 2> "$TEST_ROOT/stop-unlink.stderr"
stop_rc=$?
set -e
collect_managed_processes
[ "$stop_rc" -ne 0 ] || fail "pidfile unlink failure returned success"
[ "$alive_count" -eq 0 ] || fail "pidfile unlink failure skipped $alive_count later process stops"
grep -F '警告：停止过程无法清理' "$TEST_ROOT/stop-unlink.stderr" >/dev/null \
  || fail "pidfile unlink failure lacked accumulated cleanup warning"
if grep -F '直播服务器已停止；' "$TEST_ROOT/stop-unlink.stdout" >/dev/null; then
  fail "pidfile unlink failure printed unconditional normal-success message"
fi
echo "PASS: stop first-pidfile-unlink-failure RC=$stop_rc all-processes-dead warning=yes"

prepare_stop_fixture
launch_all_managed
mkdir "$STOP_FIX/runtime/mediamtx.stop"
chown "$STOP_UID:$STOP_GID" "$STOP_FIX/runtime/mediamtx.stop"
set +e
setpriv --reuid="$STOP_UID" --regid="$STOP_GID" --clear-groups \
  /bin/sh "$STOP_FIX/stop.sh" > "$TEST_ROOT/stop-sentinel.stdout" 2> "$TEST_ROOT/stop-sentinel.stderr"
stop_rc=$?
set -e
collect_managed_processes
[ "$stop_rc" -ne 0 ] || fail "directory sentinel cleanup returned success"
[ "$alive_count" -eq 0 ] || fail "directory sentinel case left $alive_count managed processes"
grep -F '警告：停止过程无法清理' "$TEST_ROOT/stop-sentinel.stderr" >/dev/null \
  || fail "directory sentinel lacked explicit cleanup warning"
echo "PASS: stop directory-sentinel RC=$stop_rc all-processes-dead warning=yes"

prepare_stop_fixture
launch_all_managed
write_dummy_credential
set +e
PATH="$STOP_FIX/test-bin:$PATH" FAIL_REMOVE_SUFFIX=/publish.credentials \
  setpriv --reuid="$STOP_UID" --regid="$STOP_GID" --clear-groups \
  /bin/sh "$STOP_FIX/stop.sh" --clear-credentials \
  > "$TEST_ROOT/stop-credential.stdout" 2> "$TEST_ROOT/stop-credential.stderr"
stop_rc=$?
set -e
collect_managed_processes
[ "$stop_rc" -ne 0 ] || fail "credential unlink failure returned success"
[ "$alive_count" -eq 0 ] || fail "credential unlink failure left $alive_count managed processes"
[ -f "$STOP_FIX/runtime/publish.credentials" ] || fail "credential unlink fixture did not preserve failed target"
grep -F '凭据未能作废' "$TEST_ROOT/stop-credential.stderr" >/dev/null \
  || fail "credential unlink failure lacked explicit invalidation warning"
if grep -F '凭据已作废' "$TEST_ROOT/stop-credential.stdout" >/dev/null; then
  fail "credential unlink failure claimed invalidation success"
fi
echo "PASS: stop credential-unlink-failure RC=$stop_rc all-processes-dead credential-exists=yes"

prepare_stop_fixture
replacement_behavior="trap 'exec /bin/sleep 30' TERM; while :; do sleep 1; done"
launch_managed_binary "$STOP_FIX/bin/caddy_linux_amd64" "$STOP_FIX/runtime/caddy.pid" "$replacement_behavior"
for wait_attempt in 1 2 3 4 5 6 7 8 9 10; do
  [ -s "$STOP_FIX/runtime/caddy.pid" ] && break
  sleep 0.1
done
replacement_pid=$(cat "$STOP_FIX/runtime/caddy.pid")
set +e
setpriv --reuid="$STOP_UID" --regid="$STOP_GID" --clear-groups \
  /bin/sh "$STOP_FIX/stop.sh" > "$TEST_ROOT/stop-revalidate.stdout" 2> "$TEST_ROOT/stop-revalidate.stderr"
stop_rc=$?
set -e
kill -0 "$replacement_pid" 2>/dev/null \
  || fail "identity-changing process was SIGKILLed after PID reuse simulation"
grep -F '身份已变化' "$TEST_ROOT/stop-revalidate.stderr" >/dev/null \
  || fail "identity-changing process lacked no-SIGKILL warning"
kill "$replacement_pid" 2>/dev/null || true
for launcher_pid in $STOP_LAUNCHERS; do wait "$launcher_pid" 2>/dev/null || true; done
echo "PASS: stop SIGKILL-revalidation identity-changed RC=$stop_rc process-survived=yes"

prepare_stop_fixture
stubborn_behavior="trap '' TERM; while :; do sleep 1; done"
launch_managed_binary "$STOP_FIX/bin/caddy_linux_amd64" "$STOP_FIX/runtime/caddy.pid" "$stubborn_behavior"
for wait_attempt in 1 2 3 4 5 6 7 8 9 10; do
  [ -s "$STOP_FIX/runtime/caddy.pid" ] && break
  sleep 0.1
done
stubborn_pid=$(cat "$STOP_FIX/runtime/caddy.pid")
set +e
setpriv --reuid="$STOP_UID" --regid="$STOP_GID" --clear-groups \
  /bin/sh "$STOP_FIX/stop.sh" > "$TEST_ROOT/stop-stubborn.stdout" 2> "$TEST_ROOT/stop-stubborn.stderr"
stop_rc=$?
set -e
sleep 0.2
if kill -0 "$stubborn_pid" 2>/dev/null; then
  kill -9 "$stubborn_pid" 2>/dev/null || true
  fail "still-matching stubborn managed process was not SIGKILLed"
fi
for launcher_pid in $STOP_LAUNCHERS; do wait "$launcher_pid" 2>/dev/null || true; done
[ "$stop_rc" -eq 0 ] || fail "still-matching stubborn stop RC=$stop_rc"
echo "PASS: stop SIGKILL-revalidation still-matching RC=0 process-dead=yes"

# Fixed Caddy fixture ports must reject conflicts without killing the owner.
for conflict_port in 19080 19443; do
  python3 -m http.server "$conflict_port" --bind 127.0.0.1 \
    > "$TEST_ROOT/port-$conflict_port.server.log" 2>&1 &
  conflict_pid=$!
  sleep 0.5
  kill -0 "$conflict_pid" 2>/dev/null || fail "could not pre-bind control port $conflict_port"
  set +e
  /bin/sh "$SOURCE_ROOT/tests/caddy-authority.test.sh" \
    > "$TEST_ROOT/port-$conflict_port.stdout" 2> "$TEST_ROOT/port-$conflict_port.stderr"
  conflict_rc=$?
  set -e
  [ "$conflict_rc" -ne 0 ] || fail "Caddy fixture accepted occupied port $conflict_port"
  grep -F "test fixture port $conflict_port/TCP is already in use" \
    "$TEST_ROOT/port-$conflict_port.stderr" >/dev/null \
    || fail "Caddy fixture conflict $conflict_port lacked precise preflight error"
  kill -0 "$conflict_pid" 2>/dev/null \
    || fail "Caddy fixture killed unrelated owner of port $conflict_port"
  kill "$conflict_pid" 2>/dev/null || true
  wait "$conflict_pid" 2>/dev/null || true
  echo "PASS: Caddy fixture preflight port=$conflict_port/TCP RC=$conflict_rc owner-survived=yes"
done

# F-04: all destructive steps require a confirmed clean stop.
for failure in refused failed query-error disable reload; do
  for argument in default purge; do
    copy_project /opt/root-a
    set_disk /opt/root-a
    case "$failure" in
      refused|failed|query-error) set_manager "loaded|/opt/root-a|active|normal|running|success|normal|$failure" ;;
      *) set_manager 'loaded|/opt/root-a|active|normal'; : > "$JAIL/state/$failure-fails" ;;
    esac
    before_hash=$(unit_file_snapshot)
    reset_trace
    if [ "$argument" = purge ]; then
      run_jail "f04-$failure-$argument" /bin/sh /opt/root-a/uninstall.sh --purge
    else
      run_jail "f04-$failure-$argument" /bin/sh /opt/root-a/uninstall.sh
    fi
    expect_rc 1 "f04-$failure-$argument"
    [ -d "$JAIL/opt/root-a" ] || fail "F-04 deleted root after $failure"
    [ "$(unit_file_snapshot)" = "$before_hash" ] || fail "F-04 lost unit after $failure"
    if grep -q '已停止并移除' "$TEST_ROOT/f04-$failure-$argument.stdout"; then fail "F-04 false success"; fi
    rm -f "$JAIL/state/disable-fails" "$JAIL/state/reload-fails"
    echo "PASS: F-04 $failure $argument denied; unit/root preserved"
  done
done
for operation in install-systemd stop uninstall; do
  reset_absent
  set_manager not-found-active
  run_jail "not-found-active-$operation" /bin/sh "/opt/root-a/$operation.sh"
  expect_rc 1 "not-found-active-$operation"
  assert_no_global_side_effect "not-found-active-$operation"
  echo "PASS: active process behind LoadState=not-found denied for $operation"
done
/bin/sh "$SOURCE_ROOT/tests/stop-clear-authorization.test.sh"
echo "CONTROL_PLANE_REPAIR_TESTS=PASS"
