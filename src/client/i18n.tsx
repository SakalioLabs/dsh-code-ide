import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type IdeLocale = 'en' | 'zh'
export const IDE_LOCALE_MESSAGE_TYPE = 'dsh-code-ide/locale'

const EN = {
  explorer: 'Explorer', search: 'Search', open: 'Open…', commands: 'Commands…',
  terminal: 'Terminal', harness: 'Harness', newFile: 'New File', newFolder: 'New Folder',
  copyRelativePath: 'Copy Relative Path', rename: 'Rename', deletePermanently: 'Delete Permanently',
  collapseFolders: 'Collapse Folders in Explorer', refreshExplorer: 'Refresh Explorer',
  filesIn: 'Files in {name}', explorerActions: 'Explorer actions', actionsFor: 'Actions for {name}',
  noWorkspaceSelected: 'No workspace selected', openFileFromExplorer: 'Open a file from Explorer',
  loadingTerminalCapacity: 'Loading terminal capacity…', terminalSessions: 'Terminal sessions',
  newTerminal: 'New terminal', clearTerminal: 'Clear terminal', findInTerminal: 'Find in terminal',
  renameTerminal: 'Rename terminal', restartTerminal: 'Restart terminal',
  interruptTerminal: 'Interrupt terminal', killTerminal: 'Kill terminal',
  killNamedTerminal: 'Kill {name}', moreActions: 'More actions', noWorkspace: 'No workspace',
  terminalSessionCount: '{count} terminal sessions', terminalActions: 'Terminal panel actions',
  maximizePanel: 'Maximize panel', restorePanel: 'Restore panel size',
  collapsePanel: 'Collapse panel', expandPanel: 'Expand panel',
  stopping: 'Stopping…', selectWorkspaceForTerminal: 'Select a workspace to start a terminal',
  noTerminal: 'No terminal. Create one to get started.', searchTerminalBuffer: 'Search terminal buffer',
  previousMatch: 'Previous match', previousMatchWithKey: 'Previous match (Shift+Enter)',
  nextMatch: 'Next match', nextMatchWithKey: 'Next match (Enter)', closeFind: 'Close find',
  noResults: 'No results', searchLength: 'Enter 1–1,024 characters',
  searchUnavailable: 'Search unavailable', readOnly: 'Read-only', saving: 'Saving…',
  save: 'Save', saved: 'Saved', quickOpen: 'Quick Open', primarySideBar: 'Primary side bar',
  recreate: 'Recreate', dontSave: "Don't Save", dismiss: 'Dismiss', cancel: 'Cancel',
  cannotCloseFile: 'Cannot close {name}', recreateFileQuestion: 'Recreate {name}?',
  saveChangesQuestion: 'Save changes to {name}?',
  resolveBeforeClose: 'Resolve this issue before trying to close the editor again.',
  deletedFileRecreateDescription: 'This file was deleted outside the IDE. Recreate it with your unsaved changes before closing?',
  saveBeforeCloseDescription: 'Do you want to save your changes before closing?',
  recreatingBeforeClose: 'Recreating file before closing...',
  savingBeforeClose: 'Saving changes before closing...',
  editorStatus: 'Editor status', cursorPosition: 'Ln {line}, Col {column}',
  goToLineColumn: 'Go to Line/Column…', changeLanguageMode: 'Change Language Mode…',
  changeIndentationSize: 'Change Indentation Size…', spacesSize: 'Spaces: {size}', tabSize: 'Tab Size: {size}',
  workspaceSearch: 'Workspace search', workspaceSearchResults: 'Workspace search results',
  searchQuery: 'Search query', searchCode: 'Search code…', searchOptions: 'Search options',
  matchCase: 'Match case', matchWholeWord: 'Match whole word',
  useRegularExpression: 'Use regular expression', stopSearch: 'Stop',
  showWorkspaceReplace: 'Show replace', hideWorkspaceReplace: 'Hide replace',
  searchDetails: 'Search details', filesToInclude: 'Files to include',
  filesToExclude: 'Files to exclude', filesToIncludePlaceholder: 'e.g. src/**',
  filesToExcludePlaceholder: 'e.g. **/dist/**', clearSearchResults: 'Clear results',
  searchingWorkspaceResults: 'Searching workspace. {results} so far.',
  workspaceSearchCancelled: 'Search cancelled.', enterWorkspaceSearchQuery: 'Enter a query to search the workspace.',
  noWorkspaceSearchResults: 'No results found.', workspaceSearchSummary: '{occurrences} in {files}{truncated}.',
  searchResultsTruncatedSuffix: '; results truncated', oneResult: '{count} result', manyResults: '{count} results',
  oneOccurrence: '{count} occurrence', manyOccurrences: '{count} occurrences',
  oneFile: '{count} file', manyFiles: '{count} files',
  dirtyBuffersOmittedFromSearch: 'Regex or file-filter results omit unsaved buffers. Save them or use plain literal search.',
  workspaceSearchTruncatedHint: 'Results are truncated. Narrow the query or file patterns.',
  workspaceReplace: 'Workspace replace', replaceWith: 'Replace with', replacementText: 'Replacement text',
  replaceActions: 'Replace actions', previewReplacement: 'Preview', refreshReplacementPreview: 'Refresh preview',
  applyReplacement: 'Apply', cancelReplacement: 'Cancel',
  replacementSafetyHint: 'Replace changes editor contents only; it does not save automatically.',
  buildingReplacementPreview: 'Building replacement preview. No editor content has changed.',
  applyingReplacements: 'Applying {replacements} to editor buffers.',
  appliedReplacements: 'Applied {replacements} to editor buffers. The changes are unsaved.',
  replacementPreviewEmpty: 'Preview contains no replacements.',
  replacementPreviewReady: '{replacements} in {files} ready to apply.',
  replacementPreview: 'Replacement preview', oneReplacement: '{count} replacement',
  manyReplacements: '{count} replacements', oneChange: '{count} change', manyChanges: '{count} changes',
  beforeReplacement: 'Before', afterReplacement: 'After',
  sourceView: 'Source', previewView: 'Preview', markdownPreview: 'Markdown preview',
  showMarkdownSource: 'Show Markdown source', showMarkdownPreview: 'Show Markdown preview',
  markdownPreviewTooLarge: 'This Markdown file is too large to preview safely. Open the source view instead.',
  markdownPreviewUnavailable: 'This Markdown file could not be previewed safely. Open the source view instead.',
  completedTask: 'Completed task', incompleteTask: 'Incomplete task',
  imagePreview: 'Image preview', videoPreview: 'Video preview', audioPreview: 'Audio preview',
  loadingMediaPreview: 'Loading media preview…', mediaPreviewFailed: 'This media file could not be displayed by the browser.',
  resizeExplorer: 'Resize Explorer', resizeTerminal: 'Resize Terminal',
} as const

