import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import * as os from "os";
import * as path from "path";

const output = vscode.window.createOutputChannel("Dev Env Sync");
const EXT_MANIFEST = "tools/vscode-extensions.txt";
const SELF_ID = "honor-world.dev-env-sync";

type Logger = (line: string) => void;
type ItemStatus = "pending" | "running" | "ok" | "fail" | "manual";
interface Item {
  id: string;
  name: string;
  status: ItemStatus;
  detail?: string;
  url?: string;
}
type ItemEmitter = (item: Item) => void;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------- 基础工具 ----------

function run(cmd: string, args: string[], cwd: string, log?: Logger, shell = false): Promise<string> {
  return new Promise((resolve, reject) => {
    if (log) log(`$ ${cmd} ${args.join(" ")}`);
    const p = cp.spawn(cmd, args, { cwd, shell });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(e));
    p.on("close", (code) => {
      const text = (out + err).trim();
      if (text) {
        if (log) text.split("\n").slice(-30).forEach((l) => log("  " + l));
        else output.appendLine(text);
      }
      if (code === 0) resolve(text);
      else reject(new Error(text || `${cmd} exited ${code}`));
    });
  });
}

function quickOk(cmd: string, args: string[]): boolean {
  try {
    const r = cp.spawnSync(cmd, args, { shell: process.platform === "win32" });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
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

async function copyTree(src: string, dst: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      await fs.mkdir(d, { recursive: true });
      await copyTree(s, d);
    } else if (e.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

function readManifestLines(file: string): Promise<string[]> {
  return fs
    .readFile(file, "utf8")
    .then((t) => t.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#")))
    .catch(() => []);
}

function codeCli(): string | null {
  const bin = process.platform === "win32" ? "code.cmd" : "code";
  const appBin = path.join(vscode.env.appRoot, "bin", bin);
  if (existsSync(appBin)) return appBin;
  if (quickOk(bin, ["--version"])) return bin;
  return null;
}

function npmCmd(): string | null {
  const candidates =
    process.platform === "win32" ? ["npm"] : ["npm", "/opt/homebrew/bin/npm", "/usr/local/bin/npm"];
  for (const c of candidates) {
    if (quickOk(c, ["--version"])) return c;
  }
  return null;
}

function listInstalledExtensions(): string[] {
  return vscode.extensions.all
    .filter((e) => !e.id.startsWith("vscode."))
    .map((e) => e.id)
    .sort();
}

// ---------- 内容库 ----------

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

// ---------- 部署各步骤 ----------

async function deploySkills(personalDir: string, emit: ItemEmitter): Promise<boolean> {
  const skillsSrc = path.join(personalDir, "copilot", "skills");
  const skillsDst = path.join(os.homedir(), ".copilot", "skills");
  if (!(await exists(skillsSrc))) return false;

  await fs.rm(skillsDst, { recursive: true, force: true });
  await fs.mkdir(skillsDst, { recursive: true });
  const dirs = (await fs.readdir(skillsSrc, { withFileTypes: true })).filter((e) => e.isDirectory());
  for (const d of dirs) {
    const id = `skill:${d.name}`;
    emit({ id, name: `技能 · ${d.name}`, status: "running", detail: "命令已发出，正在复制…" });
    try {
      await copyTree(path.join(skillsSrc, d.name), path.join(skillsDst, d.name));
      emit({ id, name: `技能 · ${d.name}`, status: "ok", detail: "安装完毕" });
    } catch (e) {
      emit({ id, name: `技能 · ${d.name}`, status: "fail", detail: errMsg(e) });
    }
  }
  return true;
}

async function deployInstructions(personalDir: string, emit: ItemEmitter): Promise<void> {
  const instr = path.join(personalDir, "copilot", "copilot-instructions.md");
  if (!(await exists(instr))) return;
  emit({ id: "cfg:instructions", name: "配置 · Copilot 全局指令", status: "running", detail: "命令已发出…" });
  try {
    const gh = path.join(os.homedir(), ".github");
    await fs.mkdir(gh, { recursive: true });
    await fs.copyFile(instr, path.join(gh, "copilot-instructions.md"));
    emit({ id: "cfg:instructions", name: "配置 · Copilot 全局指令", status: "ok", detail: "安装完毕" });
  } catch (e) {
    emit({ id: "cfg:instructions", name: "配置 · Copilot 全局指令", status: "fail", detail: errMsg(e) });
  }
}

async function deployExtensions(personalDir: string, log: Logger, emit: ItemEmitter): Promise<boolean> {
  const file = path.join(personalDir, EXT_MANIFEST);
  if (!(await exists(file))) return false;

  const cli = codeCli();
  if (!cli) {
    emit({ id: "tool:code-cli", name: "扩展安装器 · code CLI", status: "manual", detail: "未找到 code 命令", url: "https://code.visualstudio.com/download" });
    return false;
  }
  const ids = await readManifestLines(file);
  let changed = false;
  for (const id of ids) {
    if (id === SELF_ID || vscode.extensions.getExtension(id)) {
      emit({ id: `ext:${id}`, name: `扩展 · ${id}`, status: "ok", detail: "已安装" });
      continue;
    }
    emit({ id: `ext:${id}`, name: `扩展 · ${id}`, status: "running", detail: "命令已发出，正在安装…" });
    try {
      await run(cli, ["--install-extension", id, "--force"], os.homedir(), log, process.platform === "win32");
      emit({ id: `ext:${id}`, name: `扩展 · ${id}`, status: "ok", detail: "安装完毕" });
      changed = true;
    } catch (e) {
      emit({ id: `ext:${id}`, name: `扩展 · ${id}`, status: "fail", detail: errMsg(e).slice(0, 160) });
    }
  }
  return changed;
}

async function deployToolchain(personalDir: string, log: Logger, emit: ItemEmitter): Promise<void> {
  const tools = path.join(personalDir, "tools");

  if (process.platform === "darwin") {
    // Xcode CLT
    if (quickOk("xcode-select", ["-p"])) {
      emit({ id: "tool:clt", name: "工具 · Xcode 命令行工具", status: "ok", detail: "已安装" });
    } else {
      emit({ id: "tool:clt", name: "工具 · Xcode 命令行工具", status: "running", detail: "命令已发出，已触发系统安装窗口…" });
      const p = cp.spawn("xcode-select", ["--install"]);
      p.on("error", () => undefined);
      p.unref();
      emit({ id: "tool:clt", name: "工具 · Xcode 命令行工具", status: "manual", detail: "请在系统弹窗中点击「安装」", url: "https://developer.apple.com/xcode/resources/" });
    }
    // Homebrew 清单
    const brewfile = path.join(tools, "brew", "Brewfile");
    if (await exists(brewfile)) {
      emit({ id: "tool:brew", name: "工具 · Homebrew 清单（brew bundle）", status: "running", detail: "命令已发出，正在安装（可能较久）…" });
      try {
        await run("brew", ["bundle", "--file", brewfile], os.homedir(), log);
        emit({ id: "tool:brew", name: "工具 · Homebrew 清单（brew bundle）", status: "ok", detail: "安装完毕" });
      } catch (e) {
        emit({ id: "tool:brew", name: "工具 · Homebrew 清单（brew bundle）", status: "fail", detail: errMsg(e).slice(0, 160) });
      }
    }
  } else if (process.platform === "win32") {
    if (!quickOk("winget", ["--version"])) {
      emit({ id: "tool:winget", name: "工具 · winget（App Installer）", status: "manual", detail: "未找到 winget", url: "https://aka.ms/getwinget" });
      return;
    }
    const pkgsFile = path.join(tools, "winget", "packages.txt");
    const pkgs = await readManifestLines(pkgsFile);
    for (const pkg of pkgs) {
      emit({ id: `tool:winget:${pkg}`, name: `工具 · ${pkg}`, status: "running", detail: "命令已发出，正在安装…" });
      try {
        await run("winget", ["install", "-e", "--id", pkg, "--silent", "--accept-package-agreements", "--accept-source-agreements"], os.homedir(), log, true);
        emit({ id: `tool:winget:${pkg}`, name: `工具 · ${pkg}`, status: "ok", detail: "安装完毕" });
      } catch (e) {
        emit({ id: `tool:winget:${pkg}`, name: `工具 · ${pkg}`, status: "fail", detail: errMsg(e).slice(0, 160) });
      }
    }
    emit({
      id: "tool:buildtools",
      name: "工具 · Visual Studio 2022 Build Tools（C++）",
      status: "manual",
      detail: "需管理员权限手动安装",
      url: "https://visualstudio.microsoft.com/visual-cpp-build-tools/",
    });
  }
}

async function deployNpmGlobals(personalDir: string, log: Logger, emit: ItemEmitter): Promise<void> {
  const file = path.join(personalDir, "tools", "npm-globals.txt");
  if (!(await exists(file))) return;
  const pkgs = await readManifestLines(file);
  if (pkgs.length === 0) return;

  const npm = npmCmd();
  if (!npm) {
    emit({ id: "tool:node", name: "工具 · Node.js / npm", status: "manual", detail: "未检测到 npm，请安装 Node LTS", url: "https://nodejs.org/" });
    return;
  }
  for (const pkg of pkgs) {
    emit({ id: `npm:${pkg}`, name: `npm · ${pkg}`, status: "running", detail: "命令已发出，正在安装…" });
    try {
      await run(npm, ["install", "-g", pkg], os.homedir(), log, process.platform === "win32");
      emit({ id: `npm:${pkg}`, name: `npm · ${pkg}`, status: "ok", detail: "安装完毕" });
    } catch (e) {
      emit({ id: `npm:${pkg}`, name: `npm · ${pkg}`, status: "fail", detail: errMsg(e).slice(0, 160) });
    }
  }
}

// ---------- 动作（命令与面板共用） ----------

async function runDeploy(log: Logger, askUrl: boolean, emit: ItemEmitter): Promise<{ msg: string; changed: boolean }> {
  const cfg = vscode.workspace.getConfiguration("devEnvSync");
  let url = (cfg.get<string>("personalRepo") ?? "").trim();
  if (!url && askUrl) {
    const input = await vscode.window.showInputBox({
      prompt: "输入私有内容库地址（保存后随 VS Code 设置同步，同账号其他设备自动读取）",
      placeHolder: "git@github.com:YOU/private-repo.git",
    });
    url = (input ?? "").trim();
    if (!url) return { msg: "已取消", changed: false };
    await cfg.update("personalRepo", url, vscode.ConfigurationTarget.Global);
    log(`已保存 personalRepo：${url}`);
  }
  if (!url) throw new Error("未配置私人库地址：请在面板输入框中填写并点击「应用设置」");

  // git 前置检查
  if (!quickOk("git", ["--version"])) {
    emit({ id: "tool:git", name: "工具 · Git", status: "manual", detail: "未找到 git，请先安装", url: "https://git-scm.com/" });
    throw new Error("未找到 git：请先安装 Git（https://git-scm.com/）后重试");
  }

  const frameworkDir = expandHome(cfg.get<string>("frameworkDir") ?? "~/dev/dev-env-sync");
  let personalDir: string;
  try {
    personalDir = await ensurePersonal(frameworkDir, url, log);
  } catch (e) {
    const m = errMsg(e);
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

  const skillsOk = await deploySkills(personalDir, emit);
  if (!skillsOk) log("未找到 skills 目录，跳过技能部署");
  await deployInstructions(personalDir, emit);
  const extChanged = await deployExtensions(personalDir, log, emit);
  if (!extChanged) log("未找到扩展清单或清单为空，跳过扩展同步");

  if (cfg.get<boolean>("withToolchain", true)) {
    await deployToolchain(personalDir, log, emit);
    await deployNpmGlobals(personalDir, log, emit);
  }

  const msg = skillsOk
    ? "✔ 部署完毕：技能、全局指令、扩展与工具链均已按清单处理（⚠ 项请手动安装）"
    : "⚠ 部署完毕：未找到 skills 目录（请检查私有库 copilot/skills 结构）";
  return { msg, changed: true };
}

async function runUpload(log: Logger, emit: ItemEmitter): Promise<string> {
  const cfg = vscode.workspace.getConfiguration("devEnvSync");
  const frameworkDir = expandHome(cfg.get<string>("frameworkDir") ?? "~/dev/dev-env-sync");
  const personalDir = path.join(frameworkDir, "personal");

  if (!(await exists(path.join(personalDir, ".git")))) {
    throw new Error("personal 内容库不存在，请先执行「一键部署」");
  }

  // 1. 导出本机扩展清单到私有库
  emit({ id: "up:manifest", name: "扩展清单 · 导出本机已装扩展", status: "running", detail: "命令已发出…" });
  try {
    const ids = listInstalledExtensions();
    const dir = path.join(personalDir, "tools");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "vscode-extensions.txt"), `# VS Code 扩展清单（由 Dev Env Sync 自动生成，部署时按此清单安装）\n${ids.join("\n")}\n`, "utf8");
    emit({ id: "up:manifest", name: `扩展清单 · 已导出 ${ids.length} 个扩展`, status: "ok", detail: "安装完毕" });
  } catch (e) {
    emit({ id: "up:manifest", name: "扩展清单 · 导出失败", status: "fail", detail: errMsg(e) });
  }

  // 2. 提交并推送私有库
  const stamp = new Date().toLocaleString();
  emit({ id: "up:personal", name: "私有内容库 · 提交并推送", status: "running", detail: "命令已发出…" });
  try {
    await run("git", ["add", "-A"], personalDir, log);
    try {
      await run("git", ["commit", "-m", `sync: ${stamp}`], personalDir, log);
    } catch {
      log("commit 跳过（可能无改动）");
    }
    await run("git", ["push"], personalDir, log);
    emit({ id: "up:personal", name: "私有内容库 · 提交并推送", status: "ok", detail: "安装完毕" });
  } catch (e) {
    emit({ id: "up:personal", name: "私有内容库 · 提交并推送", status: "fail", detail: errMsg(e).slice(0, 160) });
    throw new Error(`推送私有库失败：${errMsg(e).slice(0, 200)}`);
  }

  // 3. 框架仓库（若存在）
  if (await exists(path.join(frameworkDir, ".git"))) {
    emit({ id: "up:framework", name: "同步框架 · 提交并推送", status: "running", detail: "命令已发出…" });
    try {
      await run("git", ["add", "-A"], frameworkDir, log);
      try {
        await run("git", ["commit", "-m", `sync: ${stamp}`], frameworkDir, log);
      } catch {
        log("框架 commit 跳过（可能无改动）");
      }
      await run("git", ["push", "-u", "origin", "HEAD"], frameworkDir, log);
      emit({ id: "up:framework", name: "同步框架 · 提交并推送", status: "ok", detail: "安装完毕" });
    } catch (e) {
      emit({ id: "up:framework", name: "同步框架 · 提交并推送", status: "fail", detail: errMsg(e).slice(0, 160) });
    }
  }
  return "✔ 上传完毕：扩展清单与改动已推送到私有库";
}

// ---------- 命令（命令面板入口） ----------

function commandEmitter(log: Logger): ItemEmitter {
  return (item) => {
    if (item.status === "ok") log(`✅ ${item.name} — 安装完毕`);
    else if (item.status === "fail") log(`❌ ${item.name} — ${item.detail ?? ""}`);
    else if (item.status === "manual") log(`⚠️ ${item.name} — 需手动安装${item.url ? "：" + item.url : ""}`);
  };
}

async function cmdDeploy(): Promise<void> {
  try {
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Dev Env Sync：一键部署…" },
      () => runDeploy((l) => output.appendLine(l), true, commandEmitter((l) => output.appendLine(l))),
    );
    const act = await vscode.window.showInformationMessage(res.msg, "重启 VS Code");
    if (act === "重启 VS Code") await vscode.commands.executeCommand("workbench.action.reloadWindow");
  } catch (e) {
    const m = errMsg(e);
    output.appendLine(`✗ 部署失败: ${m}`);
    vscode.window.showErrorMessage(`Dev Env Sync 部署失败：${m.slice(0, 300)}`);
  }
}

async function cmdUpload(): Promise<void> {
  try {
    const msg = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Dev Env Sync：一键上传…" },
      () => runUpload((l) => output.appendLine(l), commandEmitter((l) => output.appendLine(l))),
    );
    vscode.window.showInformationMessage(msg);
  } catch (e) {
    const m = errMsg(e);
    output.appendLine(`✗ 上传失败: ${m}`);
    vscode.window.showErrorMessage(`Dev Env Sync 上传失败：${m.slice(0, 300)}`);
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
            await this.saveConfig(m);
            break;
          case "deploy":
            await this.doAction("deploy");
            break;
          case "upload":
            await this.doAction("upload");
            break;
          case "open":
            if (typeof m.url === "string") await vscode.env.openExternal(vscode.Uri.parse(m.url));
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

  private emit: ItemEmitter = (item) => {
    this.post({ type: "item", item });
  };

  private async saveConfig(m: Record<string, unknown>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("devEnvSync");
    const repo = String(m.repo ?? "").trim();
    const dir = String(m.dir ?? "").trim() || "~/dev/dev-env-sync";
    const tool = Boolean(m.tool);
    await cfg.update("personalRepo", repo, vscode.ConfigurationTarget.Global);
    await cfg.update("frameworkDir", dir, vscode.ConfigurationTarget.Global);
    await cfg.update("withToolchain", tool, vscode.ConfigurationTarget.Global);
    this.log("✔ 设置已应用（随 VS Code 设置同步到同账号所有设备）");
    this.post({ type: "saved" });
    this.postState();
  }

  private async doAction(kind: "deploy" | "upload"): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.post({ type: "busy", busy: true, action: kind });
    this.post({ type: "clear" });
    try {
      this.log(`════ 开始${kind === "deploy" ? "一键部署" : "一键上传"} ════`);
      if (kind === "deploy") {
        const res = await runDeploy((l) => this.log(l), true, this.emit);
        this.log(res.msg);
        this.post({ type: "done", ok: true, msg: res.msg, changed: res.changed });
      } else {
        const msg = await runUpload((l) => this.log(l), this.emit);
        this.log(msg);
        this.post({ type: "done", ok: true, msg });
      }
    } catch (e) {
      const m = errMsg(e);
      this.log("✗ " + m);
      this.post({ type: "done", ok: false, msg: m });
    } finally {
      this.busy = false;
      this.post({ type: "busy", busy: false, action: kind });
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
  .sub { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 10px; }
  .row { display: flex; gap: 8px; margin-bottom: 8px; }
  button { border: 0; border-radius: 3px; padding: 7px 14px; cursor: pointer; font-size: 13px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.small { padding: 4px 10px; font-size: 12px; }
  #status { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; background: var(--vscode-textBlockQuote-background); color: var(--vscode-descriptionForeground); }
  #status.busy { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .cfg label { display: block; color: var(--vscode-descriptionForeground); font-size: 11px; margin: 6px 0 2px; }
  .cfg input[type=text] { width: 100%; box-sizing: border-box; padding: 5px 7px; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 3px; }
  .cfg .check { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
  .cfg .check label { margin: 0; }
  .divider { height: 1px; background: var(--vscode-panel-border); margin: 10px 0; }
  #hint { display:none; background: var(--vscode-textBlockQuote-background); border-radius: 4px; padding: 8px; margin-bottom: 10px; font-size: 12px; }
  #savedMsg { display: none; color: var(--vscode-testing-iconPassed); font-size: 11px; margin-top: 4px; }
  #items { margin-top: 6px; max-height: 260px; overflow-y: auto; }
  .item { display: flex; gap: 6px; align-items: baseline; padding: 3px 0; font-size: 12px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  .item .ic { flex: none; width: 18px; text-align: center; }
  .item .nm { flex: none; }
  .item .dt { color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .item a:hover { text-decoration: underline; }
  #log { background: var(--vscode-textBlockQuote-background); border-radius: 4px; padding: 8px; max-height: 140px; overflow-y: auto; font-family: var(--vscode-editor-font-family); font-size: 11px; white-space: pre-wrap; word-break: break-all; }
  .okline { color: var(--vscode-testing-iconPassed); }
  #reload { display: none; }
</style>
</head>
<body>
  <h1>🚀 Dev Env Sync <span id="status">空闲</span></h1>
  <div class="sub">一键部署 / 一键上传你的开发环境（技能 · 工具 · 扩展 · 配置）</div>

  <div id="hint">
    首次使用：点击「一键部署」会引导填写私人库地址（未建库请先在 GitHub 创建一个 Private 仓库）。
    地址保存后随 VS Code 设置同步，同一 GitHub 账号的其他设备自动读取，无需再填写。
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
      <label for="tool">部署时自动安装工具链（Homebrew / winget / npm）</label>
    </div>
    <button id="save" class="small secondary">应用设置</button>
    <div id="savedMsg">✔ 已应用</div>
  </div>

  <div class="divider"></div>
  <div class="sub">安装清单</div>
  <div id="items"></div>

  <div class="divider"></div>
  <div class="sub">运行日志</div>
  <div id="log"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ICONS = { pending: "⏳", running: "⏳", ok: "✅", fail: "❌", manual: "⚠️" };

  $("deploy").addEventListener("click", () => vscode.postMessage({ cmd: "deploy" }));
  $("upload").addEventListener("click", () => vscode.postMessage({ cmd: "upload" }));
  $("reload").addEventListener("click", () => vscode.postMessage({ cmd: "reload" }));
  $("save").addEventListener("click", () => {
    $("savedMsg").style.display = "none";
    vscode.postMessage({ cmd: "saveConfig", repo: $("repo").value, dir: $("dir").value, tool: $("tool").checked });
  });

  function addLog(line) {
    const el = document.createElement("div");
    el.textContent = line;
    if (line.startsWith("✔")) el.className = "okline";
    if (line.startsWith("✗")) el.style.color = "var(--vscode-errorForeground)";
    $("log").appendChild(el);
    while ($("log").children.length > 200) $("log").removeChild($("log").firstChild);
    $("log").scrollTop = $("log").scrollHeight;
  }

  function renderItem(item) {
    let el = document.querySelector('[data-iid="' + CSS.escape(item.id) + '"]');
    if (!el) {
      el = document.createElement("div");
      el.className = "item";
      el.dataset.iid = item.id;
      $("items").appendChild(el);
    }
    const link = item.url ? ' <a href="#" data-url="' + esc(item.url) + '">官网</a>' : "";
    const tag = item.status === "manual" ? ' <span class="dt">[需手动]</span>' : "";
    el.innerHTML = '<span class="ic">' + ICONS[item.status] + '</span><span class="nm">' + esc(item.name) + '</span>' + tag + link + '<span class="dt">' + esc(item.detail ?? "") + "</span>";
  }

  $("items").addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (a && a.dataset.url) vscode.postMessage({ cmd: "open", url: a.dataset.url });
  });

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === "state") {
      $("repo").value = m.personalRepo || "";
      $("dir").value = m.frameworkDir || "";
      $("tool").checked = !!m.withToolchain;
      $("hint").style.display = m.personalRepo ? "none" : "block";
    } else if (m.type === "saved") {
      $("savedMsg").style.display = "block";
      setTimeout(() => ($("savedMsg").style.display = "none"), 2500);
    } else if (m.type === "log") {
      addLog(m.line);
    } else if (m.type === "item") {
      renderItem(m.item);
    } else if (m.type === "clear") {
      $("items").innerHTML = "";
    } else if (m.type === "busy") {
      $("deploy").disabled = m.busy;
      $("upload").disabled = m.busy;
      $("status").textContent = m.busy ? (m.action === "deploy" ? "部署中…" : "上传中…") : "空闲";
      $("status").classList.toggle("busy", m.busy);
    } else if (m.type === "done") {
      $("status").textContent = m.ok ? "完成" : "失败";
      if (m.ok && m.changed) $("reload").style.display = "inline-block";
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
