import { basename, dirname, join } from 'path'
import { existsSync } from 'fs'
import { Base } from './Base'
import { ForkPromise } from '@shared/ForkPromise'
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
import { copyFile, mkdirp, readFile, remove, writeFile } from 'fs-extra'
import TaskQueue from '../TaskQueue'
import { makeGlobalTomcatServerXML } from './service/ServiceItemJavaTomcat'
import { EOL } from 'os'
import { ProcessListSearch } from '../Process'
import { I18nT } from '@lang/index'

class Tomcat extends Base {
  constructor() {
    super()
    this.type = 'tomcat'
  }

  fetchAllOnLineVersion() {
    console.log('Tomcat fetchAllOnLineVersion !!!')
    return new ForkPromise(async (resolve) => {
      try {
        const all: OnlineVersionItem[] = await this._fetchOnlineVersion('tomcat')
        all.forEach((a: any) => {
          const dir = join(global.Server.AppDir!, `tomcat-${a.version}`, 'bin/catalina.bat')
          const zip = join(global.Server.Cache!, `tomcat-${a.version}.zip`)
          a.appDir = join(global.Server.AppDir!, `tomcat-${a.version}`)
          a.zip = zip
          a.bin = dir
          a.downloaded = existsSync(zip)
          a.installed = existsSync(dir)
        })
        resolve(all)
      } catch (e) {
        console.log('Tomcat fetch version e: ', e)
        resolve([])
      }
    })
  }

  async _fixStartBat(version: SoftInstalled) {
    const file = join(dirname(version.bin), 'setclasspath.bat')
    if (existsSync(file)) {
      let content = await readFile(file, 'utf-8')
      content = content.replace(
        `set "_RUNJAVA=%JRE_HOME%\\bin\\java.exe"`,
        `set "_RUNJAVA=%JRE_HOME%\\bin\\javaw.exe"`
      )
      await writeFile(file, content)
    }
  }

  _initDefaultDir(version: SoftInstalled, baseDir?: string) {
    return new ForkPromise(async (resolve, reject, on) => {
      let dir = ''
      if (baseDir) {
        dir = baseDir
      } else {
        const v = version?.version?.split('.')?.shift() ?? ''
        dir = join(global.Server.BaseDir!, `tomcat/tomcat${v}`)
      }
      if (existsSync(dir) && existsSync(join(dir, 'conf/server.xml'))) {
        resolve(dir)
      }
      on({
        'APP-On-Log': AppLog('info', I18nT('appLog.confInit'))
      })
      const files = [
        'catalina.properties',
        'context.xml',
        'jaspic-providers.xml',
        'jaspic-providers.xsd',
        'tomcat-users.xml',
        'tomcat-users.xsd',
        'logging.properties',
        'web.xml',
        'server.xml'
      ]
      const fromConfDir = join(dirname(dirname(version.bin)), 'conf')
      const toConfDir = join(dir, 'conf')
      await mkdirp(toConfDir)
      for (const file of files) {
        const src = join(fromConfDir, file)
        if (existsSync(src)) {
          await copyFile(src, join(toConfDir, file))
        }
      }
      on({
        'APP-On-Log': AppLog(
          'info',
          I18nT('appLog.confInitSuccess', { file: join(dir, 'conf/server.xml') })
        )
      })
      resolve(dir)
    })
  }

  _stopServer(version: SoftInstalled) {
    return new ForkPromise(async (resolve, reject, on) => {
      on({
        'APP-On-Log': AppLog('info', I18nT('appLog.stopServiceBegin', { service: this.type }))
      })
      const v = version?.version?.split('.')?.shift() ?? ''
      const dir = join(global.Server.BaseDir!, `tomcat/tomcat${v}`)
      const all = await ProcessListSearch(dir, false)
      const arr: Array<number> = []
      all.forEach((item) => {
        arr.push(item.ProcessId)
      })
      console.log('tomcat _stopServer arr: ', arr)
      if (arr.length > 0) {
        const str = arr.map((s) => `/pid ${s}`).join(' ')
        try {
          await execPromise(`taskkill /f /t ${str}`)
        } catch (e) {}
      }
      on({
        'APP-On-Log': AppLog('info', I18nT('appLog.stopServiceEnd', { service: this.type }))
      })
      resolve({
        'APP-Service-Stop-PID': arr
      })
    })
  }

  _startServer(version: SoftInstalled, lastVersion?: SoftInstalled, CATALINA_BASE?: string) {
    return new ForkPromise(async (resolve, reject, on) => {
      on({
        'APP-On-Log': AppLog(
          'info',
          I18nT('appLog.startServiceBegin', { service: `${this.type}-${version.version}` })
        )
      })
      const bin = version.bin
      await this._fixStartBat(version)
      const baseDir = await this._initDefaultDir(version, CATALINA_BASE).on(on)
      await makeGlobalTomcatServerXML({
        path: baseDir
      } as any)

      const tomcatDir = join(global.Server.BaseDir!, 'tomcat')

      const commands: string[] = [
        '@echo off',
        'chcp 65001>nul',
        `set "CATALINA_BASE=${baseDir}"`,
        `cd /d "${dirname(bin)}"`,
        `start /B ${basename(bin)} > NUL 2>&1 &`
      ]

      const command = commands.join(EOL)
      console.log('command: ', command)

      const cmdName = `start.cmd`
      const sh = join(tomcatDir, cmdName)
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
      process.chdir(tomcatDir)
      try {
        const res = await execPromise(
          `powershell.exe -Command "(Start-Process -FilePath ./${cmdName} -PassThru -WindowStyle Hidden).Id"`
        )
        on({
          'APP-On-Log': AppLog('info', I18nT('appLog.startServiceSuccess', { pid: res.stdout }))
        })
        console.log('tomcat start res: ', res.stdout)
        resolve(true)
      } catch (e: any) {
        on({
          'APP-On-Log': AppLog(
            'error',
            I18nT('appLog.execStartCommandFail', {
              error: e,
              service: `${this.type}-${version.version}`
            })
          )
        })
        console.log('-k start err: ', e)
        reject(e)
        return
      }
    })
  }

  allInstalledVersions(setup: any) {
    return new ForkPromise((resolve) => {
      let versions: SoftInstalled[] = []
      Promise.all([versionLocalFetch(setup?.tomcat?.dirs ?? [], 'catalina.bat')])
        .then(async (list) => {
          versions = list.flat()
          versions = versionFilterSame(versions)
          const all = versions.map((item) => {
            const command = 'call version.bat'
            const reg = /(Server version: Apache Tomcat\/)(.*?)(\n)/g
            return TaskQueue.run(versionBinVersion, item.bin, command, reg)
          })
          return Promise.all(all)
        })
        .then(async (list) => {
          list.forEach((v, i) => {
            const { error, version } = v
            const num = version
              ? Number(versionFixed(version).split('.').slice(0, 2).join(''))
              : null
            Object.assign(versions[i], {
              bin: join(dirname(versions[i].bin), 'startup.bat'),
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
export default new Tomcat()
