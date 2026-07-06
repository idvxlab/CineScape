import { useEffect, useRef, useState } from 'react'
import { useProject } from '../../../state/ProjectContext'
import type { SevenDims, Anchor } from '../../../api/types'
import { zoneOf, levelOf } from '../../../lib/dims'
import { compilePrompt } from '../../../api/mock'
import { CameraStage3D } from './CameraStage3D'
import { DimControls } from './DimControls'
import { ShotStrip } from './ShotStrip'

export interface Draft { dims: SevenDims; anchor: Anchor }

export function EditTab() {
  const { project, activeShot, editShot, backplate } = useProject()
  const [draft, setDraft] = useState<Draft>({ dims: activeShot.dims, anchor: activeShot.anchor })
  // Mirror of `draft` that updates SYNCHRONOUSLY. Instant-action controls (grid / presets / shot-size /
  // colour) call onChange then onCommit back-to-back in one handler; setDraft is async, so onCommit would
  // otherwise read the STALE draft and commit the old value — hence "click twice / it snaps back". onCommit
  // reads this ref instead, so a single click commits the value just set.
  const draftRef = useRef<Draft>(draft)
  const [mode, setMode] = useState<'none' | 'comp' | 'move' | 'light'>('none') // canvas editing mode (mutually exclusive)

  const syncDraft = (next: Draft) => { draftRef.current = next; setDraft(next) }

  // On shot switch: reset the draft + exit editing mode
  useEffect(() => {
    syncDraft({ dims: activeShot.dims, anchor: activeShot.anchor })
    setMode('none')
  }, [activeShot.id])

  // Re-sync the draft when the committed dims/anchor change externally (e.g. the semantic Expression
  // sliders on the right panel) so the 3D stage reflects them live.
  useEffect(() => {
    syncDraft({ dims: activeShot.dims, anchor: activeShot.anchor })
  }, [activeShot.dims, activeShot.anchor])

  // While dragging: purely local updates (0 requests), deriving shot size/tilt orientation in real time
  const onDraftChange = (p: { dims?: Partial<SevenDims>; anchor?: Partial<Anchor> }) => {
    const d = draftRef.current
    const dims = { ...d.dims, ...p.dims } as SevenDims
    // shot size = effective distance (physical Dolly distance ÷ zoom/FOV)
    if (p.dims?.distanceM != null || p.dims?.composition?.zoom != null) dims.shotSize = zoneOf(dims.distanceM / (dims.composition.zoom ?? 1))
    if (p.dims?.angle?.pitch != null) dims.angle = { ...dims.angle, level: levelOf(dims.angle.pitch) }
    syncDraft({ dims, anchor: { ...d.anchor, ...p.anchor } })
  }

  // On release: recompute only this shot's Prompt. Reads draftRef (synchronous) so instant-action buttons
  // that onChange+onCommit in the same tick commit the value they just set, not the stale one.
  const onCommit = async () => {
    const { dims, anchor } = draftRef.current
    const { promptSummary } = await compilePrompt(dims, anchor)
    editShot(activeShot.id, { dims, anchor, promptSummary })
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-3 overflow-hidden">
      {/* Stage: fills the available width and height directly, no longer leaving right-side margin for a fixed aspect ratio */}
      <div className="min-h-0">
        <div className="relative h-full w-full overflow-hidden rounded-xl">
          <CameraStage3D
            backdropUrl={backplate ?? project.source.url}
            backdropReady={!!backplate}
            dims={draft.dims}
            anchor={draft.anchor}
            compMode={mode === 'comp'}
            moveMode={mode === 'move'}
            lightMode={mode === 'light'}
            onExitComp={() => setMode('none')}
            onExitMove={() => setMode('none')}
            onExitLight={() => setMode('none')}
            onDraftChange={onDraftChange}
            onCommit={onCommit}
          />
          <DimControls
            dims={draft.dims}
            compMode={mode === 'comp'}
            moveMode={mode === 'move'}
            lightMode={mode === 'light'}
            onToggleComp={() => setMode((m) => (m === 'comp' ? 'none' : 'comp'))}
            onToggleMove={() => setMode((m) => (m === 'move' ? 'none' : 'move'))}
            onToggleLight={() => setMode((m) => (m === 'light' ? 'none' : 'light'))}
            onChange={(p) => onDraftChange({ dims: p })}
            onCommit={onCommit}
          />
        </div>
      </div>
      {/* Shot Script: always keep one visible plan strip */}
      <div className="min-h-0 flex-1">
        <ShotStrip />
      </div>
    </div>
  )
}
