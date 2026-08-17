# dsh-code-ide

**简体中文** · [English](README_en.md) · [日本語](README_ja.md) · [Deutsch](README_de.md)

<p align="center">
  <img src="docs/assets/dsh-code-ide-demo.png" alt="dsh-code-ide 演示：在 DeepSeek Harness 会话中显示资源管理器、代码编辑器和终端的浏览器 IDE 工作台" width="100%" />
</p>

`dsh-code-ide` 以可选插件的方式，为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 增加一个浏览器 IDE 工作台。它不会替换 Harness 首页、对话、会话、设置或工具界面。

> [!IMPORTANT]
> `v0.1.0-alpha.0` 是 GitHub **预发布版**，提供预构建插件包，但不发布到 npm。兼容基线仍是 DeepSeek Harness 源码提交 `47f943859bef60e4160492346772ded9b24f765a`；其他提交或 npm RC 尚不属于兼容承诺。

## 快速安装（推荐）

已安装 `dsh` 的用户只需运行：

~~~sh
dsh plugin --profile web add github:SakalioLabs/dsh-code-ide
~~~

如果你从 Harness 源码 checkout 运行，则在该目录中把上面的 `dsh` 替换为 `pnpm dsh`。本仓库已提交与源码同步的预构建 `dist/`，并且不包含安装时构建脚本；Git 安装不会在用户环境重新构建本插件，因此不需要为 `dsh-code-ide` 配置 `allowBuilds`，也不需要 clone 本插件或手工复制 patch。

### 交给 Harness 安装

把下面一句直接发给 Harness 即可：

~~~text
请将 github:SakalioLabs/dsh-code-ide 安装到当前 DeepSeek Harness 的 Web profile，并在完成后核对 plugin list 与 --dump-config 中只有一个 dsh-code-ide。
~~~

> [!CAUTION]
> 上面的 GitHub 简写会跟随仓库 `main`。需要固定到已发布版本、校验下载内容或离线留档时，请使用下方的 GitHub Release 流程。

## 它如何融入 Harness

安装后，Harness 会话顶部会新增一个原生、可选的 **IDE** 页签；默认页仍然是 **对话**。只有用户打开 IDE 页签时，工作台才会挂载。该会话的普通消息输入栏会暂时隐藏；切回对话后会原样恢复。等待用户回答的问题或审批仍具有更高优先级，不会被 IDE 隐藏。

~~~text
DeepSeek Harness /
├─ 对话（官方，默认）
├─ 轨迹（官方）
└─ IDE（本插件，可选）
   └─ /dsh-code-ide/?embedded=1&workspaceId=…
~~~

IDE 由同源路由 `/dsh-code-ide/` 提供，并嵌入官方会话区域。父级 Harness 会把当前会话的工作区、浅色/深色主题以及 `zh`/`en` 语言同步给 IDE。整个集成是增量式的，不 fork Harness 客户端，也不接管 `/`。

界面借鉴 VS Code 的工作台习惯，但它不是 Code - OSS，也没有 VS Code Extension Host 或 Marketplace 兼容层。

## 主要功能

