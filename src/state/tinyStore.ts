import { useSyncExternalStore } from 'react'

// Minimal store (replaces zustand, avoids the dependency). Used only for a bit of frontend UI state.
type SetState<T> = (partial: Partial<T> | ((s: T) => Partial<T>)) => void

export function create<T extends object>(init: (set: SetState<T>) => T) {
  let state: T
  const listeners = new Set<() => void>()
  const set: SetState<T> = (partial) => {
    const next = typeof partial === 'function' ? (partial as (s: T) => Partial<T>)(state) : partial
    state = { ...state, ...next }
    listeners.forEach((l) => l())
  }
  state = init(set)
  const subscribe = (l: () => void) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }
  return function useStore<U = T>(selector: (s: T) => U = (s) => s as unknown as U): U {
    return useSyncExternalStore(
      subscribe,
      () => selector(state),
      () => selector(state),
    )
  }
}
