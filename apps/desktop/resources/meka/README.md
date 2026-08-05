# Bundled Meka resources

This directory is the single read-only carrier copied to
`process.resourcesPath/meka` in packaged builds.

- `projects/<project-id>/project.json`: built-in project baselines used when a project-owned
  configuration does not exist.
- `roles/<role-id>.json`: built-in role manifests.
- `skills/<category>/<sub-category>/<skill-id>/SKILL.md`: built-in Skills selected by projects
  and roles.

Do not place user-owned data here. Once a built-in project is edited, its complete project
configuration and editable built-in role snapshots are stored at
`<project-root>/.meka/project.json` and become the only runtime source. Deleting that file resets
the project to these bundled resources. Custom role manifests remain under the application
userData directory at `meka-roles/`.

Forge validates this tree before and after packaging. Every configured bundled Skill ID must resolve
to exactly one `SKILL.md`.
