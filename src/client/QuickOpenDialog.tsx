import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { nextListIndex, type ListNavigationKey } from './list-navigation.ts'
import type { EditorLocation } from './navigation/editor-navigation.ts'
import css from './ide.module.css'

export type QuickInputNavigationKey = Exclude<ListNavigationKey, 'Home' | 'End'>

export function isQuickInputNavigationKey(key: string): key is QuickInputNavigationKey {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'PageDown' || key === 'PageUp'
}

export interface QuickInputOption {
  id: string
  label: string
  detail?: string
  shortcut?: string
  disabled?: boolean
  disabledReason?: string
  /** Compact command rows reveal secondary state only for the active item. */
  compact?: boolean
}

export interface QuickInputDialogProps<Option extends QuickInputOption = QuickInputOption> {
  open: boolean
  query: string
  options: readonly Option[]
  title: string
  inputLabel: string
  placeholder: string
  listLabel: string
  status?: ReactNode
  hint?: ReactNode
  error?: string
  busy?: boolean
  /** Supplying this value makes the active option controlled. */
  activeIndex?: number
  onActiveIndexChange?: (index: number) => void
  onQueryChange: (query: string) => void
  onSelect: (option: Option) => void
  onDismiss: () => void
  /** Called after the controlled dialog leaves its open state. */
  onRestoreFocus?: () => void
}

/**
 * Shared presentation for quick-open and command-palette style pickers.
 *
 * Keep this component mounted while switching picker modes. Its focus effect
 * is keyed only by `open`, so changing titles, options, or callbacks while the
 * modal remains open does not restore and recapture focus between modes.
 */
export function QuickInputDialog<Option extends QuickInputOption>({
  open,
  query,
  options,
  title,
  inputLabel,
  placeholder,
  listLabel,
  status,
  hint,
  error,
  busy = false,
  activeIndex: controlledActiveIndex,
  onActiveIndexChange,
  onQueryChange,
  onSelect,
  onDismiss,
  onRestoreFocus,
}: QuickInputDialogProps<Option>) {
  const [localActiveIndex, setLocalActiveIndex] = useState(options.length === 0 ? -1 : 0)
  const inputRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef(new Map<number, HTMLButtonElement>())
  const previousFocus = useRef<HTMLElement | null>(null)
  const restoreFocus = useRef(onRestoreFocus)
  const pendingRestoreFrame = useRef<number>()
  const titleId = useId()
  const statusId = useId()
  const listboxId = useId()
  const optionPrefix = useId()
  const optionSignature = useMemo(() => options.map(option => option.id).join('\u0000'), [options])
  const activeIndex = controlledActiveIndex ?? localActiveIndex

  restoreFocus.current = onRestoreFocus

  const updateActiveIndex = (index: number): void => {
    if (controlledActiveIndex === undefined) setLocalActiveIndex(index)
    onActiveIndexChange?.(index)
  }

  useEffect(() => {
    if (!open) return

    // React StrictMode replays effects as setup -> cleanup -> setup. Defer the
    // cleanup restore by one frame so the replayed setup can cancel it, while
    // a real close or unmount still restores focus exactly once.
    if (pendingRestoreFrame.current !== undefined) {
      window.cancelAnimationFrame(pendingRestoreFrame.current)
      pendingRestoreFrame.current = undefined
    }

    if (previousFocus.current === null) {
      previousFocus.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    }
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())

    return () => {
      window.cancelAnimationFrame(frame)
      pendingRestoreFrame.current = window.requestAnimationFrame(() => {
        pendingRestoreFrame.current = undefined
        if (restoreFocus.current !== undefined) restoreFocus.current()
        else previousFocus.current?.focus()
        previousFocus.current = null
      })
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    if (controlledActiveIndex === undefined) setLocalActiveIndex(options.length === 0 ? -1 : 0)
    // The stable signature avoids resetting selection when a parent recreates
    // equivalent option objects during an unrelated render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledActiveIndex, open, optionSignature, query])

  const selectedIndex = options.length === 0
    ? -1
    : Math.min(Math.max(activeIndex, 0), options.length - 1)

  useEffect(() => {
    if (!open || selectedIndex < 0) return
    optionRefs.current.get(selectedIndex)?.scrollIntoView({ block: 'nearest' })
  }, [open, selectedIndex])

  if (!open) return null

  const activeOptionId = selectedIndex < 0 ? undefined : `${optionPrefix}-${selectedIndex}`

  const choose = (index: number): void => {
    const option = options[index]
    if (option !== undefined && option.disabled !== true) onSelect(option)
  }

  const dialog = (
    <div
      className={css.quickOpenBackdrop}
      onMouseDown={event => {
        if (event.target === event.currentTarget) onDismiss()
      }}
    >
      <div
        className={css.quickOpenDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onDismiss()
          } else if (event.key === 'Tab') {
            // The combobox owns listbox focus through aria-activedescendant.
            // Keep keyboard focus inside this one-control modal.
            event.preventDefault()
            inputRef.current?.focus()
          }
        }}
      >
        <h2 id={titleId} className={css.visuallyHidden}>{title}</h2>
        <label className={css.quickOpenInputRow}>
          <span className={css.visuallyHidden}>{inputLabel}</span>
          <input
            ref={inputRef}
            className={css.quickOpenInput}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeOptionId}
            aria-describedby={statusId}
            aria-invalid={error !== undefined ? 'true' : undefined}
            value={query}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            onChange={event => onQueryChange(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                choose(selectedIndex)
                return
              }
              if (event.altKey || event.ctrlKey || event.metaKey) return
              // Home/End remain native text-editing keys in the editable
              // combobox. Only directional and paging keys move the list.
              if (!isQuickInputNavigationKey(event.key)) return
              event.preventDefault()
              updateActiveIndex(nextListIndex(selectedIndex, options.length, event.key))
            }}
          />
          {busy ? <span className={css.quickOpenSpinner} aria-hidden="true" /> : null}
        </label>

        <div id={statusId} className={css.quickOpenStatus} aria-live="polite" aria-atomic="true">
          {error === undefined ? status : null}
        </div>

        <div id={listboxId} className={css.quickOpenList} role="listbox" aria-label={listLabel}>
          {options.map((option, index) => {
            const selected = index === selectedIndex
            const disabled = option.disabled === true
            return (
              <button
                id={`${optionPrefix}-${index}`}
                key={option.id}
                ref={element => {
                  if (element === null) optionRefs.current.delete(index)
                  else optionRefs.current.set(index, element)
                }}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={selected}
                aria-disabled={disabled || undefined}
                className={selected ? css.quickOpenOptionActive : css.quickOpenOption}
                data-compact={option.compact || undefined}
                data-disabled={disabled || undefined}
                onMouseEnter={() => updateActiveIndex(index)}
                onMouseDown={event => event.preventDefault()}
                onClick={() => choose(index)}
              >
                <span className={css.quickOpenOptionText}>
                  <span className={css.quickOpenOptionLabel}>{option.label}</span>
                  {option.detail === undefined || option.detail.length === 0 || option.compact === true && !selected
                    ? null
                    : <span className={css.quickOpenOptionDetail}>{option.detail}</span>}
                  {disabled && option.disabledReason !== undefined && (option.compact !== true || selected)
                    ? <span className={css.quickOpenOptionReason}>{option.disabledReason}</span>
                    : null}
                </span>
                {option.shortcut === undefined || option.shortcut.length === 0
                  ? null
                  : <kbd className={css.quickOpenOptionShortcut}>{option.shortcut}</kbd>}
              </button>
            )
          })}
        </div>

        {error !== undefined ? <div className={css.quickOpenError} role="alert">{error}</div> : null}
        {hint === undefined ? null : <div className={css.quickOpenHint}>{hint}</div>}
      </div>
    </div>
  )
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}

