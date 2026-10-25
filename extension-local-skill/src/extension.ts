import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SKILL_ZH,
  buildCategoryList,
  resolveCategory,
  MISC_CATEGORY_ID,
  THIRD_PARTY_SKILLS,
  type CategoryDef,
} from './skill-zh';
import { scanTranscripts } from './transcripts';

const SKILLS_DIR = path.join(os.homedir(), '.copilot', 'skills');
/** 状态文件放在 skills 目录之外，避免自身写入触发目录监听导致面板刷新（分类折叠丢失） */
const STATE_FILE = path.join(os.homedir(), '.copilot', '.skill-quick-launch.json');
/** 旧版状态文件位置（0.3.x），读取后迁移并删除 */
const LEGACY_STATE_FILE = path.join(SKILLS_DIR, '.active-skills.json');
/** 联网安装日志（skill-web-installer 维护），installed 记录视为第三方技能 */
const INSTALL_LOG = path.join(SKILLS_DIR, '.skill-install-log.md');
const INSTRUCTIONS = path.join(os.homedir(), '.github', 'copilot-instructions.md');

const BLOCK_START = '<!-- SKILLS-MANAGER:START -->';
const BLOCK_END = '<!-- SKILLS-MANAGER:END -->';

/** 技能名是否为真实技能目录（过滤 transcript 里的示例名/文件名） */
function skillExists(name: string): boolean {
  return fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md'));
}

interface SkillInfo {
  name: string;
  title: string;   // 用途标题（**...** 加粗部分）
  brief: string;   // 用途摘要一句话
  rawDesc: string; // frontmatter description 原文（用于第三方来源识别）
  triggers: string;
  useFor: string;
  active: boolean;
  file: string;
  zhTitle: string; // 中文标题（≤15 字）
  zhDesc: string;  // 中文描述（≤50 字）
  category: string; // 分类 id（见 skill-zh.ts CATEGORY_ORDER）
  origin: 'self' | 'third'; // 自建（可编辑） / 第三方（锁定）
}

function parseSkillMd(file: string): {
  title: string;
  brief: string;
  rawDesc: string;
  triggers: string;
  useFor: string;
  name: string;
} {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  let name = path.basename(path.dirname(file));
  let title = '';
  let brief = '';
  let rawDesc = '';
  let triggers = '';
  let useFor = '';
  if (m) {
    const fm = m[1];
    const pick = (key: string): string => {
      const mm = fm.match(new RegExp('^' + key + ':\\s*(.*)$', 'm'));
      if (!mm) { return ''; }
      return mm[1].trim().replace(/^['"](.*)['"]$/, '$1');
    };
    const nm = pick('name');
    if (nm) { name = nm; }
    rawDesc = pick('description');
    const bold = rawDesc.match(/\*\*(.*?)\*\*/);
    title = bold ? bold[1].trim() : name;
    const rest = rawDesc.replace(/\*\*.*?\*\*/g, '').replace(/^[\s—:：]+/, '').trim();
    brief = rest.split(/USE FOR:|Triggers:/)[0].trim();
    // Triggers 可能写在 frontmatter 顶层，也可能内嵌在 description 里（多数技能是后者）
    const tg = fm.match(/^Triggers:\s*(.*)$/m);
    const tgInDesc = rawDesc.match(/Triggers[:：]\s*([^。\n]*)/i);
    triggers = (tg ? tg[1] : tgInDesc ? tgInDesc[1] : '').trim().replace(/[。.]$/, '');
    const uf = rawDesc.match(/USE FOR[:：]\s*([^。\n]*)/i);
    useFor = uf ? uf[1].trim().replace(/[。.]$/, '') : '';
  }
  return { name, title, brief, rawDesc, triggers, useFor };
}

/** 联网安装日志中标记为 installed 的技能名集合（第三方来源依据之一） */
function installLogNames(): Set<string> {
  const out = new Set<string>();
  try {
    if (!fs.existsSync(INSTALL_LOG)) { return out; }
    const lines = fs.readFileSync(INSTALL_LOG, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^##\s+\d{4}-\d{2}-\d{2}\s+([\w-]+)\s*—\s*installed/);
      if (m) { out.add(m[1]); }
    }
  } catch { /* 日志不可读时忽略 */ }
  return out;
}

/** 判定技能来源：自建（可编辑）还是第三方（锁定）。
 *  优先级：用户显式标记 > 内置第三方名单 > 安装日志 installed > 描述中的外部仓库链接。 */
function classifySkill(name: string, rawDesc: string, st: ActiveState): 'self' | 'third' {
  if (st.origins[name] === 'self' || st.origins[name] === 'third') { return st.origins[name]; }
  if (THIRD_PARTY_SKILLS.has(name)) { return 'third'; }
  if (installLogNames().has(name)) { return 'third'; }
  if (/\b(?:https?:\/\/)?(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+/i.test(rawDesc)) { return 'third'; }
  return 'self';
}

interface ActiveState {
  active: string[];
  unchecked: Record<string, number>; // 用户手动取消勾选的时间戳（晚于该时间的命中才自动勾回）
  custom: Record<string, { title: string; desc: string }>; // 自建技能的自定义名称/描述
  origins: Record<string, 'self' | 'third'>; // 用户显式指定的来源标记
  /** 内置分类改名（id → 标题）；空/缺失用默认名 */
  categoryTitles: Record<string, string>;
  /** 用户自建分类（按创建顺序追加在内置分类之后） */
  customCategories: { id: string; title: string }[];
  /** 技能 → 分类的手动指定；优先于内置映射 */
  skillCategory: Record<string, string>;
}

function emptyState(): ActiveState {
  return {
    active: [],
    unchecked: {},
    custom: {},
    origins: {},
    categoryTitles: {},
    customCategories: [],
    skillCategory: {},
  };
}

function readActiveState(): ActiveState {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      active: Array.isArray(j.active) ? j.active : [],
      unchecked: j.unchecked && typeof j.unchecked === 'object' ? j.unchecked : {},
      custom: j.custom && typeof j.custom === 'object' ? j.custom : {},
      origins: j.origins && typeof j.origins === 'object' ? j.origins : {},
      categoryTitles:
        j.categoryTitles && typeof j.categoryTitles === 'object' ? j.categoryTitles : {},
      customCategories: Array.isArray(j.customCategories)
        ? j.customCategories.filter(
            (c: unknown): c is { id: string; title: string } =>
              !!c && typeof (c as { id?: unknown }).id === 'string',
          )
        : [],
      skillCategory:
        j.skillCategory && typeof j.skillCategory === 'object' ? j.skillCategory : {},
    };
  } catch { /* 首次使用或文件损坏 */ }
  // 迁移旧版状态（~/.copilot/skills/.active-skills.json）
  try {
    if (fs.existsSync(LEGACY_STATE_FILE)) {
      const j = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, 'utf8'));
      const st = emptyState();
      if (Array.isArray(j.active)) { st.active = j.active; }
      if (j.unchecked && typeof j.unchecked === 'object') { st.unchecked = j.unchecked; }
      writeActiveState(st);
      try { fs.unlinkSync(LEGACY_STATE_FILE); } catch { /* 删除失败不影响功能 */ }
      return st;
    }
  } catch { /* 旧文件不可读时忽略 */ }
  return emptyState();
}

