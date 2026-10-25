/**
 * 从 Copilot 会话记录（transcripts 目录下 .jsonl）中提取"对话中调用过的技能"。
 * 数据源：<VS Code 用户数据>/User/workspaceStorage/<ws>/GitHub.copilot-chat/transcripts/<sid>.jsonl
 * 命中规则：行内出现 `.copilot/skills/<name>` 或 `/skills/<name>/SKILL.md`，且 <name> 是真实技能目录。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** VS Code 用户数据目录（跨平台：Windows APPDATA / Linux .config / macOS Library） */
function codeUserDataDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) { return path.join(appData, 'Code', 'User'); }
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User');
  }
  if (process.platform === 'linux') {
    return path.join(os.homedir(), '.config', 'Code', 'User');
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
}

const WS_ROOT = path.join(codeUserDataDir(), 'workspaceStorage');

const RE_SKILL = /\.copilot\/skills\/([a-zA-Z0-9][a-zA-Z0-9-]*)/g;
const RE_SKILL2 = /\/skills\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/SKILL\.md/g;

function walkTranscriptFiles(): string[] {
  const out: string[] = [];
  if (!fs.existsSync(WS_ROOT)) { return out; }
  for (const ws of fs.readdirSync(WS_ROOT, { withFileTypes: true })) {
    if (!ws.isDirectory()) { continue; }
    const dir = path.join(WS_ROOT, ws.name, 'GitHub.copilot-chat', 'transcripts');
    if (!fs.existsSync(dir)) { continue; }
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.jsonl')) { out.push(path.join(dir, f)); }
    }
  }
  return out;
}

/** 从单个 transcript 文件提取 技能名 → 最新命中时间戳(ms) */
function extractHits(file: string): Map<string, number> {
  const out = new Map<string, number>();
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.includes('skills/')) { continue; }
    let ts = 0;
    const tsm = line.match(/"ts":(\d+)/);
    if (tsm) { ts = Number(tsm[1]); }
    const names = new Set<string>();
    let m: RegExpExecArray | null;
    RE_SKILL.lastIndex = 0;
    while ((m = RE_SKILL.exec(line)) !== null) { names.add(m[1]); }
    RE_SKILL2.lastIndex = 0;
    while ((m = RE_SKILL2.exec(line)) !== null) { names.add(m[1]); }
    for (const n of names) {
      const prev = out.get(n) ?? 0;
      if (ts > prev) { out.set(n, ts); }
    }
  }
  return out;
}

/**
 * 增量扫描：known 记录 文件名→mtime 与 技能名→已知 ts。
 * 只处理 mtime 变化的文件；返回 技能名 → 最新命中 ts 的全量视图。
 */
export function scanTranscripts(known: Map<string, number>): Map<string, number> {
  const skills = new Map<string, number>();
  // 先把 known 中技能条目拷贝出来
  for (const [k, v] of known) {
    if (!k.startsWith('__file__')) { skills.set(k, v); }
  }
  for (const f of walkTranscriptFiles()) {
    let st: fs.Stats;
    try { st = fs.statSync(f); } catch { continue; }
    const key = '__file__' + f;
    if (known.get(key) === st.mtimeMs) { continue; } // 未变化
    try {
      const hits = extractHits(f);
      for (const [n, ts] of hits) {
        const prev = skills.get(n) ?? 0;
        if (ts > prev) { skills.set(n, ts); }
      }
      known.set(key, st.mtimeMs);
    } catch { /* unreadable, skip */ }
  }
  return skills;
}
