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
CURRENT_FILE="$STATE_DIR/current"

die() { printf 'dsh: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法：
  dsh "问题"                把问题发给当前会话，流式显示思考与回复
  dsh <会话id> "问题"       发给指定会话
  dsh list                  列出会话（* 表示当前）
  dsh new <会话id>          新建会话并设为当前
  dsh use <会话id>          切换当前会话
  dsh rm <会话id>           归档会话（可恢复）
  dsh status                当前会话与通道状态

说明：回复来自 DSH 客户端里的同一段对话；在终端按 Ctrl+C 只是停止等待，
那一轮会在客户端里继续跑完。
EOF
}

cfg_json() { grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$CONFIG" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/'; }
cfg_num() { grep -o "\"$1\"[[:space:]]*:[[:space:]]*[0-9][0-9]*" "$CONFIG" 2>/dev/null | head -1 | grep -o '[0-9][0-9]*$'; }

load_channel() {
  [ -r "$CONFIG" ] || die "找不到通道配置 $CONFIG —— 先在 DSH 侧边栏 WSL 面板里启用通道并安装 dsh 命令"
  TOKEN=$(cfg_json token)
  PORT=$(cfg_num port)
  ENABLED=$(grep -o '"enabled"[[:space:]]*:[[:space:]]*true' "$CONFIG" >/dev/null 2>&1 && echo 1 || echo 0)
  DEFAULT_SESSION=$(cfg_json sessionId)
  [ -n "${TOKEN:-}" ] && [ -n "${PORT:-}" ] || die "通道配置不完整 —— 在 DSH 面板里重新安装一次 dsh 命令"
  [ "$ENABLED" = 1 ] || die "WSL 通道没有启用 —— 在 DSH 侧边栏 WSL 面板里打开「启用 WSL 通道」"
  GW=$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}')
  [ -n "${GW:-}" ] || die "WSL 没有默认网关，无法连到 DSH 宿主机"
  BASE="http://$GW:$PORT"
}

current_session() {
  local saved=''
  [ -r "$CURRENT_FILE" ] && saved=$(tr -d '[:space:]' < "$CURRENT_FILE")
  [ -n "$saved" ] && { printf '%s' "$saved"; return; }
  printf '%s' "${DEFAULT_SESSION:-wsl}"
}

set_current() {
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$1" > "$CURRENT_FILE"
}

# POST a body to one route; prints the response body. `say` streams for as long as the
# turn runs, so it carries no client-side deadline; the management routes are quick.
post() {
  local route=$1 body=$2 session=${3:-}
  local timeout=60
  local extra=()
  [ "$route" = say ] && { timeout=0; extra=(-N); }
  if [ -n "$session" ]; then
    curl -sS "${extra[@]}" --max-time "$timeout" -X POST \
      -H "x-dsh-wsl-token: $TOKEN" \
      -H "x-dsh-wsl-session: $session" \
      --data-binary "$body" "$BASE/$route"
  else
    curl -sS "${extra[@]}" --max-time "$timeout" -X POST -H "x-dsh-wsl-token: $TOKEN" \
      --data-binary "$body" "$BASE/$route"
  fi
}

cmd_list() {
  local out
  out=$(post list '')
  case "$out" in
    err*) die "${out#err	}" ;;
  esac
  printf '%s\n' "$out" | awk -F'\t' '
    NF == 0 { next }
    { mark = ($5 == "*") ? "*" : " "; printf "%s %-28s %s\n", mark, $1, ($2 == "" ? "(未命名)" : $2) }
  '
}

cmd_new() {
  local id=$1 out
  [ -n "$id" ] || die "用法：dsh new <会话id>"
  out=$(post new "$id" "$id")
  case "$out" in
    err*) die "${out#err	}" ;;
  esac
  set_current "$id"
  printf '已新建并切换到会话 %s\n' "$id"
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

cmd_status() {
  local state
  state=$(curl -sS --max-time 10 "$BASE/state" 2>/dev/null) || die "连不上 DSH 宿主（$BASE）—— 桌面版在运行吗？"
  printf '当前会话：%s\n' "$(current_session)"
  printf '通道：%s\n' "$(printf '%s\n' "$state" | tr '\n' ' ')"
  printf 'shim：%s\n' "$(command -v dsh || printf '未知')"
}

# Stream one turn: `~`-prefixed frames, `~s`/`~a` carry base64 chunks of raw text.
cmd_say() {
  local session=$1 prompt=$2
  local reason=0 ended=0 line ms steps tin tout breason ok text_reason
  local -a rest
  while IFS= read -r line; do
    case "$line" in
      '~ack') ;;
      '~r '*) ms=${line#'~r '}; printf '\033[2m⏱ 思考中… %d.%01ds\033[0m' $((ms / 1000)) $(((ms % 1000) / 100)); reason=1 ;;
      '~t '*) if [ "$reason" = 1 ]; then printf '\033[0m\n'; fi; reason=2 ;;
      '~s '*) [ "$reason" = 1 ] || printf '\033[2m'; printf '%s' "${line#'~s '}" | base64 -d; reason=1 ;;
      '~a '*) if [ "$reason" = 1 ]; then printf '\033[0m\n'; fi; reason=2; printf '%s' "${line#'~a '}" | base64 -d ;;
      '~step '*) ;;
      '~p') ;;
      '~x '*)
        text_reason=$(printf '%s' "${line#'~x '}" | base64 -d)
        printf '\ndsh: %s\n' "$text_reason" >&2
        exit 1
        ;;
      '~e '*)
        read -r _ ok ms steps tin tout breason <<< "$line"
        text_reason=$(printf '%s' "${breason:-}" | base64 -d 2>/dev/null)
        [ "$reason" = 1 ] && printf '\033[0m'
        printf '\n'
        printf '✓ 完成 %d.%01ds · %s 步 · in %s / out %s tok%s\n' \
          $((ms / 1000)) $(((ms % 1000) / 100)) "$steps" "$tin" "$tout" \
          "${text_reason:+ (${text_reason})}"
        ended=1
        [ "$ok" = 1 ] && exit 0 || exit 1
        ;;
      'err'*) die "${line#err	}" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < <(post say "$prompt" "$session")
  [ "$reason" = 1 ] && printf '\033[0m'
  [ "$ended" = 1 ] || { printf '\n' >&2; die "连接在回合结束前断开"; }
}

# ---------------------------------------------------------------- entry point

[ $# -eq 0 ] && { usage; exit 1; }
case "$1" in
  -h|--help|help) usage; exit 0 ;;
esac

load_channel

case "$1" in
  list|ls) cmd_list; exit 0 ;;
  new) cmd_new "${2:-}"; exit 0 ;;
  use) cmd_use "${2:-}"; exit 0 ;;
  rm|archive) cmd_rm "${2:-}"; exit 0 ;;
  status) cmd_status; exit 0 ;;
esac

# A bare first word that names no command is either a session id (two or more args) or
# the prompt itself. `dsh "问题"` uses the current session; `dsh <id> "问题"` is explicit.
if [ $# -ge 2 ]; then
  cmd_say "$1" "${*:2}"
else
  cmd_say "$(current_session)" "$1"
fi
