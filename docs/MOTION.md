# 动效恢复

> 本文记录当时恢复动效的实现；当前页面纯渐显、阶段无弹簧、下拉原位淡出等修正规则见 [UI-ITERATION-3.md](UI-ITERATION-3.md)。

按用户最新要求恢复完整过渡，沿用 swust-oc-web-ppt 的 Apple Keynote 式缓动、顺序入场和可中断原则，幅度及节奏适配桌面工作台。沿用第二轮布局、颜色令牌和业务逻辑。

| 场景 | 当前实现 |
| --- | --- |
| 侧栏 | 420ms，cubic-bezier(.22,1,.36,1)，宽度从当前位置连续反向；图标和导航纵向位置固定，文字透明度过渡 |
| 页面 | 短退出 120ms / 进入 320ms；内容分组 560ms，55ms 错开；旧页退出时 inert，快速导航选择最新页 |
| 导航/日期选中 | 阻尼弹簧 stiffness 420 / damping 38，共享布局底色滑动 |
| 日程换日 | 当天内容淡入并轻移；精确时间和模糊时段规则不变 |
| 弹窗 | 整个 surface 320ms 轻移 12px + .985→1 缩放；180ms 退出；快速中断重开从当前状态续接 |
| 下拉/日历/时间选择 | 自绘 top layer 160–240ms 淡入、轻移及缩放，关闭时保留退出过渡；跟随入场中的锚点 |
| 阶段展开 | 280ms 高度与箭头过渡；不支持新 CSS 特性的环境退回正常展开 |
| 提示条/进度 | 提示条 240ms；进度条 420ms；按钮、输入框、选项有悬停与焦点过渡 |
| 任务完成 | 保留勾选、变灰、行折叠 |

系统减少动态效果会立即结束进行中的动画，后续操作直接显示最终状态。动画不用于虚构数值、自动改变时间或延迟数据保存。所有真实内容默认可见，没有无限循环动画。

## 代码

- src/components/motion.ts：统一缓动、分组参数、实时系统偏好。
- src/components/PageTransition.tsx：页面生命周期与退出期间 inert。
- src/motion.css：连续侧栏、控件和浮层过渡。
- src/components/Modal.tsx：外壳动画、关闭/重开续接及稳定滚动槽。
- App、Dashboard、Tasks、Schedule、Settings、DateStrip 接入对应语义动画；Controls 在锚点移动时更新浮层位置。

repository、state、model、SQLite migrations 没有修改。测试只清理自己创建的 UUID，保留用户在上轮验收之后新增的项目和日程。

## 实际验证

- `npm test`：23 项通过。
- `npm run test:ui`：CRUD、时间定位、重叠安排、完成同步、持久化、28 组布局及主题通过；动画运行中主滚动槽和弹窗滚动槽宽度保持恒定。测试记录在 artifacts/motion-restore/regression。
- `npm run test:ui:edge`：最后一条任务完成动画、320×360 日期/时间控件、断网 SQLite 创建通过。
- `npm run test:motion`：9 组检查通过，包括侧栏多次中途反向、图标无跳动、快速连续导航、弹窗进出无短暂溢出、快速关闭/重开、日期弹簧选中、阶段展开、运行中切换减少动态效果，以及窄屏 drawer 焦点/inert。JavaScript 错误为 0。
- 已查看首页、日程和窄屏导航截图。逐帧 JSON 和截图保存在 Git 忽略的 artifacts/motion-restore。

Windows 打包和发布版离线重启结果在完成后补记。
