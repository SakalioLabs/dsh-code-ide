import { TERMINAL_CAPABILITY, type TerminalProviderContext } from './capabilities.js'
import { TerminalHost } from './terminal.js'

export interface TerminalProviderConfig {
  terminalShell: string
  terminalArgs: string[]
  maxTerminalSessions: number
  maxTerminalMessageBytes: number
  maxTerminalInputBytes: number
  maxTerminalBufferedBytes: number
}

/** Own the native PTY lifecycle behind a versioned capability. */
export function terminalProvider(ctx: TerminalProviderContext, config: TerminalProviderConfig): void {
  const terminal = new TerminalHost(ctx.workspaceRegistry, {
    shell: config.terminalShell,
    shellArgs: config.terminalArgs,
    maxMessageBytes: config.maxTerminalMessageBytes,
    maxInputBytes: config.maxTerminalInputBytes,
    maxBufferedBytes: config.maxTerminalBufferedBytes,
    maxSessions: config.maxTerminalSessions,
    logger: ctx.logger,
  })

  // See workspace-files-provider: explicit nesting avoids relying on sibling
  // effect disposal order/concurrency for the consumer-before-resource fence.
  ctx.effect(() => {
    const withdraw = ctx.provide(TERMINAL_CAPABILITY, terminal) as () => void | Promise<void>
    return async () => {
      await withdraw()
      await terminal.dispose()
    }
  }, 'dsh-code-ide: terminal capability')
}

terminalProvider.inject = ['workspaceRegistry']
terminalProvider.provide = TERMINAL_CAPABILITY
