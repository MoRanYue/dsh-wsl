#!/usr/bin/env bash
# dsh — talk to the running DSH desktop from inside WSL.
#
# The desktop's dsh-wsl plugin hosts a small loopback channel; this script sends a
# prompt into the DSH session the panel designates and streams the reply back here.
# WSL reaches the host through its default gateway (under WSL2 NAT that is the
# Windows side), so no interop and no Windows binary is needed: plain bash + curl.
#
# Installed by the plugin's panel ("安装 dsh 命令"). Regenerate instead of editing:
# the panel overwrites this file on every install.
set -u

# Filled in by the plugin when it installs this script (a /mnt/<drive>/... path).
CONFIG='__CHANNEL_CONFIG__'
STATE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dsh-wsl"
# The current session is per TERMINAL: one shared file made `dsh use`/`new` in one window
# silently retarget another window (both are the same user, different conversations).
# `tty` is the pty name; a redirected/pipe run falls back to the shared name.
tty_key() {
  local t
  t=$(tty 2>/dev/null || true)
  case "$t" in
    /dev/*) printf '%s' "${t##*/}" ;;
    *) printf '%s' 'shared' ;;
  esac
}
CURRENT_FILE="$STATE_DIR/current.$(tty_key)"
# The working client/base for the CURRENT channel instance (startedAt changes on every start).
# Probed once per channel start instead of on every command: the probe is what made `dsh`
# feel slow (an in-WSL curl that the firewall silently drops costs seconds before falling
# back to `curl.exe`).
TRANSPORT_FILE="$STATE_DIR/transport"

die() { printf 'dsh: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法：
  dsh "问题"                把问题发给当前会话，流式显示思考与回复
  dsh <会话id> "问题"       发给指定会话
  dsh insert "消息"         把消息插入当前对话，不等待回复（正在进行的回合会直接看到）
  dsh insert <会话id> "消息" 插入指定会话，不等待回复
  dsh list                  列出会话（* 表示当前）
  dsh new <会话id>          新建会话并设为当前
  dsh use <会话id>          切换当前会话
  dsh rm <会话id>           归档会话（可恢复）
  dsh status                当前会话与通道状态

说明：回复来自 DSH 客户端里的同一段对话；在终端按 Ctrl+C 只是停止等待，
那一轮会在客户端里继续跑完。`dsh "…"` 若目标正是正在等待这条命令的会话会
自锁，此时会直接报「无法执行」并说明原因；要往正在进行的对话里送消息，
用 `dsh insert`（立即返回）。当前会话按终端分别保存：两个终端互不影响。
EOF
}

