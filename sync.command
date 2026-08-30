#!/usr/bin/env bash
# dev-env-sync 一键上传（macOS 双击运行）
# 把本机改动提交并推送到：个人私有库 + 公开框架库
cd "$(dirname "$0")"
DATE="$(date '+%Y-%m-%d %H:%M')"

echo "==> 上传个人内容库（私有）"
if [ -d personal/.git ]; then
  (cd personal && git add -A)
  (cd personal && git commit -q -m "sync: $DATE") 2>/dev/null || true
  if OUT=$(cd personal && git push 2>&1); then
    echo "$OUT" | tail -1
    echo "✔ 个人库已上传"
  else
    echo "  ✗ 个人库 push 失败："
    echo "$OUT" | tail -2
  fi
else
  echo "  (无 personal/ 目录，跳过)"
fi

echo "==> 上传同步框架（公开）"
git add -A
git commit -q -m "sync: $DATE" 2>/dev/null || true
if OUT=$(git push -u origin HEAD 2>&1); then
  echo "✔ 框架已上传"
else
  echo "  ✗ 框架 push 失败（若远程仓库尚未创建，先到 GitHub 创建 dev-env-sync-template，再双击本脚本即可）"
  echo "$OUT" | tail -2
fi

echo ""
echo "✔ 完成。其他设备双击 deploy 即可同步。"
