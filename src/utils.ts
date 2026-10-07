// ============================================================
// utils.ts —— 纯工具函数（不碰 chrome.* API，也不碰 DOM）
// ------------------------------------------------------------
// 「纯函数」的意思是：给同样的输入，永远返回同样的输出，
// 不依赖外部状态。这种函数最好测试、最容易复用，
// 也是 TS 类型标注能发挥最大价值的地方。
// ============================================================

import type { TabRecord } from './types'

/** 一组标签页平均占用内存的估算值（MB）。业界常用 50~100MB，这里取中间值 */
const AVG_TAB_MEMORY_MB = 64

/**
 * 把时间戳格式化成人类友好的分组默认名，例如「10月7日 22:30」
 *
 * padStart(2, '0')：把字符串补齐到 2 位，不足就在前面补 '0'
 * （9 → '09'），常用于时间显示
 */
export function formatGroupName(timestamp: number): string {
  const d = new Date(timestamp)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`
}

/** 把毫秒数格式化成「2026/10/07 22:30」这种紧凑写法 */
export function formatDateTime(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/**
 * 从网址里取出域名（hostname）。
 * new URL() 解析失败时（比如「file:///D:/xx」以外的乱字符串）返回 null。
 * 返回「可能为 null」逼迫调用方处理失败情况，而不是拿到 undefined 还不知道
 */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/** 取域名的第一个字符，用作没有图标时的占位字母 */
export function initialOf(url: string): string {
  const host = hostOf(url)
  const source = host && host.length > 0 ? host : url
  return source.charAt(0).toUpperCase()
}

/**
 * 判断一个网址是否「值得被收纳」。
 * 浏览器内部页（chrome://、edge://、huawei://、about: 等）没有收藏价值，
 * 而且关掉后也没法用 tabs.create 稳定恢复，所以直接跳过。
 */
export function isCollectibleUrl(url: string): boolean {
  return /^(https?|file):\/\//i.test(url)
}

/**
 * 去掉同一批记录里重复的网址（保留第一次出现的那个）。
 *
 * Set 的 has() 是 O(1) 查找，比在数组里 indexOf 快得多 ——
 * 当有几百条记录时，这个差别会非常明显。
 */
export function dedupeRecords(records: TabRecord[]): TabRecord[] {
  const seen = new Set<string>()
  const result: TabRecord[] = []
  for (const record of records) {
    // 规范化：去掉末尾斜杠差异和大小写差异，避免「同一页面被存两次」
    const key = record.url.replace(/\/+$/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(record)
  }
  return result
}

/**
 * 从一批记录里剔除「列表中已经存在」的网址。
 *
 * existingUrls 是一个 Set<string>，由调用方提前把所有已存网址放进去。
 * 用参数传集合而不是每次现算，是常见的性能优化手法。
 */
export function filterNewRecords(
  records: TabRecord[],
  existingUrls: Set<string>,
): TabRecord[] {
  return records.filter((r) => {
    const key = r.url.replace(/\/+$/, '').toLowerCase()
    return !existingUrls.has(key)
  })
}

/** 估算收纳这批标签页能省下多少内存（返回字节数，方便统一换算） */
export function estimateMemorySaved(count: number): number {
  return count * AVG_TAB_MEMORY_MB * 1024 * 1024
}

/**
 * 把字节数格式化成「1.2 GB」「350 MB」这种易读形式。
 *
 * 泛型参数其实没必要，这里直接返回 string 就够了。
 * Number.prototype.toFixed(n) 保留 n 位小数（返回字符串）。
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const precision = value >= 100 || unitIndex === 0 ? 0 : 1
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}
