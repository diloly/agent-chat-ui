<template>
  <div class="app">
    <SessionList />
    <ChatPanel />
  </div>
</template>

<script setup lang="ts">
import SessionList from '~/components/SessionList.vue';
import ChatPanel from '~/components/ChatPanel.vue';
</script>

<style>
* { box-sizing: border-box; }
html, body, #__nuxt { height: 100%; margin: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: #121212;
  color: #e0e0e0;
}
.app {
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  display: flex;
  flex-direction: row;
}
</style>