export interface QuickOpenOption {
  id: string
  path: string
  location?: EditorLocation
  label?: string
  detail?: string
}

export interface QuickOpenDialogProps {
  open: boolean
  query: string
  options: readonly QuickOpenOption[]
  searching: boolean
  truncated?: boolean
  error?: string
  onQueryChange: (query: string) => void
  onOpen: (option: QuickOpenOption) => void
  onDismiss: () => void
  /** Called after the controlled dialog leaves its open state. */
  onRestoreFocus?: () => void
}

function basename(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || path
}

interface QuickOpenInputOption extends QuickInputOption {
  source: QuickOpenOption
}

export function QuickOpenDialog({
  open,
  query,
  options,
  searching,
  truncated = false,
  error,
  onQueryChange,
  onOpen,
  onDismiss,
  onRestoreFocus,
}: QuickOpenDialogProps) {
  const inputOptions = useMemo<QuickOpenInputOption[]>(() => options.map(option => {
    const label = option.label ?? basename(option.path)
    return {
      id: option.id,
      label,
      detail: option.detail ?? (label === option.path ? '' : option.path),
      source: option,
    }
  }), [options])

  const status = searching
    ? 'Searching files…'
    : options.length === 0
      ? query.length === 0 ? 'Type a file name to search.' : 'No matching files.'
      : `${options.length} file${options.length === 1 ? '' : 's'} found${truncated ? '; results truncated' : ''}.`

  return (
    <QuickInputDialog
      open={open}
      query={query}
      options={inputOptions}
      title="Quick Open"
      inputLabel="Search files by name"
      placeholder="Search files by name"
      listLabel="Matching files"
      status={status}
      hint={truncated && error === undefined ? 'Keep typing to narrow the truncated result set.' : undefined}
      busy={searching}
      {...(error === undefined ? {} : { error })}
      onQueryChange={onQueryChange}
      onSelect={option => onOpen(option.source)}
      onDismiss={onDismiss}
      {...(onRestoreFocus === undefined ? {} : { onRestoreFocus })}
    />
  )
}
