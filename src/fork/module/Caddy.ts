import { join, dirname, basename } from 'path'
import { existsSync } from 'fs'
import { Base } from './Base'
import type { AppHost, OnlineVersionItem, SoftInstalled } from '@shared/app'
import {
  AppLog,
  execPromise,
  hostAlias,
  versionBinVersion,
  versionFilterSame,
  versionFixed,
  versionInitedApp,
  versionLocalFetch,
  versionSort
} from '../Fn'
import { ForkPromise } from '@shared/ForkPromise'
import { readFile, writeFile, mkdirp, remove } from 'fs-extra'
import TaskQueue from '../TaskQueue'
import { EOL } from 'os'
import { fetchHostList } from './host/HostFile'
import { I18nT } from '@lang/index'

class Caddy extends Base {
  constructor() {
    super()
    this.type = 'caddy'
  }

  init() {
    this.pidPath = join(global.Server.BaseDir!, 'caddy/caddy.pid')
  }

  initConfig() {
    return new ForkPromise(async (resolve, reject, on) => {
      const baseDir = join(global.Server.BaseDir!, 'caddy')
      const iniFile = join(baseDir, 'Caddyfile')
      if (!existsSync(iniFile)) {
        on({
          'APP-On-Log': AppLog('info', I18nT('appLog.confInit'))
        })
        const tmplFile = join(global.Server.Static!, 'tmpl/Caddyfile')
        let content = await readFile(tmplFile, 'utf-8')
        const sslDir = join(baseDir, 'ssl')
        await mkdirp(sslDir)
        const logFile = join(baseDir, 'caddy.log')
        const vhostDir = join(global.Server.BaseDir!, 'vhost/caddy')
        await mkdirp(sslDir)
        content = content
          .replace('##SSL_ROOT##', sslDir.split('\\').join('/'))
          .replace('##LOG_FILE##', logFile.split('\\').join('/'))
          .replace('##VHOST-DIR##', vhostDir.split('\\').join('/'))
        await writeFile(iniFile, content)
        const defaultIniFile = join(baseDir, 'Caddyfile.default')
        await writeFile(defaultIniFile, content)
        on({
          'APP-On-Log': AppLog('info', I18nT('appLog.confInitSuccess', { file: iniFile }))
        })
      }
      resolve(iniFile)
    })
  }

