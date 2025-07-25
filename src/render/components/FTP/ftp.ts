import { defineStore } from 'pinia'
import IPC from '@/util/IPC'
import { ip } from '@/util/NodeFn'

export interface FtpItem {
  user: string
  pass: string
  dir: string
  disabled: boolean
  mark: string
}

interface State {
  running: boolean
  ip: string
  fetching: boolean
  allFtp: Array<FtpItem>
  port: number
}

const state: State = {
  running: false,
  ip: '',
  fetching: false,
  allFtp: [],
  port: 0
}

export const FtpStore = defineStore('pure-ftpd', {
  state: (): State => state,
  getters: {},
  actions: {
    getIP() {
      ip.address().then((res) => {
        this.ip = res
      })
    },
    getPort() {
      IPC.send('app-fork:pure-ftpd', 'getPort').then((key: string, res?: any) => {
        IPC.off(key)
        this.port = res?.data
      })
    },
    getAllFtp() {
      return new Promise((resolve) => {
        IPC.send('app-fork:pure-ftpd', 'getAllFtp').then((key: string, res?: any) => {
          IPC.off(key)
          this.allFtp.splice(0)
          const arr = res?.data ?? []
          this.allFtp.push(...arr)
          resolve(true)
        })
      })
    }
  }
})
