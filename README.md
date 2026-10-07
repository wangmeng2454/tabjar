# TabJar 标签罐（TypeScript + Vite）

![License](https://img.shields.io/github/license/wangmeng2454/tabjar) ![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white) ![Vite](https://img.shields.io/badge/Vite-5.x-646CFF?logo=vite&logoColor=white)

一个 Manifest V3 标签页收纳扩展，华为浏览器 / Chrome / Edge 通用。

点一下，把所有标签页收进一个清爽的列表、立刻释放内存；随时一键找回。

## 📚 项目文档（开发前置资料）

完整的需求分析、竞品调研、技术设计等文档见 [`docs/`](./docs/)，建议从
[`docs/00-项目总览与阅读指南.md`](./docs/00-项目总览与阅读指南.md) 开始。

| 文档 | 内容 |
|---|---|
| [00 项目总览与阅读指南](./docs/00-项目总览与阅读指南.md) | 项目说明、文档索引、快速开始 |
| [01 竞品调研与功能总结](./docs/01-竞品调研与功能总结.md) | 11 款同类插件功能拆解与对比 |
| [02 需求分析文档(PRD)](./docs/02-需求分析文档(PRD).md) | 背景、目标、需求、验收标准 |
| [03 功能整合方案与建议](./docs/03-功能整合方案与建议.md) | 功能取舍、优先级、差异化建议 |
| [04 技术方案设计](./docs/04-技术方案设计.md) | 选型、架构、关键流程、权限 |
| [05 数据模型与存储设计](./docs/05-数据模型与存储设计.md) | 数据模型、存储、迁移 |
| [06 交互与视觉设计规范](./docs/06-交互与视觉设计规范.md) | 界面、交互、配色 |
| [07 华为浏览器适配与发布指南](./docs/07-华为浏览器适配与发布指南.md) | 内核差异、调试、上架 |
| [08 开发计划与里程碑](./docs/08-开发计划与里程碑.md) | 里程碑、迭代、交付清单 |
| [09 测试计划与验收标准](./docs/09-测试计划与验收标准.md) | 用例库、兼容矩阵 |
| [10 风险登记与决策记录](./docs/10-风险登记与决策记录.md) | 风险册、ADR 决策 |

### 🧩 功能特性

- **一键收纳**：点击图标 / 快捷键（`Ctrl+Shift+Y` 打开列表）/ 右键菜单，三种入口
- **分组管理**：按收纳时间自动分组，支持重命名、星标、折叠 / 展开
- **批量操作**：多选恢复、合并为新组、批量删除
- **搜索**：按标题 / 域名实时过滤，命中分组自动展开
- **撤销保护**：收纳后可一键撤销；清空需二次确认
- **导入导出**：JSON / HTML / TXT 三种格式，兼容 OneTab 文本格式迁移
- **深色主题**：深色 / 浅色 / 跟随系统
- **本地优先**：数据仅存本地，不申请多余权限（仅 `tabs` / `storage` / `contextMenus`）

## 开发

```powershell
npm install       # 安装依赖
npm run build     # 构建到 dist/
npm run watch     # 监听改动自动重新构建
npm run typecheck # 仅做类型检查
```

## 在华为浏览器中加载

1. `npm run build`
2. 华为浏览器 → 右上角 `∷` → 管理扩展程序 → 开启 **开发者模式**
3. **加载已解压的扩展程序** → 选择本项目的 **`dist/`** 目录
4. 改代码后：`npm run build`，再在扩展管理页点击刷新图标

## 使用

- 点击工具栏 TabJar 图标 → 当前窗口所有标签页被收纳成一个分组并关闭，自动打开汇总页
- 汇总页：单击条目恢复单个 / 恢复整组 / 删除条目 / 清空列表
- 固定的标签页和扩展内部页面不会被收纳

## 结构导读（TS 学习向）

```
manifest.config.ts   # 清单：权限只有 tabs + storage
src/types.ts         # 数据模型 interface —— TS 的核心价值所在
src/storage.ts       # chrome.storage 读写封装（Service Worker 随时会被回收，状态必须落盘）
src/background.ts    # Service Worker：点击图标 → 收集 → 存储 → 关标签
src/tabs/tabs.*      # 汇总页 UI：DOM 渲染 + 事件处理
```
