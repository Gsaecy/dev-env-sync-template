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

/** 并发执行池：同时最多 limit 个任务。 */
async function runPool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/** 目录签名：相对路径+文件大小（不用 mtime——copyFile 不保留源时间戳，会导致永远不同）。 */
async function dirSig(dir: string): Promise<string | null> {
  const list: string[] = [];
  async function walk(d: string, rel: string): Promise<void> {
    const es = await fs.readdir(d, { withFileTypes: true });
    for (const e of es) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), r);
      else if (e.isFile()) {
        const st = await fs.stat(path.join(d, e.name));
        list.push(`${r}|${st.size}`);
      }
    }
  }
  try {
    await walk(dir, "");
  } catch {
    return null;
  }
  return list.sort().join("\n");
}

function readManifestLines(file: string): Promise<string[]> {
  return fs
    .readFile(file, "utf8")
    .then((t) => t.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#")))
    .catch(() => []);
}

// ---------- 扩展清单（按平台分节） ----------
// 部署时安装「通用」段 + 当前平台专属段，其他平台段忽略（如 macOS 的 Swift 扩展不会同步到 Windows）。

interface ManifestSections {
  common: string[];
  platforms: Record<string, string[]>;
}

const PLATFORM_LABEL: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

function parseManifest(text: string): ManifestSections {
  const m: ManifestSections = { common: [], platforms: {} };
  let cur: string[] = m.common;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const mm = line.match(/^#\s*\[platform:([a-z0-9_]+)\]/);
      if (mm) {
        const p = mm[1];
        m.platforms[p] = m.platforms[p] ?? [];
        cur = m.platforms[p];
      }
      continue;
    }
    cur.push(line);
  }
  return m;
}

function serializeManifest(m: ManifestSections): string {
  const lines = [
    "# VS Code 扩展清单（由 Dev Env Sync 自动生成）",
    "# 部署时安装「通用」段 + 当前平台专属段；其他平台段忽略",
    "",
    ...m.common,
  ];
  for (const [p, ids] of Object.entries(m.platforms)) {
    if (!ids.length) continue;
    const label = PLATFORM_LABEL[p] ?? p;
    lines.push("", `# [platform:${p}] ${label} 专属`);
    lines.push(...ids);
  }
  lines.push("");
  return lines.join("\n");
}

