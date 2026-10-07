// ============================================================
// serialize.ts —— 导出 / 导入（数据进出的唯一通道）
// ------------------------------------------------------------
// 为什么值得单独一个文件？
// 1. 导入导出是「纯数据转换」，不涉及 chrome.* 也不涉及 DOM，
//    写成纯函数之后极易测试。
// 2. 市面上同类插件（OneTab、TheTab、Session Buddy）的导出格式各不相同，
//    把格式转换集中在这里，将来想兼容别的插件只需要改这一个文件。
// ============================================================

import type { TabGroup, TabRecord } from './types'
import { formatDateTime } from './utils'

/** 支持的三种导出格式。用联合类型限定，switch 时 TS 能帮你检查漏分支 */
export type ExportFormat = 'json' | 'html' | 'txt'

/** 生成导出文件名里的时间戳，例如 20261007-2230 */
function fileStamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  )
}

/** 生成导出文件的元信息（文件名 + MIME 类型），浏览器下载 API 需要这两样 */
export function exportMeta(format: ExportFormat): {
  filename: string
  mime: string
} {
  const stamp = fileStamp()
  switch (format) {
    case 'json':
      return { filename: `tabjar-${stamp}.json`, mime: 'application/json' }
    case 'html':
      return { filename: `tabjar-${stamp}.html`, mime: 'text/html' }
    case 'txt':
      return { filename: `tabjar-${stamp}.txt`, mime: 'text/plain' }
  }
}

// ------------------------------------------------------------
// 三种导出格式
// ------------------------------------------------------------

/** JSON 格式：完整保留所有字段，是唯一能「原样导回」的格式 */
export function toJSON(groups: TabGroup[]): string {
  // 第三个参数 2 表示缩进两格，人类可直接阅读
  return JSON.stringify({ version: 2, groups }, null, 2)
}

/**
 * 纯文本格式：一行一条「标题 | 网址」，分组之间用空行和注释行分隔。
 * 优点是任何文本编辑器都能打开，也方便直接粘贴到笔记、邮件里。
 */
export function toTXT(groups: TabGroup[]): string {
  const lines: string[] = [`# TabJar 导出 · ${formatDateTime(Date.now())}`]
  for (const group of groups) {
    lines.push('')
    lines.push(`## ${group.name}（${group.tabs.length} 个）`)
    for (const tab of group.tabs) {
      lines.push(`${tab.title} | ${tab.url}`)
    }
  }
  return lines.join('\n')
}

// HTML 转义：防止标题里的 < > & 破坏生成的网页结构
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * HTML 格式：生成一个可直接双击打开的静态网页，
 * 每条记录都是可点击的链接 —— 相当于一份离线书签。
 */
export function toHTML(groups: TabGroup[]): string {
  const sections = groups
    .map((group) => {
      const items = group.tabs
        .map(
          (tab) =>
            `      <li><a href="${escapeHtml(tab.url)}">${escapeHtml(
              tab.title,
            )}</a><span class="host">${escapeHtml(safeHost(tab.url))}</span></li>`,
        )
        .join('\n')
      return (
        `    <section>\n` +
        `      <h2>${escapeHtml(group.name)} · ${group.tabs.length} 个</h2>\n` +
        `      <ul>\n${items}\n      </ul>\n` +
        `    </section>`
      )
    })
    .join('\n')

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="UTF-8" />',
    '  <title>TabJar 导出</title>',
    '  <style>',
    '    body{font-family:system-ui,"Microsoft YaHei",sans-serif;max-width:860px;margin:0 auto;padding:32px 16px;color:#1a1a1a;}',
    '    h1{color:#cf0a2c;font-size:22px;}',
    '    section{border:1px solid #e5e8ec;border-radius:12px;padding:12px 20px;margin-bottom:16px;}',
    '    h2{font-size:14px;color:#666f7a;font-weight:normal;margin:0 0 8px;}',
    '    ul{list-style:none;padding:0;margin:0;}',
    '    li{display:flex;gap:12px;align-items:baseline;padding:6px 0;border-bottom:1px solid #f0f2f5;}',
    '    li:last-child{border-bottom:none;}',
    '    a{color:#1a4f9c;text-decoration:none;}',
    '    a:hover{text-decoration:underline;}',
    '    .host{font-size:11px;color:#99a1aa;}',
    '  </style>',
    '</head>',
    '<body>',
    `  <h1>TabJar 导出 · ${formatDateTime(Date.now())}</h1>`,
    sections,
    '</body>',
    '</html>',
  ].join('\n')
}

