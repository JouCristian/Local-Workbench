# v0.1.0 本地交付与验收

验收日期：2026-11-12，Windows x64。所有开发和验证均在用户本机进行，未推送远程仓库。

## 交付内容

- `src/domain/`：完整 TypeScript 数据类型、Zod JSON/表单校验、日期及任务逻辑。
- `src/data/repository.ts`：Tauri SQL 插件访问、参数化查询、串行写入。
- `src/state.tsx`：共享状态、数据库刷新、主题持久化、错误与反馈。
- `src/components/`：编辑、确认、任务、日程、事件与空状态组件。
- `src/pages/`：Dashboard、Tasks、Schedule、Settings 四个功能页面。
- `src-tauri/src/`：插件注册、系统数据目录、事务恢复与自动备份。
- `src-tauri/migrations/`：3 个版本化迁移，包含外键、CHECK 和阶段归属及删除保留触发器。
- `src-tauri/capabilities/`：本地 SQL 和用户选定文件的访问权限。
- `src-tauri/icons/`：由同一个原创 SVG 生成的应用图标（含 Tauri 工具附带生成的平台尺寸）。
- `tests/`：17 项基础测试，包含真实磁盘 SQLite 数据库。
- `scripts/desktop-smoke.mjs`：真实 Tauri 开发窗口的 8 组集成验收。
- `scripts/release-smoke.mjs`：真实 Release EXE 离线运行、进程重启及临时数据清理验收。
- `examples/generic.json`：不含个人资料的通用示例。
- 根目录包含 npm/Cargo 锁文件、构建配置、格式配置、`.gitignore`、MIT `LICENSE`、`README.md`、`PRODUCT.md` 与 `DESIGN.md`。
- `docs/FILES.txt`：本次交付的公开源码文件清单。

本地个人初始化 JSON 位于 Git 忽略的 `private/`；证据截图、导出文件和结果日志位于 Git 忽略的 `artifacts/`。个人内容没有进入公开示例、源码或前端发行资源。Vite 也禁止读取 `private/`、`*.local.json`、数据库和 `.git` 文件。

## 功能状态

| 范围 | v0.1.0 状态 |
| --- | --- |
| 总览 | 今日任务及独立安排、近期 DDL、工作阶段及未完成事项、项目进度、未来日程、事件及休息日均有独立可见区域，分区可滚动 |
| 项目与阶段 | 创建、编辑、删除、阶段日期范围、允许重叠、项目分组及侧栏直达 |
| 任务 | CRUD、UUID、备注、三状态、三级优先级、可选 DDL 与时间、项目和阶段关联、筛选、搜索及快速添加 |
| 日程 | 日期及周导航、独立或任务关联、多次执行、允许同时安排、全天和模糊时段、精确时间及可选结束时间 |
| 特殊日期 | 重要事件及休息日 CRUD，在总览和日程中展示 |
| 设置 | 三种主题、JSON 导入导出、备份恢复、版本及实际数据目录 |
| 数据可靠性 | SQLite 磁盘持久化、3 个迁移、输入校验、外键完整性、恢复单事务及覆盖前自动备份 |
| 交互 | Motion 页面与状态过渡、任务反馈、原生 dialog 焦点约束、删除确认、加载/错误/空状态、减少动态效果 |

## 验收结果

