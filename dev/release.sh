#!/bin/sh
# 发布一个新版本：一次做完「版本号 / 打包 / 分发 / 清单 / git」四件事。
#
# 用法：
#   sh dev/release.sh 2.7.54 "修了什么"
#
# 为什么要有这个东西：团队空间的改动会同时影响三个消费方
# （DSH 客户端 / Codex MCP / 独立门户页），而发布又要落到两个 profile
# （desktop 与 web）。少做一步就会出现「有人看到旧版」或「按钮还是坏的」。
#
# 前提：本机已有 ~/.dsh/profiles/desktop 与 ~/.dsh/storages/team-space-dist。
# 回滚：脚本会打印每一步的备份路径。
set -e

VERSION=${1:?用法: sh dev/release.sh <版本号> "提交说明"}
MESSAGE=${2:-"release v$VERSION"}

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
DIST="$HOME/.dsh/storages/team-space-dist"
STORE="$HOME/.dsh/storages/team-space.json"
TARBALL="$REPO/../dsh-team-space-$VERSION.tgz"
STAMP=$(date +%Y%m%d-%H%M%S)

cd "$REPO"

echo "== 1/5 版本号 =="
cp package.json "package.json.bak-$STAMP"
python3 - "$VERSION" <<'PY'
import json, re, sys
version = sys.argv[1]
pkg = json.load(open('package.json'))
old = pkg['version']
pkg['version'] = version
json.dump(pkg, open('package.json', 'w'), ensure_ascii=False, indent=2)
open('package.json', 'a').write('\n')
src = open('lib/client.js', encoding='utf-8').read()
src = re.sub(r'团队空间 v[0-9][0-9.]* ·', f'团队空间 v{version} ·', src, count=1)
open('lib/client.js', 'w', encoding='utf-8').write(src)
print(f'  {old} → {version}')
PY

echo "== 2/5 离线自检 =="
# 两个都要跑，各自证明不同的事：
#   mock-host —— 用临时 DSH_HOME 真跑**这份源码**，不重启 DSH 就能验宿主半的新逻辑
#   selftest  —— 打本机**运行中**的宿主，证明线上那份没坏（刚改完还没重启时它会落后一个版本）
#   e2e-p0    —— selftest 没覆盖的路由（detail/download/member/portal/MCP/consume）
#   check-store —— 旧数据迁移 + store 损坏不静默清空
# 注意：不能写成 `node xxx | tail -2` —— tail 的退出码永远是 0，
# 测试挂了发布也会继续。这里统一走 run_check，失败直接中止。
CHECK_LOG="${TMPDIR:-/tmp}/team-space-release-check.log"
run_check() {
  label=$1
  shift
  if ! "$@" > "$CHECK_LOG" 2>&1; then
    echo "  ✗ $label 失败"
    tail -30 "$CHECK_LOG"
    exit 1
  fi
  tail -2 "$CHECK_LOG"
}
run_check mock-host node dev/mock-host.mjs
run_check check-store node dev/check-store.mjs
run_check selftest node dev/selftest.mjs
run_check e2e-p0 node dev/e2e-p0.mjs

echo "== 3/5 打包 =="
rm -f "$TARBALL"
tar -czf "$TARBALL" \
  --exclude node_modules --exclude .git --exclude '.bak-*' --exclude '*.bak-*' \
  --exclude 'docs/images' --exclude 'docs/*.png' \
  -C "$(dirname "$REPO")" "$(basename "$REPO")"
ls -la "$TARBALL" | awk '{print "  " $5 " 字节  " $NF}'

echo "== 4/5 分发与清单 =="
mkdir -p "$DIST"
cp "$TARBALL" "$DIST/"
python3 - "$STORE" "$VERSION" <<'PY'
import json, sys, hashlib, time, os
store_path, version = sys.argv[1], sys.argv[2]
d = json.load(open(store_path))
item = next((x for x in d.get('plugins', []) if x['name'] == 'dsh-team-space'), None)
if item is None:
    sys.exit('清单里没有 dsh-team-space，先手工建一条')
backup = f'{store_path}.bak-{time.strftime("%Y%m%d-%H%M%S")}-before-{version.replace(".", "")}'
open(backup, 'w').write(open(store_path).read())
item['version'] = version
item['source'] = f'本地打包：dsh-team-space-{version}.tgz；源码 {os.getcwd()}'
# 地址里不要加引号：客户端用 /https?:\/\/\S+\.tgz/ 抠地址，引号会被一起吃进去
item['installCommand'] = (
    'curl -fsSL -o /tmp/ts.tgz '
    f'http://192.168.42.124:8080/api/team-space/download?file=dsh-team-space-{version}.tgz'
)
item['updatedAt'] = int(time.time() * 1000)
FIELDS = {'name': 120, 'version': 60, 'source': 300, 'audit': 2000,
          'installCommand': 1000, 'note': 2000, 'clientSha': 64}
record = {}
for key, limit in FIELDS.items():
    value = item.get(key) if isinstance(item.get(key), str) else ''
    record[key] = value.strip()[:limit]
item['contentHash'] = hashlib.sha256(json.dumps(record, ensure_ascii=False).encode()).hexdigest()
tmp = f'{store_path}.{os.getpid()}.tmp'
open(tmp, 'w').write(json.dumps(d, ensure_ascii=False, indent=2) + '\n')
os.replace(tmp, store_path)
print(f'  清单 → {version}')
print(f'  备份 → {backup}')
PY

echo "== 5/5 git =="
git add -A
git commit -q -m "release: v$VERSION — $MESSAGE" || echo "  （没有改动，跳过提交）"
git push origin HEAD 2>&1 | tail -2

echo
echo "完成。别忘了："
echo "  · 宿主半改过 → 完全退出 DSH（Cmd+Q）再启动"
echo "  · 网页版用户 → 跑 dev/install-web-profile.sh 后重开 dsh web"
echo "  · Codex 用户 → 配置没变就不用动，工具随 MCP 进程重启生效"
