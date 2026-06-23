import { SourceUploader } from './SourceUploader'
import { IntentChat } from './IntentChat'

export function LeftPanel() {
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <SourceUploader />
      <IntentChat />
    </div>
  )
}