export type IdeMessageKey = keyof typeof EN

const ZH: Record<IdeMessageKey, string> = {
  explorer: '资源管理器', search: '搜索', open: '打开…', commands: '命令…',
  terminal: '终端', harness: '对话', newFile: '新建文件', newFolder: '新建文件夹',
  copyRelativePath: '复制相对路径', rename: '重命名', deletePermanently: '永久删除',
  collapseFolders: '折叠资源管理器中的文件夹', refreshExplorer: '刷新资源管理器',
  filesIn: '{name} 中的文件', explorerActions: '资源管理器操作', actionsFor: '{name} 的操作',
  noWorkspaceSelected: '未选择工作区', openFileFromExplorer: '从资源管理器打开文件',
  loadingTerminalCapacity: '正在加载终端容量…', terminalSessions: '终端会话',
  newTerminal: '新建终端', clearTerminal: '清空终端', findInTerminal: '在终端中查找',
  renameTerminal: '重命名终端', restartTerminal: '重启终端', interruptTerminal: '中断终端',
  killTerminal: '关闭终端', killNamedTerminal: '关闭 {name}', moreActions: '更多操作',
  terminalSessionCount: '{count} 个终端会话', terminalActions: '终端面板操作',
  maximizePanel: '最大化面板', restorePanel: '恢复面板大小',
  collapsePanel: '折叠面板', expandPanel: '展开面板',
  noWorkspace: '无工作区', stopping: '正在停止…', selectWorkspaceForTerminal: '选择工作区以启动终端',
  noTerminal: '暂无终端。新建一个终端即可开始。', searchTerminalBuffer: '搜索终端缓冲区',
  previousMatch: '上一个匹配项', previousMatchWithKey: '上一个匹配项（Shift+Enter）',
  nextMatch: '下一个匹配项', nextMatchWithKey: '下一个匹配项（Enter）', closeFind: '关闭查找',
  noResults: '无结果', searchLength: '请输入 1–1,024 个字符', searchUnavailable: '搜索不可用',
  readOnly: '只读', saving: '正在保存…', save: '保存', saved: '已保存',
  recreate: '\u91cd\u65b0\u521b\u5efa', dontSave: '\u4e0d\u4fdd\u5b58', dismiss: '\u5173\u95ed', cancel: '\u53d6\u6d88',
  cannotCloseFile: '\u65e0\u6cd5\u5173\u95ed {name}', recreateFileQuestion: '\u91cd\u65b0\u521b\u5efa {name}\uff1f',
  saveChangesQuestion: '\u8981\u4fdd\u5b58\u5bf9 {name} \u7684\u66f4\u6539\u5417\uff1f',
  resolveBeforeClose: '\u8bf7\u5148\u89e3\u51b3\u6b64\u95ee\u9898\uff0c\u518d\u5c1d\u8bd5\u5173\u95ed\u7f16\u8f91\u5668\u3002',
  deletedFileRecreateDescription: '\u6b64\u6587\u4ef6\u5df2\u5728 IDE \u5916\u88ab\u5220\u9664\u3002\u662f\u5426\u4f7f\u7528\u672a\u4fdd\u5b58\u7684\u66f4\u6539\u91cd\u65b0\u521b\u5efa\u540e\u518d\u5173\u95ed\uff1f',
  saveBeforeCloseDescription: '\u662f\u5426\u5728\u5173\u95ed\u524d\u4fdd\u5b58\u66f4\u6539\uff1f',
  recreatingBeforeClose: '\u6b63\u5728\u91cd\u65b0\u521b\u5efa\u6587\u4ef6\u5e76\u5173\u95ed\u2026',
  savingBeforeClose: '\u6b63\u5728\u4fdd\u5b58\u66f4\u6539\u5e76\u5173\u95ed\u2026',
  quickOpen: '快速打开', primarySideBar: '主侧边栏',
  editorStatus: '编辑器状态', cursorPosition: '行 {line}，列 {column}',
  goToLineColumn: '转到行/列…', changeLanguageMode: '更改语言模式…',
  changeIndentationSize: '更改缩进大小…', spacesSize: '空格: {size}', tabSize: '制表符宽度: {size}',
  workspaceSearch: '工作区搜索', workspaceSearchResults: '工作区搜索结果',
  searchQuery: '搜索内容', searchCode: '搜索代码…', searchOptions: '搜索选项',
  matchCase: '区分大小写', matchWholeWord: '全词匹配',
  useRegularExpression: '使用正则表达式', stopSearch: '停止',
  showWorkspaceReplace: '展开替换', hideWorkspaceReplace: '收起替换',
  searchDetails: '搜索详情', filesToInclude: '包含文件',
  filesToExclude: '排除文件', filesToIncludePlaceholder: '例如 src/**',
  filesToExcludePlaceholder: '例如 **/dist/**', clearSearchResults: '清除结果',
  searchingWorkspaceResults: '正在搜索工作区，当前找到 {results}。',
  workspaceSearchCancelled: '搜索已取消。', enterWorkspaceSearchQuery: '输入内容以搜索工作区。',
  noWorkspaceSearchResults: '未找到结果。', workspaceSearchSummary: '{occurrences}，位于 {files}{truncated}。',
  searchResultsTruncatedSuffix: '；结果已截断', oneResult: '{count} 个结果', manyResults: '{count} 个结果',
  oneOccurrence: '{count} 处匹配', manyOccurrences: '{count} 处匹配',
  oneFile: '{count} 个文件', manyFiles: '{count} 个文件',
  dirtyBuffersOmittedFromSearch: '正则或文件筛选搜索不包含未保存缓冲区。请先保存，或使用普通文本搜索。',
  workspaceSearchTruncatedHint: '结果已截断，请缩小搜索内容或文件范围。',
  workspaceReplace: '工作区替换', replaceWith: '替换为', replacementText: '替换文本',
  replaceActions: '替换操作', previewReplacement: '预览更改', refreshReplacementPreview: '刷新预览',
  applyReplacement: '应用', cancelReplacement: '取消',
  replacementSafetyHint: '替换只修改编辑器内容，不会自动保存。',
  buildingReplacementPreview: '正在生成替换预览，编辑器内容尚未更改。',
  applyingReplacements: '正在将 {replacements} 应用到编辑器缓冲区。',
  appliedReplacements: '已将 {replacements} 应用到编辑器缓冲区，更改尚未保存。',
  replacementPreviewEmpty: '预览中没有可替换内容。',
  replacementPreviewReady: '{replacements}，位于 {files}，可以应用。',
  replacementPreview: '替换预览', oneReplacement: '{count} 处替换',
  manyReplacements: '{count} 处替换', oneChange: '{count} 处更改', manyChanges: '{count} 处更改',
  beforeReplacement: '替换前', afterReplacement: '替换后',
  sourceView: '源码', previewView: '预览', markdownPreview: 'Markdown 预览',
  showMarkdownSource: '显示 Markdown 源码', showMarkdownPreview: '显示 Markdown 预览',
  markdownPreviewTooLarge: '此 Markdown 文件过大，无法安全预览，请切换到源码视图。',
  markdownPreviewUnavailable: '无法安全生成此 Markdown 文件的预览，请切换到源码视图。',
  completedTask: '已完成任务', incompleteTask: '未完成任务',
  imagePreview: '图片预览', videoPreview: '视频预览', audioPreview: '音频预览',
  loadingMediaPreview: '正在加载媒体预览…', mediaPreviewFailed: '浏览器无法显示此媒体文件。',
  resizeExplorer: '调整资源管理器大小', resizeTerminal: '调整终端大小',
}

