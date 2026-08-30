#!/usr/bin/env bash
# dev-env-sync 一键安装核心（macOS / Linux）
# 由 deploy.command 调用，也可单独执行。
# 内容来源：优先 personal/（私有内容库），缺失时用仓库自带示例。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OS="$(uname -s)"
ARCH="$(uname -m)"

# 内容根目录：personal/（私有库）优先
CONTENT_ROOT="$REPO_DIR/personal"
if [ -d "$CONTENT_ROOT" ]; then
  echo "==> 内容源：personal/（私有内容库）"
else
  CONTENT_ROOT="$REPO_DIR"
  echo "⚠ 未检测到 personal/，使用仓库自带示例内容（正式部署请先配置私人库，见 README）"
fi

info() { echo "==> $*"; }
ok()   { echo "✔ $*"; }
warn() { echo "⚠ $*"; }

info "设备环境：$OS / $ARCH"

# ---------- 1. Copilot skills 与全局指令 ----------
deploy_copilot() {
  local src="$CONTENT_ROOT/copilot/skills" dst="$HOME/.copilot/skills"
  if [ ! -d "$src" ]; then warn "未找到 ${src}，跳过 skills 部署"; return 0; fi
  info "部署 Copilot skills → $dst"
  mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then
    # --delete 保证与仓库完全一致（仓库删掉的技能本机也删）
    rsync -a --delete "$src/" "$dst/"
  else
    warn "本机无 rsync，改用 cp 覆盖；仓库已删除的技能不会被清理"
    cp -a "$src/." "$dst/"
  fi
  if [ -f "$CONTENT_ROOT/copilot/copilot-instructions.md" ]; then
    mkdir -p "$HOME/.github"
    cp "$CONTENT_ROOT/copilot/copilot-instructions.md" "$HOME/.github/copilot-instructions.md"
  fi
  ok "skills 与全局指令部署完成"
}

# ---------- 2. npm 全局包 ----------
install_npm_globals() {
  local file="$CONTENT_ROOT/tools/npm-globals.txt"
  [ -s "$file" ] || { warn "npm 全局包清单缺失或为空，跳过"; return 0; }
  info "安装 npm 全局包（清单：${file}）"
  grep -vE '^\s*(#|$)' "$file" | while IFS= read -r pkg; do
    npm install -g "$pkg"
  done
  ok "npm 全局包完成"
}

# ---------- 3. macOS：Xcode CLT + Homebrew + Brewfile ----------
setup_macos() {
  # Xcode Command Line Tools（提供 clang/clang++/make 等 C/C++ 工具）
  if xcode-select -p >/dev/null 2>&1; then
    ok "Xcode CLT 已就绪（clang/clang++/make）"
  else
    warn "未检测到 Xcode CLT，触发安装（会弹出系统窗口）"
    xcode-select --install || true
    read -r -p "CLT 安装完成后按回车继续..." _
  fi

  # Homebrew：Apple Silicon → /opt/homebrew，Intel → /usr/local 自动适配
  if command -v brew >/dev/null 2>&1; then
    ok "Homebrew 已就绪：$(brew --version | head -1)"
  else
    info "安装 Homebrew"
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [ "$ARCH" = "arm64" ]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    else
      eval "$(/usr/local/bin/brew shellenv)"
    fi
  fi

  local brewfile="$CONTENT_ROOT/tools/brew/Brewfile"
  if [ -s "$brewfile" ]; then
    info "按 Brewfile 安装工具（幂等可重复执行）"
    brew bundle --file="$brewfile"
    ok "Homebrew 清单完成"
  else
    warn "未找到 Brewfile，跳过"
  fi
}

# ---------- 4. Linux（最小支持） ----------
setup_linux() {
  warn "Linux 暂未适配包管理器清单，仅部署 Copilot 技能；有 node 则同步 npm 全局包"
}

# ---------- 主流程 ----------
deploy_copilot

case "$OS" in
  Darwin) setup_macos ;;
  Linux)  setup_linux ;;
  *)      warn "未知系统 $OS，跳过系统工具安装" ;;
esac

if command -v npm >/dev/null 2>&1; then
  install_npm_globals
else
  warn "未找到 npm（macOS 首装 node@22 后 PATH 未刷新），重开终端后重跑 deploy.command 即可"
fi

echo ""
ok "全部完成。重启 VS Code 后生效。"
