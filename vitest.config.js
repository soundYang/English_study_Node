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
    // 覆盖率只盯词表校验：它错了没人看得出来（md/02 S7 的验收项）。
    // 其余模块按需临时改 include，不设全局阈值，否则噪声会盖掉信号。
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/modules/readings/vocabulary.service.js'],
    },
  },
})
