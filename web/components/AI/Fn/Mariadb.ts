import type BaseTask from '@web/components/AI/Task/BaseTask'
import { AppStore } from '@web/store/app'
import { BrewStore } from '@web/store/brew'
import { startService } from '@web/fn'
import { AIStore } from '@web/components/AI/store'
import { fetchInstalled } from '@web/components/AI/Fn/Util'
import { I18nT } from '@shared/lang'

export function startMariaDB(this: BaseTask) {
  return new Promise(async (resolve, reject) => {
    await fetchInstalled(['mariadb'])
    const appStore = AppStore()
    const brewStore = BrewStore()
    const current = appStore.config.server?.mariadb?.current
    const installed = brewStore.module('mariadb').installed
    let mariadb = installed?.find((i) => i.path === current?.path && i.version === current?.version)
    if (!mariadb || !mariadb?.version) {
      mariadb = installed?.find((i) => !!i.path && !!i.version)
    }
    if (!mariadb || !mariadb?.version) {
      reject(new Error(I18nT('ai.noAvailableVersion')))
      return
    }
    const res = await startService('mariadb', mariadb)
    if (res === true) {
      const aiStore = AIStore()
      aiStore.chatList.push({
        user: 'ai',
        content: I18nT('ai.mariaDBServiceStarted')
      })
      resolve(true)
      return
    }
    reject(new Error(res as string))
  })
}
