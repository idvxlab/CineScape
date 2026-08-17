import { SourceUploader } from './SourceUploader'
import { IntentChat } from './IntentChat'

export function LeftPanel() {
  return (
    // overflow-y-auto: when the two cards exceed the panel height (e.g. the study
    // view locks the page to the viewport), scroll inside instead of clipping.
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
      <SourceUploader />
      <IntentChat />
    </div>
  )
}
