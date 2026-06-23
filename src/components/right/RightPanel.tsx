import { useState } from 'react'
import { useProject } from '../../state/ProjectContext'

export function RightPanel() {
  const { project, activeShot, ready, schemes, sceneVideo, animatingScheme, generateVideo } = useProject()
  const [err, setErr] = useState('')

  const generate = () => {
    setErr('')
    generateVideo().catch((e) => setErr(e?.message ?? String(e)))
  }

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="card p-3">
        <div className="mb-2 text-sm font-semibold">
          Video Preview <span className="text-xs font-normal text-gray-400">(AI-generated)</span>
        </div>
        {ready ? (
          <>
            <div className="relative overflow-hidden rounded-lg bg-black">
              {sceneVideo ? (
                <video src={sceneVideo} controls className="aspect-video w-full object-cover" />
              ) : (
                <img src={project.source.url} className="aspect-video w-full object-cover opacity-90" alt="preview" />
              )}
              {animatingScheme && (
                <div className="absolute inset-0 grid place-items-center gap-2 bg-black/55 text-sm text-white">
                  <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Generating video… (即梦, may take a while)
                </div>
              )}
            </div>
            {err && <div className="mt-1.5 text-[11px] text-rose-500">Video failed: {err}</div>}
            <button className="btn btn-primary mt-3 w-full py-2.5 disabled:opacity-50" onClick={generate} disabled={animatingScheme || schemes.length === 0}>
              {animatingScheme ? 'Generating…' : sceneVideo ? '↻ Regenerate Video' : '✨ Generate Video'}
            </button>
            {sceneVideo && <a href={sceneVideo} download className="btn mt-2 block w-full py-2.5 text-center text-brand">⬇ Download</a>}
          </>
        ) : (
          <>
            <div className="grid aspect-video w-full place-items-center rounded-lg bg-[#f1f3f6] text-center">
              <div>
                <div className="mx-auto mb-2 text-3xl text-gray-300">🎞</div>
                <div className="text-[13px] font-medium text-gray-500">No preview yet</div>
                <div className="text-[11px] text-gray-400">Generate a shot plan to see AI video previews.</div>
              </div>
            </div>
            <button className="btn btn-primary mt-3 w-full py-2.5 opacity-50" disabled>✨ Generate Video</button>
            <button className="btn mt-2 w-full py-2.5 text-gray-300" disabled>⬇ Download</button>
          </>
        )}
      </div>

      <div className="card p-4">
        <div className="mb-2 text-sm font-semibold">Current Shot · Prompt Summary</div>
        {ready ? (
          <>
            <div className="mb-1 text-xs text-gray-500">
              Shot {activeShot.index}: {activeShot.label} ({fmt(activeShot.startSec)} – {fmt(activeShot.endSec)})
            </div>
            <p className="text-[13px] leading-relaxed text-gray-700">{activeShot.promptSummary}</p>
          </>
        ) : (
          <div className="grid place-items-center py-8 text-center">
            <div className="mb-2 text-3xl text-gray-300">📄</div>
            <div className="text-[12px] text-gray-400">Shot details will appear when a shot is selected.</div>
          </div>
        )}
      </div>
    </div>
  )
}
function fmt(s: number) {
  return `0:${String(Math.floor(s)).padStart(2, '0')}`
}
