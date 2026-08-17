import { ProjectLayout } from './components/layout/ProjectLayout'
import { StudyApp } from './study/StudyApp'

export default function App() {
  const code = new URLSearchParams(window.location.search).get('study')
  if (code && code.trim()) return <StudyApp participantCode={code.trim()} />
  return <ProjectLayout />
}
