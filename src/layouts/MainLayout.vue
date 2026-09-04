<script setup>
import TheHeader from '../components/TheHeader.vue'
</script>
<template>
  <div class="layout">
    <TheHeader />
    <main>
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <keep-alive :max="12">
            <component :is="Component" />
          </keep-alive>
        </transition>
      </router-view>
    </main>
  </div>
</template>
<style scoped>
.layout { min-height: 100vh; }
main { min-height: calc(100vh - 64px); }
</style>
