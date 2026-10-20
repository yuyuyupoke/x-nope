#!/bin/sh
# 配布用の dist/x-nope.zip を作る。
# 解凍すると x-nope/ フォルダができ、そのまま Chrome に読み込める。
set -eu
cd "$(dirname "$0")/.."

version=$(node -p "require('./manifest.json').version")
pkg=$(node -p "require('./package.json').version")
if [ "$version" != "$pkg" ]; then
  echo "manifest.json ($version) と package.json ($pkg) のバージョンが一致していない" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -r "$work"' EXIT
mkdir "$work/x-nope"
cp manifest.json net.js content.js style.css README.md LICENSE "$work/x-nope/"

mkdir -p dist
# 失敗したときに壊れた zip を残さないよう、作業フォルダで作ってから置き換える
(cd "$work" && zip -qrX x-nope.zip x-nope)
mv "$work/x-nope.zip" dist/x-nope.zip

echo "dist/x-nope.zip を作成 (v$version)"
unzip -l dist/x-nope.zip
