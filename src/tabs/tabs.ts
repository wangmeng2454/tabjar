// ============================================================
// tabs.ts —— 汇总页逻辑（运行在扩展自己的页面里）
// ------------------------------------------------------------
// 这个页面和普通网页几乎一样，但多了 chrome.* API 的权限。
// 常见套路：
//   1. 读 storage 拿数据 → 2. 用数据生成 DOM（render）→
//   3. 用户操作 → 4. 改数据 → 5. 落盘（persist）→ 回到 2 重渲染
//
// 本版本在 1.0 基础上增加了：搜索、重命名、星标置顶、
// 批量选择、导入导出、撤销收纳、深色主题。
// ============================================================

import { $, downloadText, el } from '../dom'
import {
  clearUndo,
  loadCollapsed,
  loadGroups,
  loadSettings,
  loadUndo,
  onStorageChanged,
  saveCollapsed,
  saveGroups,
  saveSettings,
} from '../storage'
import {
  exportMeta,
  parseImport,
  toHTML,
  toJSON,
  toTXT,
  type ExportFormat,
} from '../serialize'
import type { Settings, TabGroup, TabRecord, UndoSnapshot } from '../types'
import {
  estimateMemorySaved,
  formatBytes,
  formatDateTime,
  formatGroupName,
  hostOf,
  initialOf,
} from '../utils'

// ------------------------------------------------------------
// 0. 拿到页面里的关键元素（对应 tabs.html 里的 id）
// ------------------------------------------------------------
const listEl = $('list')
const summaryEl = $('summary')
const emptyEl = $<HTMLParagraphElement>('empty')
const searchEl = $<HTMLInputElement>('search')
const undoBtn = $<HTMLButtonElement>('btn-undo')
const bulkBar = $<HTMLDivElement>('bulk-bar')
const bulkCount = $('bulk-count')
const settingsPanel = $<HTMLElement>('settings-panel')
const exportMenu = $<HTMLElement>('export-menu')
const fileInput = $<HTMLInputElement>('file-input')

// ------------------------------------------------------------
// 1. 页面状态（内存里的「唯一数据源」）
// ------------------------------------------------------------
/** 所有分组。页面上的每一块 DOM 都由它推导出来 */
let groups: TabGroup[] = []
let settings: Settings
/** 撤销快照；为 null 表示当前没有可撤销的操作 */
let undoSnapshot: UndoSnapshot | null = null
/** 搜索关键词（始终以小写形式保存，方便做忽略大小写比较） */
let query = ''

/**
 * 折叠中的分组 id 集合（TK-212）。
 * 界面偏好而非数据：持久化在独立的 collapsed 键（ADR-09），
 * 绝不写进 TabGroup（会污染导出 JSON）或 Settings。
 */
let collapsed = new Set<string>()

/**
 * 批量选中的条目集合。
 *
 * Set<string> 的元素形如 "分组id::下标"，例如 "abc-123::4"。
 * 用 Set 而不是数组，是因为 add/has/delete 都是 O(1)，
 * 且天然不会出现重复选中。
 */
const selected = new Set<string>()

/** 把「分组 id + 下标」拼成一个选中项的键 */
function keyOf(groupId: string, index: number): string {
  return `${groupId}::${index}`
}

/** 从键里拆回「分组 id + 下标」（lastIndexOf 找最后一个分隔符，最稳妥） */
function parseKey(key: string): { groupId: string; index: number } {
  const sep = key.lastIndexOf('::')
  return {
    groupId: key.slice(0, sep),
    index: Number(key.slice(sep + 2)),
  }
}

// ------------------------------------------------------------
// 2. 主题（浅色 / 深色 / 跟随系统）
// ------------------------------------------------------------
/** MediaQueryList 用来监听「系统是否处于深色模式」 */
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

/** 根据设置把 <html data-theme="..."> 改成对应值，CSS 会跟着切换 */
function applyTheme(): void {
  const mode =
    settings.theme === 'auto'
      ? darkQuery.matches
        ? 'dark'
        : 'light'
      : settings.theme
  document.documentElement.dataset.theme = mode
}

// 系统主题切换时实时响应（只有设置成 auto 时才需要理会）
darkQuery.addEventListener('change', () => {
  if (settings.theme === 'auto') applyTheme()
})

