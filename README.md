# 酒馆音效精灵（精简重构版）

基于 从前跟你一样 的 st-immersive-sound 项目 https://my.feishu.cn/wiki/V0ymw4pjDia4PqkipZgcHehEnLc 精简重构：

- 每回合AI回复 → LLM按简化prompt解析出 BGM / 环境音 / 音效 / 角色语音的编排方案
- 语音供应商：**豆包（火山引擎）** + **MiMo（小米）** + **Edge-TTS（微软，免费，无需API Key）**，三选一，按角色/分类各自可指定
- 角色卡固定音色绑定；未绑定的NPC自动判断性别年龄，归入 男/女/大爷/大妈/男孩/女孩 六个兜底音色，**一旦归类就持久记住，同名NPC不会再变音色**；旁白单独一个音色
- 本地 IndexedDB 持久化保存每条生成的语音，保留"相同 cacheKey 跳过重复请求"的去重逻辑
- 基础顺序播放引擎：BGM/环境音循环 + 音效单次 + 语音顺序播放 + 语音播放时自动压低BGM/环境音音量（ducking）

## 已经砍掉的功能（相对原项目）

minimax 供应商、助眠中心、歌词播放器(卡拉OK高亮)、震动、悬浮球、离线渲染导出、外部播放器API、AI助手面板、危险正则检测、3D空间音效/混响效果器、多套LLM请求类型路由、日志面板、主题、关于页面。

## 安装

1. 把整个 `st-tavern-audio` 文件夹放到酒馆的
   `SillyTavern/data/<user>/extensions/` 或通过扩展管理器安装。
2. 重启/刷新酒馆页面，在"扩展"设置里找到"🔊 酒馆音效精灵"。

## 配置顺序建议

1. **豆包TTS / MiMo TTS**：填好鉴权信息，把你要用的音色一个个加进去（豆包需要 speaker_id + resource_id；这两个字段你之前的项目里已经在用，直接照抄即可）。
   **Edge-TTS** 不需要填任何鉴权信息，直接在下拉里选一个内置音色、按需填语速/音调/音量，起个名字保存即可。
2. **角色音色**：给主要角色卡绑定固定音色。
3. **NPC音色**：给 男/女/大爷/大妈/男孩/女孩 六类和旁白各配一个默认音色。
4. **素材库**：按 `key=url=上传者=音量` 的格式，把你的BGM/环境音/音效素材一行行贴进去。
5. **LLM解析**：填一个用来做编排的LLM（可以用便宜/快的小模型），保存后系统会用内置的 prompt 模板去解析每回合正文。
6. 打开"主设置"里的启用开关即可。

## ⚠️ 需要你确认/补充的地方

1. **豆包接口鉴权字段**：
   `X-Api-App-Key` / `X-Api-Access-Key` / `X-Api-Resource-Id` 三个请求头实现。
2. **NPC音色映射的作用域**：目前是全局的（`extension_settings` 级别，不分角色卡/不分聊天）。
3. **LLM输出格式**：约定LLM必须返回一段JSON（prompt模板里有完整格式说明）。如果你常用的模型不太听话、经常输出不规范JSON，可以在"LLM解析"页调整 prompt 模板。
4. **Edge-TTS 的稳定性说明**：它是纯浏览器端直连微软内部服务的 WebSocket 实现，无需 API Key，但也没有官方保障——微软近年加了一个基于时间戳的反爬校验（Sec-MS-GEC），代码里已经按社区通用算法实现，正常情况下能用；如果之后微软改协议或加更严格的校验导致连不上，这个供应商可能会失效。

## 目录结构

```
st-tavern-audio/
├── manifest.json
├── index.js                  # 入口：事件挂载 + 设置面板初始化
├── style.css
├── html/settings.html         # 设置面板
└── utils/
    ├── config.js              # 设置结构与默认值
    ├── pipeline.js            # 核心管线：prompt→LLM→解析→TTS→播放
    ├── prompt-builder.js      # 拼装最终发给LLM的prompt
    ├── parser.js              # 解析LLM返回的JSON编排结果
    ├── npc-voice-map.js       # 角色/NPC音色解析与持久化映射
    ├── voice-dispatch.js      # 统一语音调度（豆包/MiMo/Edge-TTS三选一 + 去重）
    ├── doubao-tts.js          # 豆包底层API
    ├── edge-tts.js            # Edge-TTS底层API（浏览器端WebSocket，免Key）
    ├── nimo-tts.js / nimo-voices.js / nimo-clone-storage.js  # MiMo（原项目移植）
    ├── tts-cache.js           # 内存缓存 + cacheKey去重
    ├── voice-audio-store.js   # 语音本地持久化（供缓存管理面板）
    ├── audio-cache.js         # BGM/音效静态素材缓存
    ├── audio-context.js       # 精简版音频总线
    ├── playback-engine.js     # 顺序播放引擎
    ├── world-info.js          # 素材库解析与模糊匹配
    ├── llm-service.js         # LLM请求（浏览器直连API）
    ├── local-kv-store.js      # 通用IndexedDB KV
    └── ui-settings.js         # 设置面板交互逻辑
```
