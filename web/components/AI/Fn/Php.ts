import type BaseTask from '@web/components/AI/Task/BaseTask'
import { startService } from '@web/fn'
import { AIStore } from '@web/components/AI/store'
import type { SoftInstalled } from '@shared/app'
import { I18nT } from '@shared/lang'

export function startPhp(this: BaseTask, version: SoftInstalled) {
  return new Promise(async (resolve, reject) => {
    const res = await startService('php', version)
    if (res === true) {
      const aiStore = AIStore()
      aiStore.chatList.push({
        user: 'ai',
        content: I18nT('ai.phpServiceStarted', { num: version.num })
      })
      resolve(true)
    } else if (typeof res === 'string') {
      reject(new Error(res))
    }
  })
}
