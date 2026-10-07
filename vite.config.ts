// ============================================================
// vite.config.ts —— 构建工具 Vite 的配置
// ------------------------------------------------------------
// Vite 负责把 src/ 下的 TypeScript 编译打包成浏览器能运行的 JS。
// CRXJS 插件让 Vite 懂得「浏览器扩展」的规则
// （生成 manifest.json、打包 Service Worker 等）。
// ============================================================

// node:url 是 Node.js 内置模块，用来可靠地拼接文件路径（跨平台）
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

// 汇总页是通过代码里 chrome.runtime.getURL('src/tabs/tabs.html') 打开的，
// manifest 中没有引用它，CRXJS 不会自动打包 ——
// 必须在这里显式声明为构建入口，Vite 才会处理它
// （new URL(相对路径, import.meta.url) 是 ESM 中获取文件路径的标准写法）
const tabsHtml = fileURLToPath(new URL('./src/tabs/tabs.html', import.meta.url))

export default defineConfig({
  // crx 插件：接收上面定义的清单，接管扩展相关的打包逻辑
  plugins: [crx({ manifest })],

  build: {
    // 源码里用了「顶层 await」（ES2022 特性），
    // Vite 默认目标环境较老不支持，必须显式提到 es2022
    target: 'es2022',

    rollupOptions: {
      input: {
        // 额外的构建入口：键名随意，值是文件路径
        tabs: tabsHtml,
      },
    },
  },
})
