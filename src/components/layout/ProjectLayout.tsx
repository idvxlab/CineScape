import { LeftPanel } from '../left/LeftPanel'
import { CenterPanel } from '../center/CenterPanel'
import { RightPanel } from '../right/RightPanel'
import { useProject } from '../../state/ProjectContext'

export function ProjectLayout() {
  const { dirty, saveProject } = useProject()
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-[#e8ebee] bg-white px-5 py-3">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand text-white">🎬</div>
        <div className="leading-tight">
          <div className="text-[17px] font-bold">Intent-to-Cinema</div>
          <div className="text-xs text-gray-400">See your story intent through the language of the lens</div>
        </div>
        <div className="flex-1" />
        <button className="btn" onClick={() => saveProject()}>
          💾 Save Plan{dirty ? ' *' : ''}
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)_320px] gap-4 p-4">
        <LeftPanel />
        <CenterPanel />
        <RightPanel />
      </div>
    </div>
  )
}