- **资源管理器**：有界懒加载、Seti 风格文件图标、键盘导航、展开状态保留、工作区相对路径校验。
- **文件操作**：Windows x64 的本地 NTFS 工作区支持新建文件/目录、拖放移动、重命名和永久删除。通过运行时 `openat2` 探针的 Linux Host，以及通过运行时 `libSystem` 探针的 macOS x64/arm64 本地 APFS 工作区，支持新建文件和目录；移动、重命名和删除仍保持禁用。
- **编辑器**：CodeMirror 6、多标签、拖拽/键盘排序、最多 4 个编辑器分组、每文档独立撤销/选择/滚动状态、自动换行、缩进、行尾和语言模式。
- **语法高亮**：内置并按需加载 Plain Text、JavaScript、JSX、TypeScript、TSX、JSON、CSS/SCSS/Less、HTML、Markdown、Python、C、C++、Java、Go、Rust、Shell、PowerShell、YAML、XML 和 SQL。
- **保存与恢复**：版本感知保存、外部变化检测、冲突处理、删除文件重建、脏标签关闭确认，以及浏览器本地的有界 hot-exit 恢复。
- **查找与替换**：Quick Open、工作区搜索、正则/大小写/全词/include/exclude、结果导航和先预览后应用的替换。替换只修改编辑缓冲区，不会自动保存到磁盘。
- **命令与快捷键**：命令面板、可编辑的一段或两段快捷键、冲突检测和浏览器本地持久化。
- **终端**：多个命名 xterm.js 会话，工作目录为当前工作区，支持查找、清屏、重命名、重启、中断、终止、折叠和最大化。
- **布局与语言**：桌面/紧凑布局、可调整面板；IDE UI 支持简体中文和英语，并跟随 Harness 热切换。

## 环境要求

| 项目 | 要求 |
|---|---|
| DeepSeek Harness | 源码提交 `47f943859bef60e4160492346772ded9b24f765a` |
| Node.js | `^22.19.0` 或 `>=24.0.0` |
| pnpm | 本仓库固定 `10.17.0`；Harness 固定 `11.7.0` |
| 浏览器 | 现代同源浏览器，支持 WebSocket、`localStorage`、Web Locks |
| 搜索 | `@vscode/ripgrep@1.18.0` 对应平台二进制 |
| 终端 | 必须复用 Harness 提供的精确 peer `node-pty@1.1.0` |

npm 当前提供 `@deepseek-ai/dsh@0.1.0-rc.6`，但本 alpha 尚未完成对该发布版的端到端兼容验证；因此它不是本项目承诺的安装基线。不要另外编译第二份 `node-pty`。

## 手动安装（可审计的后备方案）

安装、启动、更新和卸载必须使用同一个 `DSH_HOME`。下面的 `pnpm dsh` 命令都在 Harness checkout 中运行；如果你的环境已有全局 `dsh`，可将其替换为 `dsh`。

### 1. 准备受支持的 Harness

~~~sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout 47f943859bef60e4160492346772ded9b24f765a
pnpm install --frozen-lockfile
pnpm build
~~~

### 2A. 下载并校验固定版本

Linux/macOS：

~~~sh
curl -fLO https://github.com/SakalioLabs/dsh-code-ide/releases/download/v0.1.0-alpha.0/dsh-code-ide-0.1.0-alpha.0.tgz
curl -fLO https://github.com/SakalioLabs/dsh-code-ide/releases/download/v0.1.0-alpha.0/dsh-code-ide-0.1.0-alpha.0.tgz.sha256
sha256sum -c dsh-code-ide-0.1.0-alpha.0.tgz.sha256
~~~

Windows PowerShell：

~~~powershell
$asset = "dsh-code-ide-0.1.0-alpha.0.tgz"
Invoke-WebRequest "https://github.com/SakalioLabs/dsh-code-ide/releases/download/v0.1.0-alpha.0/$asset" -OutFile $asset
Invoke-WebRequest "https://github.com/SakalioLabs/dsh-code-ide/releases/download/v0.1.0-alpha.0/$asset.sha256" -OutFile "$asset.sha256"
$expected = (Get-Content "$asset.sha256").Split()[0].ToUpperInvariant()
$actual = (Get-FileHash $asset -Algorithm SHA256).Hash
if ($actual -ne $expected) { throw "SHA-256 mismatch" }
~~~

校验通过后，从 Harness checkout 安装本地文件：

~~~sh
pnpm dsh plugin --profile web add /absolute/path/to/dsh-code-ide-0.1.0-alpha.0.tgz
~~~

这是固定版本、可校验和可离线留档的安装方式；日常快速安装使用顶部的 GitHub 简写。

### 2B. 从本地源码或本地打包安装

先在本插件仓库中构建；需要本地归档时再执行 `pnpm pack`：

