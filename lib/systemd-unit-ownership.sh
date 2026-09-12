#!/bin/sh
# Shared, side-effect-free ownership classification for the single global unit.
# Call unit_ownership_snapshot CURRENT_ROOT UNIT_FILE UNIT_NAME, then inspect:
#   UNIT_DISK_STATE:    ABSENT | SAME_ROOT | FOREIGN | MALFORMED
#   UNIT_MANAGER_STATE: NOT_FOUND | SAME_ROOT | FOREIGN | QUERY_ERROR | MALFORMED
#   UNIT_MANAGER_ACTIVE_STATE: systemd ActiveState when manager state is loaded

unit_ownership_resolve_root() {
  unit_candidate_root=$1
  case "$unit_candidate_root" in
    ""|/*[!A-Za-z0-9_./-]*|*[!A-Za-z0-9_./-]*|.|..|*/.|*/..|*//*|*/../*|*/./*)
      return 1
      ;;
    /*) ;;
    *) return 1 ;;
  esac
  unit_resolved_root=$(realpath -e -- "$unit_candidate_root" 2>/dev/null) || return 1
  [ -d "$unit_resolved_root" ] || return 1
  printf '%s\n' "$unit_resolved_root"
}

unit_ownership_parse_command() {
  unit_command=$1
  case "$unit_command" in
    "/bin/sh "*) unit_script=${unit_command#"/bin/sh "} ;;
    *) return 1 ;;
  esac
  case "$unit_script" in
    /*/service-manager.sh) ;;
    *) return 1 ;;
  esac
  unit_command_root=${unit_script%/service-manager.sh}
  unit_ownership_resolve_root "$unit_command_root"
}

unit_ownership_classify_disk() {
  UNIT_DISK_STATE=MALFORMED
  UNIT_DISK_ROOT=
  if [ ! -e "$UNIT_OWNERSHIP_FILE" ] && [ ! -L "$UNIT_OWNERSHIP_FILE" ]; then
    UNIT_DISK_STATE=ABSENT
    return 0
  fi
  [ ! -L "$UNIT_OWNERSHIP_FILE" ] && [ -f "$UNIT_OWNERSHIP_FILE" ] || return 0

  unit_disk_uid=$(stat -c %u -- "$UNIT_OWNERSHIP_FILE" 2>/dev/null) || return 0
  unit_disk_mode=$(stat -c %a -- "$UNIT_OWNERSHIP_FILE" 2>/dev/null) || return 0
  case "$unit_disk_uid:$unit_disk_mode" in
    0:[0-7][0-7][0-7]) ;;
    *) return 0 ;;
  esac
  unit_disk_perm=$((0$unit_disk_mode))
  [ $((unit_disk_perm & 0022)) -eq 0 ] || return 0

  unit_disk_working=
  unit_disk_exec=
  unit_disk_working_count=0
  unit_disk_exec_count=0
  while IFS= read -r unit_disk_line || [ -n "$unit_disk_line" ]; do
    case "$unit_disk_line" in
      WorkingDirectory=*)
        unit_disk_working_count=$((unit_disk_working_count + 1))
        unit_disk_working=${unit_disk_line#WorkingDirectory=}
        ;;
      ExecStart=*)
        unit_disk_exec_count=$((unit_disk_exec_count + 1))
        unit_disk_exec=${unit_disk_line#ExecStart=}
        ;;
    esac
  done < "$UNIT_OWNERSHIP_FILE"
  [ "$unit_disk_working_count" -eq 1 ] && [ "$unit_disk_exec_count" -eq 1 ] || return 0

  unit_disk_working_root=$(unit_ownership_resolve_root "$unit_disk_working") || return 0
  unit_disk_exec_root=$(unit_ownership_parse_command "$unit_disk_exec") || return 0
  [ "$unit_disk_working_root" = "$unit_disk_exec_root" ] || return 0
  UNIT_DISK_ROOT=$unit_disk_exec_root
  if [ "$UNIT_DISK_ROOT" = "$UNIT_OWNERSHIP_CURRENT_ROOT" ]; then
    UNIT_DISK_STATE=SAME_ROOT
  else
    UNIT_DISK_STATE=FOREIGN
  fi
}

unit_ownership_classify_manager() {
  UNIT_MANAGER_STATE=QUERY_ERROR
  UNIT_MANAGER_ROOT=
  UNIT_MANAGER_ACTIVE_STATE=
  if ! unit_manager_output=$(systemctl show "$UNIT_OWNERSHIP_NAME" --no-pager \
    --property=LoadState --property=FragmentPath --property=WorkingDirectory \
    --property=ExecStart --property=ActiveState --property=MainPID 2>/dev/null); then
    return 0
  fi

  unit_manager_load=
  unit_manager_fragment=
  unit_manager_working=
  unit_manager_exec=
  unit_manager_active=
  unit_manager_pid=
  unit_manager_load_count=0
  unit_manager_fragment_count=0
  unit_manager_working_count=0
  unit_manager_exec_count=0
  unit_manager_active_count=0
  unit_manager_pid_count=0
  while IFS= read -r unit_manager_line || [ -n "$unit_manager_line" ]; do
    case "$unit_manager_line" in
      LoadState=*)
        unit_manager_load_count=$((unit_manager_load_count + 1))
        unit_manager_load=${unit_manager_line#LoadState=}
        ;;
      FragmentPath=*)
        unit_manager_fragment_count=$((unit_manager_fragment_count + 1))
        unit_manager_fragment=${unit_manager_line#FragmentPath=}
        ;;
      WorkingDirectory=*)
        unit_manager_working_count=$((unit_manager_working_count + 1))
        unit_manager_working=${unit_manager_line#WorkingDirectory=}
        ;;
      ExecStart=*)
        unit_manager_exec_count=$((unit_manager_exec_count + 1))
        unit_manager_exec=${unit_manager_line#ExecStart=}
        ;;
      ActiveState=*)
        unit_manager_active_count=$((unit_manager_active_count + 1))
        unit_manager_active=${unit_manager_line#ActiveState=}
        ;;
      MainPID=*)
        unit_manager_pid_count=$((unit_manager_pid_count + 1))
        unit_manager_pid=${unit_manager_line#MainPID=}
        ;;
      "") ;;
      *) UNIT_MANAGER_STATE=MALFORMED; return 0 ;;
    esac
  done <<EOF
