# Conventions

## Extension Layout

Use one directory per extension:

```text
extensions/<name>/
  index.ts
  README.md
  src/
```

`index.ts` is the Pi entry point. Move implementation details into `src/` only when the extension grows beyond a small file.

## Skill Layout

Use one directory per skill:

```text
skills/<name>/
  SKILL.md
  scripts/
  references/
  assets/
```

`SKILL.md` is required and should include frontmatter with `name` and `description`. Keep helper scripts, detailed references, and templates next to the skill that uses them.

## Naming

- Directory names use kebab-case.
- Stable extensions live directly under `extensions/`.
- Stable skills live directly under `skills/`.
- Experimental extensions live under `extensions/_experimental/`.
- Experimental skills live under `skills/_experimental/`.
- Archived code should usually stay in git history instead of a permanent `_archive/` directory.

## Dependencies

Use the root `package.json` while these extensions and skills are personal and normally installed together. If one extension or skill needs a large or unusual runtime dependency, consider splitting it into its own package later.

Runtime dependencies belong in `dependencies`. Pi core packages imported by extensions should be listed in `peerDependencies` with a `*` range.
