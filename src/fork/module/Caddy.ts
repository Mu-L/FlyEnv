import { basename, dirname, join } from 'path'
import { existsSync } from 'fs'
import { Base } from './Base'
import type { AppHost, OnlineVersionItem, SoftInstalled } from '@shared/app'
import {
  AppLog,
  brewInfoJson,
  execPromise,
  hostAlias,
  portSearch,
  versionBinVersion,
  versionFilterSame,
  versionFixed,
  versionLocalFetch,
  versionSort,
  waitTime
} from '../Fn'
import { ForkPromise } from '@shared/ForkPromise'
import { readFile, writeFile, mkdirp, remove, chmod } from 'fs-extra'
import { I18nT } from '@lang/index'
import TaskQueue from '../TaskQueue'
import { fetchHostList } from './host/HostFile'
import Helper from '../Helper'

class Caddy extends Base {
  constructor() {
    super()
    this.type = 'caddy'
  }

  init() {
    this.pidPath = join(global.Server.BaseDir!, 'caddy/caddy.pid')
  }

  initConfig(): ForkPromise<string> {
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
          .replace('##SSL_ROOT##', sslDir)
          .replace('##LOG_FILE##', logFile)
          .replace('##VHOST-DIR##', vhostDir)
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
      const name = host.name
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
        .replace('##LOG-PATH##', logFile)
        .replace('##ROOT##', root)
        .replace('##PHP-VERSION##', `${phpv}`)
      contentList.push(content)

      if (host.useSSL) {
        let tls = 'internal'
        if (host.ssl.cert && host.ssl.key) {
          tls = `${host.ssl.cert} ${host.ssl.key}`
        }
        const httpHostNameAll = httpsNames.join(',\n')
        const content = tmplSSLContent
          .replace('##HOST-ALL##', httpHostNameAll)
          .replace('##LOG-PATH##', logFile)
          .replace('##SSL##', tls)
          .replace('##ROOT##', root)
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
      const bin = version.bin
      await this.#fixVHost()
      const iniFile = await this.initConfig().on(on)
      if (existsSync(this.pidPath)) {
        try {
          await remove(this.pidPath)
        } catch (e) {}
      }

      const sslDir = join(global.Server.BaseDir!, 'caddy/ssl')
      await Helper.send('caddy', 'sslDirFixed', sslDir)

      const checkPid = async (time = 0) => {
        console.log('checkPid: ', time)
        if (existsSync(this.pidPath)) {
          const pid = await readFile(this.pidPath, 'utf-8')
          on({
            'APP-On-Log': AppLog('info', I18nT('appLog.startServiceSuccess', { pid: pid.trim() }))
          })
          resolve({
            'APP-Service-Start-PID': pid.trim()
          })
        } else {
          if (time < 10) {
            await waitTime(500)
            await checkPid(time + 1)
          } else {
            on({
              'APP-On-Log': AppLog(
                'error',
                I18nT('appLog.startServiceFail', {
                  error: I18nT('fork.startFail'),
                  service: `caddy-${version.version}`
                })
              )
            })
            reject(new Error(I18nT('fork.startFail')))
          }
        }
      }

      const commands: string[] = ['#!/bin/zsh']
      commands.push(`cd "${dirname(bin)}"`)
      commands.push(
        `nohup ./${basename(bin)} start --config "${iniFile}" --pidfile "${this.pidPath}" --watch > /dev/null 2>&1 &`
      )
      commands.push(`echo $!`)
      const command = commands.join('\n')
      console.log('command: ', command)
      const sh = join(global.Server.BaseDir!, `caddy/start.sh`)
      await writeFile(sh, command)
      await chmod(sh, '0777')
      on({
        'APP-On-Log': AppLog('info', I18nT('appLog.execStartCommand'))
      })
      try {
        const res = await execPromise(`zsh "${sh}"`)
        console.log('start res: ', res)
      } catch (e) {
        on({
          'APP-On-Log': AppLog(
            'error',
            I18nT('appLog.execStartCommandFail', { error: e, service: `caddy-${version.version}` })
          )
        })
        console.log('start e: ', e)
        reject(e)
        return
      }
      on({
        'APP-On-Log': AppLog('info', I18nT('appLog.execStartCommandSuccess'))
      })
      on({
        'APP-Service-Start-Success': true
      })
      await checkPid()
    })
  }

  fetchAllOnLineVersion() {
    return new ForkPromise(async (resolve) => {
      try {
        const all: OnlineVersionItem[] = await this._fetchOnlineVersion('caddy')
        const dict: any = {}
        all.forEach((a: any) => {
          const dir = join(global.Server.AppDir!, `static-caddy-${a.version}`, 'caddy')
          const zip = join(global.Server.Cache!, `static-caddy-${a.version}.tar.gz`)
          a.appDir = join(global.Server.AppDir!, `static-caddy-${a.version}`)
          a.zip = zip
          a.bin = dir
          a.downloaded = existsSync(zip)
          a.installed = existsSync(dir)
          dict[`caddy-${a.version}`] = a
        })
        resolve(dict)
      } catch (e) {
        resolve({})
      }
    })
  }

  allInstalledVersions(setup: any) {
    return new ForkPromise((resolve) => {
      let versions: SoftInstalled[] = []
      Promise.all([versionLocalFetch(setup?.caddy?.dirs ?? [], 'caddy', 'caddy')])
        .then(async (list) => {
          versions = list.flat()
          versions = versionFilterSame(versions)
          const all = versions.map((item) =>
            TaskQueue.run(versionBinVersion, `${item.bin} version`, /(v)(\d+(\.\d+){1,4})(.*?)/g)
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

  brewinfo() {
    return new ForkPromise(async (resolve, reject) => {
      try {
        const all = ['caddy']
        const info = await brewInfoJson(all)
        resolve(info)
      } catch (e) {
        reject(e)
        return
      }
    })
  }

  portinfo() {
    return new ForkPromise(async (resolve) => {
      const Info: { [k: string]: any } = await portSearch(
        `^caddy\\d*$`,
        (f) => {
          return (
            f.includes('www') && f.includes('Fast, multi-platform web server with automatic HTTPS')
          )
        },
        (name) => {
          return existsSync(join('/opt/local/bin/', name))
        }
      )
      resolve(Info)
    })
  }
}
export default new Caddy()
