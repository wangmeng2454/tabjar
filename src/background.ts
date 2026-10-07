// ============================================================
// background.ts —— Service Worker（后台脚本）
// ------------------------------------------------------------
// Service Worker 是扩展的「大脑」，但它非常特殊：
// 1. 不常驻 —— 浏览器会在空闲时杀掉它，事件来了再唤醒
// 2. 没有 DOM —— 不能用 document、window，只能用 chrome.* API
// 3. 「type: module」—— 支持 ESModule 的 import/export 语法
//
// 本文件职责：
//   · 点击工具栏图标 / 按快捷键 → 收纳当前窗口
//   · 右键菜单 → 收纳单个页面 / 收纳窗口里其余的页面
//   · 维护「撤销收纳」快照和图标上的数字徽标
// ============================================================

import { loadGroups, loadSettings, saveGroups, saveUndo } from './storage'
import type { Settings, TabGroup, TabRecord } from './types'
import { dedupeRecords, estimateMemorySaved, filterNewRecords, formatBytes, formatGroupName, isCollectibleUrl } from './utils'

// chrome.runtime.getURL() 把扩展内部路径转成可访问的完整 URL，
// 形如 chrome-extension://<扩展ID>/src/tabs/tabs.html
const TABS_PAGE = chrome.runtime.getURL('src/tabs/tabs.html')

// ------------------------------------------------------------
// 小工具
// ------------------------------------------------------------

/** 把浏览器返回的 Tab 对象精简成我们自己的 TabRecord（顺便做防御性处理） */
function toRecord(tab: chrome.tabs.Tab): TabRecord {
  const url = tab.url ?? ''
  const record: TabRecord = {
    url,
    // 页面没加载完时 title 可能为空，用网址兜底
    title: tab.title && tab.title.length > 0 ? tab.title : url,
  }
  // 「可选属性 + 展开运算符」：只有确实有图标时才加这个字段
  if (tab.favIconUrl) record.favIconUrl = tab.favIconUrl
  return record
}

/** 把所有已存分组的网址收进一个 Set，用于「跳过重复网址」判断 */
async function buildExistingUrlSet(): Promise<Set<string>> {
  const groups = await loadGroups()
  const urls = new Set<string>()
  for (const group of groups) {
    for (const tab of group.tabs) {
      // 统一小写 + 去掉末尾斜杠，避免同一页面被判定为不同网址
      urls.add(tab.url.replace(/\/+$/, '').toLowerCase())
    }
  }
  return urls
}

/** 更新图标上的数字徽标（显示当前一共收纳了多少个标签页） */
async function updateBadge(): Promise<void> {
  const groups = await loadGroups()
  const total = groups.reduce((sum, g) => sum + g.tabs.length, 0)
  await chrome.action.setBadgeText({ text: total > 0 ? String(total) : '' })
  // 徽标底色，红底白字最醒目
  await chrome.action.setBadgeBackgroundColor({ color: '#cf0a2c' })
}

// ------------------------------------------------------------
// 收纳逻辑
// ------------------------------------------------------------

/**
 * 真正执行收纳：把给定的标签页存成一个新分组并关闭它们。
 *
 * 参数用「对象 + 类型」而不是一长串位置参数 ——
 * 调用处写 collectAndStore({ tabs, windowId })，一眼能看懂每个值是什么。
 */