# Read the few fields this shim needs with bash builtins only. This used to be a dozen
# grep/sed/head forks on EVERY command — that alone was most of the delay of `dsh use`, which
# touches no network at all.
read_config() {
  TOKEN=''
  PORT=''
  ENABLED=0
  DEFAULT_SESSION=''
  STARTED=''
  HOST=''
  local line value
  while IFS= read -r line; do
    case "$line" in
      *'"token"'*)
        value=${line#*: }
        value=${value%,}
        value=${value#\"}
        value=${value%\"}
        TOKEN=$value
        ;;
      *'"port"'*)
        value=${line#*: }
        value=${value%,}
        PORT=${value//[!0-9]/}
        ;;
      *'"enabled"'*)
        case "$line" in *true*) ENABLED=1 ;; esac
        ;;
      *'"sessionId"'*)
        value=${line#*: }
        value=${value%,}
        value=${value#\"}
        value=${value%\"}
        DEFAULT_SESSION=$value
        ;;
      *'"startedAt"'*)
        value=${line#*: }
        value=${value%,}
        STARTED=${value//[!0-9]/}
        ;;
      *'"host"'*)
        value=${line#*: }
        value=${value%,}
        value=${value#\"}
        value=${value%\"}
        HOST=$value
        ;;
    esac
  done < "$CONFIG"
}

load_channel() {
  [ -r "$CONFIG" ] || die "找不到通道配置 $CONFIG —— 先在 DSH 侧边栏的 WSL 面板里打开「启用 dsh 命令」并安装 dsh 命令"
  read_config
  [ -n "${TOKEN:-}" ] && [ -n "${PORT:-}" ] || die "通道配置不完整 —— 在 DSH 面板里重新安装一次 dsh 命令"
  [ "$ENABLED" = 1 ] || die "WSL 通道没有启用 —— 在 DSH 侧边栏的 WSL 面板里打开「启用 dsh 命令」"
  # Reuse the transport that worked for this exact channel instance. This is the hot path:
  # no network probe, no `ip route` spawn.
  if [ -r "$TRANSPORT_FILE" ] && [ -n "${STARTED:-}" ]; then
    local cached_started cached_client cached_base
    IFS=$'\t' read -r cached_started cached_client cached_base < "$TRANSPORT_FILE" || true
    if [ "${cached_started:-}" = "$STARTED" ] && [ -n "${cached_client:-}" ] \
      && [ -n "${cached_base:-}" ] && command -v "$cached_client" >/dev/null 2>&1; then
      CURL=$cached_client
      BASE=$cached_base
      return
    fi
  fi
  # First command after a (re)start: resolve the address once and probe with a SHORT connect
  # timeout, so a blocked path costs ~0.5 s instead of seconds.
  if [ -n "${HOST:-}" ]; then
    BASE="http://$HOST:$PORT"
  else
    GW=$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}')
    [ -n "${GW:-}" ] || die "WSL 没有默认网关，无法连到 DSH 宿主机"
    BASE="http://$GW:$PORT"
  fi
  CURL=''
  local candidate
  for candidate in curl curl.exe; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" -sS --connect-timeout 0.25 --max-time 1 "$BASE/state" >/dev/null 2>&1; then
      CURL=$candidate
      break
    fi
  done
  # Windows' own curl can reach a host that only listens on the host adapter, and the
  # service may bind loopback instead; try the Windows loopback last.
  if [ -z "$CURL" ] && command -v curl.exe >/dev/null 2>&1 \
    && curl.exe -sS --connect-timeout 0.25 --max-time 1 "http://127.0.0.1:$PORT/state" >/dev/null 2>&1; then
    CURL=curl.exe
    BASE="http://127.0.0.1:$PORT"
  fi
  [ -n "$CURL" ] || die "连不上 DSH 宿主（$BASE）—— 桌面版在运行吗？通道在面板里启用了吗？"
  mkdir -p "$STATE_DIR"
  printf '%s\t%s\t%s\n' "${STARTED:-0}" "$CURL" "$BASE" > "$TRANSPORT_FILE"
}

current_session() {
  local saved='' line=''
  if [ -r "$CURRENT_FILE" ]; then IFS= read -r line < "$CURRENT_FILE" || true; saved=${line//[[:space:]]/}; fi
  # A terminal that has never chosen one adopts the old shared value once (upgrade path);
  # after its first `use`/`new` the per-terminal file is the only source.
  if [ -z "$saved" ] && [ -r "$STATE_DIR/current" ]; then
    IFS= read -r line < "$STATE_DIR/current" || true
    saved=${line//[[:space:]]/}
  fi
  [ -n "$saved" ] && { printf '%s' "$saved"; return; }
  # Empty means auto: the host keeps a dedicated session for the terminal.
  printf '%s' "${DEFAULT_SESSION:-}"
}

set_current() {
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$1" > "$CURRENT_FILE"
}

# One POST with the CURRENT client/base. Kept separate so a failed request can forget a stale
# transport, re-resolve, and retry with the new token/base.
post_once() {
  local route=$1 body=$2 session=${3:-}
  local timeout=60
  local extra=()
  [ "$route" = say ] && { timeout=0; extra=(-N); }
  [ -n "${DSH_WSL_CALLER_SESSION:-}" ] && extra+=(-H "x-dsh-wsl-caller: $DSH_WSL_CALLER_SESSION")
  if [ -n "$session" ]; then
    "$CURL" -sS "${extra[@]}" --max-time "$timeout" -X POST \
      -H "x-dsh-wsl-token: $TOKEN" \
      -H "x-dsh-wsl-session: $session" \
      --data-binary "$body" "$BASE/$route"
  else
    "$CURL" -sS "${extra[@]}" --max-time "$timeout" -X POST \
      -H "x-dsh-wsl-token: $TOKEN" \
      --data-binary "$body" "$BASE/$route"
  fi
}

# POST a body to one route; prints the response body. `say` streams for as long as the
# turn runs, so it carries no client-side deadline and is not retried mid-stream. The
# management routes are quick, so a connection failure there is recovered once: a stale
# cached transport (WSL restart, firewall change) must not require a manual step.
post() {
  local route=$1 body=$2 session=${3:-}
  if [ "$route" = say ]; then
    post_once "$route" "$body" "$session"
    return
  fi
  local out
  out=$(post_once "$route" "$body" "$session")
  if [ $? -ne 0 ]; then
    rm -f "$TRANSPORT_FILE"
    load_channel || return 1
    out=$(post_once "$route" "$body" "$session") || die "连不上 DSH 宿主（$BASE）—— 桌面版在运行吗？"
  fi
  printf '%s' "$out"
}

cmd_list() {
  local out
  out=$(post list '' "$(current_session)")
  case "$out" in
    err*) die "${out#err	}" ;;
  esac
  printf '%s\n' "$out" | awk -F'\t' '
    NF == 0 { next }
    { mark = ($5 == "*") ? "*" : " "; printf "%s %-28s %s\n", mark, $1, ($2 == "" ? "(未命名)" : $2) }
  '
}

cmd_new() {
  local id=$1 out created
  [ -n "$id" ] || die "用法：dsh new <会话id>"
  out=$(post new "$id" "$id")
  case "$out" in
    err*) die "${out#err	}" ;;
  esac
  # The Host may mint its own id; switching to the requested one would point every later
  # command at a session that does not exist. Use what it answered with.
  created=$(printf '%s\n' "$out" | cut -f2)
  [ -n "${created:-}" ] || created=$id
  set_current "$created"
  printf '已新建并切换到会话 %s\n' "$created"
}

cmd_use() {
  local id=$1
  [ -n "$id" ] || die "用法：dsh use <会话id>"
  set_current "$id"
  printf '当前会话：%s\n' "$id"
}

cmd_rm() {
  local id=$1 out
  [ -n "$id" ] || die "用法：dsh rm <会话id>"
  out=$(post rm "$id" "$id")
  case "$out" in
    err*) die "${out#err	}" ;;
  esac
  if [ "$(current_session)" = "$id" ]; then rm -f "$CURRENT_FILE"; fi
  printf '已归档会话 %s\n' "$id"
}

# Hand a message to a conversation and return at once; the supported way to put text into a
# conversation that is currently waiting for this shell (where `say` would self-lock).
cmd_insert() {
  local session=$1 prompt=$2 out
  [ -n "$prompt" ] || die "用法：dsh insert \"消息\" 或 dsh insert <会话id> \"消息\""
  out=$(post insert "$prompt" "$session")
  case "$out" in
    err*) die "${out#err	}" ;;
  esac
  printf '已插入对话 %s\n' "$(printf '%s\n' "$out" | tr '\t' ' ')"
}

cmd_status() {
  local state session_line landing
  state=$("$CURL" -sS --connect-timeout 1 --max-time 3 "$BASE/state" 2>/dev/null) || {
    # The cached transport can go stale between two commands (channel restarted, firewall
    # changed): forget it and settle the current one instead of failing once.
    rm -f "$TRANSPORT_FILE"
    load_channel
    state=$("$CURL" -sS --connect-timeout 1 --max-time 3 "$BASE/state" 2>/dev/null) \
      || die "连不上 DSH 宿主（$BASE）—— 桌面版在运行吗？"
  }
  session_line=$(current_session)
  [ -n "$session_line" ] || session_line='默认（最近活跃会话）'
  CURRENT_SESSION=$session_line
  # The Host's channel landing (panel setting) and this shell's current session can differ;
  # naming them apart is what stops one being mistaken for the other. Parsed with builtins:
  # `dsh status` should not pay for sed/tr forks on a line of text.
  local state_line
  landing=''
  while IFS= read -r state_line; do
    case "$state_line" in
      session=*) landing=${state_line#session=} ;;
    esac
  done <<< "$state"
  printf '当前会话：%s\n' "${CURRENT_SESSION:-$(current_session)}"
  printf '通道：%s\n' "${state//$'\n'/ }"
  if [ -n "${landing:-}" ]; then printf '面板落点：%s（未用 dsh use 指定时的目标）\n' "$landing"; fi
  printf 'shim：%s\n' "$(command -v dsh || printf '未知')"
  printf '客户端：%s\n' "$CURL"
}

# Stream one turn: `~`-prefixed frames, `~s`/`~a` carry base64 chunks of raw text.
cmd_say() {
  local session=$1 prompt=$2
  local reason=0 ended=0 line ms steps tin tout breason ok text_reason
  local ticker='' reason_start=0 ack_ticker='' ack_start=0
  local balance_pid='' balance_file=''
  # The account wallet is fetched in the background from the moment the Host accepts the turn,
  # so the end-of-turn line costs nothing: by the time the reply finishes it is already there.
  prefetch_balance() {
    [ -n "$balance_pid" ] && return
    balance_file="$STATE_DIR/balance.$$"
    ( post balance > "$balance_file" 2>/dev/null ) &
    balance_pid=$!
  }
  report_balance() {
    [ -n "$balance_pid" ] || return
    wait "$balance_pid" 2>/dev/null
    balance_pid=''
    local reply='' body=''
    if [ -r "$balance_file" ]; then IFS= read -r reply < "$balance_file"; fi
    rm -f "$balance_file"
    case "$reply" in
      ok*)
        body=${reply#ok}
        body=${body#$'\t'}
        case "$body" in
          '未登录') body='未登录 DeepSeek 账号' ;;
          '暂不可用') return ;;
          '') return ;;
        esac
        printf '账户余额：%s\n' "$body"
        ;;
    esac
  }
  # `~ack` only says the Host accepted the request; the model's first frame can be seconds
  # away when the target conversation carries a large context. A live elapsed counter from
  # that moment makes the wait honest instead of looking frozen.
  stop_ack_ticker() {
    if [ -n "$ack_ticker" ]; then
      kill "$ack_ticker" 2>/dev/null
      wait "$ack_ticker" 2>/dev/null
      ack_ticker=''
      printf '\r\033[2K'
    fi
  }
  start_ack_ticker() {
    ack_start=$(date +%s%3N)
    (
      while :; do
        now=$(date +%s%3N)
        printf '\r\033[2m… 已送达，等待模型 %ds\033[0m' $(( (now - ack_start) / 1000 ))
        sleep 0.2
      done
    ) &
    ack_ticker=$!
  }
  # The first `~r` only says WHEN reasoning began: the elapsed time up to that point would stay
  # frozen on screen while the model keeps thinking. Keep a live clock instead — it ticks on the
  # same line (carriage return) until the first text arrives.
  stop_reason() {
    local had=$reason
    stop_ack_ticker
    if [ -n "$ticker" ]; then
      kill "$ticker" 2>/dev/null
      wait "$ticker" 2>/dev/null
      ticker=''
    fi
    if [ "$had" = 1 ]; then printf '\033[0m\n'; fi
    reason=2
  }
  # A host crash or a closed connection ends the stream WITHOUT the frames that stop the
  # clock; without this the ticker would keep printing on this terminal forever.
  trap 'stop_reason' INT TERM
  local -a rest
  while IFS= read -r line; do
    case "$line" in
      '~ack') start_ack_ticker; prefetch_balance ;;
      '~r '*)
        stop_ack_ticker
        ms=${line#'~r '}
        if [ "$reason" != 1 ]; then
          reason=1
          reason_start=$(date +%s%3N)
          (
            while :; do
              now=$(date +%s%3N)
              elapsed=$((now - reason_start + ms))
              printf '\r\033[2m⏱ 思考中… %d.%01ds\033[0m' $((elapsed / 1000)) $(((elapsed % 1000) / 100))
              sleep 0.2
            done
          ) &
          ticker=$!
        fi
        ;;
      '~t '*) stop_reason ;;
      '~a '*) stop_ack_ticker; stop_reason; printf '%s' "${line#'~a '}" | base64 -d ;;
      '~step '*) ;;
      '~p') ;;
      '~x '*)
        stop_reason
        [ -n "$balance_pid" ] && kill "$balance_pid" 2>/dev/null
        text_reason=$(printf '%s' "${line#'~x '}" | base64 -d)
        printf '\ndsh: %s\n' "$text_reason" >&2
        exit 1
        ;;
      '~e '*)
        stop_reason
        read -r _ ok ms steps tin tout breason <<< "$line"
        text_reason=$(printf '%s' "${breason:-}" | base64 -d 2>/dev/null)
        printf '\n'
        printf '✓ 完成 %d.%01ds · %s 步 · in %s / out %s tok%s\n' \
          $((ms / 1000)) $(((ms % 1000) / 100)) "$steps" "$tin" "$tout" \
          "${text_reason:+ (${text_reason})}"
        # A large landing conversation is the usual reason a terminal turn takes seconds: each
        # message re-sends its whole context. Naming the cause beats letting it look like lag.
        if [ "${tin:-0}" -gt 50000 ] 2>/dev/null; then
          printf '提示：目标会话上下文较大（in %s tok），每回合都要重发；终端聊天可先 %s 建一个精简会话\n' \
            "$tin" '`dsh new terminal`' >&2
        fi
        report_balance
        ended=1
        [ "$ok" = 1 ] && exit 0 || exit 1
        ;;
      'err'*) stop_ack_ticker; [ -n "$balance_pid" ] && kill "$balance_pid" 2>/dev/null; die "${line#err	}" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < <(post say "$prompt" "$session")
  stop_reason
  [ "$ended" = 1 ] || { printf '\n' >&2; die "连接在回合结束前断开"; }
}

# ---------------------------------------------------------------- entry point

[ $# -eq 0 ] && { usage; exit 1; }
case "$1" in
  -h|--help|help) usage; exit 0 ;;
esac

# `use` touches one local file: no channel, no network, no probe.
case "$1" in
  use) cmd_use "${2:-}"; exit 0 ;;
esac

load_channel

case "$1" in
  list|ls) cmd_list; exit 0 ;;
  new) cmd_new "${2:-}"; exit 0 ;;
  rm|archive) cmd_rm "${2:-}"; exit 0 ;;
  status) cmd_status; exit 0 ;;
  insert)
    if [ $# -ge 3 ]; then cmd_insert "$2" "${*:3}"; else cmd_insert "$(current_session)" "${2:-}"; fi
    exit 0
    ;;
esac

# A bare first word that names no command is either a session id (two or more args) or
# the prompt itself. `dsh "问题"` uses the current session; `dsh <id> "问题"` is explicit.
if [ $# -ge 2 ]; then
  cmd_say "$1" "${*:2}"
else
  cmd_say "$(current_session)" "$1"
fi