// ------------------------------------------------------------
// 3. 数据落盘与重新渲染
// ------------------------------------------------------------
/** 让工具栏图标上的数字徽标和列表保持一致 */
async function syncBadge(): Promise<void> {
  const total = groups.reduce((sum, g) => sum + g.tabs.length, 0)
  await chrome.action.setBadgeText({ text: total > 0 ? String(total) : '' })
  await chrome.action.setBadgeBackgroundColor({ color: '#cf0a2c' })
}

/** 每个数据操作的最后一步：写存储 → 同步徽标 → 重绘界面 */
async function persist(): Promise<void> {
  await saveGroups(groups)
  // 孤儿清理（TK-212）：分组会被删除 / 恢复 / 移组 / 清空，
  // collapsed 里对应 id 必须跟着消失，否则永远留在存储里
  const alive = new Set(groups.map((g) => g.id))
  const next = [...collapsed].filter((id) => alive.has(id))
  if (next.length !== collapsed.size) {
    collapsed = new Set(next)
    await saveCollapsed(next)
  }
  await syncBadge()
  render()
}

// ------------------------------------------------------------
// 4. 搜索过滤
// ------------------------------------------------------------
/**
 * 计算某个分组在当前搜索词下「应该显示哪些下标」。
 * 返回 null 表示整个分组都不显示。
 *
 * 规则：
 *  · 没有关键词 → 显示全部
 *  · 有标签页命中 → 只显示命中的那些
 *  · 没有标签页命中但分组名命中 → 显示全部
 *  · 都不命中 → 整组隐藏
 */
function visibleIndices(group: TabGroup, keyword: string): number[] | null {
  if (keyword.length === 0) return group.tabs.map((_, i) => i)

  const nameHit = group.name.toLowerCase().includes(keyword)
  const hits: number[] = []
  group.tabs.forEach((tab, i) => {
    const inTitle = tab.title.toLowerCase().includes(keyword)
    const inUrl = tab.url.toLowerCase().includes(keyword)
    if (inTitle || inUrl) hits.push(i)
  })

  if (hits.length > 0) return hits
  if (nameHit) return group.tabs.map((_, i) => i)
  return null
}

// ------------------------------------------------------------
// 5. 渲染
// ------------------------------------------------------------
/** 渲染整个列表。搜索时只渲染命中的部分 */
function render(): void {
  listEl.textContent = ''
  const keyword = query.trim().toLowerCase()

  // 先算好每一组要显示的下标，再统一渲染
  type Visible = { group: TabGroup; indices: number[] }
  const visible: Visible[] = []
  for (const group of groups) {
    const indices = visibleIndices(group, keyword)
    if (indices !== null) visible.push({ group, indices })
  }

  const totalCount = groups.reduce((n, g) => n + g.tabs.length, 0)
  const visibleCount = visible.reduce((n, v) => n + v.indices.length, 0)

  if (keyword.length > 0) {
    summaryEl.textContent = `匹配 ${visible.length} 组 / ${visibleCount} 条（共 ${totalCount} 条）`
  } else {
    const memory = formatBytes(estimateMemorySaved(totalCount))
    summaryEl.textContent = `${groups.length} 组 · ${totalCount} 个标签页 · 约可释放 ${memory}`
  }

  // 一个标签页都没有才显示「空状态」；搜索无结果单独提示
  emptyEl.hidden = totalCount > 0 || keyword.length > 0

  if (visible.length === 0 && keyword.length > 0) {
    listEl.appendChild(el('p', { className: 'search-empty', text: '没有匹配的标签页。' }))
    return
  }

  for (const { group, indices } of visible) {
    listEl.appendChild(renderGroup(group, indices))
  }
}

/** 没有真图标时的占位块：域名的首字母 */
function renderFavicon(tab: TabRecord): HTMLElement {
  if (tab.favIconUrl) {
    const img = el('img', { className: 'favicon' }) as HTMLImageElement
    img.src = tab.favIconUrl
    img.alt = ''
    // 图标地址可能已失效，加载失败就换成字母占位块
    img.addEventListener('error', () => {
      img.replaceWith(el('span', { className: 'favicon-fallback', text: initialOf(tab.url) }))
    })
    return img
  }
  return el('span', { className: 'favicon-fallback', text: initialOf(tab.url) })
}