~~~sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack  # 可选
~~~

然后回到 Harness checkout，安装源码目录或刚生成的 `.tgz`，二选一：

~~~sh
pnpm dsh plugin --profile web add /absolute/path/to/dsh-code-ide
# 或：pnpm dsh plugin --profile web add /absolute/path/to/dsh-code-ide-0.1.0-alpha.0.tgz
~~~

本地目录是开发工作流；修改 Host 或注入客户端后需要重新构建、重新 `add` 并重启 Harness。

### 2C. Git 快捷安装

使用与快速安装相同的 GitHub 简写：

~~~sh
pnpm dsh plugin --profile web add github:SakalioLabs/dsh-code-ide
~~~

仓库中的预构建 `dist/` 由 CI 校验，Git 安装不会执行本插件的构建脚本，也不需要 `allowBuilds`。该命令跟随滚动的 `main`；若需要可复现且带校验和的安装，请使用上面的固定 Release。

### 3. 核对并启动

~~~sh
pnpm dsh plugin --profile web list --depth 0
pnpm dsh --profile web --dump-config
pnpm dsh web
~~~

访问 `http://127.0.0.1:3080/`，进入一个已关联工作区的会话，然后选择顶部的 **IDE** 页签。`/dsh-code-ide/` 是同源诊断/工作台路由，不是对 Harness 首页的替代。

插件包会自动应用自己的 `dsh.bundle.patch`。不要再手工复制 `examples/dsh-code-ide.bundle.patch.yml`，否则会得到重复条目。`--dump-config` 中应保留全部官方 Web 条目，并且只有一个启用的 `dsh-code-ide`。

## 更新与卸载

更新前先停止 `dsh web`。GitHub 简写安装可重新运行下面的 `add`；固定版本用户改用新 Release 的 URL 或已校验本地包；本地源码安装则先重新构建。随后重启 Harness。

~~~sh
# 更新滚动 main
pnpm dsh plugin --profile web add github:SakalioLabs/dsh-code-ide

# 卸载
pnpm dsh plugin --profile web remove dsh-code-ide
~~~

卸载会从 profile 的依赖与 bundle 列表中移除插件，不会删除 Harness 会话、工作区文件，也不会自动清除浏览器 `localStorage` 中的 IDE 偏好和恢复数据。

## 使用提示

1. 在 Harness 中打开或创建一个已关联工作区的会话。
2. 选择 **IDE** 页签；工作区尚未就绪时会显示明确状态，不会静默切到另一个工作区。
3. 从资源管理器或 Quick Open 打开文本文件。
4. 编辑并显式保存；搜索替换产生的修改同样需要保存。
5. 需要 Harness 输入框时切回 **对话**。

常用快捷键：

| 操作 | Windows/Linux | macOS |
|---|---|---|
| Quick Open | `Ctrl+P` | `Cmd+P` |
| 命令面板 | `Ctrl+Shift+P` / `F1` | `Cmd+Shift+P` / `F1` |
| 保存 | `Ctrl+S` | `Cmd+S` |
| 资源管理器 / 搜索 | `Ctrl+Shift+E` / `Ctrl+Shift+F` | `Cmd+Shift+E` / `Cmd+Shift+F` |
| 跳转到行 | `Ctrl+G` | `Cmd+G` |
| 快捷键设置 | `Ctrl+K`，再 `Ctrl+S` | `Cmd+K`，再 `Cmd+S` |
| 显示/隐藏终端 | `Ctrl+反引号` | `Cmd+反引号` |
| 自动换行 | `Alt+Z` | `Option+Z` |

## 配置

默认 bundle 配置：

~~~yaml
- insert:
    - id: dsh-code-ide
      name: dsh-code-ide
      config:
        maxFileBytes: 4194304
        terminalShell: auto
~~~