$unit_manager_output
EOF

  if [ "$unit_manager_load_count" -ne 1 ]; then
    UNIT_MANAGER_STATE=MALFORMED
    return 0
  fi
  if [ "$unit_manager_load" = not-found ]; then
    # systemd can retain an active process after its unit file is removed and
    # reloaded. LoadState alone must never authorize a new deployment owner.
    if [ "$unit_manager_active_count" -ne 1 ] || [ "$unit_manager_active" != inactive ] \
       || [ "$unit_manager_pid_count" -ne 1 ] || [ "$unit_manager_pid" != 0 ]; then
      UNIT_MANAGER_STATE=MALFORMED
      return 0
    fi
    UNIT_MANAGER_STATE=NOT_FOUND
    return 0
  fi
  if [ "$unit_manager_load" != loaded ] \
     || [ "$unit_manager_fragment_count" -ne 1 ] \
     || [ "$unit_manager_working_count" -ne 1 ] \
     || [ "$unit_manager_exec_count" -ne 1 ] \
     || [ "$unit_manager_active_count" -ne 1 ] \
     || [ "$unit_manager_pid_count" -ne 1 ] \
     || [ "$unit_manager_fragment" != "$UNIT_OWNERSHIP_FILE" ]; then
    UNIT_MANAGER_STATE=MALFORMED
    return 0
  fi
  case "$unit_manager_active" in
    active|inactive|failed|activating|deactivating|reloading) ;;
    *) UNIT_MANAGER_STATE=MALFORMED; return 0 ;;
  esac
  case "$unit_manager_pid" in ""|*[!0-9]*) UNIT_MANAGER_STATE=MALFORMED; return 0 ;; esac

  unit_manager_prefix='{ path=/bin/sh ; argv[]=/bin/sh '
  case "$unit_manager_exec" in
    "$unit_manager_prefix"*) unit_manager_rest=${unit_manager_exec#"$unit_manager_prefix"} ;;
    *) UNIT_MANAGER_STATE=MALFORMED; return 0 ;;
  esac
  unit_manager_script=${unit_manager_rest%%" ;"*}
  unit_manager_tail=${unit_manager_rest#"$unit_manager_script"}
  case "$unit_manager_tail" in
    " ; "*"}") ;;
    *) UNIT_MANAGER_STATE=MALFORMED; return 0 ;;
  esac

  unit_manager_working_root=$(unit_ownership_resolve_root "$unit_manager_working") || {
    UNIT_MANAGER_STATE=MALFORMED
    return 0
  }
  unit_manager_exec_root=$(unit_ownership_parse_command "/bin/sh $unit_manager_script") || {
    UNIT_MANAGER_STATE=MALFORMED
    return 0
  }
  if [ "$unit_manager_working_root" != "$unit_manager_exec_root" ]; then
    UNIT_MANAGER_STATE=MALFORMED
    return 0
  fi

  UNIT_MANAGER_ROOT=$unit_manager_exec_root
  UNIT_MANAGER_ACTIVE_STATE=$unit_manager_active
  if [ "$UNIT_MANAGER_ROOT" = "$UNIT_OWNERSHIP_CURRENT_ROOT" ]; then
    UNIT_MANAGER_STATE=SAME_ROOT
  else
    UNIT_MANAGER_STATE=FOREIGN
  fi
}

unit_ownership_snapshot() {
  UNIT_OWNERSHIP_CURRENT_ROOT=$1
  UNIT_OWNERSHIP_FILE=$2
  UNIT_OWNERSHIP_NAME=$3
  unit_ownership_classify_disk
  unit_ownership_classify_manager
}

# Called only after a successful stop, before deleting unit/root data. Query
# failures and populated cgroups are not proof that the service has exited.
unit_ownership_verify_stopped() {
  unit_stop_name=$1
  for unit_stop_property in ActiveState SubState Result MainPID ControlPID ControlGroup; do
    unit_stop_value=$(systemctl show "$unit_stop_name" -p "$unit_stop_property" --value 2>/dev/null) || return 1
    case "$unit_stop_property" in
      ActiveState) [ "$unit_stop_value" = inactive ] || return 1 ;;
      SubState) [ "$unit_stop_value" = dead ] || return 1 ;;
      Result) [ "$unit_stop_value" = success ] || return 1 ;;
      MainPID|ControlPID) [ "$unit_stop_value" = 0 ] || return 1 ;;
      ControlGroup)
        case "$unit_stop_value" in
          "") ;;
          /system.slice/obs-whip-live.service)
            unit_cgroup=/sys/fs/cgroup$unit_stop_value
            if [ -d "$unit_cgroup" ]; then
              grep -qx 'populated 0' "$unit_cgroup/cgroup.events" || return 1
            fi
            ;;
          *) return 1 ;;
        esac
        ;;
    esac
  done
}
