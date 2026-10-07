// ============================================================
// dom.ts —— DOM 操作的小工具
// ------------------------------------------------------------
// 原生 DOM API 写起来很啰嗦：
//   const b = document.createElement('button')
//   b.className = 'ghost'
//   b.textContent = '恢复'
//   b.addEventListener('click', fn)
// 下面的 el() 把这四行压成一行的函数调用，
// 同时用「泛型」保住元素的精确类型（button 就有 disabled 属性，div 没有）。
// ============================================================

/**
 * 按 id 取元素；找不到时立刻抛错（早失败）。
 *
 * 不用纯类型断言的原因：$() 的返回值经 `as T` 包装后，tsc 抓不到
 * id 写错的情况；一旦不匹配，运行期会以 `null.addEventListener`
 * 的形式在**模块顶层**抛错，中止整个页面脚本（历史缺陷 TK-902）。
 * 显式报错能把「静默失效」变成「打开页面即暴露」。
 */
export const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id)
  if (!node) {
    throw new Error(
      `[TabJar] 找不到元素 #${id}，请检查 tabs.html 的 id 契约（见 docs/tasks/02-列表页与交互.md TK-201）`,
    )
  }
  return node as T
}

/** el() 支持的属性集合。都是 string | boolean，够覆盖常用场景 */
export interface ElementOptions {
  className?: string
  text?: string
  title?: string
  placeholder?: string
  type?: string
  value?: string
  hidden?: boolean
  disabled?: boolean
  href?: string
}

/**
 * 快速创建元素。
 *
 * <K extends keyof HTMLElementTagNameMap> 是泛型约束：
 * 传入 'button' 时 K 就是 'button'，返回值类型自动变成 HTMLButtonElement。
 * 调用处写 el('button', {...})，编辑器就知道返回的是按钮。
 *
 * children 既可以是 Node（真实 DOM 节点），也可以是 string（自动转文本节点）。
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)

  if (options.className !== undefined) node.className = options.className
  if (options.text !== undefined) node.textContent = options.text
  if (options.title !== undefined) node.title = options.title
  if (options.placeholder !== undefined) {
    node.setAttribute('placeholder', options.placeholder)
  }
  if (options.type !== undefined) node.setAttribute('type', options.type)
  if (options.value !== undefined) {
    node.setAttribute('value', options.value)
  }
  if (options.hidden) node.hidden = true
  if (options.disabled) {
    // HTMLButtonElement 才有 disabled；这里先统一用 setAttribute 兜底
    node.setAttribute('disabled', 'disabled')
  }
  if (options.href !== undefined && node instanceof HTMLAnchorElement) {
    node.href = options.href
  }

  // append 可以同时接收节点和字符串，比 appendChild 方便
  node.append(...children)
  return node
}

/**
 * 把一段文本当作文件下载到本地。
 * 思路：用 Blob 在内存里造一个临时文件 → 生成一个指向它的临时链接 → 模拟点击。
 * 用完立即撤销 URL，避免内存泄漏。
 */
export function downloadText(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const link = el('a', { href: url })
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
