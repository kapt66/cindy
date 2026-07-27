import { ipcMain } from 'electron';

import { listMekaSkillCatalog } from '../../meka-projects/skillCatalog.js';

export const MEKA_SKILL_CATALOG_LIST = 'meka-skill-catalog:list';

export function registerMekaSkillCatalogIpc(): void {
  ipcMain.handle(MEKA_SKILL_CATALOG_LIST, () => listMekaSkillCatalog());
}
