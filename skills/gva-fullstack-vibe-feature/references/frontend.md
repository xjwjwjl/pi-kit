# Frontend Convention

## Directory Layout

```text
web/src/api/{module}.js            — API 封装（唯一允许 import request 的地方）
web/src/view/{module}/index.vue    — 页面
web/src/view/{module}/components/  — UI 子组件（可选，复杂页面拆分用）
```

## API Wrappers

`web/src/api/{module}.js` 是唯一引入 `@/utils/request` 的文件。页面只调用这里的封装函数。

```js
import service from '@/utils/request'

const post = (url, data) => service({ url, method: 'post', data }).then(res => res.data)

export const orderApi = {
  list:   data => post('/order/list', data),
  create: data => post('/order/create', data),
  update: data => post('/order/update', data),
  delete: data => post('/order/delete', data),
}
```

