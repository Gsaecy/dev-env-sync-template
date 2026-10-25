/** 技能中文显示映射（name → 中文标题 ≤15 字 + 中文描述 ≤50 字） */
export interface ZhInfo {
  title: string;
  desc: string;
}

export const SKILL_ZH: Record<string, ZhInfo> = {
  '3d-chladni-render': { title: '3D克拉尼粒子动画', desc: '按音频生成克拉尼粒子律动视频（MP4/透明MOV）' },
  'apple-app-dev-experience': { title: '苹果开发经验库', desc: 'SafeVault/MaiKer 排障经验：扫码、TOTP、弹窗、审核等 38 条' },
  'apple-appstore-rules': { title: 'App Store规则手册', desc: '官方审核指南五大章、取名与商标规则速查' },
  'apple-appstore-submission-checklist': { title: '上架检查清单', desc: '提审前逐项自查：AI 自动诊断 + 用户勾选，全过才提交' },
  'awesome-design-md': { title: '网站设计系统库', desc: '74 套真实网站 DESIGN.md 配色排版规范，供 UI 参考' },
  'brand-launch-video-star': { title: '品牌发布视频', desc: '快速生成 15-30 秒产品营销与发布宣传视频' },
  'claude-typer': { title: 'Claude打字动画', desc: '提示词打字机动画视频渲染' },
  'disney-animation-rule-skill': { title: '迪士尼动画原则', desc: '12 原则落地为代码动画的设计与审查规则' },
  'follow-up-actions': { title: '用户待办提醒', desc: '任务收尾明确列出需要用户亲手做的操作' },
  'gpt-image-2-style-library': { title: 'GPT生图风格库', desc: 'GPT-Image2 提示词模板、风格与场景选择' },
  'light-spotlight-render': { title: '聚光灯扫字动画', desc: '生成聚光灯文字揭示 HTML 动画' },
  'mac-appstore-submission': { title: 'Mac上架手册', desc: 'MAS 打包签名、Transporter 交付与 ASC 填写实操' },
  originkit: { title: '网页特效组件库', desc: '50 个免费网页动画组件，可检索并拉取源码' },
  pixel2motion: { title: 'Logo动画化', desc: '位图 Logo 转 SVG 并编排开场动画（HTML 交付）' },
  'printed-curtain-render': { title: '线帘幕布模拟', desc: '把图片织入可动线帘的浏览器交互模拟' },
  'procedural-fish-render': { title: '程序鱼动画', desc: '渲染程序化鱼群动画视频' },
  'project-doc-sync': { title: '项目文档同步', desc: '代码改动后自动同步 README 与技术文档' },
  'remotion-3d-ticker': { title: '3D滚动墙动画', desc: 'Remotion 无限 3D 图片滚动墙/瀑布流' },
  'remotion-candlestick': { title: 'K线图动画', desc: 'Remotion 金融蜡烛图数据动画' },
  'remotion-vinyl-player': { title: '黑胶播放器动画', desc: 'Remotion 黑胶唱片播放器组件' },
  'ruler-progress-render': { title: '尺子进度动画', desc: '渲染尺子进度条演示视频' },
  'skill-web-installer': { title: '联网装技能', desc: '搜索开源技能库并安装缺失的新技能' },
  'svg-assembly-animator': { title: 'SVG组装动画', desc: '零件组装动效并导出透明序列帧' },
  'text-to-lottie': { title: '文本转Lottie', desc: '文字描述生成 Lottie 动画 JSON（带校验）' },
  'third-strike-web-search': { title: '三连败联网排查', desc: '同一问题失败 3 次强制联网搜索方案' },
  'threejs-earth-render': { title: '地球航线动画', desc: 'Three.js 3D 地球飞线动画视频渲染' },
  'web-3d-effects': { title: '网页3D特效', desc: '为网站添加流畅 3D 背景、粒子与视差效果' },
  'wechat-2d-render': { title: '微信聊天动画', desc: 'Remotion 微信风格聊天动效视频' },
};

/** 第三方技能名单（联网安装/社区来源，锁定不可编辑名称与描述）。
 *  未收录且无安装日志记录、无外部来源线索的技能视为自建，可编辑。 */
