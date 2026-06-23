import { useRef, useState } from 'react'
import { useProject } from '../../state/ProjectContext'

export function SourceUploader() {
  const { source, ready, setSource } = useProject()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const onFile = (file?: File | null) => {
    if (!file || !file.type.startsWith('image/')) return
    setSource(file)
  }

  return (
    <div className="card p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span className="grid h-5 w-5 place-items-center rounded bg-brand-soft text-xs text-brand">1</span>
        Upload Source
        <span className="text-gray-300">ⓘ</span>
      </div>

      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />

      {source ? (
        <>
          <div className="overflow-hidden rounded-lg border border-[#edf0f3]">
            <img src={source.url} alt="source" className="aspect-video w-full object-cover" />
          </div>
          {!ready && (
            <div className="mt-2 rounded-lg bg-brand-soft/60 px-2.5 py-1.5 text-[11px] text-brand">
              ↘ Now describe your intent in the assistant to analyze.
            </div>
          )}
          <button className="btn mt-2 w-full" onClick={() => inputRef.current?.click()}>⬆ Replace</button>
        </>
      ) : (
        <>
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); onFile(e.dataTransfer.files?.[0]) }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-9 text-center transition ${
              dragOver ? 'border-brand bg-brand-soft/50' : 'border-[#dfe4ea] hover:border-brand/50 hover:bg-[#fafbfc]'
            }`}
          >
            <div className="text-3xl text-brand">☁︎</div>
            <div className="text-[15px] font-semibold text-gray-700">Upload your source</div>
            <div className="text-[12px] text-gray-400">Drag &amp; drop or click to upload</div>
            <div className="text-[11px] text-gray-300">Supports images (the still that sets your scene)</div>
          </div>
          <button className="btn mt-2 w-full" onClick={() => inputRef.current?.click()}>+ Upload</button>
        </>
      )}
    </div>
  )
}
