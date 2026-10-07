// ============================================================
// storage.ts —— 封装所有对 chrome.storage 的读写
// ------------------------------------------------------------
// 为什么单独建一个文件？
// 1. MV3 的 Service Worker（后台脚本）随时可能被浏览器「杀掉」再重启，
//    内存里的全局变量会丢失，所以所有状态必须写入 storage 持久化。
// 2. 把读写集中在一处，数据格式变了只需要改这个文件。
// 3. 顺便在这里做「数据迁移」：老版本存的数据缺新字段，读出来时补齐。
// ============================================================

// 「import type」表示只导入类型（编译后会被完全删除，不产生任何 JS 代码）
import type { Settings, TabGroup, UndoSnapshot } from './types'
import { DEFAULT_SETTINGS } from './types'
import { formatGroupName } from './utils'

// 存储里的键名。const 声明常量，值不可再被重新赋值
const GROUPS_KEY = 'groups'
const SETTINGS_KEY = 'settings'
const UNDO_KEY = 'undo'
// 折叠中的分组 id 列表（ADR-09：独立键，刻意不进 Settings / TabGroup）
const COLLAPSED_KEY = 'collapsed'

// ------------------------------------------------------------
// 数据迁移：把任意「来历不明」的数据洗成合法的 TabGroup
// ------------------------------------------------------------
/**
 * chrome.storage 读出来的东西类型上是不可信的 —— 它可能来自老版本、
 * 可能被用户手动改过、也可能是空的。所以入库前先「洗」一遍。
 *
 * 「unknown」是 TS 里比 any 更安全的类型：用之前必须先判断它到底是什么，
 * 不能像 any 那样随便调方法。配合下面的 is 开头的判断函数使用。
 */
function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 把一条来历不明的数据修整成合法的 TabGroup（缺字段就补默认值） */
function sanitizeGroup(raw: unknown, index: number): TabGroup {
  // 「?? 」空值合并运算符：左边是 null/undefined 时取右边的默认值
  const source = isRecordLike(raw) ? raw : {}
  const createdAt =
    typeof source.createdAt === 'number' ? source.createdAt : Date.now()
  const rawTabs = Array.isArray(source.tabs) ? source.tabs : []

  return {
    id:
      typeof source.id === 'string' && source.id.length > 0
        ? source.id
        : `legacy-${createdAt}-${index}`,
    // 老版本（1.0.0）没有 name 字段 —— 用收纳时间补一个
    name:
      typeof source.name === 'string' && source.name.length > 0
        ? source.name
        : formatGroupName(createdAt),
    createdAt,
    // 老版本没有 starred —— 默认 false
    starred: source.starred === true,
    tabs: rawTabs
      .filter(isRecordLike)
      .map((t) => ({
        url: typeof t.url === 'string' ? t.url : '',
        title: typeof t.title === 'string' ? t.title : '',
        // 只有确实存在这个字段时才写进去，保持 favIconUrl 的可选语义
        ...(typeof t.favIconUrl === 'string' ? { favIconUrl: t.favIconUrl } : {}),
      }))
      .filter((t) => t.url.length > 0),
  }
}

/**
 * 读取所有已收纳的分组（含旧数据迁移）
 *
 * 返回类型 Promise<TabGroup[]> —— async 函数自动包装成 Promise，
 * 调用方要写成：const groups = await loadGroups()
 */
export async function loadGroups(): Promise<TabGroup[]> {
  const res = await chrome.storage.local.get({ [GROUPS_KEY]: [] })
  const rawList: unknown = res[GROUPS_KEY]
  if (!Array.isArray(rawList)) return []
  return rawList.map(sanitizeGroup)
}

/** 把分组列表完整写回存储（整体覆盖，不做增量） */
export async function saveGroups(groups: TabGroup[]): Promise<void> {
  // Promise<void> 表示：异步完成但不返回任何值
  await chrome.storage.local.set({ [GROUPS_KEY]: groups })
}

