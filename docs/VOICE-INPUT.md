# 语音输入：使用、实现与验收

本轮范围为输入辅助：录音、识别、编辑回填、手动发送。未增加语音播报、实时字幕或免确认的业务写入。

## 使用

1. 在助手的 API 设置中配置 DeepSeek Key；Windows 需有可用的默认输入设备，并允许桌面应用访问麦克风。
2. 点击输入框右下角麦克风，胶囊向左展开，显示真实音量波形、时长和停止按钮；模型选择和发送按钮按相同缓动向左移动。
3. 再点击停止，立即释放麦克风，胶囊维持展开，按钮转为识别转圈。DeepSeek 目前是整段音频识别，不显示伪造的实时文字。
4. 成功后文字回填，胶囊和相邻按钮同步收回，恢复麦克风。原文字未变时按录音开始处的光标/选区插入；录音期间有新编辑时追加到最新内容，避免覆盖新文字。
5. 核对、修改后再手动发送。录音/识别期间发送按钮禁用，Enter 不发送。Agent 的查询、表单、业务确认逻辑不变。

单段最多 120 秒，到上限自动停止并识别。胶囊左端取消按钮或 Esc 可取消；切换会话、离开助手、进入 API 设置、隐藏页面等会取消当前语音会话，迟到结果不会填到其它位置。取消识别只能中止本地等待，已经上传的音频/已产生的服务费用无法撤回。

无设备、权限受限、录音过短、静音、设备断开、无文字、网络异常、账号权限/余额问题分别提示，保留已有输入。失败后重新录音，无自动网络重试，不保留原始录音供重试。

## 实现边界

- `src-tauri/src/assistant_voice.rs`：CPAL 默认麦克风采集，工作线程持有音频流；多声道合为单声道，带连续相位的加权重采样至 16kHz PCM16 WAV。最多约 3.84MB 音频数据，不依赖浏览器录音编码器、FFmpeg 或独立服务。
- 采集结束后先释放设备，再编码/上传。API Key 仍只由原生凭据模块读取，不返回前端；音频只在内存，未写入业务库、助手附件或长期文件。
- `assistant_voice_start/finish/cancel` 独立于 Agent 工具；每次有唯一会话 ID，防止重复停止/计费和旧取消影响新会话。原生采集与网络有超时，长度由原生层限制。
- `src/data/voice.ts`：原生 IPC/音量事件；`useVoiceInput.ts`：界面状态、取消、上下文检查；`src/domain/voice.ts`：保留用户编辑的文字插入。
- `src/vendor/voice-pill/`：React Bits 原组件的胶囊、滚动波形、计时视觉，适配原生受控音量、Lucide、主题变量及 SWUST 缓动，保留第三方许可。
- 胶囊实际预留宽度以 320ms、`cubic-bezier(.22,1,.36,1)` 改变；相邻按钮随同一布局同步移动。识别过程保持宽度，减少动态效果时即时变化。
- “读取工作台”只控制业务查询，不控制 ASR；点击语音会将录音发往 DeepSeek。ASR 不读取或发送任务数据库，不受 Flash/Pro 对话模型选择影响。只有点击发送后，文本才进入原有 Agent。

服务格式、时长和费用以 [DeepSeek ASR 官方说明](https://api-docs.deepseek.com/guides/asr/)为准。

## 自动检查

```powershell
npx tsc -b --pretty false
npm test
cargo test --manifest-path src-tauri/Cargo.toml --lib
node scripts/voice-ui-smoke.mjs
node scripts/runtime-ui-smoke.mjs
```

UI 脚本需要独占带 CDP 9222 的 Tauri 开发窗口。语音脚本替换实际已加载的 ESM 实例（包括 HMR 查询 URL），验证替身使用计数；不能仅导入无查询后缀的新实例，也不能给 Tauri 不可写的原生 invoke 赋值后假定拦截成功。测试使用受控音频事件，不应打开麦克风或调用付费服务。只创建/删除自身 UUID 对话，并检查原业务库和原会话未变；结束重载，恢复原模块与外观。

覆盖录音/识别/回填、光标插入、并发编辑保留、取消与迟到结果、切换设置与会话、设备/网络失败、初始化取消竞态、两分钟上限、发送禁用、手动发送、明暗/窄屏/减少动态效果，以及按钮同步位移。原生测试验证 PCM/WAV、采样相位、上限、旧 ID 取消、真实 HTTP multipart 和错误无自动重试。

## 真实 ASR 专项

只使用本机生成的合成语音，不将私人录音替换为测试夹具。会产生一次 ASR 费用；Key 由 Rust 内部读取，无需提供或打印。

```powershell
Add-Type -AssemblyName System.Speech
$voiceFixtureSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voiceFixtureFormat = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
New-Item -ItemType Directory -Path 'artifacts/voice-provider' -Force | Out-Null
$voiceFixtureSynth.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet, [System.Speech.Synthesis.VoiceAge]::NotSet, 0, [System.Globalization.CultureInfo]::GetCultureInfo('zh-CN'))
$voiceFixtureSynth.SetOutputToWaveFile((Join-Path (Get-Location) 'artifacts/voice-provider/synthetic.wav'), $voiceFixtureFormat)
$voiceFixtureSynth.Speak('明天下午安排一次集中学习。')
$voiceFixtureSynth.Dispose()
cargo test --manifest-path src-tauri/Cargo.toml actual_deepseek_asr_synthetic_fixture --lib -- --ignored --nocapture
```

需要 Windows 中文系统语音；没有该语音时先解决夹具生成，不改用用户环境录音来凑测试。结果在忽略的 `artifacts/voice-provider/`。UI 截图和帧记录在 `artifacts/voice-ui/`，可能含用户侧栏，不应公开。

## 人工验收

- 说“明天下午和明天晚上各安排一次复习”，停止识别，修改一个字再手动发送；核对两条模糊日程预览，仍须点击业务确认。
- 原来有文字时，在中间定位光标录音；录音期间再手动编辑，检查旧内容和新文字都保留。
- 录音中取消、识别中取消、识别中切到另一对话、进入设置再返回，检查设备释放与输入不串入。
- 检查默认麦克风实际音量反馈、短录音、安静环境、权限关闭和断网提示。硬件效果、口音和噪声识别质量仍需用户实际说话验收。
- 检查向左展开/向右收回时模型和发送按钮同步，识别时转圈、结束恢复麦克风，不出现滚动槽或输入框跳动。

## 验证记录

2026-11-16：70 项前端、65 项 Rust 默认测试通过，TypeScript/cargo check 通过；单独执行的真实合成语音 ASR 约 3.625 秒，识别为“明天下午安排一次集中学习。”。修正后的受控 UI 测试通过回填、取消、上下文、失败恢复、手动发送、明暗/420px窄屏/减少动态效果；展开 30→144px、收回 144→30px 的逐帧采样中，模型和发送按钮与胶囊宽度变化的位移差小于 0.001px。原助手表单/事务/取消/暂停/替换/恢复回归也通过。未构建安装包。

早期自动 UI 测试因模块实例未拦截成功而触发真实录音路径，识别请求完成情况未在现有日志中确认；这次失败不作为受控测试通过证据。随后改为核对实际加载实例并检查替身调用计数，防止同类误触发。