/** 生成一个分组的完整 DOM。indices 是「这一组里要显示的下标」 */
function renderGroup(group: TabGroup, indices: number[]): HTMLElement {
  // 搜索态强制展开（TK-212 关键边界）：否则「搜到了却看不见」会被当成 bug。
  // 清空搜索后 collapsed 未被改动，自然恢复原折叠状态
  const forceExpand = query.trim().length > 0
  const isCollapsed = collapsed.has(group.id) && !forceExpand

  const box = el('section', {
    className: `${group.starred ? 'group starred' : 'group'}${isCollapsed ? ' collapsed' : ''}`,
  })

  // ---- 分组头 ----
  const head = el('div', { className: 'group-head' })

  // 折叠开关（放最左是刻意选择：分组名已被「重命名」、复选框已被「全选」占用）
  const caret = el('button', {
    className: 'caret',
    text: isCollapsed ? '▸' : '▾',
    title: isCollapsed ? '展开本组' : '折叠本组',
  })
  // 无障碍：aria-expanded 与箭头方向同步（展开 = true）
  caret.setAttribute('aria-expanded', String(!isCollapsed))
  caret.addEventListener('click', async () => {
    if (collapsed.has(group.id)) collapsed.delete(group.id)
    else collapsed.add(group.id)
    // 只改界面偏好：不动 groups、不清 selected —— 折叠不能打断用户勾选
    await saveCollapsed([...collapsed])
    render()
  })

  // 全选本组的复选框（折叠不影响范围：indices 始终是组内全部条目，
  // 折叠只是「不渲染」，绝不能改成只作用于可见项）
  const groupCheck = el('input', { type: 'checkbox', title: '全选本组' }) as HTMLInputElement
  groupCheck.checked = indices.every((i) => selected.has(keyOf(group.id, i)))
  groupCheck.addEventListener('change', () => {
    for (const i of indices) {
      const key = keyOf(group.id, i)
      if (groupCheck.checked) selected.add(key)
      else selected.delete(key)
    }
    updateBulkBar()
    render()
  })

  // 星标按钮：★ 已星标 / ☆ 未星标
  const starBtn = el('button', {
    className: group.starred ? 'star on' : 'star',
    text: group.starred ? '★' : '☆',
    title: group.starred ? '取消星标' : '星标并置顶',
  })
  starBtn.addEventListener('click', async () => {
    group.starred = !group.starred
    // 重新排序：星标的排前面，同级之间按收纳时间从新到旧
    groups.sort((a, b) => {
      if (a.starred !== b.starred) return a.starred ? -1 : 1
      return b.createdAt - a.createdAt
    })
    await persist()
  })

  // 分组名：点击进入编辑状态
  const nameEl = el('span', {
    className: 'group-name',
    text: group.name,
    title: '点击重命名',
  })
  nameEl.addEventListener('click', () => startRename(group, nameEl))

  const meta = el('span', {
    text: `${formatDateTime(group.createdAt)} · ${group.tabs.length} 个`,
  })
  const spacer = el('span', { className: 'spacer' })

  // 恢复整组 / 删除整组
  const restoreBtn = el('button', { className: 'ghost', text: '恢复整组' })
  restoreBtn.addEventListener('click', () => void restoreGroup(group))

  const deleteBtn = el('button', { className: 'ghost danger', text: '删除' })
  deleteBtn.addEventListener('click', () => void deleteGroup(group.id))

  // 恢复/删除按钮装进 .btns 容器（对应 tabs.css 的紧凑小按钮样式，O-2）
  const btns = el('span', { className: 'btns' }, restoreBtn, deleteBtn)
  head.append(caret, groupCheck, starBtn, nameEl, meta, spacer, btns)
  box.appendChild(head)

  // ---- 每个标签页一行（折叠即不渲染）----
  // render() 是全量重建：不生成 .item DOM 比生成后再置 hidden 更省，
  // 且天然绕开 display:flex 与 [hidden] 的层叠优先级坑（TK-906）
  if (!isCollapsed) {
    for (const index of indices) {
      box.appendChild(renderItem(group, index))
    }
  }
  return box
}

