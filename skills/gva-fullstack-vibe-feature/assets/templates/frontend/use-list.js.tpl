import { ref } from 'vue'
import { get{{PASCAL}}List } from '@/api/{{MODULE}}'

export const use{{PASCAL}}List = () => {
  const loading = ref(false)
  const list = ref([])
  const total = ref(0)
  const page = ref(1)
  const pageSize = ref(10)
  const query = ref({})

  const load = async () => {
    loading.value = true
    try {
      const res = await get{{PASCAL}}List({
        page: page.value,
        pageSize: pageSize.value,
        ...query.value
      })
      if (res.code === 0) {
        list.value = res.data.list || []
        total.value = res.data.total || res.data.totalCount || 0
      }
    } finally {
      loading.value = false
    }
  }

  return {
    loading,
    list,
    total,
    page,
    pageSize,
    query,
    load
  }
}
