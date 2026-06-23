import type { Project, SevenDims, Shot, Plan, IntentTag } from './types'
import { zoneOf, levelOf, mockCompilePrompt } from '../lib/dims'

const BACKDROP =
  'https://images.unsplash.com/photo-1499346030926-9a72daac6c63?q=80&w=1600&auto=format&fit=crop'

function dims(p: Partial<SevenDims> & { distanceM: number; pitch?: number }): SevenDims {
  const { pitch = -10, ...rest } = p
  const base: SevenDims = {
    distanceM: 8,
    shotSize: 'Medium',
    angle: { yaw: 0, pitch, level: levelOf(pitch) },
    composition: { rule: 'center', focus: { x: 0.5, y: 0.5 }, headroom: 0.5, leadRoom: 0.5, balance: 0, zoom: 1, preset: 'center' },
    movement: { type: 'Static', durationSec: 3, easing: 'ease-in-out' },
    rhythm: { curve: [{ x: 0, y: 0.3 }, { x: 0.25, y: 0.55 }, { x: 0.5, y: 0.75 }, { x: 0.75, y: 0.55 }, { x: 1, y: 0.3 }] },
    lighting: { direction: 'Backlight', keyPct: 60, ratio: 4, pos: { x: 0.5, y: 0.18 }, softness: 0.5, temperature: 0.45, spread: 0.4 },
    color: { look: 'Cool', contrast: 20, saturation: -5 },
    focal: { mm: 35, dof: 0.3 },
  }
  const d: SevenDims = { ...base, ...rest }
  d.shotSize = zoneOf(d.distanceM)
  d.angle.level = levelOf(d.angle.pitch)
  return d
}

function mkShot(s: Omit<Shot, 'promptSummary' | 'shotSize'> & { dims: SevenDims }): Shot {
  return { ...s, promptSummary: mockCompilePrompt(s.dims, s.anchor) }
}

const ANCHOR = { point2d: { x: 0.5, y: 0.62 }, depthM: 8.5 }

const planAShots: Shot[] = [
  mkShot({
    id: 's1', index: 1, label: 'Wide Establish', startSec: 0, endSec: 3, thumbnailUrl: BACKDROP,
    description: 'Wide establishing shot — vast negative space, the figure small and alone.', anchor: { ...ANCHOR, depthM: 18 },
    dims: dims({ distanceM: 18, pitch: -6, movement: { type: 'Static', durationSec: 3, easing: 'ease-in-out' } }),
  }),
  mkShot({
    id: 's2', index: 2, label: 'Character Close-up', startSec: 3, endSec: 6, thumbnailUrl: BACKDROP,
    description: 'Character close-up — oppressive mood, restrained expression.', anchor: { ...ANCHOR, depthM: 2.5 },
    dims: dims({ distanceM: 2.5, pitch: 0, focal: { mm: 85, dof: 0.2 }, movement: { type: 'Static', durationSec: 3, easing: 'ease-in-out' } }),
  }),
  mkShot({
    id: 's3', index: 3, label: 'Close Tracking', startSec: 6, endSec: 8, thumbnailUrl: BACKDROP,
    description: 'Close tracking — the searching figure and footsteps seen from behind.', anchor: { ...ANCHOR, depthM: 4 },
    dims: dims({ distanceM: 4, pitch: -10, focal: { mm: 50, dof: 0.35 }, movement: { type: 'Dolly Out', durationSec: 3, easing: 'ease-in-out' } }),
  }),
  mkShot({
    id: 's4', index: 4, label: 'Closing Beat', startSec: 8, endSec: 10, thumbnailUrl: BACKDROP,
    description: 'Closing beat — city light breathing across the frame.', anchor: { ...ANCHOR, depthM: 5 },
    dims: dims({ distanceM: 5, pitch: -4, focal: { mm: 35, dof: 0.4 }, movement: { type: 'Dolly In', durationSec: 2.5, easing: 'ease-out' } }),
  }),
]

const plans: Plan[] = [
  {
    id: 'planA', variant: 'A', title: 'Plan A · Recommended', shots: planAShots,
    rationale: [
      'Builds a "solitude + introspection" emotional arc across 4 shots',
      'Stillness and slow pacing create an inward, restrained narrative',
      'Light, space and blocking negative-space heighten the lonely, oppressive mood',
    ],
    totalSec: 10, shotCount: 4,
  },
  { id: 'planB', variant: 'B', title: 'Plan B · Heightened Tension', shots: planAShots, rationale: [], totalSec: 10, shotCount: 4 },
  { id: 'planC', variant: 'C', title: 'Plan C · Inner Monologue', shots: planAShots, rationale: [], totalSec: 11, shotCount: 5 },
]

const intents: IntentTag[] = [
  { code: '3.4', name: 'Isolation', nameEn: 'Isolation', group: 'Atmosphere' },
  { code: '5.2', name: 'Vulnerability', nameEn: 'Vulnerability', group: 'Characterization' },
  { code: '3.1', name: 'Tension', nameEn: 'Tension', group: 'Atmosphere' },
  { code: '2.x', name: 'Oppression', group: 'Spatial Representation' },
  { code: '1.x', name: 'Hope', group: 'Emotional Evocation' },
]

export const mockProject: Project = {
  id: 'demo',
  source: { url: BACKDROP, type: 'image', durationSec: 10, detectedAnchor: ANCHOR },
  chat: [
    { id: 'm1', role: 'user', text: 'I want to convey lostness and solitude — something like "no one around / inner monologue".', ts: '10:21' },
    { id: 'm2', role: 'assistant', text: 'I understand the gist of your story.', ts: '10:21' },
    { id: 'm3', role: 'user', text: 'I want the audience to feel lonely and distant, yet with a glimmer of hope.', ts: '10:22' },
    {
      id: 'm4', role: 'assistant', ts: '10:22',
      text: 'Got it. Based on your intent, here are the keywords I confirmed:',
      highlights: ['Oppression', 'Solitude', 'City', 'Light'],
    },
    { id: 'm5', role: 'assistant', text: "I'll generate the cinematic language and match a fluid narrative structure to carry that emotion.", ts: '10:22' },
  ],
  intents,
  plans,
  activePlanId: 'planA',
  activeShotId: 's3',
  video: { id: 'v1', status: 'idle', progress: 0 },
  updatedAt: new Date().toISOString(),
}

// build a fresh project from a user-uploaded image: same mock plans/dims, but the uploaded
// image becomes the source backdrop + every shot's thumbnail.
export function createProjectFromImage(url: string): Project {
  return {
    ...mockProject,
    source: { ...mockProject.source, url, detectedAnchor: ANCHOR },
    plans: mockProject.plans.map((pl) => ({ ...pl, shots: pl.shots.map((s) => ({ ...s, thumbnailUrl: url })) })),
    updatedAt: new Date().toISOString(),
  }
}

// mock backend: "analyze" an uploaded image → resolve once the (fake) detection finishes
export async function analyzeSource(_url: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 1600))
}

// mock backend: edit the current shot's seven dims → return only this shot's Prompt
export async function compilePrompt(dimsIn: SevenDims, anchor: Shot['anchor']): Promise<{ promptSummary: string }> {
  await new Promise((r) => setTimeout(r, 120))
  return { promptSummary: mockCompilePrompt(dimsIn, anchor) }
}