/** 生成单条标签页那一行 */
function renderItem(group: TabGroup, index: number): HTMLElement {
  const tab = group.tabs[index]
  const key = keyOf(group.id, index)

  const item = el('div', { className: selected.has(key) ? 'item checked' : 'item' })

  // 选中框
  const check = el('input', { type: 'checkbox' }) as HTMLInputElement
  check.checked = selected.has(key)
  check.title = '选中以便批量操作'
  check.addEventListener('click', (e) => {
    // 阻止事件冒泡，避免触发整行的点击行为
    e.stopPropagation()
  })
  check.addEventListener('change', () => {
    if (check.checked) selected.add(key)
    else selected.delete(key)
    item.classList.toggle('checked', check.checked)
    updateBulkBar()
  })

  // 图标 + 域名小标签 + 标题链接
  const favicon = renderFavicon(tab)
  const host = el('span', { className: 'host', text: hostOf(tab.url) ?? '本地' })
  const link = el('a', { className: 'link', text: tab.title, title: tab.title })
  link.href = tab.url
  // 拦截浏览器默认跳转，改用 chrome.tabs.create 打开（对特殊页面兼容性更好）
  link.addEventListener('click', (e) => {
    e.preventDefault()
    void restoreOne(group.id, index)
  })

  const del = el('button', { className: 'del', text: '×', title: '从列表移除' })
  del.addEventListener('click', (e) => {
    e.stopPropagation()
    void removeOne(group.id, index)
  })

  item.append(check, favicon, host, link, del)
  return item
}

// ------------------------------------------------------------
// 6. 分组级操作
// ------------------------------------------------------------

/** 在分组名上原地出现一个输入框，回车或失焦保存，Esc 放弃 */
function startRename(group: TabGroup, nameEl: HTMLElement): void {
  const input = el('input', { value: group.name }) as HTMLInputElement
  nameEl.textContent = ''
  nameEl.appendChild(input)
  input.focus()
  input.select()

  // 「是否已经结束」标记：防止 blur 在 DOM 被替换后又触发一次 commit
  let finished = false
  const commit = async (): Promise<void> => {
    if (finished) return
    finished = true
    const next = input.value.trim()
    // 输入空白时回退到默认名，避免出现空名字
    group.name = next.length > 0 ? next : formatGroupName(group.createdAt)
    await persist()
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void commit()
    if (e.key === 'Escape') {
      finished = true
      render()
    }
  })
  input.addEventListener('blur', () => void commit())
}

/** 恢复整组：按设置决定开在当前窗口还是新窗口，然后移除该分组 */
async function restoreGroup(group: TabGroup): Promise<void> {
  if (settings.openInNewWindow) {
    // chrome.windows.create 的 url 参数可以直接接收数组 ——
    // 一次调用就能开出一个带多个标签页的新窗口
    await chrome.windows.create({ url: group.tabs.map((t) => t.url) })
  } else {
    // 逐个 await 保证按原顺序打开
    for (const tab of group.tabs) {
      await chrome.tabs.create({ url: tab.url })
    }
  }
  groups = groups.filter((g) => g.id !== group.id)
  await persist()
  // 恢复的正是快照对应的分组时，撤销已无意义（重复恢复同一批页面）
  if (undoSnapshot?.group.id === group.id) await invalidateUndo()
}

/** 删除整组（页面保持关闭状态） */
async function deleteGroup(groupId: string): Promise<void> {
  groups = groups.filter((g) => g.id !== groupId)
  // 顺便清掉和这个分组相关的选中项，避免留下悬空引用
  for (const key of [...selected]) {
    if (parseKey(key).groupId === groupId) selected.delete(key)
  }
  updateBulkBar()
  await persist()
  // 删掉的正是快照对应的分组时，撤销已无意义
  if (undoSnapshot?.group.id === groupId) await invalidateUndo()
}

// ------------------------------------------------------------
// 7. 单条操作
// ------------------------------------------------------------

/** 恢复单个标签页：新开页面 + 从列表里删掉这条记录 */
async function restoreOne(groupId: string, index: number): Promise<void> {
  const group = groups.find((g) => g.id === groupId)
  if (!group) return // 防御：分组已不存在就直接退出

  // splice(位置, 删除几个)：从数组中删除并返回被删的元素数组
  const [tab] = group.tabs.splice(index, 1)
  if (tab) await chrome.tabs.create({ url: tab.url })
  // 整组删空了就把这组也移除，避免页面留一个空壳分组
  if (group.tabs.length === 0) await deleteGroup(group.id)
  else await persist()
}

