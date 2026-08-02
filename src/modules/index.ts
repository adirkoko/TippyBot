// src/modules/index.ts
import type { IModule } from '../interfaces/module'
import chatBasicModule from './chat-basic/index'
import navigationModule from './navigation'
import signTrapdoorModule from './sign-trapdoor/index'
import accessModule from './access/index'

export const modules: IModule[] = [
  chatBasicModule,
  navigationModule,
  signTrapdoorModule,
  accessModule,
  // Add more modules here as needed...
]