export const THIRD_PARTY_SKILLS: Set<string> = new Set([
  '3d-chladni-render', // github.com/nolangz/3D-Chladni
  'awesome-design-md', // VoltAgent/awesome-design-md
  'brand-launch-video-star', // vibe-motion 社区
  'claude-typer', // Remotion CLI 远程渲染
  'disney-animation-rule-skill',
  'gpt-image-2-style-library', // awesome-gpt-image-2
  'light-spotlight-render',
  'originkit', // originkit.dev
  'pixel2motion',
  'printed-curtain-render',
  'procedural-fish-render', // github.com/vibe-motion/procedural-fish
  'remotion-3d-ticker',
  'remotion-candlestick',
  'remotion-vinyl-player',
  'ruler-progress-render', // github.com/sxhzju/ruler-progress-animator
  'svg-assembly-animator',
  'text-to-lottie',
  'threejs-earth-render', // github.com/vibe-motion/threejs-earth
  'wechat-2d-render', // github.com/sxhzju/wechat-2d
]);

/** 技能分类（完善的分类规范），未收录的技能自动归入「未分类」 */
export const CATEGORY_ORDER: { id: string; title: string }[] = [
  { id: 'execution', title: '项目执行规范' },
  { id: 'ui', title: 'UI 优化与设计' },
  { id: 'animation', title: '动画与视频渲染' },
  { id: 'appstore', title: '上架与审核规范' },
  { id: 'apple-dev', title: '苹果开发经验' },
  { id: 'misc', title: '未分类' },
];

export const SKILL_CATEGORY: Record<string, string> = {
  // 项目执行规范
  'project-doc-sync': 'execution',
  'follow-up-actions': 'execution',
  'third-strike-web-search': 'execution',
  'skill-web-installer': 'execution',
  // UI 优化与设计
  'awesome-design-md': 'ui',
  'web-3d-effects': 'ui',
  originkit: 'ui',
  'disney-animation-rule-skill': 'ui',
  'gpt-image-2-style-library': 'ui',
  'text-to-lottie': 'ui',
  'light-spotlight-render': 'ui',
  // 动画与视频渲染
  '3d-chladni-render': 'animation',
  'brand-launch-video-star': 'animation',
  'claude-typer': 'animation',
  pixel2motion: 'animation',
  'printed-curtain-render': 'animation',
  'procedural-fish-render': 'animation',
  'remotion-3d-ticker': 'animation',
  'remotion-candlestick': 'animation',
  'remotion-vinyl-player': 'animation',
  'ruler-progress-render': 'animation',
  'svg-assembly-animator': 'animation',
  'threejs-earth-render': 'animation',
  'wechat-2d-render': 'animation',
  // 上架与审核规范
  'apple-appstore-rules': 'appstore',
  'apple-appstore-submission-checklist': 'appstore',
  'mac-appstore-submission': 'appstore',
  // 苹果开发经验
  'apple-app-dev-experience': 'apple-dev',
};

export function categoryOf(name: string): string {
  return SKILL_CATEGORY[name] || 'misc';
}

/** 兜底分类：未归属任何分类的技能都放这里 */
export const MISC_CATEGORY_ID = 'misc';
export const MISC_CATEGORY_TITLE = '未分类';

export interface CategoryDef {
  id: string;
  title: string;
  /** 用户自建分类（可删除）；内置分类只能改名 */
  custom?: boolean;
}

/**
 * 组装最终分类列表：内置分类（可改名）→ 自建分类 → 未分类（永远最后）。
 * 空标题回退默认名，保证面板不会出现没有名字的分类。
 */
export function buildCategoryList(
  titles: Record<string, string>,
  custom: { id: string; title: string }[],
): CategoryDef[] {
  const out: CategoryDef[] = [];
  for (const c of CATEGORY_ORDER) {
    if (c.id === MISC_CATEGORY_ID) { continue; }
    out.push({ id: c.id, title: (titles[c.id] ?? '').trim() || c.title });
  }
  for (const c of custom) {
    if (!c.id || out.some((x) => x.id === c.id)) { continue; }
    out.push({ id: c.id, title: (c.title ?? '').trim() || '新分类', custom: true });
  }
  out.push({
    id: MISC_CATEGORY_ID,
    title: (titles[MISC_CATEGORY_ID] ?? '').trim() || MISC_CATEGORY_TITLE,
  });
  return out;
}

/** 技能所属分类：手动指定优先，其次内置映射，最后未分类；指向已删除分类时回退未分类 */
export function resolveCategory(
  name: string,
  override: string | undefined,
  validIds: Set<string>,
): string {
  if (override && validIds.has(override)) { return override; }
  const builtin = categoryOf(name);
  return validIds.has(builtin) ? builtin : MISC_CATEGORY_ID;
}
