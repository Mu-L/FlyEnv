import { defineAsyncComponent, markRaw } from 'vue'
import type { AppToolModuleItem } from '@/core/type'
import { I18nT } from '@lang/index'

const module: AppToolModuleItem = {
  id: 'Timestamp',
  type: 'Converter',
  label: () => I18nT('util.toolTimestamp'),
  icon: import('@/svg/time.svg?raw'),
  index: 0,
  component: markRaw(defineAsyncComponent(() => import('./Index.vue')))
}
export default module
