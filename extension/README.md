# 部署环境一键迁移 · One-Click Dev Environment Migration

**Dev Env Sync** —— 登录 GitHub 账号后，在 VS Code 里点一下，就把你的个人开发环境从私有仓库一键迁移到任何设备；改完再点一下，回传本机改动。

| 功能 | 说明 |
|------|------|
| ⬇️ **一键部署** | 拉取私有内容库 → 部署 Copilot 技能与全局指令 → 按清单安装 VS Code 扩展与工具链（Homebrew / winget / npm） |
| ⬆️ **一键上传** | 导出本机已装扩展清单，连同改动一起提交推送到私有库 |
| 🖥️ **平台自动过滤** | 扩展清单按平台分节：通用段 + 各平台专属段，macOS 的 Swift 扩展绝不会同步到 Windows 设备 |
| ⚡ **增量部署** | 技能与全局指令按内容比对，未变化直接跳过；一切已是最新时不再提示重启 |
| 📋 **逐项安装清单** | 每项实时状态：⏳ 执行中 → ✅ 安装完毕 / ❌ 失败 / ⚠️ 需手动（附官网链接） |
| 🔒 **隐私安全** | 私人内容库存你自己的 Private 仓库，公开仓库只含框架脚本 |

---

👨‍💻 **开发者个人主页**：<https://hongyuguo.com>
⭐ **GitHub 项目与赞赏**：<https://github.com/Gsaecy/dev-env-sync-template>

---

## 使用

1. 点击活动栏图标打开面板，首次「一键部署」会引导填写私人库地址（未建库请先在 GitHub 创建一个 Private 仓库）
2. 地址保存后随 VS Code 设置同步——同一 GitHub 账号的新设备自动读取，无需再填
3. 新设备：安装本扩展 → 点「一键部署」即可还原完整开发环境

## 配置（设置 → Dev Env Sync）

- `devEnvSync.personalRepo`：私有内容库地址（随 VS Code 设置同步）
- `devEnvSync.frameworkDir`：本地工作目录（默认 `~/dev/dev-env-sync`）
- `devEnvSync.withToolchain`：部署后是否自动装工具链（默认开）

## 私有内容库结构

```
copilot/skills/…                  # Copilot 技能（每个技能一个目录）
copilot/copilot-instructions.md   # 全局指令
tools/vscode-extensions.txt       # VS Code 扩展清单（通用段 + [platform:*] 专属段）
tools/npm-globals.txt             # npm 全局包清单
tools/brew/Brewfile               # macOS Homebrew 清单
tools/winget/packages.txt         # Windows winget 清单
```

扩展清单平台分节示例：

```
# 通用（所有平台）
ms-python.python

# [platform:darwin] macOS 专属
sswg.swift-lang
```

部署时只安装「通用段 + 当前平台专属段」，其余平台段自动忽略。

## 命令

| 命令 | 作用 |
|---|---|
| `Dev Env Sync: 一键部署` | 拉取私有内容库 → 部署 Copilot 技能与全局指令 → 自动装扩展与工具链 |
| `Dev Env Sync: 一键上传` | 导出本机扩展清单并推送到私有内容库（若有框架仓库一并推送） |

## 新设备前置

1. 已装 Git（https://git-scm.com）
2. SSH key 已添加到 GitHub（`ssh-keygen -t ed25519`），或私人库地址用 https 形式

## 版本更新

- **0.4.1** — 修复工具链开关样式：`.cfg label` 特异性覆盖 `.switch` 导致轨道塌陷、白点手柄浮在文字上方
- **0.4.0** — Apple 风格界面（毛玻璃卡片 / 胶囊按钮 / 分段开关 / 线条图标）；扩展名改为「部署环境一键迁移」；扩展清单按平台分节，macOS 专属扩展（Swift/Xcode/Apple）不再同步到 Windows；主页展示开发者主页与 GitHub 项目
- **0.3.0** — 修复部署误删本机隐藏状态文件；增量部署（内容未变跳过）；并发安装提速；面板 busy/清单状态重建恢复
- **0.2.0** — 图形面板：逐项安装清单、扩展同步、设置区应用
- **0.1.x** — 基础命令与活动栏入口

## 构建与发布

```bash
cd extension
npm install && npm run compile
npm run package   # 生成 dev-env-sync-x.y.z.vsix
```

发布：marketplace.visualstudio.com/manage → honor-world → 上传 `.vsix`。
> ⚠️ **版本铁律**：每轮修复必须升版本号再上传——同版本号重传，商店端客户端不会重新拉取，本地测试正常但商店一直是旧包。
