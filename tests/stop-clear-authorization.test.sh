#!/bin/sh
# Reuse the existing chroot manager and local-process fixtures without changing
# product code. Fault files affect only the generated test manager.
set -eu
SOURCE_ROOT=${P3_SOURCE_ROOT:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)}
driver=$(mktemp "${TMPDIR:-/tmp}/obs-stop-clear-driver.XXXXXX")
trap 'rm -f -- "$driver"' EXIT HUP INT TERM
python3 - "$SOURCE_ROOT" "$0" "$driver" <<'PY'
import pathlib, re, sys
root, this, out = map(pathlib.Path, sys.argv[1:])
text = (root / 'tests/control-plane-repair.test.sh').read_text()
prefix = text.split('# A failure after t=4 seconds', 1)[0]
prefix = re.sub(r'^SOURCE_ROOT=.*$', 'SOURCE_ROOT=' + repr(str(root)), prefix, count=1, flags=re.M)
anchor = '    state=$(cat /state/manager)'
hook = '''    if [ "$value_query" -eq 1 ] && [ -e /state/p3/stopped ]; then
      [ ! -e "/state/p3/error.$requested_property" ] || exit 2
      if [ -f "/state/p3/value.$requested_property" ]; then
        cat "/state/p3/value.$requested_property"; exit 0
      fi
    fi
    if [ "$value_query" -eq 0 ] && [ -f /state/p3/ownership ]; then
      cat /state/p3/ownership; exit 0
    fi
'''
prefix = prefix.replace(anchor, hook + anchor, 1)
prefix = prefix.replace('  stop)\n', '''  stop)
    if [ -d /state/p3 ]; then
      touch /state/p3/stopped
      [ ! -e /state/p3/stop-fails ] || exit 1
      if [ -e /state/p3/stop-times-out ]; then
        echo injected-stop-timeout >> /state/calls
        exec /usr/bin/timeout 1 /usr/bin/sleep.real 5
      fi
    fi
''', 1)
local = text.split('# Supplement stop safety fixtures', 1)[1].split('\n', 1)[1].split('\nprepare_stop_fixture\n', 1)[0]
driver = pathlib.Path(this).read_text().split('\n# P3 DRIVER\n', 1)[1]
out.write_text(prefix + '\n' + local + '\n' + driver)
PY
/bin/sh "$driver"
exit
# P3 DRIVER
P3_FAILURES=0
P3_COUNT=0
snapshot() {
  if [ -f "$1" ] && [ ! -L "$1" ]; then
    printf '%s:' "$(sha256sum "$1" | sed 's/ .*//')"
    stat -c '%u:%g:%a' "$1"
  else printf '%s\n' ABSENT; fi
}
p3_reset() {
  rm -rf -- "$JAIL/state/p3" "$JAIL/sys/fs/cgroup"
  mkdir -p "$JAIL/state/p3"
  set_disk /opt/root-a
  set_manager 'loaded|/opt/root-a|active|normal|running|success|normal|clean'
  for root in root-a root-b; do
    mkdir -p "$JAIL/opt/$root/runtime"
    printf '%s\n' 'fixture-only-credential' > "$JAIL/opt/$root/runtime/publish.credentials"
    chmod 0600 "$JAIL/opt/$root/runtime/publish.credentials"
  done
  reset_trace
}
p3_record() {
  P3_COUNT=$((P3_COUNT + 1))
  [ "$ok" -eq 1 ] || P3_FAILURES=$((P3_FAILURES + 1))
  python3 - "$name" "$RUN_RC" "$elapsed" "$before" "$after" "$expect" "$ok" "$p3_command" <<'PY'
import json, os, sys
n, rc, ms, before, after, expected, ok, command = sys.argv[1:]
r = dict(TEST_ID=n, TARGET='actual product script in disposable fixture', COMMAND=command, EVIDENCE_LEVEL='E3', RC=int(rc), ELAPSED_MS=int(ms), CREDENTIAL_BEFORE=before, CREDENTIAL_AFTER=after, EXPECTED=expected, SIDE_EFFECTS='credential, foreign credential, unit or local process assertions included in verdict', VERDICT='PASS' if ok=='1' else 'FAIL')
line=json.dumps(r)
print(line)
if os.environ.get('P3_EVIDENCE_FILE'):
    with open(os.environ['P3_EVIDENCE_FILE'], 'a') as f: f.write(line+'\n')
PY
}
p3_case() {
  name=$1; argument=$2; expect=$3; expected_rc=$4; no_global=${5:-0}
  p3_command="timeout 12 chroot JAIL /bin/sh /opt/root-a/stop.sh $argument (default means no argument)"
  credential=$JAIL/opt/root-a/runtime/publish.credentials
  before=$(snapshot "$credential")
  foreign_before=$(snapshot "$JAIL/opt/root-b/runtime/publish.credentials")
  unit_before=$(unit_file_snapshot)
  started=$(date +%s%3N)
  if [ "$argument" = default ]; then run_jail "$name" /bin/sh /opt/root-a/stop.sh
  else run_jail "$name" /bin/sh /opt/root-a/stop.sh "$argument"; fi
  elapsed=$(($(date +%s%3N) - started))
  after=$(snapshot "$credential")
  ok=1
  if [ "$expected_rc" = nonzero ]; then [ "$RUN_RC" -ne 0 ] || ok=0
  else [ "$RUN_RC" -eq "$expected_rc" ] || ok=0; fi
  if [ "$RUN_RC" -eq 124 ]; then
    if [ ! -e "$JAIL/state/p3/stop-times-out" ] || [ "$elapsed" -gt 5000 ] \
      || ! grep -q injected-stop-timeout "$TRACE"; then ok=0; fi
  fi
  [ "$RUN_RC" -ne 137 ] || ok=0
  if [ "$expect" = keep ]; then
    [ "$before" = "$after" ] || ok=0
    if grep -q '凭据已作废' "$TEST_ROOT/$name.stdout"; then ok=0; fi
  else [ "$after" = ABSENT ] || ok=0; fi
  [ "$foreign_before" = "$(snapshot "$JAIL/opt/root-b/runtime/publish.credentials")" ] || ok=0
  [ "$unit_before" = "$(unit_file_snapshot)" ] || ok=0
  if [ "$no_global" -eq 1 ] && grep -Eq '(^| )(stop|enable|disable|daemon-reload|reset-failed)( |$)' "$TRACE"; then ok=0; fi
  p3_record
}
echo "PRODUCT_STOP_SHA256=$(sha256sum "$SOURCE_ROOT/stop.sh" | sed 's/ .*//')"
for state in clean failed query-error; do
  for argument in default --clear-credentials; do
    p3_reset
    set_manager "loaded|/opt/root-a|active|normal|running|success|normal|$state"
    expect=keep; expected_rc=1
    [ "$state" != clean ] || expected_rc=0
    if [ "$state" = clean ] && [ "$argument" = --clear-credentials ]; then expect=absent; fi
    p3_case "OPS01-$state-$argument" "$argument" "$expect" "$expected_rc"
  done
