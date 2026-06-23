import { useEditor } from '../../state/useEditor'
import { useProject } from '../../state/ProjectContext'
import { PreviewTab } from './preview/PreviewTab'
import { EditTab } from './edit/EditTab'

export function CenterPanel() {
  const tab = useEditor((s) => s.tab)
  const setTab = useEditor((s) => s.setTab)
  const { ready } = useProject()
  return (
    <div className="card flex min-h-0 flex-col">
      <div className="flex items-center justify-center gap-10 border-b border-[#eef1f4] py-3">
        {(['preview', 'edit'] as const).map((t) => (
          <button
            key={t}
            onClick={() => ready && setTab(t)}
            disabled={!ready}
            className={`relative pb-1 text-[15px] font-semibold transition ${
              !ready ? 'cursor-default text-gray-300' : tab === t ? 'text-brand' : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            {t === 'preview' ? 'Preview' : 'Edit'}
            {ready && tab === t && <span className="absolute -bottom-[13px] left-0 h-0.5 w-full rounded bg-brand" />}
          </button>
        ))}
      </div>
      <div className={`min-h-0 flex-1 p-5 ${tab === 'preview' ? 'overflow-auto' : 'overflow-hidden'}`}>
        {!ready ? <CenterEmpty /> : tab === 'preview' ? <PreviewTab /> : <EditTab />}
      </div>
    </div>
  )
}

function CenterEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-4 grid h-20 w-20 place-items-center rounded-full bg-[#f1f3f6] text-3xl text-gray-400">🎬</div>
      <div className="text-[17px] font-semibold text-gray-700">Your shot plan will appear here</div>
      <div className="mt-1.5 max-w-sm text-[13px] text-gray-400">after you upload a source and describe your intent.</div>
      <div className="mt-1 max-w-sm text-[12px] text-gray-300">We'll break your story into shots and sequences.</div>
    </div>
  )
}
