# Bundled Meka resources

This directory is the single read-only carrier copied to
`process.resourcesPath/meka` in packaged builds.

- `projects/<project-id>/project.json`: built-in project baselines.
- `roles/<role-id>.json`: built-in role manifests.
- `skills/<category>/<sub-category>/<skill-id>/SKILL.md`: built-in Skills selected by projects
  and roles.

Do not place user overrides here. Built-in project overrides remain at
`<project-root>/.meka/project.json`; custom role manifests remain under the application userData
directory at `meka-roles/`.

Forge validates this tree before and after packaging. Every configured bundled Skill ID must resolve
to exactly one `SKILL.md`.