| 选项 | 默认值 | 说明 |
|---|---:|---|
| `maxFileBytes` | 4 MiB | 可读写 UTF-8 文本文件上限 |
| `maxDirectoryEntries` | 5,000 | 单次目录列表的直属条目上限 |
| `terminalShell` | `auto` | Windows 使用 `COMSPEC`，Unix 使用 `SHELL`，并带回退 |
| `terminalArgs` | shell 默认 | 显式 shell 参数数组 |
| `maxTerminalSessions` | 8 | Host 活跃/待创建 PTY 上限，硬上限 64 |
| `maxConcurrentSearches` | 2 | 并发受管搜索数 |
| `searchTimeoutMs` | 30,000 | 搜索超时（毫秒） |

完整有界配置见 [`src/host/plugin.ts`](src/host/plugin.ts)。

## 安全边界与已知限制

- 仅面向本机、同源 loopback 使用。当前没有远程用户认证、TLS、进程隔离、配额或完整审计日志，不要直接暴露到局域网或互联网。
- Windows x64 的本地 NTFS 工作区使用强句柄约束（handle containment），完整支持新建文件/目录、移动/重命名和永久删除。Linux 仅在运行时 `openat2` 探针通过后支持新建文件/目录；macOS x64/arm64 仅在本地 APFS 工作区且运行时 `libSystem` 探针通过后支持新建文件/目录。Linux/macOS 的移动、重命名和删除仍禁用，其 trusted-local `dirfd` 层级只防御来自浏览器请求的路径穿越、已有或竞争性符号链接以及跨挂载访问，不抵御同 UID 本地进程主动执行 rename/reparent。探针失败时结构性操作会安全关闭；提交后结果无法确定时会进入 `recoveryRequired` 或安全关闭。浏览、编辑、保存、搜索和终端不受影响。这些保护是工作区约束，不是操作系统沙箱。
- 保存是版本感知流程，但不是跨进程原子 CAS。
- IDE 终端以运行 Harness 的操作系统用户权限执行，**不是沙箱**。环境变量只做有限敏感名称过滤。
- hot-exit、快捷键和部分恢复信息会以同源 `localStorage` 明文保存；同源代码可以访问这些数据。
- 外部文件变化使用轮询；硬刷新后不会恢复终端进程。
- 不支持 VS Code 插件、Extension Host、Marketplace、LSP 智能补全、调试器、Git UI、二进制编辑器或多根工作区。
- 日文和德文 README 只是文档翻译；当前 UI 语言只有简体中文和英语。

在处理不可信仓库前，请阅读 [`docs/security.md`](docs/security.md) 与 [`docs/compatibility.md`](docs/compatibility.md)。

## 开发

~~~sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
~~~

`build:host`、`build:client` 和 `build:harness-client` 分别构建 Host、IDE SPA 和 Harness client entry。不要手工修改 `dist/`。更多信息见 [`docs/development.md`](docs/development.md) 与 [`docs/architecture.md`](docs/architecture.md)。

## 仓库结构

~~~text
src/host/             Harness Host 插件、文件/搜索/终端服务
src/harness-client/   conversation.view 原生入口与主题/语言桥
src/client/           IDE SPA（Explorer、编辑器、搜索、终端）
src/shared/           Host/浏览器共享协议与校验
tests/                定向单元与契约测试
docs/                 架构、兼容性、安全和开发文档
~~~

## 许可证

项目使用 [MIT License](LICENSE)。随包提供的 Seti UI 文件图标同样采用 MIT，归属与固定来源记录在 [ThirdPartyNotices.txt](ThirdPartyNotices.txt)。

## 发布状态

`v0.1.0-alpha.0` 是 GitHub 预发布版，发布资产为 `dsh-code-ide-0.1.0-alpha.0.tgz` 及其 SHA-256 校验文件；它没有发布到 npm。只有该 Release 页面上的资产属于发布包，历史 Actions 测试包和本地 `tmp/` 产物不是发布资产。兼容范围仍以文档中的 Harness 固定提交为准。