function writeActiveState(state: ActiveState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function writeActive(names: string[]): void {
  const st = readActiveState();
  st.active = names;
  writeActiveState(st);
}

function readActive(): string[] {
  return readActiveState().active;
}

/** 用户手动取消勾选：记录时间戳，避免被旧记录自动勾回 */
function markUnchecked(name: string): void {
  const st = readActiveState();
  st.unchecked[name] = Date.now();
  writeActiveState(st);
}

function listSkills(): SkillInfo[] {
  if (!fs.existsSync(SKILLS_DIR)) { return []; }
  const st = readActiveState();
  const activeSet = new Set<string>(st.active);
  const categories = buildCategoryList(st.categoryTitles, st.customCategories);
  const validCats = new Set(categories.map((c) => c.id));
  const out: SkillInfo[] = [];
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) { continue; }
    const file = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) { continue; }
    try {
      const p = parseSkillMd(file);
      const origin = classifySkill(p.name, p.rawDesc, st);
      const custom = st.custom[p.name];
      let zhTitle: string;
      let zhDesc: string;
      if (custom && origin === 'self' && custom.title) {
        zhTitle = custom.title;
        zhDesc = custom.desc || '';
      } else if (SKILL_ZH[p.name]) {
        zhTitle = SKILL_ZH[p.name].title;
        zhDesc = SKILL_ZH[p.name].desc;
      } else {
        zhTitle = p.title;
        // 未收录中文映射：描述只取加粗标题之后的正文，避免「标题 + 标题」重复
        zhDesc = (p.brief || p.title).slice(0, 50);
      }
      const category = resolveCategory(p.name, st.skillCategory[p.name], validCats);
      out.push({ ...p, active: activeSet.has(p.name), file, zhTitle, zhDesc, category, origin });
    } catch { /* skip unreadable */ }
  }
  return out.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

/**
 * 激活模式：
 * - `route`（默认）：清单作为「路由表」，用户消息命中某技能的用途/触发词时才读取该 SKILL.md
 *   —— 这是 VS Code / Claude 等成熟技能方案的做法：靠 description 匹配，不预加载全部技能。
 * - `always`：旧版语义，每次新对话先读全部已激活技能的 SKILL.md。
 */
type ActivationMode = 'route' | 'always';

function activationMode(): ActivationMode {
  const v = vscode.workspace.getConfiguration('skillQuickLaunch').get<string>('activationMode', 'route');
  return v === 'always' ? 'always' : 'route';
}

/** 生成路由表行；超长时逐级截断，避免全局指令膨胀到影响模型注意力 */
function routeRows(active: SkillInfo[], triggerBudget: number): string[] {
  return active.map((s) => {
    const desc = s.zhDesc ? s.zhDesc : s.brief;
    const useFor = s.useFor && !desc.includes(s.useFor) ? s.useFor : '';
    const trig = s.triggers
      ? `触发词：${s.triggers.length > triggerBudget ? s.triggers.slice(0, triggerBudget) + '…' : s.triggers}`
      : '';
    const when = [desc, useFor && `适用：${useFor}`, trig].filter(Boolean).join('｜');
    return `- \`${s.name}\`｜${s.zhTitle}｜${when}`;
  });
}

