# Intent-to-Cinema · Frontend (MVP)

Make narrative intent visible through cinematic language. Video/photo + one sentence → backend returns recommended plans → frontend displays + seven-dimensional interactive editing → generate video.

> This frontend is an MVP: it ships with mock data and runs standalone (intent understanding / design space / plan recommendation are computed by the backend in the production version).

## Run

```bash
npm install
npm run dev      # http://localhost:5180
npm run build    # tsc --noEmit + vite build
```

## Tech Stack
React 18 + TypeScript + Vite + Tailwind CSS (state: ProjectContext + a minimal store, no Redux/Zustand).

## Structure
- Three-column layout: left = upload + intent chat / center = plan preview ⇄ interactive editing / right = video preview + generate + Prompt summary
- **Core: `src/components/center/edit/CameraStage2D.tsx`** — a 2D pseudo-3D camera editor
  - Green ring = fixed ground-plane orbit; pink arc = tilt orbit rising from the green-ring base point; the camera rises along the pink arc with tilt
  - Unity-style draggable axis arrows: 🟢 Orbit (fly-around) / 🟦 Dolly (shot size) / 🩷 Tilt (up/down), highlighted on hover
  - Draggable anchor reticle; dragging = draft (local, real-time), release = commit (recomputes only the current shot's Prompt)
- `src/lib/dims.ts` — shot-size thresholds, mock compilation of seven dims → Prompt
- `src/api/` — types, mock data, and mock backend

## Seven-dimensional cinematic language (technique layer)
Shot size / angle (orbit · tilt) / composition / camera movement / lighting / color / focal length. The editor maps each dimension to an on-screen draggable control.

See `Intent-to-Cinema_Frontend_Design.md` for the full design.
