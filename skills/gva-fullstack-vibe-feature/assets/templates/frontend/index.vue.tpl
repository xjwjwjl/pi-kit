<template>
  <div class="{{MODULE}}-page">
    <div class="gva-search-box">
      <el-form :inline="true" :model="query">
        <el-form-item label="名称">
          <el-input v-model="query.name" clearable placeholder="请输入名称" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="load">查询</el-button>
        </el-form-item>
      </el-form>
    </div>

    <div class="gva-table-box">
      <el-table v-loading="loading" :data="list" row-key="id">
        <el-table-column prop="id" label="ID" width="90" />
        <el-table-column prop="name" label="名称" min-width="180" />
        <el-table-column prop="createdAt" label="创建时间" min-width="180" />
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
import { use{{PASCAL}}List } from './composables/use{{PASCAL}}List'

const {
  loading,
  list,
  query,
  load
} = use{{PASCAL}}List()

onMounted(() => {
  load()
})
</script>