/** 把激活技能清单同步进 ~/.github/copilot-instructions.md（保留文件其他内容） */
function syncInstructions(active: SkillInfo[]): string {
  const mode = activationMode();
  const ordered = [...active].sort((a, b) => a.name.localeCompare(b.name));

  // 预算控制：技能多时缩短触发词，保证整块不超过约 12K 字符
  let budget = 160;
  let rows = routeRows(ordered, budget);
  while (rows.join('\n').length > 12000 && budget > 30) {
    budget = Math.floor(budget / 2);
    rows = routeRows(ordered, budget);
  }

  const listPart = ordered.length
    ? ['已激活技能路由表（`技能名`｜显示名｜何时使用）：', ...rows].join('\n')
    : '已激活技能：\n（当前没有激活技能：不要主动调用任何本地技能。）';

  const usageRules =
    mode === 'always'
      ? [
          '1. **默认执行**：先逐个读取下面清单中全部技能对应的 `~/.copilot/skills/<技能名>/SKILL.md` 全文，把它们作为本次对话的默认工作流严格执行，不需要等用户再次提及技能名。',
          '2. **本次对话可临时更改**：如果用户在本对话中明确要求更改技能调用（例如「这次不用 X 技能」），以用户本次指示为准；勾选状态不变，下次新对话仍恢复默认执行全部勾选技能。',
        ]
      : [
          '1. **默认激活 + 命中即调用**：下面清单里的技能已由用户激活。当用户消息在**任务类型、关键词或触发词**上与某项技能匹配时，必须**先读取** `~/.copilot/skills/<技能名>/SKILL.md` 全文，并严格按其步骤执行；不要等用户点名技能，也不要先凭经验直接做。',
          '2. **不命中就不加载**：没有匹配到的技能不要读取、不要调用，避免无关技能干扰当前任务。',
          '3. **多个命中**：优先选择最具体的那一个；确实需要组合时按相关性顺序逐个读取执行。',
          '4. **用户临时要求优先**：用户在本对话明确说「这次不用 X 技能 / 只用 Y 技能 / 不用任何技能」时，以用户当次指示为准；激活状态不变。',
        ];

  const block = [
    BLOCK_START,
    '## 本地技能激活清单（由「本地skill快捷调用」扩展维护，勿手改）',
    `激活模式：**${mode === 'always' ? 'always（每次对话预读全部）' : 'route（命中即调用）'}**`,
    '以下规则在每次新对话开始时自动生效：',
    ...usageRules,
    `5. 清单之外的技能属于未激活状态：即使用户消息命中其用途，也**不要**主动调用，除非用户明确点名要求。`,
    '',
    listPart,
    BLOCK_END,
  ].join('\n');

  let content = '';
  if (fs.existsSync(INSTRUCTIONS)) {
    content = fs.readFileSync(INSTRUCTIONS, 'utf8');
  }
  const re = new RegExp(BLOCK_START + '[\\s\\S]*' + BLOCK_END, 'g');
  if (content.includes(BLOCK_START)) {
    content = content.replace(re, block);
  } else {
    content = (content.trimEnd() + '\n\n' + block + '\n').trimStart();
  }
  fs.mkdirSync(path.dirname(INSTRUCTIONS), { recursive: true });
  fs.writeFileSync(INSTRUCTIONS, content);
  return INSTRUCTIONS;
}

class SkillsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'skillsManager.listView';
  private _view?: vscode.WebviewView;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();
    // 每次面板变为可见都自动重扫：新增技能无需任何操作即可看到
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.refreshHtml();
      }
    });
    webviewView.webview.onDidReceiveMessage((msg) => {
      switch (msg.command) {
        case 'toggle': {
          const active = readActive();
          const idx = active.indexOf(msg.name);
          if (msg.checked && idx === -1) { active.push(msg.name); }
          if (!msg.checked) {
            if (idx !== -1) { active.splice(idx, 1); }
            markUnchecked(msg.name); // 记录取消时间，避免被旧会话记录自动勾回
          }
          writeActive(active);
          const skills = listSkills();
          syncInstructions(skills.filter((s) => s.active));
          // 不刷新整个面板：分类折叠状态保持不变
          this.post({ command: 'saved', count: active.length, total: skills.length });
          break;
        }
        case 'saveCustom': {
          const st = readActiveState();
          const title = String(msg.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 15);
          const desc = String(msg.desc ?? '').replace(/\s+/g, ' ').trim().slice(0, 50);
          if (title) {
            st.custom[msg.name] = { title, desc };
          } else {
            delete st.custom[msg.name]; // 名称为空视为放弃自定义
          }
          if (msg.lock) {
            st.origins[msg.name] = 'third';
            delete st.custom[msg.name]; // 锁定为第三方时清掉自定义名称/描述
          }
          writeActiveState(st);
          this.syncActive(); // 显示名变化要同步进路由表
          this.refreshHtml();
          break;
        }
        case 'resetCustom': {
          const st = readActiveState();
          delete st.custom[msg.name];
          writeActiveState(st);
          this.syncActive();
          this.refreshHtml();
          break;
        }
        case 'setOrigin': {
          const st = readActiveState();
          if (msg.origin === 'third') {
            st.origins[msg.name] = 'third';
            delete st.custom[msg.name];
          } else {
            st.origins[msg.name] = 'self';
          }
          writeActiveState(st);
          this.refreshHtml();
          break;
        }
        case 'selectAll': {
          const skills = listSkills();
          writeActive(skills.map((s) => s.name));
          syncInstructions(skills);
          this.refreshHtml();
          break;
        }
        case 'clearAll': {
          writeActive([]);
          syncInstructions([]);
          this.refreshHtml();
          break;
        }
        case 'refresh': {
          this.refreshHtml();
          break;
        }
        // ---- 分类：改名 / 新建 / 删除（自建）----
        case 'renameCategory': {
          const st = readActiveState();
          const id = String(msg.id ?? '');
          const title = String(msg.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 20);
          if (!id) { break; }
          if (title) {
            st.categoryTitles[id] = title;
          } else {
            delete st.categoryTitles[id];
          }
          writeActiveState(st);
          this.refreshHtml();
          break;
        }
        case 'addCategory': {
          const st = readActiveState();
          const title = String(msg.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 20);
          if (!title) { break; }
          const id = `cat-${Date.now().toString(36)}`;
          st.customCategories.push({ id, title });
          writeActiveState(st);
          this.refreshHtml();
          break;
        }
        case 'deleteCategory': {
          const st = readActiveState();
          const id = String(msg.id ?? '');
          if (!id || id === MISC_CATEGORY_ID) { break; }
          st.customCategories = st.customCategories.filter((c) => c.id !== id);
          delete st.categoryTitles[id];
          // 该分类下的技能回到「未分类」，不丢技能
          for (const [name, cat] of Object.entries(st.skillCategory)) {
            if (cat === id) { st.skillCategory[name] = MISC_CATEGORY_ID; }
          }
          writeActiveState(st);
          this.refreshHtml();
          break;
        }
        // ---- 技能换分类 ----
        case 'moveSkill': {
          const st = readActiveState();
          const name = String(msg.name ?? '');
          const category = String(msg.category ?? '');
          const valid = new Set(buildCategoryList(st.categoryTitles, st.customCategories).map((c) => c.id));
          if (!name || !valid.has(category)) { break; }
          st.skillCategory[name] = category;
          writeActiveState(st);
          const title =
            buildCategoryList(st.categoryTitles, st.customCategories).find((c) => c.id === category)?.title ?? '';
          this.post({ command: 'moved', name, category, title });
          break;
        }
        case 'resetSkillCategory': {
          const st = readActiveState();
          delete st.skillCategory[String(msg.name ?? '')];
          writeActiveState(st);
          this.refreshHtml();
          break;
        }
      }
    });
  }

  /** 按当前激活清单重写全局指令（勾选/改名/换分类后都需要） */
  private syncActive(): void {
    try {
      syncInstructions(listSkills().filter((s) => s.active));
    } catch { /* 写入失败不影响面板 */ }
  }

  /** 自动勾选：会话记录中命中且未被用户取消的技能 */
  notifyAutoAdded(names: string[]): void {
    this.post({ command: 'autoAdded', names });
    this.refreshHtml();
  }

  /** 公开刷新入口（目录监听/可见性变化时调用） */
  public refresh(): void {
    this.refreshHtml();
  }

  private post(msg: unknown): void {
    this._view?.webview.postMessage(msg);
  }

  private refreshHtml(): void {
    if (this._view) {
      this._view.webview.html = this.getHtml();
    }
  }

  private getHtml(): string {
    const skills = listSkills();
    const st = readActiveState();
    const activeCount = skills.filter((s) => s.active).length;
    // 分类顺序：内置（可改名）→ 自建 → 未分类；空分类默认不显示，自建分类即使为空也显示（可拖入）
    const categories: CategoryDef[] = buildCategoryList(st.categoryTitles, st.customCategories);
    const groups = categories
      .map((cat) => ({ ...cat, items: skills.filter((s) => s.category === cat.id) }))
      .filter((g) => g.items.length > 0 || g.custom);
    const categoryOptions = categories
      .map((c) => `<option value="${this.esc(c.id)}">${this.esc(c.title)}</option>`)
      .join('');

    // 空状态：新用户还没有任何技能时的安装指引
    const emptyState = `
    <div class="empty">
      <div class="empty-title">还没有可用的本地技能</div>
      <div class="empty-step">① 把技能文件夹（内含 <code>SKILL.md</code>）放入 <code>~/.copilot/skills/</code></div>
      <div class="empty-step">② 面板会自动扫描识别，无需任何操作（也可点「刷新」）</div>
      <div class="empty-step">③ 或先激活「联网装技能」技能，让 Copilot 帮你搜索并安装开源技能</div>
    </div>`;

    const listHtml = groups.length ? groups.map((g) => {
      const activeCount = g.items.filter((s) => s.active).length;
      const rows = g.items.map((s) => {
        const trig = s.triggers.length > 60 ? s.triggers.slice(0, 60) + '…' : s.triggers;
        const acts = s.origin === 'self'
          ? `<button class="act" data-act="edit" title="编辑名称与描述（自建技能）">✎</button>
             <button class="act" data-act="third" title="锁定为第三方（锁定后不可编辑）">🔒</button>`
          : `<button class="act self" data-act="self" title="第三方技能不可修改。点击标记为自建技能">自建</button>`;
        return `
      <div class="skill ${s.active ? 'on' : ''}" data-name="${this.esc(s.name)}"
           draggable="true"
           data-title="${this.esc(s.zhTitle)}" data-desc="${this.esc(s.zhDesc)}"
           data-cat="${this.esc(s.category)}">
        <label class="check" title="${s.active ? '取消勾选' : '勾选激活'}">
          <input type="checkbox" ${s.active ? 'checked' : ''} />
          <span class="circle"></span>
        </label>
        <div class="info">
          <div class="top"><span class="name">${this.esc(s.zhTitle)}</span><span class="ename">${this.esc(s.name)}</span>${s.origin === 'third' ? '<span class="badge" title="第三方技能：名称与描述不可修改">第三方</span>' : ''}</div>
          <div class="desc">${this.esc(s.zhDesc)}</div>
          ${trig ? `<div class="trig">触发: ${this.esc(trig)}</div>` : ''}
        </div>
        <div class="acts">
          <button class="act" data-act="move" title="更换所属分类">🗂</button>
          ${acts}
        </div>
      </div>`;
      }).join('');
      const catActs = `<span class="gacts">
          <button class="gact" data-gact="rename" title="重命名分类">✎</button>
          ${g.custom ? '<button class="gact" data-gact="delete" title="删除该分类（技能回到未分类）">🗑</button>' : ''}
        </span>`;
      const emptyHint = g.items.length === 0
        ? '<div class="gempty">把技能拖到这里即可归入该分类</div>'
        : '';
      return `
    <div class="group" data-cat="${this.esc(g.id)}" data-cattitle="${this.esc(g.title)}" data-custom="${g.custom ? 1 : 0}">
      <div class="ghead">
        <span class="chev">▾</span>
        <span class="gtitle">${this.esc(g.title)}</span>
        <span class="gcount">${activeCount}/${g.items.length}</span>
        ${catActs}
      </div>
      <div class="gbody">${rows}${emptyHint}</div>
    </div>`;
    }).join('') : emptyState;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<style>
  :root {
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border);
    --accent: var(--vscode-focusBorder);
    --card: color-mix(in srgb, var(--vscode-sideBar-background) 60%, transparent);
    --glass: color-mix(in srgb, var(--vscode-editor-background) 40%, transparent);
  }
  body { padding: 8px; color: var(--fg); font-size: 12px; font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; }
  .hint { background: var(--glass); border: 1px solid var(--border); border-radius: 10px; padding: 6px 9px; color: var(--muted); font-size: 11px; line-height: 1.5; margin-bottom: 8px; }
  .hint code { font-family: monospace; font-size: 10.5px; }
  #filter { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 8px; padding: 5px 8px; margin-bottom: 8px; font-size: 11.5px; }
  #filter:focus { outline: none; border-color: var(--accent); }
  .bar { display: flex; gap: 6px; margin-bottom: 8px; align-items: center; flex-wrap: wrap; }
  .bar .total { color: var(--muted); font-size: 10.5px; }
  .bar button { background: var(--glass); color: var(--fg); border: 1px solid var(--border); border-radius: 980px; padding: 3px 11px; cursor: pointer; font-size: 11px; transition: opacity .15s; }
  .bar button:hover { opacity: .8; }
  .bar button:active { opacity: .6; }
  #status { color: var(--muted); font-size: 11px; margin-left: auto; }
  .group { background: var(--glass); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 8px; overflow: hidden; }
  .ghead { display: flex; align-items: center; gap: 6px; padding: 7px 10px; cursor: pointer; user-select: none; }
  .ghead:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  .chev { transition: transform .15s ease; color: var(--muted); font-size: 10px; }
  .group.collapsed .chev { transform: rotate(-90deg); }
  .group.collapsed .gbody { display: none; }
  .gtitle { font-weight: 600; font-size: 12.5px; }
  .gcount { color: var(--muted); font-size: 10.5px; margin-left: auto; }
  .gacts { display: flex; gap: 2px; margin-left: 6px; opacity: 0; transition: opacity .12s; }
  .ghead:hover .gacts { opacity: .9; }
  .gact { background: transparent; border: none; color: var(--muted); cursor: pointer; font-size: 11px; padding: 1px 3px; border-radius: 4px; line-height: 1.4; }
  .gact:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--fg); }
  .gempty { color: var(--muted); font-size: 10.5px; padding: 10px; text-align: center; border-top: 1px dashed var(--border); }
  .group.dragover { outline: 1.5px dashed var(--accent); outline-offset: -1.5px; }
  .skill.dragging { opacity: .45; }
  .skill[draggable=true] { cursor: grab; }
  .mvrow { display: flex; align-items: center; gap: 6px; padding: 3px 2px; font-size: 11.5px; color: var(--fg); cursor: pointer; }
  .mvrow input { margin: 0; }
  .mvrow span.cur { color: var(--muted); font-size: 10px; }
  .cmsg { color: var(--muted); font-size: 11px; line-height: 1.6; margin-bottom: 8px; }
  .empty { background: var(--glass); border: 1px dashed var(--border); border-radius: 12px; padding: 14px 12px; color: var(--muted); font-size: 11.5px; line-height: 1.8; }
  .empty-title { color: var(--fg); font-weight: 600; margin-bottom: 4px; }
  .empty code { font-family: monospace; font-size: 10.5px; }
  .gbody { border-top: 1px solid var(--border); }
  .skill { display: flex; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--border); align-items: flex-start; }
  .skill:last-child { border-bottom: none; }
  .skill.on { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  .check { position: relative; flex: none; width: 15px; height: 15px; margin-top: 1px; cursor: pointer; }
  .check input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
  .circle { position: relative; display: block; width: 14px; height: 14px; border: 1.5px solid var(--muted); border-radius: 50%; box-sizing: border-box; }
  .check input:checked + .circle { border-color: var(--accent); background: var(--accent); }
  .check input:checked + .circle::after { content: "✓"; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 9.5px; font-weight: 700; color: #fff; line-height: 1; }
  .info { flex: 1; min-width: 0; }
  .top { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .name { font-weight: 600; font-size: 12.5px; }
  .ename { color: var(--muted); font-size: 10px; }
  .badge { color: var(--muted); border: 1px solid var(--border); border-radius: 980px; padding: 0 5px; font-size: 9px; line-height: 1.5; }
  .desc { color: var(--fg); opacity: .92; margin-top: 1px; line-height: 1.4; }
  .trig { color: var(--muted); font-size: 10.5px; margin-top: 2px; word-break: break-all; }
  .acts { flex: none; display: flex; gap: 2px; margin-top: 1px; opacity: .85; }
  .acts:hover { opacity: 1; }
  .act { background: transparent; border: none; color: var(--muted); cursor: pointer; font-size: 11px; padding: 1px 3px; border-radius: 4px; line-height: 1.4; }
  .act:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--fg); }
  .act.self { font-size: 9.5px; border: 1px solid var(--border); border-radius: 980px; padding: 0 5px; }
  .modal { position: fixed; inset: 0; background: color-mix(in srgb, var(--vscode-editor-background) 55%, transparent); display: flex; align-items: flex-start; justify-content: center; z-index: 10; }
  .modal.hidden { display: none; }
  .mbox { margin-top: 26px; width: calc(100% - 24px); max-width: 340px; background: var(--vscode-editor-background); border: 1px solid var(--border); border-radius: 12px; padding: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.35); }
  .mtitle { font-weight: 600; margin-bottom: 8px; }
  .mtitle code { font-family: monospace; font-size: 10.5px; }
  .mbox label { display: block; font-size: 11px; color: var(--muted); margin-bottom: 6px; }
  .mbox input[type=text], .mbox textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 8px; padding: 5px 8px; font-size: 12px; margin-bottom: 8px; font-family: inherit; resize: vertical; }
  .mbox input[type=text]:focus, .mbox textarea:focus { outline: none; border-color: var(--accent); }
  .mlock { display: flex !important; align-items: center; gap: 6px; color: var(--fg) !important; cursor: pointer; }
  .mlock input { margin: 0; }
  .mbtns { display: flex; gap: 6px; margin-top: 10px; }
  .mbtns button { background: var(--glass); color: var(--fg); border: 1px solid var(--border); border-radius: 980px; padding: 3px 12px; cursor: pointer; font-size: 11px; }
  .mbtns button.primary { background: var(--accent); color: #fff; border-color: transparent; }
  .mbtns button:hover { opacity: .85; }
</style>
</head>
<body>
  <div class="hint">✓ 勾选 = <b>默认激活</b>：对话内容命中该技能的用途或触发词时，Copilot 会先读取并按其执行，不用再点名。分类可 ✎ 改名、＋ 新建；技能用 🗂 或直接拖到别的分类即可换组。</div>
  <input id="filter" type="text" placeholder="搜索技能名称 / 用途…" />
  <div class="bar">
    <span class="total" id="totalText">共 ${skills.length} 项 · 激活 ${activeCount} 项</span>
    <button id="all">全选</button>
    <button id="none">清空</button>
    <button id="newcat">＋ 分类</button>
    <button id="refresh">刷新</button>
    <span id="status"></span>
  </div>
  <div id="list">${listHtml}</div>
  <div id="modal" class="modal hidden">
    <div class="mbox">
      <div class="mtitle">编辑技能 <code id="m-name"></code>（自建）</div>
      <label>名称（≤15 字）</label>
      <input id="m-title" type="text" maxlength="15" placeholder="中文显示名称" />
      <label>描述（≤50 字）</label>
      <textarea id="m-desc" maxlength="50" rows="2" placeholder="一句话说明用途"></textarea>
      <label class="mlock"><input type="checkbox" id="m-lock" /> 锁定为第三方（锁定后不可编辑）</label>
      <div class="mbtns">
        <button id="m-save" class="primary">保存</button>
        <button id="m-reset">还原默认</button>
        <button id="m-cancel">取消</button>
      </div>
    </div>
  </div>
  <div id="cmodal" class="modal hidden">
    <div class="mbox">
      <div class="mtitle" id="c-title">重命名分类</div>
      <div class="cmsg" id="c-msg"></div>
      <label id="c-label">分类名称（≤20 字，留空还原默认）</label>
      <input id="c-input" type="text" maxlength="20" placeholder="例如：前端工程规范" />
      <div class="mbtns">
        <button id="c-save" class="primary">保存</button>
        <button id="c-cancel">取消</button>
      </div>
    </div>
  </div>
  <div id="movemodal" class="modal hidden">
    <div class="mbox">
      <div class="mtitle">更换分类 <code id="mv-name"></code></div>
      <div id="mv-list"></div>
      <div class="mbtns">
        <button id="mv-save" class="primary">保存</button>
        <button id="mv-cancel">取消</button>
      </div>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const CATS = ${JSON.stringify(categories).replace(/</g, '\\u003c')};
    const list = document.getElementById('list');
    // 分类折叠状态持久化：面板刷新/重启后保持
    let ui = vscode.getState() || {};
    const collapsed = Array.isArray(ui.collapsed) ? ui.collapsed : [];
    list.querySelectorAll('.group').forEach(g => {
      if (collapsed.indexOf(g.dataset.cat) !== -1) g.classList.add('collapsed');
    });
    // 勾选/取消
    list.querySelectorAll('.skill input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        const row = cb.closest('.skill');
        const name = row.dataset.name;
        row.classList.toggle('on', cb.checked);
        updateGroupCount(row);
        vscode.postMessage({ command: 'toggle', name, checked: cb.checked });
      });
    });
    function updateGroupCount(row) {
      const g = row.closest('.group');
      if (g) updateGroupCountFor(g);
    }
    function updateGroupCountFor(g) {
      const total = g.querySelectorAll('.skill').length;
      const active = g.querySelectorAll('.skill.on').length;
      const c = g.querySelector('.gcount');
      if (c) c.textContent = active + '/' + total;
      // 空的自建分类保留拖放提示；有内容则去掉
      const body = g.querySelector('.gbody');
      const hint = body && body.querySelector('.gempty');
      if (hint && total > 0) hint.remove();
      if (!hint && total === 0 && g.dataset.custom === '1' && body) {
        const d = document.createElement('div');
        d.className = 'gempty';
        d.textContent = '把技能拖到这里即可归入该分类';
        body.appendChild(d);
      }
    }
    function applyMoved(m) {
      const rows = list.querySelectorAll('.skill');
      let row = null;
      rows.forEach(r => { if (r.dataset.name === m.name) row = r; });
      const target = list.querySelector('.group[data-cat="' + m.category + '"]');
      if (!row || !target) { vscode.postMessage({ command: 'refresh' }); return; }
      const oldGroup = row.closest('.group');
      const body = target.querySelector('.gbody');
      row.dataset.cat = m.category;
      body.appendChild(row);
      target.classList.remove('collapsed');
      updateGroupCountFor(target);
      if (oldGroup && oldGroup !== target) updateGroupCountFor(oldGroup);
      const s = document.getElementById('status');
      s.textContent = '已移动到「' + (m.title || m.category) + '」';
      setTimeout(() => { s.textContent = ''; }, 3000);
    }
    // 分类展开/收起（记住折叠状态）
    list.querySelectorAll('.ghead').forEach(h => {
      h.addEventListener('click', (e) => {
        if (e.target.closest('.gact')) return;   // 分类按钮不触发折叠
        const g = h.parentElement;
        g.classList.toggle('collapsed');
        ui.collapsed = Array.from(list.querySelectorAll('.group.collapsed')).map(x => x.dataset.cat);
        vscode.setState(ui);
      });
    });
    // 行内操作：✎ 编辑 / 🔒 锁定为第三方 / 自建（解除第三方锁定）
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const row = btn.closest('.skill');
      const name = row.dataset.name;
      if (btn.dataset.act === 'edit') { openEdit(row); }
      else if (btn.dataset.act === 'move') { openMove(row); }
      else if (btn.dataset.act === 'self') { vscode.postMessage({ command: 'setOrigin', name, origin: 'self' }); }
      else if (btn.dataset.act === 'third') { vscode.postMessage({ command: 'setOrigin', name, origin: 'third' }); }
    });
    // 分类操作：✎ 改名 / 🗑 删除
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-gact]');
      if (!btn) return;
      const g = btn.closest('.group');
      const id = g.dataset.cat;
      if (btn.dataset.gact === 'rename') { openCategoryRename(id, g.dataset.cattitle || ''); }
      else if (btn.dataset.gact === 'delete') { openCategoryDelete(id, g.dataset.cattitle || ''); }
    });
    // 拖拽换分类
    let dragName = '';
    let dragCat = '';
    list.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.skill');
      if (!row) return;
      dragName = row.dataset.name;
      dragCat = row.dataset.cat;
      row.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', dragName); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
    });
    list.addEventListener('dragend', () => {
      dragName = '';
      dragCat = '';
      list.querySelectorAll('.dragging,.dragover').forEach(x => x.classList.remove('dragging','dragover'));
    });
    list.addEventListener('dragover', (e) => {
      const g = e.target.closest('.group');
      if (!g || !dragName) return;
      e.preventDefault();
      list.querySelectorAll('.group.dragover').forEach(x => x.classList.remove('dragover'));
      if (g.dataset.cat !== dragCat) g.classList.add('dragover');
    });
    list.addEventListener('dragleave', (e) => {
      const g = e.target.closest('.group');
      if (g && !g.contains(e.relatedTarget)) g.classList.remove('dragover');
    });
    list.addEventListener('drop', (e) => {
      const g = e.target.closest('.group');
      if (!g) return;
      e.preventDefault();
      const name = dragName || e.dataTransfer.getData('text/plain');
      g.classList.remove('dragover');
      if (name) vscode.postMessage({ command: 'moveSkill', name, category: g.dataset.cat });
    });
    // 编辑弹窗
    function openEdit(row) {
      document.getElementById('m-name').textContent = row.dataset.name;
      document.getElementById('m-title').value = row.dataset.title;
      document.getElementById('m-desc').value = row.dataset.desc;
      document.getElementById('m-lock').checked = false;
      document.getElementById('modal').classList.remove('hidden');
    }
    function closeEdit() { document.getElementById('modal').classList.add('hidden'); }
    document.getElementById('m-cancel').addEventListener('click', closeEdit);
    document.getElementById('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeEdit(); });
    document.getElementById('m-save').addEventListener('click', () => {
      vscode.postMessage({
        command: 'saveCustom',
        name: document.getElementById('m-name').textContent,
        title: document.getElementById('m-title').value,
        desc: document.getElementById('m-desc').value,
        lock: document.getElementById('m-lock').checked,
      });
    });
    document.getElementById('m-reset').addEventListener('click', () => {
      vscode.postMessage({ command: 'resetCustom', name: document.getElementById('m-name').textContent });
    });
    // ---- 分类改名 / 新建 ----
    let catMode = 'rename';
    let catTarget = '';
    function setCategoryForm(mode, id, title) {
      catMode = mode;
      catTarget = id;
      const input = document.getElementById('c-input');
      const label = document.getElementById('c-label');
      const msg = document.getElementById('c-msg');
      const save = document.getElementById('c-save');
      const isDelete = mode === 'delete';
      document.getElementById('c-title').textContent =
        mode === 'add' ? '新建分类' : isDelete ? '删除分类' : '重命名分类';
      label.style.display = isDelete ? 'none' : '';
      input.style.display = isDelete ? 'none' : '';
      msg.textContent = isDelete
        ? '「' + title + '」删除后，其中的技能会回到「' + (CATS.find(c => c.id === 'misc') || {}).title + '」，技能本身不会删除。'
        : '';
      save.textContent = isDelete ? '删除' : '保存';
      input.value = isDelete ? '' : title;
      input.placeholder = mode === 'add' ? '例如：前端工程规范' : '留空还原默认名称';
      document.getElementById('cmodal').classList.remove('hidden');
      if (!isDelete) { input.focus(); input.select(); }
    }
    function openCategoryRename(id, title) { setCategoryForm('rename', id, title); }
    function openCategoryDelete(id, title) { setCategoryForm('delete', id, title); }
    document.getElementById('newcat').addEventListener('click', () => setCategoryForm('add', '', ''));
    document.getElementById('c-cancel').addEventListener('click', () => document.getElementById('cmodal').classList.add('hidden'));
    document.getElementById('cmodal').addEventListener('click', (e) => {
      if (e.target.id === 'cmodal') document.getElementById('cmodal').classList.add('hidden');
    });
    document.getElementById('c-save').addEventListener('click', () => {
      const title = document.getElementById('c-input').value.trim();
      if (catMode === 'add') {
        if (!title) return;
        vscode.postMessage({ command: 'addCategory', title });
      } else if (catMode === 'delete') {
        vscode.postMessage({ command: 'deleteCategory', id: catTarget });
      } else {
        vscode.postMessage({ command: 'renameCategory', id: catTarget, title });
      }
      document.getElementById('cmodal').classList.add('hidden');
    });
    document.getElementById('c-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('c-save').click();
    });

    // ---- 技能换分类 ----
    let moveName = '';
    let moveCat = '';
    function openMove(row) {
      moveName = row.dataset.name;
      moveCat = row.dataset.cat;
      document.getElementById('mv-name').textContent = moveName;
      const box = document.getElementById('mv-list');
      box.innerHTML = CATS.map((c) => {
        const checked = c.id === moveCat ? 'checked' : '';
        return '<label class="mvrow"><input type="radio" name="mv" value="' + c.id + '" ' + checked + ' />'
          + '<span>' + c.title + '</span></label>';
      }).join('');
      document.getElementById('movemodal').classList.remove('hidden');
    }
    document.getElementById('mv-cancel').addEventListener('click', () => document.getElementById('movemodal').classList.add('hidden'));
    document.getElementById('movemodal').addEventListener('click', (e) => {
      if (e.target.id === 'movemodal') document.getElementById('movemodal').classList.add('hidden');
    });
    document.getElementById('mv-save').addEventListener('click', () => {
      const picked = document.querySelector('input[name=mv]:checked');
      if (picked && picked.value !== moveCat) {
        vscode.postMessage({ command: 'moveSkill', name: moveName, category: picked.value });
      }
      document.getElementById('movemodal').classList.add('hidden');
    });

    document.getElementById('all').addEventListener('click', () => vscode.postMessage({ command: 'selectAll' }));
    document.getElementById('none').addEventListener('click', () => vscode.postMessage({ command: 'clearAll' }));
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    // 搜索：匹配到的行显示，其所属分类自动展开；无匹配的分类隐藏
    document.getElementById('filter').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      list.querySelectorAll('.group').forEach(g => {
        let visible = 0;
        g.querySelectorAll('.skill').forEach(r => {
          const hit = r.textContent.toLowerCase().includes(q);
          r.style.display = hit ? '' : 'none';
          if (hit) visible++;
        });
        g.style.display = visible > 0 ? '' : 'none';
        if (visible > 0) g.classList.remove('collapsed');
      });
    });
    window.addEventListener('message', (ev) => {
      const m = ev.data;
      if (m && m.command === 'saved') {
        const s = document.getElementById('status');
        s.textContent = '已保存 (' + m.count + ' 个激活，新对话默认执行)';
        const t = document.getElementById('totalText');
        if (t && m.total !== undefined) { t.textContent = '共 ' + m.total + ' 项 · 激活 ' + m.count + ' 项'; }
        setTimeout(() => { s.textContent = ''; }, 4000);
      }
      if (m && m.command === 'moved') { applyMoved(m); }
      if (m && m.command === 'autoAdded' && m.names && m.names.length) {
        const s = document.getElementById('status');
        s.textContent = '检测到对话中调用，已自动勾选: ' + m.names.join(', ');
        setTimeout(() => { s.textContent = ''; }, 6000);
      }
    });
  </script>
