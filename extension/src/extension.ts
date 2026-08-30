import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const output = vscode.window.createOutputChannel("Dev Env Sync");

function log(msg: string): void {
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function showError(action: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  log(`✗ ${action}: ${msg}`);
  vscode.window.showErrorMessage(`Dev Env Sync ${action}：${msg.slice(0, 300)}（详情见输出面板）`);
}

// ---------- 基础工具 ----------

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    log(`$ cd ${cwd} && ${cmd} ${args.join(" ")}`);
    const p = cp.spawn(cmd, args, { cwd });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(e));
    p.on("close", (code) => {
      const text = (out + err).trim();
      if (text) log(text);
      if (code === 0) resolve(text);
      else reject(new Error(text || `${cmd} exited ${code}`));
    });
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

async function copyDirContents(src: string, dst: string): Promise<void> {
  await fs.rm(dst, { recursive: true, force: true });
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      await fs.mkdir(d, { recursive: true });
      await copyDirContents(s, d);
    } else if (e.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

// ---------- 内容库 ----------

async function ensurePersonal(frameworkDir: string, url: string): Promise<string> {
  const personalDir = path.join(frameworkDir, "personal");
  await fs.mkdir(frameworkDir, { recursive: true });
  if (await exists(path.join(personalDir, ".git"))) {
    log("personal 已存在，拉取最新");
    try {
      await run("git", ["pull", "--ff-only"], personalDir);
    } catch {
      log("ff-only 失败，尝试普通 pull");
      await run("git", ["pull"], personalDir);
    }
  } else {
    log(`首次克隆 ${url}`);
    await run("git", ["clone", url, "personal"], frameworkDir);
  }
  return personalDir;
}

async function deploySkills(personalDir: string): Promise<boolean> {
  const skillsSrc = path.join(personalDir, "copilot", "skills");
  const skillsDst = path.join(os.homedir(), ".copilot", "skills");
  if (!(await exists(skillsSrc))) {
    log(`未找到 ${skillsSrc}，跳过技能部署`);
    return false;
  }
  log(`部署技能 → ${skillsDst}`);
  await copyDirContents(skillsSrc, skillsDst);

  const instr = path.join(personalDir, "copilot", "copilot-instructions.md");
  if (await exists(instr)) {
    const gh = path.join(os.homedir(), ".github");
    await fs.mkdir(gh, { recursive: true });
    await fs.copyFile(instr, path.join(gh, "copilot-instructions.md"));
    log("全局指令已部署");
  }
  return true;
}

// ---------- 工具链终端脚本 ----------

function toolchainScript(personalDir: string): string | null {
  const isWin = process.platform === "win32";
  const tools = path.join(personalDir, "tools");
  const npmFile = path.join(tools, "npm-globals.txt");
  const lines: string[] = [];

  if (isWin) {
    const esc = (p: string) => p.replace(/\\/g, "\\\\");
    const pkgsFile = esc(path.join(tools, "winget", "packages.txt"));
    const npmEsc = esc(npmFile);
    lines.push("$ErrorActionPreference = \"Continue\"");
    lines.push(`$pkgs = "${pkgsFile}"`);
    lines.push("if (Test-Path $pkgs) { Get-Content $pkgs | Where-Object { $_ -and -not $_.TrimStart().StartsWith(\"#\") } | ForEach-Object { $p = $_.Trim(); if ($p) { winget install -e --id $p --silent --accept-package-agreements --accept-source-agreements } } }");
    lines.push("winget install -e --id Microsoft.VisualStudio.2022.BuildTools --silent --accept-package-agreements --accept-source-agreements --override \"--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended\"");
    lines.push(`if (Test-Path "${npmEsc}") { Get-Content "${npmEsc}" | Where-Object { $_ -and -not $_.TrimStart().StartsWith(\"#\") } | ForEach-Object { npm install -g $_.Trim() } }`);
  } else {
    const brewfile = path.join(tools, "brew", "Brewfile");
    lines.push("xcode-select -p >/dev/null 2>&1 || xcode-select --install");
    lines.push(`[ -f "${brewfile}" ] && brew bundle --file="${brewfile}" || echo "Brewfile not found, skip"`);
    lines.push(`[ -f "${npmFile}" ] && sed -e '/^#/d' -e '/^[[:space:]]*$/d' "${npmFile}" | while IFS= read -r p; do npm install -g "$p"; done || true`);
  }
  return lines.join("\n");
}

// ---------- 命令 ----------

async function deploy(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("devEnvSync");

  let url = (cfg.get<string>("personalRepo") ?? "").trim();
  if (!url) {
    const input = await vscode.window.showInputBox({
      prompt: "输入私有内容库地址（保存后随 VS Code 设置同步，不再询问）",
      placeHolder: "git@github.com:YOU/private-repo.git",
    });
    url = (input ?? "").trim();
    if (!url) return;
    await cfg.update("personalRepo", url, vscode.ConfigurationTarget.Global);
    log(`已保存 personalRepo：${url}`);
  }

  const frameworkDir = expandHome(cfg.get<string>("frameworkDir") ?? "~/dev/dev-env-sync");
  let personalDir = "";
  let skillsOk = false;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Dev Env Sync：同步内容库…" },
      async () => {
        personalDir = await ensurePersonal(frameworkDir, url);
        skillsOk = await deploySkills(personalDir);
      },
    );
  } catch (e) {
    showError("部署失败", e);
    return;
  }

  if (cfg.get<boolean>("withToolchain", true)) {
    const script = toolchainScript(personalDir);
    if (script) {
      const term = vscode.window.createTerminal({ name: "Dev Env Sync" });
      term.show();
      term.sendText(script);
      log("工具链脚本已发送到终端");
    }
  }

  if (!skillsOk) {
    vscode.window.showWarningMessage("Dev Env Sync：内容库已更新，但未找到 skills 目录（检查私有库的 copilot/skills 结构）");
    return;
  }

  const act = await vscode.window.showInformationMessage("✔ 部署完成：Copilot 技能与全局指令已更新（工具链在终端继续安装）。", "重启 VS Code");
  if (act === "重启 VS Code") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