/** 仅从列表移除一条（不打开页面） */
async function removeOne(groupId: string, index: number): Promise<void> {
  const group = groups.find((g) => g.id === groupId)
  if (!group) return
  group.tabs.splice(index, 1)
  if (group.tabs.length === 0) await deleteGroup(group.id)
  else await persist()
}

// ------------------------------------------------------------
// 8. 批量操作
// ------------------------------------------------------------

/** 刷新底部批量操作栏的显示与文案 */
function updateBulkBar(): void {
  bulkBar.hidden = selected.size === 0
  bulkCount.textContent = `已选 ${selected.size} 项`
}

/**
 * 把选中项按分组归拢成 Map<分组id, 下标数组>。
 * 每组的下标按「从大到小」排序 —— 这样 splice 删除时
 * 先删后面的，前面元素的下标才不会错位。
 */
function selectionByGroup(): Map<string, number[]> {
  const map = new Map<string, number[]>()
  for (const key of selected) {
    const { groupId, index } = parseKey(key)
    const list = map.get(groupId) ?? []
    list.push(index)
    map.set(groupId, list)
  }
  for (const list of map.values()) list.sort((a, b) => b - a)
  return map
}

/** 清空选中状态（每个批量操作结束都要调） */
function clearSelection(): void {
  selected.clear()
  updateBulkBar()
}

/** 恢复所有选中的标签页 */
async function restoreSelected(): Promise<void> {
  const byGroup = selectionByGroup()
  const toOpen: TabRecord[] = []
  for (const [groupId, indices] of byGroup) {
    const group = groups.find((g) => g.id === groupId)
    if (!group) continue
    for (const index of indices) toOpen.push(group.tabs[index])
  }
  // 已知限制（O-1）：批量恢复固定在当前窗口打开，
  // 不遵循 settings.openInNewWindow，与 TK-302/303 行为不同
  for (const tab of toOpen) {
    await chrome.tabs.create({ url: tab.url })
  }
  // 列表清理直接复用「删除所选」
  await deleteSelected()
}

/** 把选中的条目从各自分组里抽出来，合并成一个新分组放在最上面 */
async function moveSelectedToNewGroup(): Promise<void> {
  const byGroup = selectionByGroup()
  const collected: TabRecord[] = []

  // 第一遍：先把记录取出来
  for (const [groupId, indices] of byGroup) {
    const group = groups.find((g) => g.id === groupId)
    if (!group) continue
    for (const index of indices) collected.push(group.tabs[index])
  }
  if (collected.length === 0) return

  // 第二遍：再从原分组里删掉
  for (const [groupId, indices] of byGroup) {
    const gi = groups.findIndex((g) => g.id === groupId)
    if (gi === -1) continue
    const group = groups[gi]
    for (const index of indices) group.tabs.splice(index, 1)
    if (group.tabs.length === 0) groups.splice(gi, 1)
  }

  const newGroup: TabGroup = {
    id: crypto.randomUUID(),
    name: formatGroupName(Date.now()),
    createdAt: Date.now(),
    starred: false,
    tabs: collected,
  }
  // 插到第一个非星标分组之前，保证星标分组仍然在最上面
  const firstUnstarred = groups.findIndex((g) => !g.starred)
  if (firstUnstarred === -1) groups.push(newGroup)
  else groups.splice(firstUnstarred, 0, newGroup)

  clearSelection()
  await persist()
}

/** 删除所有选中的条目 */
async function deleteSelected(): Promise<void> {
  for (const [groupId, indices] of selectionByGroup()) {
    const gi = groups.findIndex((g) => g.id === groupId)
    if (gi === -1) continue
    const group = groups[gi]
    for (const index of indices) group.tabs.splice(index, 1)
    if (group.tabs.length === 0) groups.splice(gi, 1)
  }
  clearSelection()
  await persist()
}

// ------------------------------------------------------------
// 9. 全局操作
// ------------------------------------------------------------

/**
 * 作废撤销快照（TK-905）。
 * 统一规则：任何使「撤销上次收纳」失去意义的操作（全部恢复、
 * 恢复/删除了快照对应的那个分组），都必须调用本函数，
 * 否则撤销按钮仍在，点了会把同一批页面重复打开一次。
 */