async function collectAndStore(options: {
  tabs: chrome.tabs.Tab[]
  windowId: number
}): Promise<void> {
  const { tabs, windowId } = options
  if (tabs.length === 0) return

  const settings: Settings = await loadSettings()
  let records: TabRecord[] = tabs.map(toRecord)

  // 只保留 http/https/file 这类可恢复的网址
  records = records.filter((r) => isCollectibleUrl(r.url))

  // 设置里开了「跳过重复网址」时，剔除列表里已有的
  if (settings.dedupe) {
    const existing = await buildExistingUrlSet()
    records = filterNewRecords(records, existing)
  }
  // 同一批次内部的重复也去掉
  records = dedupeRecords(records)

  if (records.length === 0) {
    // 全部被过滤掉了，就没有必要创建空分组，直接打开列表页
    await openListPage()
    return
  }

  const group: TabGroup = {
    id: crypto.randomUUID(),
    name: formatGroupName(Date.now()),
    createdAt: Date.now(),
    starred: false,
    tabs: records,
  }

  // ⚠️ 顺序很重要：先把「撤销快照」和「新分组」写进存储，再关标签页。
  // 如果先关页面再写存储，中途出错数据就永久丢了
  await saveUndo({ group, windowId })

  const groups = await loadGroups()
  // 星标的分组要保持在最上面，所以新分组插到第一个非星标位置
  const firstUnstarred = groups.findIndex((g) => !g.starred)
  if (firstUnstarred === -1) {
    groups.push(group)
  } else {
    // splice(位置, 删除0个, 插入的内容) = 在该位置插入而不删除
    groups.splice(firstUnstarred, 0, group)
  }
  await saveGroups(groups)

  await openListPage()
  await chrome.tabs.remove(tabs.map((t) => t.id as number))
  await updateBadge()

  // 在控制台打印一条估算信息（Service Worker 的日志要在
  // 扩展管理页的「服务工作进程」里看）
  console.info(
    `[TabJar] 收纳 ${records.length} 个标签页，预计释放 ${formatBytes(
      estimateMemorySaved(records.length),
    )}`,
  )
}

/** 收纳当前窗口里所有「可收纳」的标签页 */
async function collectWindow(windowId: number): Promise<void> {
  const settings = await loadSettings()
  const allTabs = await chrome.tabs.query({ windowId })

  const collectible = allTabs.filter((t) => {
    if (t.id == null) return false
    // 列表页自身永远不收纳，否则会把自己关掉
    if (t.url === TABS_PAGE) return false
    // 扩展内部页面也不收纳
    if (t.url?.startsWith('chrome-extension://')) return false
    // 非法网址（chrome:// 设置页等）无法恢复，跳过
    if (t.url == null || !isCollectibleUrl(t.url)) return false
    // 固定标签页按设置决定是否忽略
    if (settings.excludePinned && t.pinned) return false
    return true
  })

  await collectAndStore({ tabs: collectible, windowId })
}

/** 只收纳某一个标签页（右键菜单「收纳当前标签页」用） */
async function collectSingleTab(tabId: number, windowId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId)
  if (tab.url == null || !isCollectibleUrl(tab.url)) return
  await collectAndStore({ tabs: [tab], windowId })
}

/** 收纳某窗口里「除了指定标签页之外」的所有页面 */
async function collectOthers(
  windowId: number,
  excludeTabId: number,
): Promise<void> {
  const settings = await loadSettings()
  const allTabs = await chrome.tabs.query({ windowId })
  const others = allTabs.filter(
    (t) =>
      t.id != null &&
      t.id !== excludeTabId &&
      t.url !== TABS_PAGE &&
      !t.url?.startsWith('chrome-extension://') &&
      t.url != null &&
      isCollectibleUrl(t.url) &&
      !(settings.excludePinned && t.pinned),
  )
  await collectAndStore({ tabs: others, windowId })
}

// ------------------------------------------------------------
// 打开 / 聚焦列表页
// ------------------------------------------------------------
/** 列表页已打开就切过去（update），没打开就新开一个（create） */
async function openListPage(): Promise<void> {
  // 用空查询条件拿到所有窗口的全部标签页，再按网址筛选。
  // 之所以不用 chrome.tabs.query({ url: TABS_PAGE })，是因为它要求传入
  // 「匹配模式」，对 chrome-extension:// 这种特殊前缀兼容性不稳，
  // 而直接比对字符串永远不会出错
  const allTabs = await chrome.tabs.query({})
  const existing = allTabs.find((t) => t.url === TABS_PAGE)
  if (existing?.id != null) {
    // active: true 把这个标签页切换为当前显示的
    await chrome.tabs.update(existing.id, { active: true })
    // focused: true 把它所在的窗口提到最前面
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true })
    }
    return
  }
  await chrome.tabs.create({ url: TABS_PAGE, active: true })
}

