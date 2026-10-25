// 冒烟测试：复刻扩展 extension.ts 中的 frontmatter 解析逻辑
const fs = require('fs');
const os = require('os');
const path = require('path');
const SK = path.join(os.homedir(), '.copilot', 'skills');

function parseSkillMd(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  let name = path.basename(path.dirname(file));
  let title = '', brief = '', triggers = '';
  if (m) {
    const fm = m[1];
    const pick = (key) => {
      const mm = fm.match(new RegExp('^' + key + ':\\s*(.*)$', 'm'));
      if (!mm) return '';
      return mm[1].trim().replace(/^['"](.*)['"]$/, '$1');
    };
    const nm = pick('name');
    if (nm) name = nm;
    const desc = pick('description');
    const bold = desc.match(/\*\*(.*?)\*\*/);
    title = bold ? bold[1].trim() : name;
    const rest = desc.replace(/\*\*.*?\*\*/g, '').replace(/^[\s—:：]+/, '').trim();
    brief = rest.split(/USE FOR:|Triggers:/)[0].trim();
    const tg = fm.match(/^Triggers:\s*(.*)$/m);
    triggers = tg ? tg[1].trim() : '';
  }
  return { name, title, brief, triggers };
}

let bad = 0;
for (const e of fs.readdirSync(SK, { withFileTypes: true })) {
  if (!e.isDirectory() || e.name.startsWith('.')) continue;
  const f = path.join(SK, e.name, 'SKILL.md');
  if (!fs.existsSync(f)) continue;
  const p = parseSkillMd(f);
  const ok = p.name.length > 0 && p.title.length > 0;
  if (!ok) bad++;
  console.log(`${ok ? 'OK ' : 'BAD'} ${p.name.padEnd(34)} | ${p.title.slice(0, 36).padEnd(36)} | ${(p.brief || '').slice(0, 40).padEnd(40)} | ${(p.triggers || '').slice(0, 40)}`);
}
console.log(bad === 0 ? '\n全部解析通过' : `\n${bad} 个解析异常（fallback 到目录名仍可用）`);