async function invalidateUndo(): Promise<void> {
  undoSnapshot = null
  await clearUndo()
  undoBtn.hidden = true
}

/** 全部恢复：所有分组的所有标签页一次打开 */
async function restoreAll(): Promise<void> {
  const all = groups.flatMap((g) => g.tabs)
  if (all.length === 0) return
  if (settings.openInNewWindow) {
    await chrome.windows.create({ url: all.map((t) => t.url) })
  } else {
    for (const tab of all) await chrome.tabs.create({ url: tab.url })
  }
  groups = []
  await persist()
  // 快照对应的分组也一并恢复了，撤销失去意义
  await invalidateUndo()
}

/** 撤销上次收纳：把快照里的标签页放回原窗口，并删掉那个分组 */
async function undoLast(): Promise<void> {
  if (!undoSnapshot) return
  const snapshot = undoSnapshot
  // 原窗口可能已被关掉，此时退化为开在「当前窗口」
  // WINDOW_ID_CURRENT 是 chrome 约定的特殊值（-2），表示当前窗口
  const windowId = snapshot.windowId ?? chrome.windows.WINDOW_ID_CURRENT
  for (const tab of snapshot.group.tabs) {
    await chrome.tabs.create({ url: tab.url, windowId })
  }
  groups = groups.filter((g) => g.id !== snapshot.group.id)
  undoSnapshot = null
  await clearUndo()
  await persist()
  undoBtn.hidden = true
}

/** 清空整个列表（有二次确认） */
async function clearAll(): Promise<void> {
  // confirm 是浏览器原生确认框，用户点「取消」返回 false
  if (!confirm('确定清空所有已收纳的标签页吗？此操作不可撤销。')) return
  groups = []
  undoSnapshot = null
  await clearUndo()
  await persist()
  undoBtn.hidden = true
}

// ------------------------------------------------------------
// 10. 导出 / 导入
// ------------------------------------------------------------

/** 按指定格式导出当前列表 */
function exportAs(format: ExportFormat): void {
  const content =
    format === 'json' ? toJSON(groups) : format === 'html' ? toHTML(groups) : toTXT(groups)
  const meta = exportMeta(format)
  downloadText(content, meta.filename, meta.mime)
  exportMenu.hidden = true
}

/** 用户在文件选择框里选完文件后走这里 */
async function handleImportFile(): Promise<void> {
  // files 是 FileList | null，「?.」安全取第一个
  const file = fileInput.files?.[0]
  if (!file) return
  const text = await file.text()
  const imported = parseImport(text)
  if (imported.length === 0) {
    alert('没有从文件里解析到任何网址。支持本扩展导出的 JSON，或包含链接的纯文本。')
    return
  }
  groups = [...imported, ...groups]
  await persist()
  // 清空 value，这样下次选择同一个文件也能再次触发 change 事件
  fileInput.value = ''
}

// ------------------------------------------------------------
// 11. 事件绑定区
// ------------------------------------------------------------

// 顶部全局按钮
// ⚠️ id 必须与 tabs.html 逐字一致（TK-902 历史缺陷：
// 曾写成 'restore-all'/'clear-all'，$() 返回 null 导致整页失效）
$('btn-restore-all').addEventListener('click', () => void restoreAll())
$('btn-clear-all').addEventListener('click', () => void clearAll())
undoBtn.addEventListener('click', () => void undoLast())

// 设置 / 导出菜单的开合（二者互斥）
const btnExport = $<HTMLButtonElement>('btn-export')
const btnSettings = $<HTMLButtonElement>('btn-settings')
btnExport.addEventListener('click', () => {
  settingsPanel.hidden = true
  exportMenu.hidden = !exportMenu.hidden
})
btnSettings.addEventListener('click', () => {
  exportMenu.hidden = true
  settingsPanel.hidden = !settingsPanel.hidden
})

// 点击页面其它位置时收起两个浮层
document.addEventListener('click', (e) => {
  const target = e.target as Node
  if (!settingsPanel.hidden && !settingsPanel.contains(target) && !btnSettings.contains(target)) {
    settingsPanel.hidden = true
  }
  if (!exportMenu.hidden && !exportMenu.contains(target) && !btnExport.contains(target)) {
    exportMenu.hidden = true
  }
})

