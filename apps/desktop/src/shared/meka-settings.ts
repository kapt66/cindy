export const MEKA_P4_SUBFOLDERS = [
  { name: 'saga2_design', descriptionKey: 'settings.meka.p4.subfolders.design' },
  { name: 'saga2_json', descriptionKey: 'settings.meka.p4.subfolders.json' },
  { name: 'saga2_unity', descriptionKey: 'settings.meka.p4.subfolders.unity' },
  { name: 'saga2_pm', descriptionKey: 'settings.meka.p4.subfolders.pm' },
] as const;

export interface MekaP4Subfolder {
  name: (typeof MEKA_P4_SUBFOLDERS)[number]['name'];
}

export interface MekaP4Settings {
  p4RootPath: string | null;
  subfolders: MekaP4Subfolder[];
  extraDirs: string[];
  readOnlyBecauseFutureSchema: boolean;
}
