#!/usr/bin/env bash
# dev-env-sync 一键上传（macOS 双击运行）
# 把本机改动提交并推送到：个人私有库 + 公开框架库
cd "$(dirname "$0")"
DATE="$(date '+%Y-%m-%d %H:%M')"

echo "==> 上传个人内容库（私有）"
if [ -d personal/.git ]; then
  (cd personal && git add -A)
  if (cd personal && git diff --cached --quiet); then
    echo "  (无改动)"
  else
    (cd personal && git commit -m "sync: $DATE" && git push) || echo "  ✗ 个人库 push 失败"
  fi
else
  echo "  (无 personal/ 目录，跳过)"
fi

echo "==> 上传同步框架（公开）"
git add -A
if git diff --cached --quiet; then
  echo "  (无改动)"
else
  git commit -m "sync: $DATE" && git push || echo "  ✗ 框架 push 失败（若远程仓库尚未创建，先到 GitHub 创建 dev-env-sync-template）"
fi

echo ""
echo "✔ 完成。其他设备双击 deploy 即可同步。"
