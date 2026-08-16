# Live2D 桌宠 (live2d-desktop-pet)

基于 Electron + PixiJS + pixi-live2d-display + MediaPipe 的 Live2D 桌面宠物，重音テト 主题。
纯本地运行：模型、语音识别、语音合成全部离线，仅 AI 对话走 DeepSeek API。

## 功能

**Live2D 本体**
- 🎭 加载本地模型（Cubism 4/5，`.model3.json` + `.moc3`，支持 moc3 v5）
- 👀 视线跟随鼠标（头、眼球、身体朝向光标）
- 🖱️ 点击不同部位触发不同表情；右键弹菜单
- 😊 表情系统 + 形态系统（表情列表后四个可单选持续生效，其余点击临时 3 秒）
- 🔄 多模型切换、模型文件夹扫描
- 📏 大小调整（滚轮 / 双击边框拖角）、透明无边框、置顶可选、位置记忆
- 📹 摄像头面部捕捉（MediaPipe：摆头/点头/歪头/眨眼/张嘴/微笑，灵敏度可调，预览小窗）
- 🛏️ 睡觉/叫醒、智能点击穿透、失焦降帧省电

**AI 对话（DeepSeek）**
- 💬 气泡 + 输入条 + 🎤 语音输入；人设切换（活泼/高冷/温柔）
- 🌐 联网搜索：function calling 让模型自主决定是否搜索（Bing），不需要时不搜
- 🧠 思考模式开关（气泡显示思考过程，语音只读最终回答）
- 📜 完整历史记录窗口（不受 100KB 记忆滑动窗口影响），可清空
- 🔊 语音朗读：**Piper 本地合成，中日英三语混说**（按字符切段分模型合成拼接）

**语音输入（全离线）**
- 🎙️ 本地识别：**sherpa-onnx + SenseVoice**（中/日/英，0.1 秒级，几乎不幻觉；whisper 作兜底）
- 三种麦克风模式：点击说话 / 长按说话 / **全程监听**（能量 VAD 断句自动识别发送）
- VAD 灵敏度可调（0.1~0.95，风扇吵可调高）；朗读回声抑制滑块（接变声器可调大）
- 识别结果自动繁转简、幻觉文本清洗、TTS 期间暂停监听防回环

## 快速开始

环境要求：Node.js ≥ 16（推荐 18+）。

```bash
npm install
npm start
```

或双击 `启动桌宠.bat`（推荐）。诊断渲染问题用 `诊断模式.bat`。

首次启动自动收录模型：
- `D:\重音テト\VTS Model File\重音テト`（默认模型）
- 本项目 `models\` 文件夹

## 添加 / 切换模型

1. 右键宠物 → 模型 → 添加模型…，选 `model3.json`
2. 或复制模型文件夹到 `models\`，右键 → 模型 → 刷新模型列表

## AI 对话配置

1. 右键 → AI 对话 → 开启对话
2. 右键 → AI 对话 → AI 对话设置…：填 DeepSeek API Key、选模型（deepseek-v4-flash/pro）、人设、记忆轮数、气泡时长、音频设备
3. 可选开关：联网搜索、思考模式、麦克风交互方式、VAD 灵敏度、朗读回声抑制

配置持久化于 `%APPDATA%\live2d-desktop-pet\config.json`。

## 语音组件下载（vendor/ 均不随 git 提交）

| 组件 | 用途 | 下载 |
| --- | --- | --- |
| `vendor/piper/` | TTS 引擎 + 中/日/英声线（约 330MB） | `node tools/download-piper.js`（中文）、`node tools/download-ja-voice.js`（日语，含 piper1.2 兼容补丁）、`node tools/download-en-voice.js`（英语） |
| `vendor/sherpa/` | 语音识别（SenseVoice 228MB + silero VAD） | `node tools/download-sherpa.js` |
| `vendor/whisper/` | 识别兜底引擎（可选，465MB） | `node tools/download-whisper.js` |

下载脚本支持直连 + 本地代理（127.0.0.1:7897）双通道。

## 技术要点（踩坑记录）

1. **Cubism5 + pixi-live2d-display@0.4.0（Cubism4 时代库）适配**：绘制前调 native `model.update()` 同步参数；禁用每帧 `loadParameters()`；补 expression 每帧更新；`shouldOverrideExpression=false`；渲染分辨率 = 系统 DPI（透明窗口高 DPI 只显示左上角）
2. **SenseVoice 输出解析**：Windows CRLF 行尾会吞识别结果，必须按 `\r?\n` 分行
3. **TTS 回声回环**：麦克风听到自己的朗读 → 朗读期间 + 结束后可配置时长内暂停监听
4. **whisper 静音幻觉**（“字幕製作:貝爾”类）→ 换 SenseVoice 根治，残留清洗正则 + 繁转简兜底
5. **函数调用搜索**：不支持 tools 的 API 自动降级普通单次调用

## 目录结构

```
live2d-desktop-pet/
├── main.js            # 主进程：窗口、协议、托盘菜单、AI 对话/搜索/TTS、语音识别
├── preload.js         # IPC 桥接
├── renderer/          # 渲染进程：模型加载、交互、面捕、聊天 UI、全程监听 VAD
├── tools/             # 各组件下载脚本（下载后 vendor 生效）
├── vendor/            # 本地模型/引擎（gitignore）：piper、sherpa、whisper、Cubism 核心
├── models/            # 放置模型
├── 启动桌宠.bat / 诊断模式.bat
└── README.md
```

## Token 消耗记录

> 口径：模型输入+输出+工具调用往返（1 token ≈ 0.75 英文词 / 约 0.5~0.6 汉字），累计值以控制台实测为准。

| 日期 | 阶段 | 累计约消耗 |
| --- | --- | --- |
| 2026-08-15 | MVP → 渲染管线 → 面捕 → 表情 → 交互细节 | 1.14 亿（约 10 元） |
| 2026-08-16 | AI 对话+联网搜索+思考模式+历史记录+语音输入(SenseVoice)+中日英 TTS（含 CosyVoice2 试错后移除） | **4.45 亿（约 23 元）** |

> 后续迭代在此追加。