| 项目 | 结果及证据 |
| --- | --- |
| 环境 | Node 24.15.0、npm 11.12.1、Rust/Cargo 1.96.0、Visual Studio 2022 Community C++、WebView2 157，实际编译成功 |
| 基础测试 | `npm test`：17/17 通过；另在 America/Los_Angeles 与 Pacific/Honolulu 时区执行通过，覆盖日期跨月/年、闰年与无虚构模糊小时 |
| 开发窗口 | `npm run tauri dev` 启动真实 Tauri 窗口，通过真实 SQL 插件完成 CRUD，未使用假数据库 |
| 创建与修改 | 通过界面创建项目、阶段、关联任务、DDL、精确及模糊日程、休息日；修改项目、任务及状态 |
| 首页联动 | 六个区域均存在；任务完成后 DDL 移除、关联日程状态同步，项目进度达到 100%；独立日程也出现在今日区域 |
| 删除保护 | 先取消确认再实际确认删除项目，任务与日程保留，阶段级联删除；SQLite 基础测试还覆盖删除阶段与任务 |
| JSON 与备份 | 真实 Windows 文件保存对话框成功写出 JSON，再用原生文件选择器导入该文件；确认覆盖后数据库恢复，旧数据备份落盘 |
| 错误导入 | 重复 UUID、无效日期/关系/版本被校验拒绝；绕过前端提交违反数据库约束的快照，Rust 事务回滚，原数据保持完整 |
| 进程重启 | Release EXE 创建任务后结束整个进程，再启动另一个进程，数据保留并可继续编辑；临时验收任务已通过确认弹窗清理 |
| 离线 | Vite 已停止；Release WebView2 网络设置为离线后重新加载、创建、编辑、切页和读取 SQLite 均成功，捕获到 0 个外部请求、0 个页面错误 |
| 主题与动态偏好 | 主题保存后重载仍保留；Release 在离线状态下切换深色与系统主题，并使用减少动态效果模式验收页面可见性 |
| 依赖审计 | `npm audit --registry=https://registry.npmjs.org`：0 vulnerabilities（含开发依赖） |
| 编译 | TypeScript + Vite 生产构建通过；`cargo check` 通过；最终 `npm run tauri build` 成功生成 Windows NSIS 安装包 |
| 隐私 | `git check-ignore` 确认个人 JSON、数据库和验收截图被排除；公开源码个人内容检索无匹配；Vite 请求私有 JSON 和 `.git/config` 均返回 403 |

离线测试限制：禁用了应用 WebView2 的网络访问，没有关闭用户系统网卡。安装包已实际构建，但未在全新 Windows 虚拟机上执行完整安装及缺失 WebView2 的安装分支。构建过程允许联网下载依赖和官方工具。

本地可复核证据：

- `artifacts/desktop-results.json`：开发窗口 8 组验收，错误列表为空，原业务数据已恢复。
- `artifacts/release-results.json`：Release 两个真实进程启动、离线操作及重启验证记录。
- `artifacts/native-export.json`：通过原生保存对话框写出的通用数据 JSON。
- `artifacts/release-dashboard.png` 与 `artifacts/release-settings-dark.png`：实际发行程序截图，可能含本机个人资料，不应提交。
- `artifacts/release-files.json`：EXE 和安装包的实际大小及 SHA256。

## 启动与安装

1. 本机快速验收：双击 `src-tauri/target/release/local-workbench.exe`。应用文件约 4.99 MiB，需要已有 WebView2，本机已具备。
2. 安装：运行 `src-tauri/target/release/bundle/nsis/Local Workbench_0.1.0_x64-setup.exe`，按向导完成安装。约 209.67 MiB，携带官方 WebView2 离线 Runtime。
3. 开发：`npm ci`，然后 `npm run tauri dev`。
4. 再构建：`npm run tauri build`。

系统数据目录：`%APPDATA%\org.localworkbench.desktop`。双击 EXE 和安装版共用此目录。个人 JSON 不随安装包分发；本机初始化结果已写入本机 SQLite。

## 已知边界与后续建议

- 安装包未签名，发布前可增加 Windows 代码签名及干净系统安装测试。
- 自动恢复备份没有轮换策略；后续优先增加定期备份和自动清理。
- 删除当前依靠确认和完整备份恢复；后续可增加回收站/撤销。
- 暂不包含系统通知、循环任务、跨午夜时间段、拖拽日历、任务依赖、云同步或加密。跨日安排目前拆成不同日期的日程。
- Vite 构建会对 Zod 包内两条纯函数注释发出非阻断提示，生产产物正常生成，验收无运行错误。
- 保留了图标生成工具附带的多平台尺寸文件，它们不影响 Windows 安装包及应用体积。
