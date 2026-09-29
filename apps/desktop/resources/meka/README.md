# Bundled Meka resources

This directory is the single read-only carrier copied to
`process.resourcesPath/meka` in packaged builds. It carries the platform layer and one project
baseline shell, and nothing else:

- `skills/<category>/<sub-category>/<skill-id>/SKILL.md`: the one bundled platform Skill
  (`通用/platform/platform-capabilities`), which defines the capability ladder, the configuration
  layer precedence and the recovery path every Meka session starts from.
- `projects/<project-id>/project.json`: the bundled project baseline. It keeps only the project's
  `basic` identity and its `metadata` discovery manifest. Its `roleDefaults` deliberately carries
  **no prompt text and no skill selection** — the prompt framework, the role roster and the skills
  are declared by the project's own `<project-root>/.meka/project.json` or by installed plugins.
- `roles/`: reserved for bundled role manifests. There is no bundled role manifest and therefore
  no such directory in the tree — git does not track empty directories. The role-manifest scan
  treats a missing bundled-role directory as an empty catalog, and the generated
  `<project-id>-default-role` is synthesized in memory, so nothing is lost by its absence.

Everything else is declared by the projects themselves. A project root owns its configuration at
`<project-root>/.meka/project.json` (project basics, metadata selections and role defaults), declares
its own roles through that file's role snapshots and its installed plugins, and every registered
project additionally gets the generated `<project-id>-default-role`. The bundled layer is the
injection mechanism: the fixed project-reference and role-context segments plus the selected role's
prompt, never project or business content.

Do not place user-owned data here. Once a project is edited, its complete project configuration and
editable role snapshots are stored at `<project-root>/.meka/project.json` and become the only runtime
source. Custom role manifests remain under the application userData directory at `meka-roles/`.

Forge validates this tree before and after packaging, but only structurally.
`forge-meka-resources.ts` asserts the source carrier is a readable, non-empty file tree, then
compares the packed tree against it per file by SHA-256, failing the build on every missing,
unexpected or changed path. It does no Skill-ID or other content semantics check — bundled Skill IDs
are resolved by `runtimeConfig.ts` (`listBundledSkills` / `readBundledRuntimeSkill`), which throw on
an id the scanned catalog cannot resolve, and the `meka-projects` unit tests cover that path.
