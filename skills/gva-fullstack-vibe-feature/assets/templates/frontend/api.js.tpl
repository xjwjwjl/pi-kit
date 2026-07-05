import service from '@/utils/request'

export const get{{PASCAL}}List = (data) => {
  return service({
    url: '/{{ROUTE_PREFIX}}/list',
    method: 'post',
    data
  })
}

export const create{{PASCAL}} = (data) => {
  return service({
    url: '/{{ROUTE_PREFIX}}/create',
    method: 'post',
    data
  })
}
