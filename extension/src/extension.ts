import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const output = vscode.window.createOutputChannel("Dev Env Sync");

type Logger = (line: string) => void;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function showError(action: string, e: unknown): void {
  const msg = errMsg(e);
  output.appendLine(`✗ ${action}: ${msg}`);
  vscode.window.showErrorMessage(`Dev Env Sync ${action}：${msg.slice(0, 300)}（详情见输出面板）`);
}

// ---------- 基础工具 ----------

function run(cmd: string, args: string[], cwd: string, log?: Logger): Promise<string> {
  return new Promise((resolve, reject) => {
    if (log) log(`$ cd ${cwd} && ${cmd} ${args.join(" ")}`);
    const p = cp.spawn(cmd, args, { cwd });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(e));
    p.on("close", (code) => {
      const text = (out + err).trim();
      if (text) {
        if (log) text.split("\n").slice(0, 20).forEach((l) => log("  " + l));
        else output.appendLine(text);
      }
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

// ---------- 内容库与部署 ----------

async function ensurePersonal(frameworkDir: string, url: string, log?: Logger): Promise<string> {
  const personalDir = path.join(frameworkDir, "personal");
  await fs.mkdir(frameworkDir, { recursive: true });
  if (await exists(path.join(personalDir, ".git"))) {
    if (log) log("内容库已存在，拉取最新…");
    try {
      await run("git", ["pull", "--ff-only"], personalDir, log);
    } catch {
      if (log) log("ff-only 失败，尝试普通 pull");
      await run("git", ["pull"], personalDir, log);
    }
  } else {
    if (log) log(`首次克隆 ${url}`);
    await run("git", ["clone", url, "personal"], frameworkDir, log);
  }
  return personalDir;
}

async function deploySkills(personalDir: string, log?: Logger): Promise<boolean> {
  const skillsSrc = path.join(personalDir, "copilot", "skills");
  const skillsDst = path.join(os.homedir(), ".copilot", "skills");
  if (!(await exists(skillsSrc))) {
    if (log) log(`未找到 ${skillsSrc}，跳过技能部署`);
    return false;
  }
  if (log) log(`部署技能 → ${skillsDst}`);
  await copyDirContents(skillsSrc, skillsDst);

  const instr = path.join(personalDir, "copilot", "copilot-instructions.md");
  if (await exists(instr)) {
    const gh = path.join(os.homedir(), ".github");
    await fs.mkdir(gh, { recursive: true });
    await fs.copyFile(instr, path.join(gh, "copilot-instructions.md"));
    if (log) log("全局指令已部署");
  }
  return true;
}

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

// ---------- 动作（命令与面板共用） ----------

async function runDeploy(log: Logger, askUrl: boolean): Promise<string> {
  const cfg = vscode.workspace.getConfiguration("devEnvSync");
  let url = (cfg.get<string>("personalRepo") ?? "").trim();
  if (!url && askUrl) {
    const input = await vscode.window.showInputBox({
      prompt: "输入私有内容库地址（保存后随 VS Code 设置同步，不再询问）",
      placeHolder: "git@github.com:YOU/private-repo.git",
    });
    url = (input ?? "").trim();
    if (!url) return "已取消";
    await cfg.update("personalRepo", url, vscode.ConfigurationTarget.Global);
    log(`已保存 personalRepo：${url}`);
  }
  if (!url) throw new Error("未配置私人库地址：请在面板或设置中填写 devEnvSync.personalRepo");

  const frameworkDir = expandHome(cfg.get<string>("frameworkDir") ?? "~/dev/dev-env-sync");
  let personalDir: string;
  try {
    personalDir = await ensurePersonal(frameworkDir, url, log);
  } catch (e) {
    const m = errMsg(e);
    if (/ENOENT/.test(m)) {
      throw new Error("未找到 git，请先安装 Git（https://git-scm.com）后重试");
    }
    if (/repository not found|could not read from remote/i.test(m)) {
      const act = await vscode.window.showErrorMessage(
        "Dev Env Sync：无法访问私人库。请确认：① 私有仓库已创建 ② 本机 SSH key 已添加到 GitHub（或改用 https 地址）",
        "去创建私有仓库",
      );
      if (act === "去创建私有仓库") await vscode.env.openExternal(vscode.Uri.parse("https://github.com/new"));
      throw new Error(`访问私人库失败：${m}`);
    }
    if (/permission denied/i.test(m)) {
      throw new Error("git 访问被拒绝：请在本机生成 SSH key 并添加到 GitHub（ssh-keygen -t ed25519），或把私人库地址改成 https 形式");
    }
    throw e;
  }
  const skillsOk = await deploySkills(personalDir, log);

  if (cfg.get<boolean>("withToolchain", true)) {
    const script = toolchainScript(personalDir);
    if (script) {
      const term = vscode.window.createTerminal({ name: "Dev Env Sync" });
      term.show();
      term.sendText(script);
      log("工具链脚本已发送到终端（Homebrew / winget / npm 全局包）");
    }
  }
  return skillsOk
    ? "✔ 部署完成：技能与全局指令已更新（工具链在终端继续安装）"
    : "⚠ 内容库已更新，但未找到 skills 目录（检查私有库 copilot/skills 结构）";
}

async function runUpload(log: Logger): Promise<string> {
  const cfg = vscode.workspace.getConfiguration("devEnvSync");
  const frameworkDir = expandHome(cfg.get<string>("frameworkDir") ?? "~/dev/dev-env-sync");
  const personalDir = path.join(frameworkDir, "personal");

  if (!(await exists(path.join(personalDir, ".git")))) {
    throw new Error("personal 内容库不存在，请先执行「一键部署」");
  }

  const stamp = new Date().toLocaleString();
  await run("git", ["add", "-A"], personalDir, log);
  try {
    await run("git", ["commit", "-m", `sync: ${stamp}`], personalDir, log);
  } catch {
    log("commit 跳过（可能无改动）");
  }
  await run("git", ["push"], personalDir, log);

  if (await exists(path.join(frameworkDir, ".git"))) {
    await run("git", ["add", "-A"], frameworkDir, log);
    try {
      await run("git", ["commit", "-m", `sync: ${stamp}`], frameworkDir, log);
    } catch {
      log("框架 commit 跳过（可能无改动）");
    }
    await run("git", ["push", "-u", "origin", "HEAD"], frameworkDir, log);
  }
  return "✔ 已上传：私有内容库（及本地框架仓库）改动均已推送";
}

// ---------- 命令（命令面板入口） ----------

async function cmdDeploy(): Promise<void> {
  try {
    const msg = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Dev Env Sync：同步内容库…" },
      () => runDeploy((l) => output.appendLine(l), true),
    );
    const act = await vscode.window.showInformationMessage(msg, "重启 VS Code");
    if (act === "重启 VS Code") await vscode.commands.executeCommand("workbench.action.reloadWindow");
  } catch (e) {
    showError("部署失败", e);
  }
}

async function cmdUpload(): Promise<void> {
  try {
    const msg = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Dev Env Sync：上传改动…" },
      () => runUpload((l) => output.appendLine(l)),
    );
    vscode.window.showInformationMessage(msg);
  } catch (e) {
    showError("上传失败", e);
  }
}

// ---------- Webview 面板 ----------

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

class PanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "devEnvSync.panel";
  private view?: vscode.WebviewView;
  private busy = false;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage(async (m: Record<string, unknown>) => {
      try {
        switch (m.cmd) {
          case "getState":
            this.postState();
            break;
          case "saveConfig":
            await this.saveConfig(String(m.key), m.value);
            break;
          case "deploy":
            await this.doAction("deploy");
            break;
          case "upload":
            await this.doAction("upload");
            break;
          case "reload":
            await vscode.commands.executeCommand("workbench.action.reloadWindow");
            break;
        }
      } catch (e) {
        this.log("✗ " + errMsg(e));
      }
    });
    this.postState();
  }

  private post(m: Record<string, unknown>): void {
    this.view?.webview.postMessage(m);
  }

  private log(line: string): void {
    output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
    this.post({ type: "log", line });
  }

  private async doAction(kind: "deploy" | "upload"): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.post({ type: "busy", busy: true });
    try {
      this.log(`════ 开始${kind === "deploy" ? "一键部署" : "一键上传"} ════`);
      const msg = kind === "deploy" ? await runDeploy((l) => this.log(l), true) : await runUpload((l) => this.log(l));
      this.log(msg);
      this.post({ type: "done", ok: true, msg });
    } catch (e) {
      const m = errMsg(e);
      this.log("✗ " + m);
      this.post({ type: "done", ok: false, msg: m });
    } finally {
      this.busy = false;
      this.post({ type: "busy", busy: false });
    }
  }

  private postState(): void {
    const cfg = vscode.workspace.getConfiguration("devEnvSync");
    this.post({
      type: "state",
      personalRepo: cfg.get<string>("personalRepo") ?? "",
      frameworkDir: cfg.get<string>("frameworkDir") ?? "~/dev/dev-env-sync",
      withToolchain: cfg.get<boolean>("withToolchain") ?? true,
    });
  }

  private async saveConfig(key: string, value: unknown): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("devEnvSync");
    await cfg.update(key, key === "withToolchain" ? Boolean(value) : String(value).trim(), vscode.ConfigurationTarget.Global);
    this.log(`已保存设置：${key}`);
    this.postState();
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:;">
<style>
  body { padding: 12px; color: var(--vscode-foreground); font-size: 13px; font-family: var(--vscode-font-family); }
  h1 { font-size: 15px; margin: 0 0 2px; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 12px; }
  .row { display: flex; gap: 8px; margin-bottom: 10px; }
  button { border: 0; border-radius: 3px; padding: 7px 14px; cursor: pointer; font-size: 13px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.small { padding: 4px 10px; font-size: 12px; }
  .cfg label { display: block; color: var(--vscode-descriptionForeground); font-size: 11px; margin: 6px 0 2px; }
  .cfg input[type=text] { width: 100%; box-sizing: border-box; padding: 5px 7px; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 3px; }
  .cfg .check { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
  .cfg .check label { margin: 0; }
  .divider { height: 1px; background: var(--vscode-panel-border); margin: 12px 0; }
  #log { background: var(--vscode-textBlockQuote-background); border-radius: 4px; padding: 8px; max-height: 220px; overflow-y: auto; font-family: var(--vscode-editor-font-family); font-size: 11px; white-space: pre-wrap; word-break: break-all; margin-top: 8px; }
  #reload { display: none; }
  .okline { color: var(--vscode-testing-iconPassed); }
</style>
</head>
<body>
  <h1>🚀 Dev Env Sync</h1>
  <div class="sub">一键部署 / 一键上传你的开发环境（技能 · 工具链 · 配置）</div>

  <div id="hint" style="display:none; background: var(--vscode-textBlockQuote-background); border-radius: 4px; padding: 8px; margin-bottom: 10px; font-size: 12px;">
    首次使用：点击「一键部署」会引导你填写私人库地址（未建库请先在 GitHub 创建一个 Private 仓库）。
    地址保存后随 VS Code 设置同步，同一 GitHub 账号的其他设备会自动读取，无需再填写。
  </div>

  <div class="row">
    <button id="deploy">⬇️ 一键部署</button>
    <button id="upload" class="secondary">⬆️ 一键上传</button>
  </div>
  <div class="row">
    <button id="reload" class="small">重启 VS Code 生效</button>
  </div>

  <div class="divider"></div>

  <div class="cfg">
    <label>私人内容库（private repo）</label>
    <input type="text" id="repo" placeholder="git@github.com:YOU/private-repo.git">
    <label>本地工作目录</label>
    <input type="text" id="dir" placeholder="~/dev/dev-env-sync">
    <div class="check">
      <input type="checkbox" id="tool">
      <label for="tool">部署后自动安装工具链（Homebrew / winget / npm）</label>
    </div>
    <button id="save" class="small secondary">保存设置</button>
  </div>

  <div class="divider"></div>
  <div class="sub">运行日志</div>
  <div id="log"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  $("deploy").addEventListener("click", () => vscode.postMessage({ cmd: "deploy" }));
  $("upload").addEventListener("click", () => vscode.postMessage({ cmd: "upload" }));
  $("reload").addEventListener("click", () => vscode.postMessage({ cmd: "reload" }));
  $("save").addEventListener("click", () => {
    vscode.postMessage({ cmd: "saveConfig", key: "personalRepo", value: $("repo").value });
    vscode.postMessage({ cmd: "saveConfig", key: "frameworkDir", value: $("dir").value });
    vscode.postMessage({ cmd: "saveConfig", key: "withToolchain", value: $("tool").checked });
  });

  function addLog(line) {
    const el = document.createElement("div");
    el.textContent = line;
    if (line.startsWith("✔")) el.className = "okline";
    if (line.startsWith("✗")) el.style.color = "var(--vscode-errorForeground)";
    $("log").appendChild(el);
    $("log").scrollTop = $("log").scrollHeight;
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === "state") {
      $("repo").value = m.personalRepo || "";
      $("dir").value = m.frameworkDir || "";
      $("tool").checked = !!m.withToolchain;
      $("hint").style.display = m.personalRepo ? "none" : "block";
    } else if (m.type === "log") {
      addLog(m.line);
    } else if (m.type === "busy") {
      $("deploy").disabled = m.busy;
      $("upload").disabled = m.busy;
    } else if (m.type === "done" && m.ok) {
      $("reload").style.display = "inline-block";
    }
  });

  vscode.postMessage({ cmd: "getState" });
</script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  output.appendLine(`[${new Date().toLocaleTimeString()}] Dev Env Sync 已激活`);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelProvider.viewType, new PanelProvider(context)),
    vscode.commands.registerCommand("devEnvSync.deploy", cmdDeploy),
    vscode.commands.registerCommand("devEnvSync.upload", cmdUpload),
  );
}

export function deactivate(): void {}
