# Forbidden Patterns

These are forbidden for new business modules unless repository-local rules explicitly override them.

## Backend

- Adding `server/router/{module}/`.
- Adding module `enter.go` files.
- Using `ApiGroupApp`, `ServiceGroupApp`, or `RouterGroupApp`.
- Adding package-level service singletons such as `var XxxServiceApp = new(...)`.
- Importing `server/global` from new service packages.
- Building a default catch-all `Container` struct.
- Putting database query chains or business workflows directly in API handlers.
- Reusing old generated CRUD structure just because similar old files exist.

## Frontend

- Importing `@/utils/request` from `web/src/view/**`.
- Hardcoding permission strings throughout Vue pages.
- Creating Pinia stores by default for purely local page state.
- Putting large search/table/form/dialog logic into a single `index.vue`.
- Editing `router/index.js`, `permission.js`, or `utils/request.js` for ordinary module work.

## Process

- Skipping the repository-local standard when it exists.
- Skipping checks without reporting why.
- Expanding the feature into unrelated framework refactors.