/** 按扩展 ID 启发式猜测所属平台：macOS 专属扩展（swift/xcode/apple）识别可靠，Windows/Linux 专属不猜。 */
function guessPlatform(id: string): string | null {
  const l = id.toLowerCase();
  if (/(^|[.\-_])(swift|xcode|apple|darwin)([.\-_]|$)/.test(l)) return "darwin";
  return null;
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
    try {
      await run("git", ["clone", url, "personal"], frameworkDir, log);
    } catch (e) {
      // 清理半成品目录，避免下次部署时 clone 因目录非空再次失败
      await fs.rm(personalDir, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }
  return personalDir;
}

// ---------- 部署各步骤 ----------

async function deploySkills(personalDir: string, emit: ItemEmitter): Promise<{ found: boolean; changed: boolean }> {
  const skillsSrc = path.join(personalDir, "copilot", "skills");
  const skillsDst = path.join(os.homedir(), ".copilot", "skills");
  if (!(await exists(skillsSrc))) return { found: false, changed: false };

  // 不再全量删除 ~/.copilot/skills：保留本机隐藏文件（.active-skills.json 等）与本机独有技能
  await fs.mkdir(skillsDst, { recursive: true });
  const srcDirs = new Set(
    (await fs.readdir(skillsSrc, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name),
  );
  const dstEntries = await fs.readdir(skillsDst, { withFileTypes: true }).catch(() => []);
  const dstDirs = new Set(dstEntries.filter((e) => e.isDirectory()).map((e) => e.name));
  const localOnly = [...dstDirs].filter((n) => !srcDirs.has(n) && !n.startsWith("."));

  let changed = false;
  await runPool(
    [...srcDirs].map((name) => async () => {
      const id = `skill:${name}`;
      const s = path.join(skillsSrc, name);
      const d = path.join(skillsDst, name);
      try {
        if ((await dirSig(s)) === (await dirSig(d))) {
          emit({ id, name: `技能 · ${name}`, status: "ok", detail: "已是最新，跳过" });
          return;
        }
        emit({ id, name: `技能 · ${name}`, status: "running", detail: "正在同步…" });
        await fs.rm(d, { recursive: true, force: true });
        await copyTree(s, d);
        changed = true;
        emit({ id, name: `技能 · ${name}`, status: "ok", detail: "已更新" });
      } catch (e) {
        emit({ id, name: `技能 · ${name}`, status: "fail", detail: errMsg(e) });
      }
    }),
    4,
  );

  for (const name of localOnly) {
    emit({ id: `skill:local:${name}`, name: `技能 · ${name}`, status: "ok", detail: "本机独有，已保留" });
  }
  return { found: true, changed };
}

async function deployInstructions(personalDir: string, emit: ItemEmitter): Promise<boolean> {
  const instr = path.join(personalDir, "copilot", "copilot-instructions.md");
  if (!(await exists(instr))) return false;
  const id = "cfg:instructions";
  const name = "配置 · Copilot 全局指令";
  try {
    const src = await fs.readFile(instr);
    const dst = path.join(os.homedir(), ".github", "copilot-instructions.md");
    if (await exists(dst)) {
      const cur = await fs.readFile(dst);
      if (cur.equals(src)) {
        emit({ id, name, status: "ok", detail: "已是最新，跳过" });
        return false;
      }
    }
    emit({ id, name, status: "running", detail: "正在同步…" });
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(instr, dst);
    emit({ id, name, status: "ok", detail: "已更新" });
    return true;
  } catch (e) {
    emit({ id, name, status: "fail", detail: errMsg(e) });
    return false;
  }
}

async function deployExtensions(personalDir: string, log: Logger, emit: ItemEmitter): Promise<{ changed: boolean }> {
  const file = path.join(personalDir, EXT_MANIFEST);
  if (!(await exists(file))) {
    log("未找到扩展清单，跳过扩展同步");
    return { changed: false };
  }

  const cli = codeCli();
  if (!cli) {
    emit({ id: "tool:code-cli", name: "扩展安装器 · code CLI", status: "manual", detail: "未找到 code 命令", url: "https://code.visualstudio.com/download" });
    return { changed: false };
  }
  // 只安装通用段 + 当前平台专属段（如 macOS 的 Swift 扩展不会装到 Windows）
  const text = await fs.readFile(file, "utf8").catch(() => "");
  const sections = parseManifest(text);
  const ids = [...new Set([...sections.common, ...(sections.platforms[process.platform] ?? [])])];
  let installed = 0;
  await runPool(
    ids.map((id) => async () => {
      if (id === SELF_ID || vscode.extensions.getExtension(id)) {
        emit({ id: `ext:${id}`, name: `扩展 · ${id}`, status: "ok", detail: "已安装" });
        return;
      }
      emit({ id: `ext:${id}`, name: `扩展 · ${id}`, status: "running", detail: "正在安装…" });
      try {
        await run(cli, ["--install-extension", id, "--force"], os.homedir(), log, process.platform === "win32");
        emit({ id: `ext:${id}`, name: `扩展 · ${id}`, status: "ok", detail: "安装完毕" });
        installed++;
      } catch (e) {
        emit({ id: `ext:${id}`, name: `扩展 · ${id}`, status: "fail", detail: errMsg(e).slice(0, 160) });
      }
    }),
    3,
  );
  return { changed: installed > 0 };
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

  const skills = await deploySkills(personalDir, emit);
  if (!skills.found) log("未找到 skills 目录，跳过技能部署");
  const instrChanged = await deployInstructions(personalDir, emit);
  const ext = await deployExtensions(personalDir, log, emit);

  if (cfg.get<boolean>("withToolchain", true)) {
    await deployToolchain(personalDir, log, emit);
    await deployNpmGlobals(personalDir, log, emit);
  }

  const changed = skills.changed || instrChanged || ext.changed;
  const msg = skills.found
    ? changed
      ? "✔ 部署完毕：技能、全局指令、扩展与工具链均已按清单处理（⚠ 项请手动安装）"
      : "✔ 部署完毕：一切已是最新，无需更新"
    : "⚠ 部署完毕：未找到 skills 目录（请检查私有库 copilot/skills 结构）";
  return { msg, changed };
}

async function runUpload(log: Logger, emit: ItemEmitter): Promise<string> {
  const cfg = vscode.workspace.getConfiguration("devEnvSync");
  const frameworkDir = expandHome(cfg.get<string>("frameworkDir") ?? "~/dev/dev-env-sync");
  const personalDir = path.join(frameworkDir, "personal");

  if (!(await exists(path.join(personalDir, ".git")))) {
    throw new Error("personal 内容库不存在，请先执行「一键部署」");
  }

  // 1. 导出本机扩展清单到私有库（按平台分节：通用段合并保留、其他平台段原样、当前平台专属段按启发式归类）
  emit({ id: "up:manifest", name: "扩展清单 · 导出本机已装扩展", status: "running", detail: "正在导出…" });
  try {
    const file = path.join(personalDir, "tools", "vscode-extensions.txt");
    const dir = path.join(personalDir, "tools");
    await fs.mkdir(dir, { recursive: true });
    const old = parseManifest(await fs.readFile(file, "utf8").catch(() => ""));
    const all = listInstalledExtensions().filter((id) => id !== SELF_ID);

    const mine: string[] = [];
    const mineCommon: string[] = [];
    for (const id of all) {
      (guessPlatform(id) === process.platform ? mine : mineCommon).push(id);
    }
    // 通用段 = 旧通用段 ∪ 本机非专属（不丢其他设备导出的通用扩展）
    const common = [...new Set([...old.common, ...mineCommon])];
    // 其他平台专属段原样保留；当前平台专属段 = 旧段 ∪ 本机启发式匹配
    const platforms: Record<string, string[]> = {};
    for (const p of Object.keys(old.platforms)) {
      platforms[p] = p === process.platform ? [...new Set([...old.platforms[p], ...mine])] : old.platforms[p];
    }
    if (mine.length) platforms[process.platform] = [...new Set([...(platforms[process.platform] ?? []), ...mine])];

    await fs.writeFile(file, serializeManifest({ common, platforms }), "utf8");
    const label = PLATFORM_LABEL[process.platform] ?? process.platform;
    emit({
      id: "up:manifest",
      name: `扩展清单 · 已导出 ${all.length} 个（${mine.length} 个归入 ${label} 专属段）`,
      status: "ok",
      detail: "导出完成",
    });
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
    emit({ id: "up:personal", name: "私有内容库 · 提交并推送", status: "ok", detail: "推送完毕" });
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
      emit({ id: "up:framework", name: "同步框架 · 提交并推送", status: "ok", detail: "推送完毕" });
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
    const act = res.changed
      ? await vscode.window.showInformationMessage(res.msg, "重启 VS Code")
      : await vscode.window.showInformationMessage(res.msg);
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
  private busyAction: "deploy" | "upload" | null = null;
  private items = new Map<string, Item>();

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
    this.items.set(item.id, item);
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
    this.busyAction = kind;
    this.items.clear();
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
      this.busyAction = null;
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
      busy: this.busy,
      busyAction: this.busyAction,
      items: [...this.items.values()],
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
  :root { --radius-s:8px; --radius-m:12px; --radius-l:16px; --radius-pill:980px; }
  body.vscode-light {
    --accent:#007aff; --accent-hover:#0066d6; --accent-soft:rgba(0,122,255,.12);
    --bg:#f5f5f7; --card:#ffffff;
    --line:rgba(0,0,0,.08); --line-strong:rgba(0,0,0,.14);
    --text:#1d1d1f; --text-sub:#6e6e73; --text-weak:#98989d;
    --input:#ffffff; --chip-bg:rgba(0,0,0,.05); --glass:rgba(255,255,255,.72);
    --shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.06);
  }
  body.vscode-dark, body.vscode-high-contrast {
    --accent:#0a84ff; --accent-hover:#3395ff; --accent-soft:rgba(10,132,255,.16);
    --bg:#1c1c1e; --card:#2c2c2e;
    --line:rgba(255,255,255,.1); --line-strong:rgba(255,255,255,.18);
    --text:#f5f5f7; --text-sub:#98989d; --text-weak:#6e6e73;
    --input:#3a3a3c; --chip-bg:rgba(255,255,255,.08); --glass:rgba(44,44,46,.8);
    --shadow:0 1px 2px rgba(0,0,0,.35),0 8px 24px rgba(0,0,0,.32);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    padding: 12px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Segoe UI', var(--vscode-font-family), sans-serif;
    font-size: 12.5px;
    -webkit-font-smoothing: antialiased;
  }
  ::selection { background: var(--accent-soft); }

  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 2px; }
  .brand svg { flex: none; color: var(--accent); }
  h1 { font-size: 15px; font-weight: 650; letter-spacing: .1px; }
  .en { font-size: 10.5px; color: var(--text-weak); letter-spacing: .2px; margin-top: 1px; }
  .sub { color: var(--text-sub); font-size: 11px; margin: 8px 0 12px; line-height: 1.5; }

  .status { display: inline-flex; align-items: center; margin-left: auto; padding: 2px 10px; border-radius: var(--radius-pill); font-size: 10.5px; font-weight: 500; color: var(--text-sub); background: var(--chip-bg); flex: none; }
  .status.busy { color: var(--accent); background: var(--accent-soft); }
  .status.ok { color: #248a3d; background: rgba(52,199,89,.15); }
  .status.err { color: #d70015; background: rgba(255,59,48,.14); }

  .ap-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 5px;
    padding: 7px 16px; border-radius: var(--radius-pill);
    border: 1px solid var(--line-strong); background: transparent; color: var(--text);
    font-size: 12px; font-weight: 500; cursor: pointer; user-select: none; font-family: inherit;
    transition: background .15s ease, color .15s ease, border-color .15s ease, opacity .15s ease, transform .1s ease;
  }
  .ap-btn:hover { background: var(--chip-bg); }
  .ap-btn:active { opacity: .7; transform: scale(.98); }
  .ap-btn:disabled { opacity: .4; cursor: not-allowed; }
  .ap-btn-primary { background: var(--accent); border-color: transparent; color: #fff; }
  .ap-btn-primary:hover { background: var(--accent-hover); }
  .ap-btn-ghost { border-color: var(--line); color: var(--text-sub); }
  .ap-btn-ghost:hover { color: var(--text); background: var(--chip-bg); }
  .ap-btn-sm { padding: 5px 12px; font-size: 11px; }

  .ap-card {
    background: var(--glass);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    border: 1px solid var(--line);
    border-radius: var(--radius-l);
    box-shadow: var(--shadow);
    padding: 12px;
    margin-top: 10px;
  }
  .ap-card h2 { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; color: var(--text-weak); margin-bottom: 8px; }

  .ap-input {
    width: 100%; padding: 6px 12px;
    background: var(--input); border: 1px solid var(--line);
    border-radius: var(--radius-pill); color: var(--text); font-size: 11.5px; font-family: inherit; outline: none;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  .ap-input::placeholder { color: var(--text-weak); }
  .ap-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }

  .cfg label { display: block; color: var(--text-sub); font-size: 11px; margin: 8px 0 4px; }

  /* .cfg .switch 特异性高于 .cfg label，防止 display:flex 被覆盖导致轨道塌陷 */
  .cfg .switch { display: flex; align-items: center; gap: 8px; margin: 10px 0; cursor: pointer; user-select: none; color: var(--text-sub); font-size: 11.5px; }
  .cfg .switch input { display: none; }
  .cfg .switch .track { flex: none; width: 34px; height: 20px; border-radius: 10px; background: var(--chip-bg); border: 1px solid var(--line-strong); position: relative; transition: background .2s ease, border-color .2s ease; }
  .cfg .switch .track::after { content: ""; position: absolute; left: 2px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: left .2s ease; }
  .cfg .switch input:checked + .track { background: var(--accent); border-color: transparent; }
  .cfg .switch input:checked + .track::after { left: 16px; }

  #hint { display: none; background: var(--accent-soft); border-radius: var(--radius-m); padding: 9px 12px; margin-top: 10px; font-size: 11px; color: var(--text-sub); line-height: 1.5; }
  #savedMsg { display: none; color: #248a3d; font-size: 10.5px; margin-top: 4px; }

  #items { max-height: 230px; overflow-y: auto; }
  .item { display: flex; gap: 6px; align-items: baseline; padding: 4px 2px; font-size: 11.5px; border-bottom: 1px solid var(--line); }
  .item:last-child { border-bottom: 0; }
  .item .ic { flex: none; width: 16px; text-align: center; }
  .item .nm { flex: none; }
  .item .dt { color: var(--text-weak); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item a { color: var(--accent); text-decoration: none; }
  .item a:hover { text-decoration: underline; }

  #log { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-m); padding: 8px 10px; max-height: 130px; overflow-y: auto; font-family: var(--vscode-editor-font-family); font-size: 10.5px; white-space: pre-wrap; word-break: break-all; color: var(--text-sub); }
  .okline { color: #248a3d; }
  #reloadRow { display: none; margin-top: 8px; }
  .footer { margin-top: 12px; text-align: center; font-size: 10.5px; color: var(--text-weak); line-height: 1.7; }
  .footer a { color: var(--accent); text-decoration: none; }
  .footer a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <header class="brand">
    <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
      <rect x="8" y="1" width="5" height="1"/>
      <rect x="7" y="2" width="7" height="1"/>
      <rect x="6" y="3" width="9" height="1"/>
      <rect x="5" y="4" width="10" height="1"/>
      <rect x="4" y="5" width="11" height="1"/>
      <rect x="4" y="6" width="11" height="1"/>
      <rect x="3" y="7" width="16" height="1"/>
      <rect x="3" y="8" width="17" height="1"/>
      <rect x="2" y="9" width="19" height="1"/>
      <rect x="2" y="10" width="20" height="1"/>
      <rect x="2" y="11" width="20" height="1"/>
      <rect x="3" y="12" width="19" height="1"/>
      <rect x="3" y="13" width="18" height="1"/>
      <rect x="4" y="14" width="16" height="1"/>
      <rect x="4" y="15" width="10" height="1"/>
      <rect x="16" y="15" width="3" height="1"/>
      <rect x="6" y="16" width="7" height="1"/>
      <rect x="9" y="17" width="1" height="1"/>
      <rect x="11" y="17" width="2" height="1"/>
      <rect x="4" y="18" width="1" height="1"/>
      <rect x="10" y="18" width="5" height="1"/>
      <rect x="3" y="19" width="3" height="1"/>
      <rect x="9" y="19" width="6" height="1"/>
      <rect x="2" y="20" width="4" height="1"/>
      <rect x="9" y="20" width="6" height="1"/>
      <rect x="3" y="21" width="3" height="1"/>
      <rect x="10" y="21" width="5" height="1"/>
      <rect x="10" y="22" width="4" height="1"/>
    </svg>
    <div>
      <h1>部署环境一键迁移</h1>
      <div class="en">Dev Env Sync</div>
    </div>
    <span id="status" class="status">空闲</span>
  </header>
  <p class="sub">把技能 · 工具 · 扩展 · 配置从私有仓库一键迁移到这台设备，或回传改动</p>

  <div class="row" style="display:flex; gap:8px;">
    <button id="deploy" class="ap-btn ap-btn-primary">⬇ 一键部署</button>
    <button id="upload" class="ap-btn">⬆ 一键上传</button>
  </div>
  <div class="row" id="reloadRow">
    <button id="reload" class="ap-btn ap-btn-sm ap-btn-ghost">重启 VS Code 生效</button>
  </div>

  <div id="hint">
    首次使用：点击「一键部署」会引导填写私人库地址（未建库请先在 GitHub 创建一个 Private 仓库）。
    地址保存后随 VS Code 设置同步，同一 GitHub 账号的其他设备自动读取，无需再填写。
  </div>

  <section class="ap-card">
    <h2>设置</h2>
    <div class="cfg">
      <label>私人内容库（Private Repo）</label>
      <input type="text" id="repo" class="ap-input" placeholder="git@github.com:YOU/private-repo.git">
      <label>本地工作目录</label>
      <input type="text" id="dir" class="ap-input" placeholder="~/dev/dev-env-sync">
      <label class="switch">
        <input type="checkbox" id="tool">
        <span class="track"></span>部署时自动安装工具链（Homebrew / winget / npm）
      </label>
      <button id="save" class="ap-btn ap-btn-sm ap-btn-ghost">应用设置</button>
      <div id="savedMsg">✔ 已应用</div>
    </div>
  </section>

  <section class="ap-card">
    <h2>安装清单</h2>
    <div id="items"></div>
  </section>

  <section class="ap-card">
    <h2>运行日志</h2>
    <div id="log"></div>
  </section>

  <footer class="footer">
    开发者主页 · <a href="#" data-url="https://hongyuguo.com">hongyuguo.com</a><br>
    GitHub 项目与赞赏 · <a href="#" data-url="https://github.com/Gsaecy/dev-env-sync-template">dev-env-sync-template</a>
  </footer>

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

  document.addEventListener("click", (e) => {
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
      $("items").innerHTML = "";
      (m.items || []).forEach(renderItem);
      if (m.busy) {
        $("deploy").disabled = true;
        $("upload").disabled = true;
        $("status").textContent = m.busyAction === "upload" ? "上传中…" : "部署中…";
        $("status").className = "status busy";
      }
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
      $("status").className = m.busy ? "status busy" : "status";
    } else if (m.type === "done") {
      $("status").textContent = m.ok ? "完成" : "失败";
      $("status").className = m.ok ? "status ok" : "status err";
      if (m.ok && m.changed) $("reloadRow").style.display = "block";
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
