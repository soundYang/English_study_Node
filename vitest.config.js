import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/tests/setup.js'],
    // 每个测试文件会起自己的内存 Mongo，并行起来会互相抢端口
    fileParallelism: false,
    // 首次运行要下载 MongoDB 二进制，给足时间
    testTimeout: 20_000,
    hookTimeout: 180_000,
  },
})
