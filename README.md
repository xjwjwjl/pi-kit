# Pi Kit

Personal Pi extension and skill workspace.

## Structure

```text
extensions/
  my-extension/
    package.json
    index.ts
    node_modules/
    src/
skills/
  my-skill/
    SKILL.md
    scripts/
    references/
    assets/
docs/
```

Each extension is an independent Pi package. Extensions are registered individually in `~/.pi/agent/settings.json` under the `extensions` array.

## Add an extension

Create a directory under `extensions/` with `package.json` and `index.ts`:

```json
// extensions/my-extension/package.json
{
  "name": "my-extension",
  "private": true,
  "type": "module",
  "pi": { "extensions": ["./index.ts"] }
}
```

Then register it in `~/.pi/agent/settings.json`:

```json
"extensions": [
  "D:/code/pi-kit/extensions/my-extension"
]
```

## Add a skill

Create a directory under `skills/` with a `SKILL.md` file.

## Conventions

- Use kebab-case for extension and skill directory names.
- Each extension is a self-contained Pi package with its own `package.json` and `node_modules/`.
- Keep extension entry logic in `index.ts`; move larger implementations into `src/`.
- Keep each skill in `skills/<name>/SKILL.md`.
- Put experiments in `extensions/_experimental/` or `skills/_experimental/`.