done
for fault in refused stop-fails stop-times-out; do
  p3_reset
  if [ "$fault" = refused ]; then set_manager 'loaded|/opt/root-a|active|normal|running|success|normal|refused'
  else touch "$JAIL/state/p3/$fault"; fi
  p3_case "OPS02-$fault" --clear-credentials keep nonzero
done
for property in ActiveState SubState Result MainPID ControlPID ControlGroup; do
  for fault in query-error empty duplicate malformed; do
    # Empty ControlGroup is the existing, legal no-cgroup result.
    [ "$property:$fault" != ControlGroup:empty ] || continue
    p3_reset
    case "$fault" in
      query-error) touch "$JAIL/state/p3/error.$property" ;;
      empty) : > "$JAIL/state/p3/value.$property" ;;
      duplicate)
        case "$property" in
          ActiveState) value=inactive ;; SubState) value=dead ;; Result) value=success ;;
          ControlGroup) value=/system.slice/obs-whip-live.service ;; *) value=0 ;;
        esac
        printf '%s\n%s\n' "$value" "$value" > "$JAIL/state/p3/value.$property" ;;
      malformed) printf '%s\n' 'untrusted garbage' > "$JAIL/state/p3/value.$property" ;;
    esac
    p3_case "OPS03-04-$property-$fault" --clear-credentials keep 1
  done
done
for property in MainPID ControlPID; do
  p3_reset
  printf '17\n' > "$JAIL/state/p3/value.$property"
  p3_case "OPS05-$property-nonzero" --clear-credentials keep 1
done
for fault in populated missing malformed wrong-path clean; do
  p3_reset
  group=/system.slice/obs-whip-live.service
  mkdir -p "$JAIL/sys/fs/cgroup$group"
  printf '%s\n' "$group" > "$JAIL/state/p3/value.ControlGroup"
  case "$fault" in
    populated) printf 'populated 1\n' > "$JAIL/sys/fs/cgroup$group/cgroup.events" ;;
    malformed) printf 'untrusted\n' > "$JAIL/sys/fs/cgroup$group/cgroup.events" ;;
    wrong-path) printf '/system.slice/foreign.service\n' > "$JAIL/state/p3/value.ControlGroup" ;;
    clean) printf 'populated 0\nfrozen 0\n' > "$JAIL/sys/fs/cgroup$group/cgroup.events" ;;
  esac
  if [ "$fault" = clean ]; then p3_case OPS06-cgroup-clean --clear-credentials absent 0
  else p3_case "OPS05-06-cgroup-$fault" --clear-credentials keep 1; fi
