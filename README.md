# OmniSense

> 版本 `0.1.0` · Chrome Manifest V3 · 全部推理在本机完成，内容不上传

一个完全在浏览器本地运行的 AI 增强套件。8 个功能共享同一个本地模型与同一份本地存储，不依赖任何后端服务，不上传页面内容。

无 API 密钥、无 token 账单、断网可用。

---

## 核心能力

| 能力 | 说明 |
|---|---|
| 端侧推理 | WebLLM 承担生成式任务，Transformers.js / ONNX Runtime 承担向量检索 |
| 划词语气改写 | 选中任意文本，一键切换 6 种风格（专业严谨 / 高情商 / 幽默风趣 / 学术 / 赛博朋克…） |
| 毒舌点评 | 针对页面内容做犀利解构，戳破营销套路与标题党 |
| 长文提炼 | 一键生成核心结论与结构化大纲 |
| 时光胶囊 | 本地向量语义记忆，用模糊自然语言召回历史浏览 |
| 隐私扫描 | 探测页面指纹追踪与表单泄露风险 |
| 广告净化 | 基于声明式网络规则静默移除视觉噪点 |
| 朗读 | 文本转语音，支持平滑控制 |

---

## 技术架构

四个运行上下文协作：

- **content script** — 注入页面，捕获划词、扫描隐私、执行净化
- **service worker** — 调度与消息路由，管理模型生命周期
- **offscreen document** — 离屏执行计算密集任务，避免阻塞主线程
- **side panel** — 用户界面的常驻工作区

核心库位于 `shared/`：IndexedDB 封装、语音合成、Markdown 渲染、国际化、token 预算控制。

模型权重本地离线加载，首次使用需数秒初始化（磁盘读取，非网络下载）。

---

## 项目结构

```
OmniSense/
├── manifest.json          扩展清单与权限声明
├── background.js          调度与消息路由
├── offscreen.js           离屏计算
├── offscreen.html         离屏环境入口
├── content/               页面注入层
│   ├── capsule-capture.js     划词捕获
│   ├── selection-pill.js      悬浮胶囊
│   ├── cosmetic-filter.js     声明式净化
│   ├── privacy-scan.js        隐私扫描
│   ├── pattern-radar.js       模式识别
│   ├── readability-inject.js  可读性注入
│   ├── zen-reader.js          沉浸阅读
│   └── read-along.js          朗读
├── sidepanel/             侧边栏工作台
├── options/               设置页
├── onboarding/            首次引导
├── shared/                核心库
│   ├── idb.js                 IndexedDB 封装
│   ├── speech.js              语音合成
│   ├── markdown.js            Markdown 渲染
│   ├── i18n.js                国际化
│   ├── token-budget.js        token 预算控制
│   ├── messaging.js           消息封装
│   ├── styles.css             共享样式
│   └── constants.js           常量
├── i18n/                  语言资源（zh / en）
├── rules/                 声明式过滤规则
├── e2e/                   端到端测试脚本
├── scripts/               商店素材打包
└── brand/                 品牌资源
```

---

## 开发

```bash
# 端到端测试（需先安装依赖）
npm install
node e2e/run-e2e.cjs

# 单项自检
node e2e/selftest-features-all.cjs
node e2e/selftest-speech.cjs

# 多语言检查
node e2e/check-i18n.cjs
```

### 安装为本地扩展

1. 打开 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选中项目根目录

---

## 性能预期

| 设备条件 | 可用能力 |
|---|---|
| 8GB+ 内存，支持 WebGPU | 全部功能（含生成式） |
| 弱设备或无 WebGPU | 自动降级为仅向量检索（时光胶囊、净化、隐私扫描） |

降级是明确的边界声明，不是故障。划词改写与毒舌点评在弱设备上会提示不可用。

---

## 隐私

- 模型权重随安装包本地加载，全程不联网
- 语义记忆向量存于 IndexedDB，不出设备
- 无账号体系、无行为埋点、无远端中转

想自行验证：打开浏览器开发者工具的网络面板，操作全部功能，确认无指向非本机域名的请求。

---

## 文档

- [FEATURES.md](FEATURES.md) — 功能总览，区分「已自动化验证」与「需人工确认」
- [TEST_REPORT.md](TEST_REPORT.md) — 测试记录

---

## License

MIT
