// src/modules/index.ts
import type { IModule } from '../interfaces/module'
import chatBasicModule from './chat-basic/index'
import navigationModule from './navigation'
import signTrapdoorModule from './sign-trapdoor/index'
import accessModule from './access/index'
import botStatusModule from './bot-status/index'
import botOpsModule from './bot-ops/index'
import homesModule from './homes/index'
import inventoryModule from './inventory/index'
import chestsModule from './chests/index'
import gatheringModule from './gathering/index'

export const modules: IModule[] = [
  chatBasicModule,
  navigationModule,
  signTrapdoorModule,
  accessModule,
  botStatusModule,
  botOpsModule,
  homesModule,
  inventoryModule,
  chestsModule,
  gatheringModule,
  // Add more modules here as needed...
]
