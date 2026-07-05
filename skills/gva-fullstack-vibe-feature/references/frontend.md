# Frontend Convention

## Directory Layout

For module `{module}`, prefer:

```text
web/src/api/{module}.js
web/src/view/{module}/index.vue
web/src/view/{module}/components/
web/src/view/{module}/composables/
web/src/view/{module}/permissions.js
```

Add Pinia only when module state must be shared across pages or modules:

```text
web/src/pinia/modules/{module}.js
```

## API Wrappers

`web/src/api/{module}.js` is the only place that should import the request utility.

```js
import service from '@/utils/request'

export const getOrderList = (data) => {
  return service({
    url: '/order/list',
    method: 'post',
    data
  })
}
```

Pages and composables should call these wrappers instead of importing `@/utils/request` directly.

## Page Structure

`index.vue` should compose the page:

- search area
- table/list area
- dialogs/drawers
- imported composables

Move reusable or bulky UI into `components/`.
Move data loading, pagination, form submit, and dialog orchestration into `composables/`.

## Permissions

Centralize permission strings:

```js
export const ORDER_PERMISSIONS = {
  read: 'order.read',
  create: 'order.create',
  update: 'order.update',
  delete: 'order.delete'
}
```

Backend remains the source of truth for authorization. Frontend permissions only control visibility.

## Routes

Use the repository's existing dynamic menu/route mechanism. Keep component paths stable and predictable:

```text
view/{module}/index.vue
```

Do not edit central router files unless the project lacks a dynamic route mechanism and wiring is required.