// ------------------------------------------------------------
// 右键菜单
// ------------------------------------------------------------
// 注意：contextMenus.create 不能重复调用同一 id，否则报错。
// 标准做法是只在 onInstalled 里 removeAll 后重建一次；
// 但部分 Chromium 内核浏览器（含华为浏览器）在浏览器重启或
// SW 被回收后可能丢失已注册的菜单，且菜单丢失后没有任何事件
// 能再触发注册。所以这里改为「幂等注册」：每次 SW 被唤醒时
// 都补注册一次，重复 id 的报错直接读掉 lastError 忽略。
function createMenuSafely(options: chrome.contextMenus.CreateProperties): void {
  chrome.contextMenus.create(options, () => {
    // 「id 已存在」属预期情况；读取 lastError 将其吞掉，避免控制台报错
    void chrome.runtime.lastError
  })
}

function registerMenus(): void {
  // contexts: ['all'] —— 在页面任意位置右键（含链接、图片、输入框）都可见。
  // 早期版本用 ['page']，用户右键点到链接/图片上菜单不出现，容易被误判为「无效」
  createMenuSafely({
    id: 'tabjar-collect-page',
    title: '收纳当前标签页到 TabJar',
    contexts: ['all'],
  })
  createMenuSafely({
    id: 'tabjar-collect-others',
    title: '收纳本窗口其余标签页（保留当前页）',
    contexts: ['all'],
  })
  // PRD F-3.7：不收纳任何标签，只是打开/聚焦列表页（对应 US-9）
  createMenuSafely({
    id: 'tabjar-open-list',
    title: '打开 TabJar 列表',
    contexts: ['all'],
  })
}

chrome.runtime.onInstalled.addListener(() => {
  // removeAll 先清空再重建，避免升级后残留旧菜单
  chrome.contextMenus.removeAll(() => registerMenus())
})
// 浏览器启动 + SW 每次被唤醒都补注册（幂等），覆盖菜单注册丢失的情况
chrome.runtime.onStartup.addListener(registerMenus)
registerMenus()

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // info.menuItemId 的类型是 string | number，这里我们自己定义的都是字符串
  if (info.menuItemId === 'tabjar-collect-page') {
    // 右键菜单一定发生在某个页面上，所以 tab 一般不为空
    if (tab?.id != null && tab.windowId != null) {
      void collectSingleTab(tab.id, tab.windowId)
    }
    return
  }
  if (info.menuItemId === 'tabjar-collect-others') {
    if (tab?.id != null && tab.windowId != null) {
      void collectOthers(tab.windowId, tab.id)
    }
    return
  }
  if (info.menuItemId === 'tabjar-open-list') {
    // 只打开/聚焦列表页，不动任何标签（openListPage 自带「已开则聚焦」逻辑）
    void openListPage()
  }
})

// ------------------------------------------------------------
// 键盘快捷键（在 manifest.config.ts 的 commands 里定义）
// ------------------------------------------------------------
chrome.commands.onCommand.addListener((command) => {
  // 回调里要用 await，所以包一层 async 箭头函数（IIFE 风格）
  void (async () => {
    if (command === 'collect-all') {
      const win = await chrome.windows.getCurrent()
      if (win.id != null) await collectWindow(win.id)
      return
    }
    if (command === 'open-list') {
      await openListPage()
    }
  })()
})

// ------------------------------------------------------------
// 工具栏图标点击（manifest 里 action 不设 default_popup 才会触发）
// ------------------------------------------------------------
chrome.action.onClicked.addListener((tab) => {
  if (tab?.windowId == null) return
  void collectWindow(tab.windowId)
})

// Service Worker 每次被唤醒都要重新算一次徽标数字
// （它不常驻，内存里的值早就没了）
void updateBadge()