/**
 * 读取设置。存储里没有就用 DEFAULT_SETTINGS 补齐，
 * 这样即使未来新增设置项，老用户的数据也能平滑过渡。
 */
export async function loadSettings(): Promise<Settings> {
  const res = await chrome.storage.local.get({ [SETTINGS_KEY]: {} })
  const raw: unknown = res[SETTINGS_KEY]
  const source = isRecordLike(raw) ? raw : {}
  return {
    theme:
      source.theme === 'light' || source.theme === 'dark'
        ? source.theme
        : DEFAULT_SETTINGS.theme,
    dedupe:
      typeof source.dedupe === 'boolean'
        ? source.dedupe
        : DEFAULT_SETTINGS.dedupe,
    excludePinned:
      typeof source.excludePinned === 'boolean'
        ? source.excludePinned
        : DEFAULT_SETTINGS.excludePinned,
    openInNewWindow:
      typeof source.openInNewWindow === 'boolean'
        ? source.openInNewWindow
        : DEFAULT_SETTINGS.openInNewWindow,
  }
}

/** 保存设置 */
export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings })
}

// ------------------------------------------------------------
// 折叠状态（TK-212 / ADR-09）
// ------------------------------------------------------------
/**
 * 读取处于折叠状态的分组 id 列表。
 *
 * 折叠是「界面偏好」而不是用户数据：塞进 Settings 会让全局偏好的
 * 迁移逻辑变复杂，写进 TabGroup 会污染导出 JSON 的数据契约 ——
 * 所以独立成一个键（详见 docs/10 ADR-09）。
 */
export async function loadCollapsed(): Promise<string[]> {
  const res = await chrome.storage.local.get({ [COLLAPSED_KEY]: [] })
  const raw: unknown = res[COLLAPSED_KEY]
  if (!Array.isArray(raw)) return []
  // 读出来的东西同样不可信：只留非空 string，并用 Set 顺手去重
  const valid = new Set<string>()
  for (const item of raw) {
    if (typeof item === 'string' && item.length > 0) valid.add(item)
  }
  return [...valid]
}

/** 保存折叠状态（元素为 group.id，整体覆盖） */
export async function saveCollapsed(ids: string[]): Promise<void> {
  await chrome.storage.local.set({ [COLLAPSED_KEY]: ids })
}

/**
 * 读取「撤销收纳」的快照；没有就返回 null。
 * 返回 null 而不是 undefined，语义更明确：「确认没有」
 */
export async function loadUndo(): Promise<UndoSnapshot | null> {
  const res = await chrome.storage.local.get({ [UNDO_KEY]: null })
  const raw: unknown = res[UNDO_KEY]
  if (!isRecordLike(raw)) return null
  const group = isRecordLike(raw.group) ? sanitizeGroup(raw.group, 0) : null
  if (!group) return null
  return {
    group,
    windowId: typeof raw.windowId === 'number' ? raw.windowId : null,
  }
}

/** 保存撤销快照；传 null 表示清除 */
export async function saveUndo(snapshot: UndoSnapshot | null): Promise<void> {
  await chrome.storage.local.set({ [UNDO_KEY]: snapshot })
}

/** 清空撤销快照（明确的语义化封装，调用处读起来更清楚） */
export async function clearUndo(): Promise<void> {
  await saveUndo(null)
}

// ------------------------------------------------------------
// 存储变更订阅（供列表页实时刷新）
// ------------------------------------------------------------
/**
 * 订阅本地存储的变化。
 *
 * 为什么需要它：列表页可能早已打开，收纳时 Service Worker 只是
 * 聚焦这个已有页面 —— 页面并不会重新加载、也不会自动重读存储。
 * 不监听变更的话，新收纳的分组永远不会出现在已打开的列表页上。
 *
 * 回调不带参数（具体读什么由调用方决定），返回「取消订阅」函数。
 */
export function onStorageChanged(callback: () => void): () => void {
  const listener = (
    _changes: Record<string, unknown>,
    area: string,
  ): void => {
    // 只关心 local 区；本扩展不用 sync 区
    if (area === 'local') callback()
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}