</body>
</html>`;
  }

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SkillsViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SkillsViewProvider.viewType, provider)
  );

  // ---- 启动即同步：把当前激活清单按最新格式写入全局指令（升级后无需手动重新勾选）----
  try {
    syncInstructions(listSkills().filter((s) => s.active));
  } catch { /* 写入失败不影响面板功能 */ }

  // ---- 目录监听：新增/删除技能后自动刷新面板（无需手动点刷新）----
  let watchTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (): void => {
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      try {
        provider.refresh();
      } catch { /* 面板未打开时刷新失败无害 */ }
    }, 600);
  };
  try {
    if (fs.existsSync(SKILLS_DIR)) {
      const watcher = fs.watch(SKILLS_DIR, { recursive: true }, scheduleRefresh);
      context.subscriptions.push({ dispose: () => watcher.close() });
    } else {
      // skills 目录尚不存在：监听上级目录，创建 skills 目录后同样自动刷新
      const parentWatcher = fs.watch(path.dirname(SKILLS_DIR), (ev, fname) => {
        if (fname === 'skills' || ev === 'rename') scheduleRefresh();
      });
      context.subscriptions.push({ dispose: () => parentWatcher.close() });
    }
  } catch {
    /* 监听失败时仍可通过「刷新」按钮或重开面板重扫 */
  }

  // ---- 自动勾选：扫描 Copilot 会话记录，对话中调用过的技能自动激活 ----
  const cfg = vscode.workspace.getConfiguration('skillQuickLaunch');
  const enabled = cfg.get<boolean>('autoDetect', true);
  const intervalSec = Math.max(5, cfg.get<number>('pollIntervalSeconds', 10));
  if (enabled) {
    const known = new Map<string, number>();
    const check = (): void => {
      try {
        const hits = scanTranscripts(known);
        const st = readActiveState();
        const autoAdded: string[] = [];
        for (const [name, ts] of hits) {
          if (!skillExists(name)) { continue; }
          if (st.active.includes(name)) { continue; }
          const uncheckedTs = st.unchecked[name] ?? 0;
          if (ts > uncheckedTs) {
            st.active.push(name);
            delete st.unchecked[name];
            autoAdded.push(name);
          }
        }
        if (autoAdded.length > 0) {
          writeActiveState(st);
          syncInstructions(listSkills().filter((s) => s.active));
          provider.notifyAutoAdded(autoAdded);
        }
      } catch { /* 扫描失败不影响手动功能 */ }
    };
    check();
    const timer = setInterval(check, intervalSec * 1000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }
}

export function deactivate(): void {}