  async #fixVHost() {
    let hostAll: Array<AppHost> = []
    const vhostDir = join(global.Server.BaseDir!, 'vhost/caddy')
    try {
      hostAll = await fetchHostList()
    } catch (e) {}
    await mkdirp(vhostDir)
    let tmplContent = ''
    let tmplSSLContent = ''
    for (const host of hostAll) {
      if (host.type && host.type !== 'php') {
        continue
      }
      const name = host.name
      if (!name) {
        continue
      }
      const confFile = join(vhostDir, `${name}.conf`)
      if (existsSync(confFile)) {
        continue
      }
      if (!tmplContent) {
        const tmplFile = join(global.Server.Static!, 'tmpl/CaddyfileVhost')
        tmplContent = await readFile(tmplFile, 'utf-8')
      }
      if (!tmplSSLContent) {
        const tmplFile = join(global.Server.Static!, 'tmpl/CaddyfileVhostSSL')
        tmplSSLContent = await readFile(tmplFile, 'utf-8')
      }
      const httpNames: string[] = []
      const httpsNames: string[] = []
      hostAlias(host).forEach((h) => {
        if (!host?.port?.caddy || host.port.caddy === 80) {
          httpNames.push(`http://${h}`)
        } else {
          httpNames.push(`http://${h}:${host.port.caddy}`)
        }
        if (host.useSSL) {
          httpsNames.push(`https://${h}:${host?.port?.caddy_ssl ?? 443}`)
        }
      })

      const contentList: string[] = []

      const hostName = host.name
      const root = host.root
      const phpv = host.phpVersion
      const logFile = join(global.Server.BaseDir!, `vhost/logs/${hostName}.caddy.log`)

      const httpHostNameAll = httpNames.join(',\n')
      const content = tmplContent
        .replace('##HOST-ALL##', httpHostNameAll)
        .replace('##LOG-PATH##', logFile.split('\\').join('/'))
        .replace('##ROOT##', root.split('\\').join('/'))
        .replace('##PHP-VERSION##', `${phpv}`)
      contentList.push(content)

      if (host.useSSL) {
        let tls = 'internal'
        if (host.ssl.cert && host.ssl.key) {
          tls = `"${host.ssl.cert}" "${host.ssl.key}"`
        }
        const httpHostNameAll = httpsNames.join(',\n')
        const content = tmplSSLContent
          .replace('##HOST-ALL##', httpHostNameAll)
          .replace('##LOG-PATH##', logFile.split('\\').join('/'))
          .replace('##SSL##', tls.split('\\').join('/'))
          .replace('##ROOT##', root.split('\\').join('/'))
          .replace('##PHP-VERSION##', `${phpv}`)
        contentList.push(content)
      }
      await writeFile(confFile, contentList.join('\n'))
    }
  }

  _startServer(version: SoftInstalled) {
    return new ForkPromise(async (resolve, reject, on) => {
      on({
        'APP-On-Log': AppLog(
          'info',
          I18nT('appLog.startServiceBegin', { service: `caddy-${version.version}` })
        )
      })
      await this.initLocalApp(version, 'caddy').on(on)
      const bin = version.bin
      await this.#fixVHost()
      const iniFile = await this.initConfig().on(on)

      if (existsSync(this.pidPath)) {
        try {
          await remove(this.pidPath)
        } catch (e) {}
      }

      const appPidFile = join(global.Server.BaseDir!, `pid/${this.type}.pid`)
      await mkdirp(dirname(appPidFile))
      if (existsSync(appPidFile)) {
        try {
          await remove(appPidFile)
        } catch (e) {}
      }

      const outFile = join(global.Server.ApacheDir!, 'start.out.log')
      const errorFile = join(global.Server.ApacheDir!, 'start.error.log')

      const psCommands: string[] = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        `Set-Location -Path "${dirname(bin)}"`,
        `$process = Start-Process -FilePath "./${basename(bin)}" \``,
        `-ArgumentList "start --config \`"${iniFile}\`" --pidfile \`"${this.pidPath}\`" --watch" \``,
        `-WindowStyle Hidden \``,
        `-RedirectStandardOutput "${outFile}" \``,
        `-RedirectStandardError "${errorFile}" \``,
        `-PassThru`,
        `Write-Host "$($process.Id)"`
      ]

      const psScript = psCommands.join(EOL)
      console.log('PowerShell command: ', psScript)

      const psName = `start.ps1`
      const psPath = join(join(global.Server.BaseDir!, `caddy`), psName)
      await writeFile(psPath, psScript)

      on({
        'APP-On-Log': AppLog('info', I18nT('appLog.execStartCommand'))
      })
      process.chdir(join(global.Server.BaseDir!, `caddy`))
      try {
        await execPromise(
          `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Unblock-File -LiteralPath './${psName}'; & './${psName}'"`
        )
      } catch (e: any) {
        on({
          'APP-On-Log': AppLog(
            'error',
            I18nT('appLog.execStartCommandFail', { error: e, service: `caddy-${version.version}` })
          )
        })
        console.log('-k start err: ', e)
        reject(e)
        return
      }
      on({
        'APP-On-Log': AppLog('info', I18nT('appLog.execStartCommandSuccess'))
      })
      on({
        'APP-Service-Start-Success': true
      })
      const res = await this.waitPidFile(this.pidPath)
      if (res) {
        if (res?.pid) {
          on({
            'APP-On-Log': AppLog('info', I18nT('appLog.startServiceSuccess', { pid: res.pid }))
          })
          await writeFile(appPidFile, res.pid)
          resolve({
            'APP-Service-Start-PID': res.pid
          })
          return
        }
        on({
          'APP-On-Log': AppLog(
            'error',
            I18nT('appLog.startServiceFail', {
              error: res?.error ?? 'Start Fail',
              service: `caddy-${version.version}`
            })
          )
        })
        reject(new Error(res?.error ?? 'Start Fail'))
        return
      }
      let msg = 'Start Fail'
      if (existsSync(errorFile)) {
        msg = (await readFile(errorFile, 'utf8')) || 'Start Fail'
      }
      on({
        'APP-On-Log': AppLog(
          'error',
          I18nT('appLog.startServiceFail', { error: msg, service: `caddy-${version.version}` })
        )
      })
      reject(new Error(msg))
    })
  }

  fetchAllOnLineVersion() {
    return new ForkPromise(async (resolve) => {
      try {
        const all: OnlineVersionItem[] = await this._fetchOnlineVersion('caddy')
        all.forEach((a: any) => {
          const dir = join(global.Server.AppDir!, `caddy-${a.version}`, 'caddy.exe')
          const zip = join(global.Server.Cache!, `caddy-${a.version}.zip`)
          a.appDir = join(global.Server.AppDir!, `caddy-${a.version}`)
          a.zip = zip
          a.bin = dir
          a.downloaded = existsSync(zip)
          a.installed = existsSync(dir)
        })
        resolve(all)
      } catch (e) {
        resolve([])
      }
    })
  }

  allInstalledVersions(setup: any) {
    return new ForkPromise((resolve) => {
      let versions: SoftInstalled[] = []
      Promise.all([versionLocalFetch(setup?.caddy?.dirs ?? [], 'caddy.exe')])
        .then(async (list) => {
          versions = list.flat()
          versions = versionFilterSame(versions)
          const all = versions.map((item) => {
            const command = `${basename(item.bin)} version`
            const reg = /(v)(\d+(\.\d+){1,4})(.*?)/g
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
              version: version,
              num,
              enable: version !== null,
              error
            })
          })
          const appInited = await versionInitedApp('caddy', 'caddy.exe')
          versions.push(...appInited.filter((a) => !versions.find((v) => v.bin === a.bin)))
          resolve(versionSort(versions))
        })
        .catch(() => {
          resolve([])
        })
    })
  }
}
export default new Caddy()
