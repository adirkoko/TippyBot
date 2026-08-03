// src/modules/index.ts
import type { IModule } from '../interfaces/module'
import chatBasicModule from './chat-basic/index'
import navigationModule from './navigation'
import signTrapdoorModule from './sign-trapdoor/index'
import accessModule from './access/index'
import botStatusModule from './bot-status/index'

export const modules: IModule[] = [
  chatBasicModule,
  navigationModule,
  signTrapdoorModule,
  accessModule,
  botStatusModule,
  // Add more modules here as needed...
]