/** URL 解析失败时返回空字符串，避免让整个导出中断 */
function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// ------------------------------------------------------------
// 导入
// ------------------------------------------------------------

/**
 * 标题兜底（TK-907 规格第 3 条，三个解析分支统一）：
 * 非空 string 的 title → 域名（safeHost；解析失败返回 ''）→ url 本身。
 * 效果：无标题条目显示域名而非整串 URL（F-5.6），完整地址仍在 url 字段里。
 */
function fallbackTitle(title: unknown, url: string): string {
  if (typeof title === 'string' && title.length > 0) return title
  return safeHost(url) || url
}

/**
 * 把「疑似一条标签页」的原始对象洗成合法 TabRecord（TK-907）。
 * url 必须是非空 string，否则返回 null（该条丢弃）；
 * favIconUrl 仅当是 string 时才写入，保持可选字段语义。
 */
function tabFromRaw(raw: unknown): TabRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const candidate = raw as { url?: unknown; title?: unknown; favIconUrl?: unknown }
  if (typeof candidate.url !== 'string' || candidate.url.length === 0) return null
  const tab: TabRecord = {
    url: candidate.url,
    title: fallbackTitle(candidate.title, candidate.url),
  }
  if (typeof candidate.favIconUrl === 'string') tab.favIconUrl = candidate.favIconUrl
  return tab
}

/**
 * 把「疑似一个分组」的原始对象洗成合法 TabGroup（TK-907 规格第 1 条）。
 * 逐字段保留：name（空则 fallbackName）/ createdAt（非 number 则现在）/
 * starred（严格 === true）/ id（空则新 UUID）/ tabs（逐条 tabFromRaw）。
 * 无有效 tabs 时返回 null（空组不入库）。
 *
 * 注意：故意不 import storage.ts 的 sanitizeGroup —— 它未导出，
 * 导出它会扩大改动面；在本文件内独立实现即可（serialize 是纯函数层）。
 */
function groupFromRaw(raw: unknown, fallbackName: string): TabGroup | null {
  if (raw === null || typeof raw !== 'object') return null
  const candidate = raw as {
    id?: unknown
    name?: unknown
    createdAt?: unknown
    starred?: unknown
    tabs?: unknown
  }
  const tabs = Array.isArray(candidate.tabs)
    ? candidate.tabs
        .map(tabFromRaw)
        .filter((t): t is TabRecord => t !== null)
    : []
  if (tabs.length === 0) return null
  return {
    id:
      typeof candidate.id === 'string' && candidate.id.length > 0
        ? candidate.id
        : crypto.randomUUID(),
    name:
      typeof candidate.name === 'string' && candidate.name.length > 0
        ? candidate.name
        : fallbackName,
    createdAt:
      typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
    starred: candidate.starred === true,
    tabs,
  }
}

/**
 * 从一段文本解析出分组列表。
 *
 * 策略：
 * 1. 先尝试按 JSON 解析：
 *    - `{ version?, groups: [...] }`（本扩展导出格式）→ **逐组保真恢复**
 *      （组名 / 收纳时间 / 星标 / id / 页面图标全保留，TK-907 / F-5.5）；
 *    - 顶层数组（如 OneTab 式 `[{url,title}]`）→ 源数据不含分组信息，
 *      合成单个新组，但条目保留 favIconUrl；
 * 2. JSON 解析失败就退化为纯文本解析 —— 逐行找网址，每一行算一条记录；
 * 3. 两种都失败返回空数组，由调用方提示用户。
 *
 * 标题兜底三个分支统一（F-5.6）：非空 title → 域名 → url。
 */
