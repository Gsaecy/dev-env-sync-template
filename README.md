# dev-env-sync

一键**同步上传**、一键**部署**的个人开发环境同步框架。公开仓库只含框架代码，你的隐私内容（Copilot 技能、工具清单、配置）放在独立的**私有仓库**里，永不上传公开仓库。

## 为什么双仓库

| 仓库 | 可见性 | 内容 |
|---|---|---|
| 本仓库（框架） | 公开 | install / deploy / sync 脚本、示例清单、文档 |
| 你的内容库 | 私有 | `copilot/skills/`（技能）、`copilot/copilot-instructions.md`、`tools/`（npm / Brewfile / winget 清单）、playground 资源 |

`personal/` 目录已被 `.gitignore` 忽略，框架仓库永远不包含任何隐私内容。

## 快速开始

1. 在 GitHub 创建一个**私有**仓库作为内容库（New repository → Private）
2. 克隆本框架：
   ```bash
   # macOS
   git clone git@github.com:Gsaecy/dev-env-sync-template.git ~/dev/dev-env-sync
   # Windows（PowerShell）
   git clone git@github.com:Gsaecy/dev-env-sync-template.git $env:USERPROFILE\dev\dev-env-sync
   ```
3. 部署：macOS 双击 `deploy.command`，Windows 双击 `deploy.bat`
   - 首次运行会询问你的私有内容库地址（输入一次，自动记住到 `.personal-repo`，该文件不会上传）

## 一键命令

- **deploy**（`deploy.command` / `deploy.bat`）：拉取公开框架 + 私有内容库 → 部署到本机
  - macOS：Xcode CLT → Homebrew → Brewfile（node/rustup/cmake/ninja…）→ npm 全局包
  - Windows：winget（Git / Node LTS / Rustup / CMake / Ninja）→ VS 2022 Build Tools（C++）→ npm 全局包
  - 自动识别 arm64 / x64，重复执行幂等
- **sync**（`sync.command` / `sync.bat`）：把本机改动一键提交并推送到两个仓库
- 内部实现：`install.sh` / `install.ps1`（可单独调用）

## 私有内容库的结构约定

```
copilot/skills/…                  # 每个技能一个目录（含 SKILL.md）
copilot/copilot-instructions.md   # Copilot 全局指令
tools/npm-globals.txt             # npm 全局包，一行一个
tools/brew/Brewfile               # macOS Homebrew 清单
tools/winget/packages.txt         # Windows winget 清单
playground/…                      # 其他离线资源（如图标库 vendor + 演示）
```

清单模板见 `tools/*.example.*`。

## 新设备三步

1. `git clone` 本框架仓库
2. 双击 `deploy`（首次输入私人库地址）
3. 打开 VS Code「设置同步」（GitHub 账号登录）恢复扩展/设置/快捷键 —— 与框架互补

## VS Code 插件（extension/）

除了双击脚本，还可以用 **VS Code 插件**在编辑器里直接同步（两条命令：`Dev Env Sync: 一键部署` / `一键上传`）。插件自包含（不依赖本仓库目录），私人库地址存 VS Code 设置并随设置同步。

- 源码：`extension/`
- 构建：`cd extension && npm install && npm run compile && npm run package`（产出 `.vsix`）
- 安装 VSIX：`code --install-extension dev-env-sync-x.y.z.vsix`
- 发布到 Marketplace 后，新设备登录 GitHub 账号即可由「设置同步」自动安装插件

## 日常

- 本机更新环境：双击 `deploy`
- 改动技能/清单后同步：双击 `sync`
