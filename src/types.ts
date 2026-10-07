// ============================================================
// types.ts —— 数据模型定义（TypeScript 的核心价值所在）
// ------------------------------------------------------------
// 「interface」定义了一种数据的形状（有哪些字段、什么类型）。
// 之后所有函数的参数、返回值都用这些类型标注后，
// 编辑器就能自动提示字段、拼写错误会直接标红，传错参数会报错。
// 这就是写 TS 相比写 JS 最大的好处。
//
// 本文件只放「类型 + 常量默认值」，不放任何逻辑，
// 这样它既能被后台脚本用，也能被页面脚本用，不会互相污染。
// ============================================================

/**
 * 单个被收纳的标签页记录
 *
 * 「?」表示可选字段：可能有，也可能没有（读取时类型是 string | undefined，
 * 使用前必须先判断，否则 TS 直接报错 —— 这是 TS 在帮我们避开空指针 bug）
 */
export interface TabRecord {
  url: string
  title: string
  /** 页面图标地址。浏览器不一定给（页面还没加载完就没有），所以是可选的 */
  favIconUrl?: string
}

/**
 * 一组同时收纳的标签页（每次点图标收纳的全部页面算一组）
 *
 * 字段类型说明：
 * - id: string        —— 唯一标识，用 crypto.randomUUID() 生成
 * - name: string      —— 分组名，用户可以改成「工作资料」这类有意义的名字
 * - createdAt: number —— 收纳时间戳（Date.now() 返回的毫秒数，也是 number）
 * - starred: boolean  —— 是否星标，星标的分组会排在最上面
 * - tabs: TabRecord[] —— 「TabRecord 数组」，表示这一组里的所有页面
 */
export interface TabGroup {
  id: string
  name: string
  createdAt: number
  starred: boolean
  tabs: TabRecord[]
}

/** 主题的三种取值。用「联合类型」限定只能是这三个字符串之一 */
export type ThemeName = 'auto' | 'light' | 'dark'

/**
 * 用户设置。把设置单独建模，后台和页面都能读到同一份。
 */
export interface Settings {
  /** 界面主题；auto 表示跟随系统深浅色 */
  theme: ThemeName
  /** 收纳时是否跳过重复网址（同一网址在列表里已存在就不重复存） */
  dedupe: boolean
  /** 收纳时是否忽略用户固定的标签页 */
  excludePinned: boolean
  /** 恢复整组时是否新开一个窗口（默认在当前窗口打开） */
  openInNewWindow: boolean
}

/** 设置的默认值。export const 导出一个对象常量 */
export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  dedupe: true,
  excludePinned: true,
  openInNewWindow: false,
}

/**
 * 「撤销收纳」用的快照。
 * 记住收纳前标签页所在的原窗口 id，撤销时能把它们放回原处。
 * windowId 用 number | null —— 万一原窗口已经被关了，就退化为「开到新窗口」
 */
export interface UndoSnapshot {
  group: TabGroup
  windowId: number | null
}
