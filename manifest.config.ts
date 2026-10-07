// ============================================================
// manifest.config.ts —— 扩展清单（用 TS 写，构建时生成 dist/manifest.json）
// ------------------------------------------------------------
// 清单是扩展的「身份证 + 说明书」：告诉浏览器扩展叫什么、
// 需要什么权限、各部分代码在哪里。
// 用 defineManifest 包一层能获得完整的字段类型提示和校验。
// ============================================================
import { defineManifest } from '@crxjs/vite-plugin'

/** 图标路径集中定义，manifest 里要写两处（总图标 + 工具栏图标） */
const ICONS = {
  '16': 'icons/icon16.png',
  '32': 'icons/icon32.png',
  '48': 'icons/icon48.png',
  '128': 'icons/icon128.png',
}

export default defineManifest({
  // Manifest V3 = 当今浏览器的扩展标准（V2 已淘汰）
  manifest_version: 3,

  name: 'TabJar 标签罐',
  // 版本口径三处统一为 1.0.0（manifest / package.json / docs/08 M4，见 TK-904）
  version: '1.0.0',
  description:
    '一键收纳所有标签页，释放内存；支持搜索、分组、星标、导入导出与撤销。',

  // ⚠️ 关键点：action 里不设 default_popup，
  // 点击图标才会触发 background 里的 chrome.action.onClicked 事件。
  // 如果设了 default_popup，点击只会弹出小窗口，onClicked 永远不触发
  action: {
    // 工具栏上那个小图标。只给图标、不给 popup，两者互不冲突
    default_icon: ICONS,
    default_title: '收纳当前窗口的标签页',
  },

  // 扩展管理页 / 应用商店里显示的大图标
  icons: ICONS,

  // 后台脚本。CRXJS 会把这里的 TS 源文件编译打包，
  // 最终 manifest 里写的是构建产物 service-worker-loader.js
  background: {
    service_worker: 'src/background.ts',
    // module 模式才能在 Service Worker 里使用 import 语法
    type: 'module',
  },

  // 权限申请原则：越少越好，用户安装时看到的权限提示越少，审核越容易过
  // - tabs:         读取标签页的网址、标题、图标（收纳功能必需）
  // - storage:      把收纳列表和设置存在本地（恢复用）
  // - contextMenus: 注册右键菜单（收纳本页 / 收纳其余标签页）
  permissions: ['tabs', 'storage', 'contextMenus'],

  // 键盘快捷键。suggested_key 只是「建议值」，用户可以在浏览器的
  // 扩展快捷键设置页里自己改
  commands: {
    'collect-all': {
      suggested_key: { default: 'Ctrl+Shift+E', mac: 'Command+Shift+E' },
      description: '收纳当前窗口的所有标签页',
    },
    'open-list': {
      suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' },
      description: '打开 TabJar 列表页',
    },
  },
})
