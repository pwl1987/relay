#!/bin/bash
# DEPLOY-03D 部署后验证脚本(只读 HTTP 探测;口令经文件读取,零打印)。
# 用法: deploy/verify-web-03d.sh <base> <password-file>
# 覆盖: / 302→/workspace、登录回路、workspace 03D 标记、manifest MIME/字段、CSP manifest-src、
#        移动 DOM 标记、图标可达、未登录 302。
set -u
BASE="${1:?用法: verify-web-03d.sh <base> <password-file>}"; BASE="${BASE%/}"
PW_FILE="${2:?用法: verify-web-03d.sh <base> <password-file>}"
PASS=0; FAIL=0
ok()   { echo "PASS $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL $1"; FAIL=$((FAIL+1)); }
check() { # check <名> <期望> <实际>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (期望=$2 实际=$3)"; fi
}
contains() { # contains <名> <haystack> <needle>
  case "$2" in *"$3"*) ok "$1";; *) bad "$1 (未含:$3)";; esac
}
not_contains() {
  case "$2" in *"$3"*) bad "$1 (不应含:$3)";; *) ok "$1";; esac
}

# 1) / 未登录 → 302 /login.html
r=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/" --max-time 10)
check "未登录 / 302" "302 $BASE/login.html" "$r"

# 2) 登录回路(口令零打印:写入 0600 临时 JSON 经 stdin 传给 curl,不进 argv/ps)
JAR=$(mktemp); BODY=$(mktemp); chmod 600 "$JAR" "$BODY"; trap 'rm -f "$JAR" "$BODY"' EXIT
printf '{"password":"%s"}' "$(cat "$PW_FILE")" > "$BODY"
lr=$(curl -s -c "$JAR" -o /tmp/d03d-login-body -w '%{http_code}' -H 'content-type: application/json' \
  --data-binary @"$BODY" "$BASE/api/session" --max-time 10)
check "登录 API 200" "200" "$lr"
rm -f "$BODY" /tmp/d03d-login-body

# 3) 已登录 / → 302 /workspace
r=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/" --max-time 10)
check "已登录 / 302→/workspace" "302 $BASE/workspace" "$r"

# 4) /workspace 200 + 03D 移动标记(菜单键/状态点/详情 sheet/回到最新/viewport-fit)
ws=$(curl -s -b "$JAR" "$BASE/workspace" --max-time 10)
code=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/workspace" --max-time 10)
check "/workspace 200" "200" "$code"
contains "workspace 含 ws-menu-btn" "$ws" 'ws-menu-btn'
contains "workspace 含 ws-title-dot" "$ws" 'ws-title-dot'
contains "workspace 含 ws-sheet" "$ws" 'ws-sheet'
contains "workspace 含 ws-jump-latest" "$ws" 'ws-jump-latest'
contains "workspace 含 viewport-fit=cover" "$ws" 'viewport-fit=cover'
contains "workspace 含 apple A2HS meta" "$ws" 'apple-mobile-web-app-capable'
contains "workspace 含 manifest 链接" "$ws" '/manifest.webmanifest'

# 5) manifest MIME+字段
mh=$(curl -s -o /tmp/d03d-manifest -D - "$BASE/manifest.webmanifest" --max-time 10)
contains "manifest content-type" "$mh" 'application/manifest+json'
contains "manifest CSP manifest-src" "$mh" "manifest-src 'self'"
m=$(cat /tmp/d03d-manifest)
contains "manifest name 中文" "$m" 'Relay · AI 软件开发工作台'
contains "manifest short_name" "$m" '"short_name": "Relay"'
contains "manifest standalone" "$m" '"display": "standalone"'
contains "manifest start_url" "$m" '"start_url": "/"'

# 6) 图标可达
for p in /icons/icon-192.png /icons/icon-512.png; do
  c=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$p" --max-time 10)
  check "图标 $p 200" "200" "$c"
done

# 7) workspace JS 含 03D 行为(visualViewport/coarse Enter/断网文案/回到最新)
js=$(curl -s -b "$JAR" "$BASE/workspace.js" --max-time 10)
contains "workspace.js visualViewport" "$js" 'visualViewport'
contains "workspace.js coarse Enter 分支" "$js" 'pointer: coarse'
contains "workspace.js 断网文案" "$js" '与 Relay 的连接暂时中断'
contains "workspace.js 回到最新" "$js" 'jumpToLatest'

# 8) style.css 含 03D 移动块
css=$(curl -s "$BASE/style.css" --max-time 10)
contains "style.css 03D 段" "$css" 'WEB-UX-03D'

# 9) 抽样旧页面 200(旧 URL 保留)
for p in /index.html /decisions.html /projects.html /system.html /goal.html /changeset.html /models.html; do
  c=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE$p" --max-time 10)
  check "页面 $p 200" "200" "$c"
done

# 10) API 会话身份
who=$(curl -s -b "$JAR" "$BASE/api/session" --max-time 10)
contains "会话 role=owner" "$who" '"role":"owner"'

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