async function upload(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("devEnvSync");
  const frameworkDir = expandHome(cfg.get<string>("frameworkDir") ?? "~/dev/dev-env-sync");
  const personalDir = path.join(frameworkDir, "personal");

  if (!(await exists(path.join(personalDir, ".git")))) {
    vscode.window.showErrorMessage("Dev Env Sync：personal 内容库不存在，请先执行「一键部署」");
    return;
  }

  const stamp = new Date().toLocaleString();
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Dev Env Sync：上传改动…" },
      async () => {
        await run("git", ["add", "-A"], personalDir);
        try {
          await run("git", ["commit", "-m", `sync: ${stamp}`], personalDir);
        } catch (e) {
          log("commit 跳过（可能无改动）：" + (e instanceof Error ? e.message : ""));
        }
        await run("git", ["push"], personalDir);

        if (await exists(path.join(frameworkDir, ".git"))) {
          await run("git", ["add", "-A"], frameworkDir);
          try {
            await run("git", ["commit", "-m", `sync: ${stamp}`], frameworkDir);
          } catch (e) {
            log("框架 commit 跳过（可能无改动）");
          }
          await run("git", ["push", "-u", "origin", "HEAD"], frameworkDir);
        }
      },
    );
    vscode.window.showInformationMessage("✔ 已上传：私有内容库（及本地框架仓库）改动均已推送");
  } catch (e) {
    showError("上传失败", e);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  log("Dev Env Sync 已激活");
  context.subscriptions.push(
    vscode.commands.registerCommand("devEnvSync.deploy", deploy),
    vscode.commands.registerCommand("devEnvSync.upload", upload),
  );
}

export function deactivate(): void {}
