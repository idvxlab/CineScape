import { create } from './tinyStore'

export type Tab = 'preview' | 'edit'

interface EditorState {
  tab: Tab
  setTab: (t: Tab) => void
}

export const useEditor = create<EditorState>((set) => ({
  tab: 'preview',
  setTab: (tab) => set({ tab }),
}))