done
for fault in foreign-active foreign-inactive prefix-b2 prefix-b-old disk-a-manager-b disk-b-manager-a query-error malformed not-found-active not-found-empty not-found-duplicate; do
  p3_reset
  case "$fault" in
    foreign-active|disk-a-manager-b) set_manager 'loaded|/opt/root-b|active|normal' ;;
    foreign-inactive) set_manager 'loaded|/opt/root-b|inactive|normal' ;;
    prefix-b2) set_manager 'loaded|/opt/root-b2|active|normal' ;;
    prefix-b-old) set_manager 'loaded|/opt/root-b-old|active|normal' ;;
    disk-b-manager-a) set_disk /opt/root-b ;;
    query-error|not-found-active) set_manager "$fault" ;;
    malformed) set_manager 'loaded|/opt/root-a|active|malformed' ;;
    not-found-empty) printf 'LoadState=not-found\nActiveState=\nMainPID=0\n' > "$JAIL/state/p3/ownership" ;;
    not-found-duplicate) printf 'LoadState=not-found\nActiveState=inactive\nMainPID=0\nMainPID=0\n' > "$JAIL/state/p3/ownership" ;;
  esac
  p3_case "OPS07-11-$fault" --clear-credentials keep 1 1
done
p3_reset
mv "$JAIL/usr/bin/rm" "$JAIL/usr/bin/rm.real"
cat > "$JAIL/usr/bin/rm" <<'RM'
#!/bin/sh
case "$*" in *publish.credentials*) exit 1;; esac
exec /usr/bin/rm.real "$@"
RM
chmod 0755 "$JAIL/usr/bin/rm"
p3_case OPS08-unlink --clear-credentials keep 1
mv "$JAIL/usr/bin/rm.real" "$JAIL/usr/bin/rm"
for state in clean failed query-error; do
  p3_reset
  set_manager "loaded|/opt/root-a|active|normal|running|success|normal|$state"
  p3_case "OPS10-preserve-$state" --preserve-credentials keep 0 1
done
for fault in clean pid-unlink sentinel-create sentinel-unlink generated-unlink credential-unlink still-alive; do
  prepare_stop_fixture
  launch_all_managed
  write_dummy_credential
  before=$(snapshot "$STOP_FIX/runtime/publish.credentials")
  suffix=
  case "$fault" in
    pid-unlink) suffix=/caddy.pid ;;
    generated-unlink) suffix=/mediamtx.generated.yml ;;
    credential-unlink) suffix=/publish.credentials ;;
    sentinel-unlink) mkdir "$STOP_FIX/runtime/mediamtx.stop" ;;
    sentinel-create)
      printf '#!/bin/sh\nexit 1\n' > "$STOP_FIX/test-bin/touch"
      chmod 0755 "$STOP_FIX/test-bin/touch" ;;
  esac
  name=OPS12-local-$fault
  p3_command="setpriv uid/gid 65534 /bin/sh (source actual stop.sh --clear-credentials); fixture OS fault=$fault"
  started=$(date +%s%3N)
  set +e
  # The still-alive case injects signal delivery failure for one exact fixture
  # PID; identity reads and the entire original stop script remain real.
  PATH="$STOP_FIX/test-bin:$PATH" FAIL_REMOVE_SUFFIX="$suffix" P3_STUBBORN_PID="$CADDY_TEST_PID" P3_LOCAL_FAULT="$fault" \
    setpriv --reuid="$STOP_UID" --regid="$STOP_GID" --clear-groups \
    /bin/sh -c '
      kill() {
        if [ "$P3_LOCAL_FAULT" = still-alive ]; then
          case "$*" in "$P3_STUBBORN_PID"|"-9 $P3_STUBBORN_PID") return 0;; esac
        fi
        command kill "$@"
      }
      script=$0; . "$script"
    ' "$STOP_FIX/stop.sh" --clear-credentials > "$TEST_ROOT/$name.stdout" 2> "$TEST_ROOT/$name.stderr"
  RUN_RC=$?
  set -e
  elapsed=$(($(date +%s%3N) - started))
  after=$(snapshot "$STOP_FIX/runtime/publish.credentials")
  recovery_pid=0
  [ ! -f "$STOP_FIX/runtime/caddy.pid" ] || recovery_pid=$(cat "$STOP_FIX/runtime/caddy.pid")
  collect_managed_processes
  ok=1; expect=keep
  if [ "$fault" = clean ]; then
    expect=absent
    [ "$RUN_RC" -eq 0 ] && [ "$after" = ABSENT ] || ok=0
  else
    [ "$RUN_RC" -ne 0 ] && [ "$before" = "$after" ] || ok=0
    if grep -q '凭据已作废' "$TEST_ROOT/$name.stdout"; then ok=0; fi
  fi
  if [ "$fault" = still-alive ]; then
    [ "$alive_count" -eq 1 ] && [ "$recovery_pid" = "$CADDY_TEST_PID" ] || ok=0
  else [ "$alive_count" -eq 0 ] || ok=0; fi
  p3_record
done
echo "STOP_CLEAR_AUTHORIZATION_CASES=$P3_COUNT FAILURES=$P3_FAILURES"
[ "$P3_FAILURES" -eq 0 ]
