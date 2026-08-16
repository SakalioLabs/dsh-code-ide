export type ListNavigationKey =
  | 'ArrowDown'
  | 'ArrowUp'
  | 'End'
  | 'Home'
  | 'PageDown'
  | 'PageUp'

const navigationKeys = new Set<string>([
  'ArrowDown',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
])

export function isListNavigationKey(key: string): key is ListNavigationKey {
  return navigationKeys.has(key)
}

export function nextListIndex(
  currentIndex: number,
  itemCount: number,
  key: ListNavigationKey,
  pageSize = 8,
): number {
  if (itemCount <= 0) return -1

  const current = currentIndex >= 0 && currentIndex < itemCount ? currentIndex : 0
  const page = Math.max(1, Math.floor(pageSize))

  switch (key) {
    case 'ArrowDown': return Math.min(itemCount - 1, current + 1)
    case 'ArrowUp': return Math.max(0, current - 1)
    case 'End': return itemCount - 1
    case 'Home': return 0
    case 'PageDown': return Math.min(itemCount - 1, current + page)
    case 'PageUp': return Math.max(0, current - page)
  }
}
