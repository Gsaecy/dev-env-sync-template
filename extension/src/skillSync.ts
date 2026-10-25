import * as fs from "fs/promises";
import * as path from "path";

/**
 * 技能目录同步的纯文件操作（不依赖 vscode，便于单独测试）。
 *
 * 方向约定：
 * - 部署：私有库 → 本机
 * - 上传：本机 → 私有库（`collectSkillsFrom`）
 */

export interface CollectResult {
  /** 本机技能总数 */
  total: number;
  /** 本次实际写入私有库的技能名 */
  updated: string[];
  /** 内容一致、跳过的数量 */
  unchanged: number;
  /** 失败项 */
  failed: { name: string; error: string }[];
}

/**
 * 目录签名：相对路径 + 文件大小。
 * 不用 mtime——`copyFile` 不保留源时间戳，用 mtime 会导致永远判定为「已变化」。
 */
export async function dirSig(dir: string): Promise<string | null> {
  const list: string[] = [];
  async function walk(d: string, rel: string): Promise<void> {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        const real = await fs.realpath(path.join(d, e.name));
        const st = await fs.stat(real);
        if (st.isDirectory()) await walk(real, r);
        else list.push(`${r}|${st.size}`);
      } else if (e.isDirectory()) {
        await walk(path.join(d, e.name), r);
      } else if (e.isFile()) {
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

/** 递归复制；符号链接按真实内容复制（链接到项目目录的技能到另一台机器会失效）。 */
export async function copyTree(src: string, dst: string): Promise<void> {
  // 目标根目录必须先建：调用方通常先 rm 掉旧目录再复制。
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isSymbolicLink()) {
      const real = await fs.realpath(s);
      const st = await fs.stat(real);
      if (st.isDirectory()) {
        await fs.mkdir(d, { recursive: true });
        await copyTree(real, d);
      } else {
        await fs.copyFile(real, d);
      }
    } else if (e.isDirectory()) {
      await fs.mkdir(d, { recursive: true });
      await copyTree(s, d);
    } else if (e.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

/**
 * 收集本机技能到私有库：本机 → 私有库。
 *
 * - 只处理非隐藏的目录与符号链接；隐藏文件（如 `.skill-install-log.md`）留在本机
 * - 内容一致则跳过；有差异整目录覆盖
 * - 私有库里本机没有的技能**不删除**（其他平台专用技能要保留）
 */
export async function collectSkillsFrom(localRoot: string, repoRoot: string): Promise<CollectResult> {
  const result: CollectResult = { total: 0, updated: [], unchanged: 0, failed: [] };

  let entries;
  try {
    entries = await fs.readdir(localRoot, { withFileTypes: true });
  } catch {
    return result;
  }

  const names = entries
    .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()))
    .map((e) => e.name)
    .sort();
  result.total = names.length;

  await fs.mkdir(repoRoot, { recursive: true });

  for (const name of names) {
    const link = path.join(localRoot, name);
    const dst = path.join(repoRoot, name);
    try {
      const src = await fs.realpath(link);
      if (!(await fs.stat(src)).isDirectory()) throw new Error("不是目录");
      if ((await dirSig(src)) === (await dirSig(dst))) {
        result.unchanged++;
        continue;
      }
      await fs.rm(dst, { recursive: true, force: true });
      await copyTree(src, dst);
      result.updated.push(name);
    } catch (e) {
      result.failed.push({ name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return result;
}

/**
 * 读取技能声明的适用平台。
 *
 * 约定：`SKILL.md` frontmatter 可选写 `platforms:`（或 `os:`），例如
 * ```yaml
 * platforms: [darwin]        # 仅 macOS
 * platforms: darwin, win32   # macOS 与 Windows
 * ```
 * 不写 = 全平台。返回值已归一化为 `darwin` / `win32` / `linux`。
 */
export async function readDeclaredPlatforms(skillDir: string): Promise<string[] | null> {
  const text = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8").catch(() => "");
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const frontmatter = text.slice(3, end);
  const match = frontmatter.match(/^\s*(?:platforms|os)\s*:\s*(.+)$/m);
  if (!match) return null;

  const raw = match[1].trim().replace(/^\[/, "").replace(/\]$/, "");
  const list = raw
    .split(/[,\s]+/)
    .map((v) => v.trim().replace(/^['"]|['"]$/g, "").toLowerCase())
    .filter(Boolean)
    .map((v) =>
      v === "macos" || v === "mac" || v === "osx"
        ? "darwin"
        : v === "windows" || v === "win"
          ? "win32"
          : v,
    );
  return list.length ? list : null;
}

/** 该技能是否适用于指定平台（未声明 = 适用）。 */
export async function isSkillAllowedOn(skillDir: string, platform: string): Promise<boolean> {
  const platforms = await readDeclaredPlatforms(skillDir);
  return !platforms || platforms.includes("*") || platforms.includes(platform);
}
