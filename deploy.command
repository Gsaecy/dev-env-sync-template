#!/usr/bin/env bash
# dev-env-sync 一键部署（macOS 双击运行）
# 拉取公开框架 + 私有内容库，然后部署到本机
cd "$(dirname "$0")"

echo "==> 1/3 更新同步框架（公开库）"
if git pull --ff-only 2>/dev/null; then
  echo "✔ 框架已更新"
else
  echo "  (框架库更新失败或未配置远程，继续)"
fi

echo "==> 2/3 更新个人内容库（私有）"
if [ -d personal/.git ]; then
  if (cd personal && git pull --ff-only) 2>/dev/null; then
    echo "✔ 个人库已更新"
  else
    echo "  (个人库更新失败，使用本地版本)"
  fi
else
  URL=""
  if [ -f .personal-repo ]; then
    URL="$(tr -d '[:space:]' < .personal-repo)"
  else
    # 首次使用：交互输入一次，之后自动记住
    printf "首次使用：请输入你的私有内容库地址（如 git@github.com:YOU/private.git）："
    read -r URL
    URL="$(printf '%s' "$URL" | tr -d '[:space:]')"
    if [ -n "$URL" ]; then printf '%s\n' "$URL" > .personal-repo; fi
  fi
  if [ -n "$URL" ]; then
    echo "  克隆 $URL → personal/"
    git clone "$URL" personal || { echo "✗ 克隆失败，请检查地址与 GitHub 权限"; exit 1; }
  else
    echo "✗ 缺少个人内容库地址，退出。重跑本脚本再输入即可。"
    exit 1
  fi
fi

echo "==> 3/3 部署到本机"
./install.sh