const DICTIONARIES: Record<IdeLocale, Record<IdeMessageKey, string>> = { en: EN, zh: ZH }

export function normalizeIdeLocale(value: unknown): IdeLocale | undefined {
  if (value === 'zh' || value === 'zh-CN' || value === 'zh-Hans') return 'zh'
  if (value === 'en' || typeof value === 'string' && value.startsWith('en-')) return 'en'
  return undefined
}

export function ideLocaleFromSearch(search: string): IdeLocale {
  return normalizeIdeLocale(new URLSearchParams(search).get('locale')) ?? 'en'
}

export function ideLocaleFromMessage(
  event: Pick<MessageEvent, 'data' | 'origin' | 'source'>,
  expectedOrigin: string,
  expectedSource: MessageEventSource | null,
): IdeLocale | undefined {
  if (event.origin !== expectedOrigin || event.source !== expectedSource) return undefined
  if (typeof event.data !== 'object' || event.data === null) return undefined
  const payload = event.data as { readonly type?: unknown; readonly locale?: unknown }
  if (payload.type !== IDE_LOCALE_MESSAGE_TYPE) return undefined
  return normalizeIdeLocale(payload.locale)
}

function formatMessage(
  template: string,
  values?: Readonly<Record<string, string | number>>,
): string {
  if (values === undefined) return template
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (token, name: string) => (
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : token
  ))
}

interface IdeI18nValue {
  readonly locale: IdeLocale
  readonly t: (key: IdeMessageKey, values?: Readonly<Record<string, string | number>>) => string
}

const FALLBACK_CONTEXT: IdeI18nValue = {
  locale: 'en',
  t: (key, values) => formatMessage(EN[key], values),
}
const IdeI18nContext = createContext<IdeI18nValue>(FALLBACK_CONTEXT)

export function IdeI18nProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [locale, setLocale] = useState<IdeLocale>(() => ideLocaleFromSearch(window.location.search))
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const next = ideLocaleFromMessage(event, window.location.origin, window.parent)
      if (next !== undefined) setLocale(next)
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [])
  useLayoutEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  }, [locale])
  const value = useMemo<IdeI18nValue>(() => ({
    locale,
    t: (key, values) => formatMessage(DICTIONARIES[locale][key], values),
  }), [locale])
  return <IdeI18nContext.Provider value={value}>{children}</IdeI18nContext.Provider>
}

export function useIdeI18n(): IdeI18nValue {
  return useContext(IdeI18nContext)
}
