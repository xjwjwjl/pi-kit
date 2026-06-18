# Pi Kit

Personal Pi extension and skill workspace.

## Structure

```text
extensions/
  my-extension/
    index.ts
    README.md
    src/
skills/
  my-skill/
    SKILL.md
    scripts/
    references/
    assets/
shared/
tests/
fixtures/
docs/
work/
outputs/
```

## Add an extension

Create a directory under `extensions/` with an `index.ts` entry file:

```text
extensions/my-extension/index.ts
```

The root `package.json` loads `extensions/*/index.ts` and excludes underscore-prefixed groups such as `extensions/_experimental/`.

## Add a skill

Create a directory under `skills/` with a `SKILL.md` file:

```text
skills/my-skill/SKILL.md
```

The root `package.json` loads direct children of `skills/` and excludes underscore-prefixed groups such as `skills/_experimental/`.

## Try or install

Run for one Pi session without installing:

```bash
pi -e /Users/wjinlin/code/pi-kit
```

Install globally for personal use:

```bash
pi install /Users/wjinlin/code/pi-kit
```

Install into a project-local `.pi/settings.json`:

```bash
pi install -l /Users/wjinlin/code/pi-kit
```

## Conventions

- Keep each extension in `extensions/<name>/`.
- Keep the Pi entry file at `extensions/<name>/index.ts`.
- Keep each skill in `skills/<name>/`.
- Keep the skill entry file at `skills/<name>/SKILL.md`.
- Put shared code in `shared/`, not inside another extension.
- Put experiments in `extensions/_experimental/` or `skills/_experimental/`; they are excluded by the manifest.
- Put temporary work in `work/` and user-facing generated files in `outputs/`.
