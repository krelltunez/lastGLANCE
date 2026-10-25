import { Cloud } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FirstRunInfo } from '@/hooks/useSnapshotFileSync'
import { realChoreCount } from '@/sync/icloud'
import { formatDateTime } from '@/utils/datetime'

// Asked once, on a launch that finds data in iCloud and none of this device's
// own (dayGLANCE's ICloudFirstRunModal). Deleting the app leaves the files in
// the iCloud container, and reinstalling turns iOS's per-app iCloud switch back
// on, so without this the app would restore everything silently and with no
// way to decline. Two choices: at first run this device holds nothing, so
// "merge" and "use the iCloud copy" are the same act. Either answer is kept;
// starting fresh can be undone with the iCloud switch in Cloud Sync.

interface Props {
  info: FirstRunInfo | null
  onRestore: () => void
  onStartFresh: () => void
}

export function ICloudFirstRunModal({ info, onRestore, onStartFresh }: Props) {
  const { t } = useTranslation()
  if (!info) return null
  const n = info.file === 'chores'
    ? realChoreCount(info.data)
    : (Array.isArray(info.data.people) ? info.data.people.length : 0)

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center app-safe-bottom bg-black/40 dark:bg-black/60 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby="icloud-first-run-title" className="w-full sm:max-w-sm flex flex-col bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/50">
        <div className="px-6 pt-6 pb-2">
          <div className="flex items-center gap-2 mb-2">
            <Cloud size={16} className="text-green-400 shrink-0" />
            <h2 id="icloud-first-run-title" className="text-sm font-semibold text-slate-800 dark:text-slate-200">{t('icloud.firstRun.title')}</h2>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            {info.file === 'chores' ? t('icloud.firstRun.bodyChores', { count: n }) : t('icloud.firstRun.bodyPeople', { count: n })}
          </p>
          {info.lastModified && (
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-2">{t('icloud.firstRun.lastModified', { when: formatDateTime(info.lastModified) })}</p>
          )}
        </div>
        <div className="flex flex-col gap-2 px-6 pt-3 pb-6">
          <button onClick={onRestore} className="w-full py-2.5 px-3 rounded-xl text-left text-white bg-green-500 hover:bg-green-400 transition-colors">
            <span className="block text-sm font-medium">{t('icloud.firstRun.restore')}</span>
            <span className="block text-xs text-green-50">{t('icloud.firstRun.restoreHint')}</span>
          </button>
          <button onClick={onStartFresh} className="w-full py-2.5 px-3 rounded-xl text-left text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
            <span className="block text-sm font-medium">{t('icloud.firstRun.startFresh')}</span>
            <span className="block text-xs text-slate-500 dark:text-slate-400">{t('icloud.firstRun.startFreshHint')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
