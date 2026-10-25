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
  - 只覆盖私有库里存在的技能；本机独有技能与隐藏文件保留（不再全量删除）
- **sync**（`sync.command` / `sync.bat`）：先把本机 `~/.copilot/skills` 收进私有库，再提交并推送到两个仓库
  - 只在本机装了新技能、没手工放进 `personal/` 时，`sync` 会自己把它们带上去；符号链接的技能按真实目录复制（Windows 上没有链接目标）
- 内部实现：`install.sh` / `install.ps1`（可单独调用）

## 私有内容库的结构约定

```
copilot/skills/…                  # 每个技能一个目录（含 SKILL.md）
copilot/copilot-instructions.md   # Copilot 全局指令
tools/npm-globals.txt             # npm 全局包，一行一个
tools/brew/Brewfile               # macOS Homebrew 清单
tools/winget/packages.txt         # Windows winget 清单
tools/vscode-extensions.txt       # VS Code 扩展清单（通用段 + [platform:*] 专属段）
tools/extension-platforms.json    # 可选：扩展平台判定覆盖表（不写就用内置规则）
playground/…                      # 其他离线资源（如图标库 vendor + 演示）
```

清单模板见 `tools/*.example.*`。

### 平台过滤（扩展与技能）

**扩展**：

- 上传时按 ID 判定落位：macOS 专属（swift / xcode / apple / ios / macos / sweetpad / swiftlint / swiftformat）写进
  `[platform:darwin]` 段，其余进通用段；旧清单里错位/重复的条目会被自动规整。
- VS Code 内置扩展（js-debug、typescript-language-features 等）不再写进清单。
- 部署时再按当前系统过滤一次：不属于本系统的扩展**跳过不装**；若本机已装且不适用，会提示卸载命令。
- 需要补充判断时，在私有库加 `tools/extension-platforms.json`（见 `tools/extension-platforms.json.example`）。

**技能**：

在 `SKILL.md` frontmatter 里声明适用平台，不写 = 全平台：

```yaml
---
name: mac-appstore-submission
description: ...
platforms: [darwin]        # 或 darwin, win32
---
```

部署时不属于当前系统的技能会跳过（不会写入 `~/.copilot/skills`）。

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

### 同类插件

技能勾选与分类管理在独立仓库：[Gsaecy/Local_skill_quick_access](https://github.com/Gsaecy/Local_skill_quick_access)（本地skill快捷调用）。

## 日常

- 本机更新环境：双击 `deploy`
- 改动技能/清单后同步：双击 `sync`
