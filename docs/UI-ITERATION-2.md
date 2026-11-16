# UI 迭代 2

> 后续用户要求已恢复页面、侧栏、弹窗和控件的动效；本文件记录当时的第二轮改造，当前动效规则见 [MOTION.md](MOTION.md)。

本轮仅调整展示层、窗口装饰与必要窗口权限。SQLite repository、状态管理、业务模型及三个迁移文件 SHA256 均与修改前一致。

## 交付内容

- 首页移除六卡片和标语，改为日期/摘要、14 天时间地平线、今日时间线、截止倒计时、项目分段进展。日期支持跳转日程，项目支持跳转任务。
- 7/14 天日期条共用组件：截止紧急度圆点、安排量细条、休息标记和重要事件旗标。窄屏 14 天分两行显示。
- 今天合并任务和执行安排；关联任务不重复显示，同一任务的多次执行仍保留。没有把截止时刻当作执行时刻。
- 日程 08:00–23:00 小时轴，精确事件按时间和持续时间定位，重叠事件并排。没有结束时间的事件使用最小可点击高度，不显示虚构结束时间。08:00 之前单列；模糊时段仅有内容时显示。
- 颜色集中在 theme.css，蓝色操作、红色逾期、橙色今天截止、金色近期截止、绿色完成；五色项目圆点/任务色条。
- 任务约 40px 行高、文字优先级、倒计时标签；统一尺寸与中文日期；设置居中最大 720px。
- 同色自定义 Windows 标题栏，应用/安装器图标同步为 primary 蓝；固定自绘滚动槽；移除页面/侧栏/弹窗/控件动画，只保留完成任务的勾选、变灰和折叠。

## 新增主要文件

- src/theme.css：颜色令牌。
- src/presentation/view.ts：纯展示计算，不写入数据。
- src/components/DateStrip.tsx：共享日期条。
- src/components/Timeline.tsx：今日时间线、小时轴与动态当前时间。
- src/components/Titlebar.tsx：原生窗口操作。
- tests/presentation.test.ts：日期展示、截止紧急度、去重、重叠阶段与日程布局测试。
- scripts/ui-round2.mjs、scripts/ui-round2-edge.mjs：真实 Tauri 窗口验收。

## 验证

`npm test`：23 项通过。`npm run test:ui`：真实 Tauri WebView2 的 CRUD、日期跳转、时间定位、重叠计划、同步完成、SQLite 重新读取、主题、标题栏最大化/还原（另验证原生最小化）、滚动槽逐帧稳定性通过。7 种尺寸 × 4 页面共 28 组布局，覆盖 320×360 至 3840×2160，无页面横向溢出或首页/日程嵌套滚动，JavaScript 错误为 0。

`npm run test:ui:edge`：逐帧验证最后一条任务也有勾选、变灰及行高折叠；320×360 窗口内日历和 23:59 时间选项可访问；WebView 断网状态仍可创建任务并保存 SQLite。

测试只添加/移除自身 UUID 的记录，不整体替换用户业务数据；原 1 项目、7 阶段、29 任务、4 日程、2 事件均保持原值。外观偏好恢复。截图和本机详细报告在 Git 忽略的 artifacts/ui-iteration-2 下，不公开个人资料。

`npm run tauri build` 成功生成最终 EXE（5,240,832 字节）及 NSIS 安装包（219,868,552 字节，含离线 WebView2 Runtime）。`npm run test:release` 通过：最终发布程序两次启动约 1.9 秒，WebView 网络离线时创建任务、通过自定义标题栏关闭整个进程、重启后读取及编辑原任务、经确认弹窗删除临时任务；四页面与深色设置正常，外部请求及 JavaScript 错误均为 0。最终再次直接读取磁盘 SQLite，43 条原始记录逐字段一致。构建有第三方注释和单个 JS 包超过 500KB 的提示，不阻塞构建。

## 验收入口

开发：`npm run tauri dev`。发布程序：`src-tauri/target/release/local-workbench.exe`。安装包：`src-tauri/target/release/bundle/nsis/Local Workbench_0.1.0_x64-setup.exe`。版本仍为 v0.1.0，没有推送 GitHub。

本轮停止于上述视觉改造，后续变更待用户验收。大数据量虚拟化和复杂拖拽日历未纳入本轮。
