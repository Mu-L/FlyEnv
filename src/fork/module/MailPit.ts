import { basename, dirname, join } from 'path'
import { existsSync } from 'fs'
import { Base } from './Base'
import type { OnlineVersionItem, SoftInstalled } from '@shared/app'
import {
  AppLog,
  execPromise,
  versionBinVersion,
  versionFilterSame,
  versionFixed,
  versionLocalFetch,
  versionSort
} from '../Fn'
import { ForkPromise } from '@shared/ForkPromise'
import { readFile, writeFile, mkdirp, remove } from 'fs-extra'
import TaskQueue from '../TaskQueue'
import { EOL } from 'os'
import { I18nT } from '@lang/index'

class MailPit extends Base {
  constructor() {
    super()
    this.type = 'mailpit'
  }

  init() {
    this.pidPath = join(global.Server.BaseDir!, 'mailpit/mailpit.pid')
  }

  initConfig(): ForkPromise<string> {
    return new ForkPromise(async (resolve, reject, on) => {
      const baseDir = join(global.Server.BaseDir!, 'mailpit')
      if (!existsSync(baseDir)) {
        await mkdirp(baseDir)
      }
      const iniFile = join(baseDir, 'mailpit.conf')
      if (!existsSync(iniFile)) {
        on({
          'APP-On-Log': AppLog('info', I18nT('appLog.confInit'))
        })
        const tmplFile = join(global.Server.Static!, 'tmpl/mailpit.conf')
        let content = await readFile(tmplFile, 'utf-8')
        const logFile = join(baseDir, 'mailpit.log')
        content = content.replace('##LOG_FILE##', logFile)
        await writeFile(iniFile, content)
        const defaultIniFile = join(baseDir, 'mailpit.conf.default')
        await writeFile(defaultIniFile, content)
        on({
          'APP-On-Log': AppLog('info', I18nT('appLog.confInitSuccess', { file: iniFile }))
        })
      }
      resolve(iniFile)
    })
  }

  fetchLogPath() {
    return new ForkPromise(async (resolve) => {
      const baseDir = join(global.Server.BaseDir!, 'mailpit')
      const iniFile = join(baseDir, 'mailpit.conf')
      if (!existsSync(iniFile)) {
        resolve('')
        return
      }
      const content = await readFile(iniFile, 'utf-8')
      const logStr = content.split('\n').find((s) => s.includes('MP_LOG_FILE'))
      if (!logStr) {
        resolve('')
        return
      }
      const file = logStr.trim().split('=').pop()
      resolve(file ?? '')
    })
  }

  _startServer(version: SoftInstalled) {
    return new ForkPromise(async (resolve, reject, on) => {
      on({
        'APP-On-Log': AppLog(
          'info',
          I18nT('appLog.startServiceBegin', { service: `mailpit-${version.version}` })
        )
      })
      const bin = version.bin
      const iniFile = await this.initConfig().on(on)
      if (existsSync(this.pidPath)) {
        try {
          await remove(this.pidPath)
        } catch (e) {}
      }

      const startLogFile = join(global.Server.BaseDir!, `mailpit/start.log`)
      if (existsSync(startLogFile)) {
        try {
          await remove(startLogFile)
        } catch (e) {}
      }

      const getConfEnv = async () => {
        const content = await readFile(iniFile, 'utf-8')
        const arr = content
          .split('\n')
          .filter((s) => {
            const str = s.trim()
            return !!str && str.startsWith('MP_')
          })
          .map((s) => s.trim())
        const dict: Record<string, string> = {}
        arr.forEach((a) => {
          const item = a.split('=')
          const k = item.shift()
          const v = item.join('=')
          if (k) {
            dict[k] = v
          }
        })
        return dict
      }

      const opt = await getConfEnv()
      const commands: string[] = ['@echo off', 'chcp 65001>nul']
      for (const k in opt) {
        const v = opt[k]
        commands.push(`set "${k}=${v}"`)
      }
      commands.push(`cd "${dirname(bin)}"`)
      commands.push(`start /B ./${basename(bin)} > "${startLogFile}" 2>&1 &`)

      const command = commands.join(EOL)
      console.log('command: ', command)
      const cmdName = `start.cmd`
      const sh = join(global.Server.BaseDir!, `mailpit/${cmdName}`)
      await writeFile(sh, command)

      const appPidFile = join(global.Server.BaseDir!, `pid/${this.type}.pid`)
      await mkdirp(dirname(appPidFile))
      if (existsSync(appPidFile)) {
        try {
          await remove(appPidFile)
        } catch (e) {}
      }

      on({
        'APP-On-Log': AppLog('info', I18nT('appLog.execStartCommand'))
      })
      process.chdir(join(global.Server.BaseDir!, `mailpit`))
      try {
        const res = await execPromise(
          `powershell.exe -Command "(Start-Process -FilePath ./${cmdName} -PassThru -WindowStyle Hidden).Id"`
        )
        if (res?.stdout) {
          const pid = res.stdout.trim()
          await writeFile(appPidFile, pid)
          on({
            'APP-On-Log': AppLog('info', I18nT('appLog.startServiceSuccess', { pid: pid }))
          })
          resolve({
            'APP-Service-Start-PID': pid
          })
        } else {
          on({
            'APP-On-Log': AppLog(
              'error',
              I18nT('appLog.startServiceFail', {
                error: res?.stderr ?? 'Start Fail',
                service: `mailpit-${version.version}`
              })
            )
          })
          reject(new Error(res?.stderr || 'Start Fail'))
        }
      } catch (e: any) {
        on({
          'APP-On-Log': AppLog(
            'error',
            I18nT('appLog.startServiceFail', {
              error: e,
              service: `mailpit-${version.version}`
            })
          )
        })
        console.log('-k start err: ', e)
        reject(e)
        return
      }
    })
  }

  fetchAllOnLineVersion() {
    return new ForkPromise(async (resolve) => {
      try {
        const all: OnlineVersionItem[] = await this._fetchOnlineVersion('mailpit')
        all.forEach((a: any) => {
          const dir = join(global.Server.AppDir!, `mailpit-${a.version}`, 'mailpit.exe')
          const zip = join(global.Server.Cache!, `mailpit-${a.version}.zip`)
          a.appDir = join(global.Server.AppDir!, `mailpit-${a.version}`)
          a.zip = zip
          a.bin = dir
          a.downloaded = existsSync(zip)
          a.installed = existsSync(dir)
        })
        resolve(all)
      } catch (e) {
        resolve({})
      }
    })
  }

  allInstalledVersions(setup: any) {
    return new ForkPromise((resolve) => {
      let versions: SoftInstalled[] = []
      Promise.all([versionLocalFetch(setup?.mailpit?.dirs ?? [], 'mailpit.exe')])
        .then(async (list) => {
          versions = list.flat()
          versions = versionFilterSame(versions)
          const all = versions.map((item) =>
            TaskQueue.run(
              versionBinVersion,
              item.bin,
              `${basename(item.bin)} version`,
              /(v)(\d+(\.\d+){1,4})( )/g
            )
          )
          return Promise.all(all)
        })
        .then((list) => {
          list.forEach((v, i) => {
            const { error, version } = v
            const num = version
              ? Number(versionFixed(version).split('.').slice(0, 2).join(''))
              : null
            Object.assign(versions[i], {
              version: version,
              num,
              enable: version !== null,
              error
            })
          })
          resolve(versionSort(versions))
        })
        .catch(() => {
          resolve([])
        })
    })
  }
}
export default new MailPit()
