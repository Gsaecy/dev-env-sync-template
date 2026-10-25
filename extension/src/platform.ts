import * as fs from "fs/promises";
import * as path from "path";

/**
 * 平台判定与扩展清单规整（不依赖 vscode，便于单独测试）。
 *
 * 背景：VS Code 扩展的 package.json **没有**「仅 macOS 可用」这种字段，
 * 只能靠 ID 语义 + 用户显式覆盖表判断。判定结果用于两处：
 * - 上传：写进清单的对应平台段，不再落到「通用」段
 * - 部署：不属于当前系统的扩展直接跳过，不安装
 */

export type Platform = "darwin" | "win32" | "linux";

export const PLATFORM_LABEL: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

/** 已知只在 macOS 上能用的扩展（按 ID 片段匹配）。宁可少判，不要误杀跨平台扩展。 */
const DARWIN_ONLY_PATTERNS: RegExp[] = [
  /(^|[.\-_])swift(land)?([.\-_]|$)/,
  /(^|[.\-_])xcode([.\-_]|$)/,
  /(^|[.\-_])apple([.\-_]|$)/,
  /(^|[.\-_])darwin([.\-_]|$)/,
  /(^|[.\-_])(ios|macos)([.\-_]|$)/,
  /sweetpad/,
  /swiftlint/,
  /swiftformat/,
];

/** id → 允许的平台列表；`["*"]` 或空数组表示全平台。 */
export type PlatformOverrides = Record<string, string[]>;

export interface ManifestSections {
  common: string[];
  platforms: Record<string, string[]>;
}

const PLATFORM_ALIASES: Record<string, Platform> = {
  macos: "darwin",
  mac: "darwin",
  osx: "darwin",
  darwin: "darwin",
  windows: "win32",
  win: "win32",
  win32: "win32",
  linux: "linux",
};

export function normalizePlatformName(value: string): string {
  const v = value.trim().toLowerCase().replace(/^['"]|['"]$/g, "");
  return PLATFORM_ALIASES[v] ?? v;
}

/** 读取 `tools/extension-platforms.json`（可选，用户可覆盖内置判断）。 */
export async function loadOverrides(personalDir: string): Promise<PlatformOverrides> {
  const file = path.join(personalDir, "tools", "extension-platforms.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const out: PlatformOverrides = {};
    for (const [id, value] of Object.entries(data)) {
      if (id.startsWith("//") || id.startsWith("_")) continue;
      const list = Array.isArray(value) ? value : [value];
      out[id] = list.map((v) => (typeof v === "string" ? normalizePlatformName(v) : ""));
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 该扩展允许在哪些平台运行。
 * 返回 `null` 表示不限平台（通用扩展）。
 */
export function allowedPlatforms(
  id: string,
  overrides: PlatformOverrides = {},
): Platform[] | null {
  const key = id.toLowerCase();
  for (const [overrideId, list] of Object.entries(overrides)) {
    if (overrideId.toLowerCase() !== key) continue;
    const clean = list.map(normalizePlatformName).filter(Boolean);
    if (!clean.length || clean.includes("*")) return null;
    return clean as Platform[];
  }
  const lower = id.toLowerCase();
  if (DARWIN_ONLY_PATTERNS.some((re) => re.test(lower))) return ["darwin"];
  return null;
}

/** 该扩展是否适用于指定平台。 */
export function isAllowedOn(id: string, platform: string, overrides: PlatformOverrides = {}): boolean {
  const allowed = allowedPlatforms(id, overrides);
  return !allowed || allowed.includes(platform as Platform);
}

function uniqSorted(list: string[]): string[] {
  return [...new Set(list)].sort();
}

/**
 * 规整清单：
 * - 每一条只属于一个段（平台专属的从「通用」里摘出去）
 * - 平台段与判定冲突时以判定为准（修正旧清单里被塞进通用段的 Swift 扩展）
 */
export function normalizeManifest(
  m: ManifestSections,
  overrides: PlatformOverrides = {},
): ManifestSections {
  const all = uniqSorted([...m.common, ...Object.values(m.platforms).flat()]);
  const common: string[] = [];
  const platforms: Record<string, string[]> = {};

  for (const id of all) {
    const allowed = allowedPlatforms(id, overrides);
    if (allowed && allowed.length === 1) {
      const p = allowed[0];
      platforms[p] = platforms[p] ?? [];
      platforms[p].push(id);
    } else {
      common.push(id);
    }
  }

  for (const p of Object.keys(platforms)) platforms[p] = uniqSorted(platforms[p]);
  for (const p of Object.keys(m.platforms)) platforms[p] = platforms[p] ?? [];
  return { common: uniqSorted(common), platforms };
}

/**
 * 把本机已装扩展并入旧清单：
 * - 先把它从所有段里摘掉，再按判定重新落位（避免「既在通用段又在平台段」）
 * - 旧清单里本机没装的通用扩展保留（可能是另一台设备的）
 */
export function mergeInstalledIntoManifest(
  old: ManifestSections,
  installed: string[],
  overrides: PlatformOverrides = {},
): ManifestSections {
  const common = [...old.common];
  const platforms: Record<string, string[]> = {};
  for (const [p, ids] of Object.entries(old.platforms)) platforms[p] = [...ids];

  const remove = (id: string) => {
    for (let i = common.length - 1; i >= 0; i--) if (common[i] === id) common.splice(i, 1);
    for (const p of Object.keys(platforms)) {
      platforms[p] = platforms[p].filter((x) => x !== id);
    }
  };

  for (const id of installed) {
    remove(id);
    const allowed = allowedPlatforms(id, overrides);
    if (allowed && allowed.length === 1) {
      (platforms[allowed[0]] = platforms[allowed[0]] ?? []).push(id);
    } else {
      common.push(id);
    }
  }

  return normalizeManifest({ common, platforms }, overrides);
}

export function parseManifest(text: string): ManifestSections {
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

export function serializeManifest(m: ManifestSections): string {
  const lines = [
    "# VS Code 扩展清单（由 Dev Env Sync 自动生成）",
    "# 部署时安装「通用」段 + 当前平台专属段；其他平台段忽略",
    "# 判定规则见 tools/extension-platforms.json（可选，覆盖内置判断）",
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

/** 从清单里整条剔除指定 ID（用于清理 VS Code 内置扩展这类不需要跨设备安装的条目）。 */
export function pruneIds(m: ManifestSections, ids: string[]): ManifestSections {
  const drop = new Set(ids.map((x) => x.toLowerCase()));
  const platforms: Record<string, string[]> = {};
  for (const [p, list] of Object.entries(m.platforms)) {
    platforms[p] = list.filter((id) => !drop.has(id.toLowerCase()));
  }
  return {
    common: m.common.filter((id) => !drop.has(id.toLowerCase())),
    platforms,
  };
}