export function parseImport(text: string): TabGroup[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []

  // ---- 尝试 JSON ----
  try {
    const parsed: unknown = JSON.parse(trimmed)
    // 顶层数组：[{url,title,favIconUrl?}, …] —— 不含分组信息，合成单组（保持原有语义）
    if (Array.isArray(parsed)) {
      const tabs = parsed
        .map(tabFromRaw)
        .filter((t): t is TabRecord => t !== null)
      return [
        {
          id: crypto.randomUUID(),
          name: `导入的数据 ${formatDateTime(Date.now())}`,
          createdAt: Date.now(),
          starred: false,
          tabs,
        },
      ]
    }
    // 形如 { version?, groups: [...] } 的对象（本扩展导出格式）：
    // 逐组 groupFromRaw 保真恢复，空组被滤掉；全部无效时返回 []
    // （调用方会提示「没有从文件里解析到任何网址」）
    if (parsed !== null && typeof parsed === 'object' && 'groups' in parsed) {
      const groups = (parsed as { groups: unknown }).groups
      if (Array.isArray(groups)) {
        return groups
          .map((g, i) => groupFromRaw(g, `导入的分组 ${i + 1}`))
          .filter((g): g is TabGroup => g !== null)
      }
    }
  } catch {
    // JSON.parse 抛错说明不是 JSON，走下面的纯文本逻辑
  }

  // ---- 退化为纯文本：逐行解析（TK-311）----
  // 正则匹配 http(s) 开头、直到空白 / 半角 ) / 分隔符为止的一串。
  // ⚠️ 字符类里必须排除全角 ｜：否则「网址｜标题」的全角分隔符会被吞进 URL，
  // URL 直接坏掉（TK-311 的隐藏 bug）
  const urlPattern = /https?:\/\/[^\s|)｜]+/g
  const seen = new Set<string>()
  const tabs: TabRecord[] = []

  // 兼容三种行格式：「标题 | 网址」（本扩展 toTXT）/「网址 | 标题」（OneTab）/
  // 纯网址行。分隔符集合：半角 |、全角 ｜、TAB。
  for (const line of trimmed.split('\n')) {
    const matches = [...line.matchAll(urlPattern)]
    if (matches.length === 0) continue

    // 仅当整行只有 1 个 URL 时才做左右标题提取（TK-311 规格第 2 条）
    if (matches.length === 1) {
      const [match] = matches
      const url = match[0]
      const key = url.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)

      // a. URL 左侧文字（去掉尾部分隔符后非空）→ 标题（「标题 | 网址」，回归不变）
      //    标题本身可含 |：只剥紧贴 URL 的最后一个分隔符，其余整段保留
      const left = line
        .slice(0, match.index ?? 0)
        .trim()
        .replace(/[|｜\t]\s*$/, '')
        .trim()
      // b. 左侧没有才看右侧（去掉首部分隔符后非空）→ 标题（「网址 | 标题」，OneTab）
      const right = line
        .slice((match.index ?? 0) + url.length)
        .trim()
        .replace(/^[|｜\t]\s*/, '')
        .trim()
      // c. 两侧都没有 → 兜底：域名（F-5.6），域名解析失败才是 url 本身
      tabs.push({ url, title: left || right || safeHost(url) || url })
      continue
    }

    // 一行多 URL：各算一条，标题一律走兜底。
    // （顺带修掉旧实现里第二个 URL 的 before 会包含第一个 URL 的边缘 bug）
    for (const match of matches) {
      const url = match[0]
      const key = url.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      tabs.push({ url, title: safeHost(url) || url })
    }
  }

  if (tabs.length === 0) return []
  return [
    {
      id: crypto.randomUUID(),
      name: `导入的链接 ${formatDateTime(Date.now())}`,
      createdAt: Date.now(),
      starred: false,
      tabs,
    },
  ]
}
