#!/bin/sh
# 把 dsh-team-space 装进「网页版」profile（~/.dsh/profiles/web）。
#
# 为什么需要单独装：插件里的一键安装把目标写死在 profiles/desktop
# （lib/index.js 的 profileNodeModules），所以网页版永远装不上。
#
# 用法：
#   sh dev/install-web-profile.sh              # 用本脚本所在的仓库
#   sh dev/install-web-profile.sh /path/to/dsh-team-space
#
# 幂等：重复执行只会把 link 与 bundle 条目对齐，不会重复添加。
# 回滚：脚本结束时会打印备份文件路径，把备份覆盖回 package.json 即可。
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=${1:-$(cd "$HERE/.." && pwd)}
PROFILE="$HOME/.dsh/profiles/web"
PKG="$PROFILE/package.json"

if [ ! -f "$REPO/package.json" ]; then
  echo "找不到插件目录：$REPO" >&2
  exit 1
fi
if [ ! -d "$PROFILE" ]; then
  echo "找不到网页版 profile：$PROFILE" >&2
  echo "先跑一次 dsh web 让它初始化，再执行本脚本。" >&2
  exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$PKG.bak-$STAMP"
cp "$PKG" "$BACKUP"

mkdir -p "$PROFILE/node_modules/@local"
ln -sfn "$REPO" "$PROFILE/node_modules/@local/dsh-team-space"

python3 - "$PKG" "$REPO" <<'PY'
import json, sys
pkg_path, repo = sys.argv[1], sys.argv[2]
d = json.load(open(pkg_path))
d.setdefault('dependencies', {})['@local/dsh-team-space'] = f'link:{repo}'
profile = d.setdefault('dsh', {}).setdefault('profile', {})
bundles = profile.setdefault('bundles', [])
if '@local/dsh-team-space' not in bundles:
    bundles.append('@local/dsh-team-space')
json.dump(d, open(pkg_path, 'w'), ensure_ascii=False, indent=2)
open(pkg_path, 'a').write('\n')
PY

echo "已安装："
echo "  link   $PROFILE/node_modules/@local/dsh-team-space -> $REPO"
python3 - "$PKG" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print('  dep    ', d['dependencies'].get('@local/dsh-team-space'))
print('  bundles', d['dsh']['profile']['bundles'])
PY
echo
echo "下一步：重新启动网页版（dsh web），刷新页面后侧边栏应出现「团队空间」。"
echo "回滚："
echo "  cp '$BACKUP' '$PKG'"
echo "  rm -f '$PROFILE/node_modules/@local/dsh-team-space'"
