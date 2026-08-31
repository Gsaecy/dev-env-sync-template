# Dev Env Sync

个人开发环境同步的 VS Code 插件：登录 GitHub 账号后，在 VS Code 里点一下就能部署/上传你的开发环境。

## 图形界面（0.1.2+）

活动栏的 **Dev Env Sync** 图标打开侧边栏面板：一键部署 / 一键上传按钮、私人库与工作目录设置、工具链开关、实时运行日志，部署完成后一键重启 VS Code。

## 命令

| 命令 | 作用 |
|---|---|
| `Dev Env Sync: 一键部署` | 拉取私有内容库 → 部署 Copilot 技能与全局指令到本机 → 终端自动装工具链（Homebrew / winget + npm 全局包）→ 提示重启 VS Code |
| `Dev Env Sync: 一键上传` | 把本机改动提交并推送到私有内容库（若本地有框架仓库则一并推送） |

## 配置（设置 → Dev Env Sync）

- `devEnvSync.personalRepo`：私有内容库地址。首次部署时自动询问并保存，随 VS Code 设置同步——同一 GitHub 账号的新设备会自动读取，无需再填写。
- `devEnvSync.frameworkDir`：本地工作目录（默认 `~/dev/dev-env-sync`）。
- `devEnvSync.withToolchain`：部署后是否自动装工具链（默认开）。

## 新设备前置

1. 已装 Git（https://git-scm.com）
2. SSH key 已添加到 GitHub（`ssh-keygen -t ed25519`），或私人库地址用 https 形式

## 私有内容库结构

```
copilot/skills/…                  # Copilot 技能（每个技能一个目录）
copilot/copilot-instructions.md   # 全局指令
tools/npm-globals.txt             # npm 全局包清单
tools/brew/Brewfile               # macOS Homebrew 清单
tools/winget/packages.txt         # Windows winget 清单
```

## 构建

```bash
npm install
npm run compile
npm run package   # 生成 dev-env-sync-x.y.z.vsix
```

## 发布到 Marketplace（新设备即可由设置同步自动安装）

**方式一：网页上传（已创建 Publisher `Gsaecy` 时推荐）**
1. 打包：`cd extension && npm run package`
2. marketplace.visualstudio.com/manage → New extension → 选 Visual Studio Code → 上传生成的 `.vsix`（出版商 ID 为 `honor-world`）

**方式二：CLI 发布（浏览器授权）**
```bash
cd extension
npx @vscode/vsce login honor-world   # 打开浏览器完成 GitHub 授权
npx @vscode/vsce publish             # 发布当前版本
```

**方式三：CI 自动发布**：GitHub 仓库添加 secret `VSCE_PAT`（Azure DevOps PAT，Marketplace → Manage 权限），推一个 `v*` 标签，`.github/workflows/publish-extension.yml` 会自动发布。

发布后新设备登录同一 GitHub 账号 → VS Code 设置同步会自动安装本插件；以后双击命令即可。