// 导出格式菜单里的三个按钮
for (const button of exportMenu.querySelectorAll('button[data-fmt]')) {
  button.addEventListener('click', () => {
    // dataset 里拿到的值是 string，需要收窄成 ExportFormat 联合类型
    const value = (button as HTMLElement).dataset.fmt
    if (value === 'json' || value === 'html' || value === 'txt') exportAs(value)
  })
}

// 导入
$('btn-import').addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', () => void handleImportFile())

// 批量操作栏
$('bulk-restore').addEventListener('click', () => void restoreSelected())
$('bulk-move').addEventListener('click', () => void moveSelectedToNewGroup())
$('bulk-delete').addEventListener('click', () => void deleteSelected())
$('bulk-cancel').addEventListener('click', () => {
  clearSelection()
  render()
})

// 搜索框：input 事件在每次按键时触发，实现「边打字边过滤」
searchEl.addEventListener('input', () => {
  query = searchEl.value
  render()
})

// 设置面板里的控件
const optDedupe = $<HTMLInputElement>('opt-dedupe')
const optPinned = $<HTMLInputElement>('opt-pinned')
const optNewWin = $<HTMLInputElement>('opt-newwin')
const optTheme = $<HTMLSelectElement>('opt-theme')

function bindSettingsControls(): void {
  optDedupe.checked = settings.dedupe
  optPinned.checked = settings.excludePinned
  optNewWin.checked = settings.openInNewWindow
  optTheme.value = settings.theme

  optDedupe.addEventListener('change', async () => {
    settings.dedupe = optDedupe.checked
    await saveSettings(settings)
  })
  optPinned.addEventListener('change', async () => {
    settings.excludePinned = optPinned.checked
    await saveSettings(settings)
  })
  optNewWin.addEventListener('change', async () => {
    settings.openInNewWindow = optNewWin.checked
    await saveSettings(settings)
  })
  optTheme.addEventListener('change', async () => {
    const value = optTheme.value
    // 收窄成联合类型：只有这三个值是合法的
    settings.theme = value === 'light' || value === 'dark' ? value : 'auto'
    await saveSettings(settings)
    applyTheme()
  })
}

// ------------------------------------------------------------
// 13. 监听存储变更，实时刷新
// ------------------------------------------------------------
// 列表页可能早已打开：收纳时 Service Worker 只是聚焦这个已有页面，
// 不会重新加载，新分组也就不会出现。这里监听 chrome.storage.onChanged，
// 数据被外部（SW / 其它页面）改动后重读并重绘。
onStorageChanged(() => {
  void (async () => {
    const nextGroups = await loadGroups()
    const nextUndo = await loadUndo()
    const nextCollapsed = await loadCollapsed()
    const groupsChanged =
      JSON.stringify(nextGroups) !== JSON.stringify(groups)
    const undoChanged =
      JSON.stringify(nextUndo) !== JSON.stringify(undoSnapshot)
    // 折叠状态也要比对：否则另一个列表页折叠了、本页不会跟随（TK-212）
    const collapsedChanged =
      JSON.stringify(nextCollapsed) !== JSON.stringify([...collapsed])

    // 本页面自己的写入也会触发 onChanged —— 数据没变就跳过，
    // 避免无谓重绘、清掉用户正在进行的勾选
    if (!groupsChanged && !undoChanged && !collapsedChanged) return

    groups = nextGroups
    undoSnapshot = nextUndo
    collapsed = new Set(nextCollapsed)
    undoBtn.hidden = undoSnapshot === null
    if (groupsChanged) {
      // 分组内容变了，原选中项的下标可能已错位，清空选择防止误操作
      clearSelection()
      render()
    } else if (collapsedChanged) {
      // 折叠变化只跟随重绘，绝不清勾选（TK-212 关键边界）
      render()
    }
  })()
})

// ------------------------------------------------------------
// 14. 初始化
// ------------------------------------------------------------
// 顶层 await：整个文件是 ESModule，允许直接在顶层写 await
groups = await loadGroups()
collapsed = new Set(await loadCollapsed())
settings = await loadSettings()
undoSnapshot = await loadUndo()

applyTheme()
bindSettingsControls()
undoBtn.hidden = undoSnapshot === null
await syncBadge()
render()
