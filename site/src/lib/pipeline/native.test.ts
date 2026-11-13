/**
 * native.test.ts — 引擎子进程闸门
 *
 * 事故背景:2 核机器上三个任务同时进来就起三个 node 进程,三个都变慢,一起撞上构建超时,
 * 于是三份都失败、都退款。闸门的取值因此必须"读错就退回 1",而不是"读错就不限"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { engineConcurrency, engineConcurrencyState } from './native'

function withEnv<T>(value: string | undefined, run: () => T): T {
  const before = process.env.NATIVE_BUILD_CONCURRENCY
  if (value === undefined) delete process.env.NATIVE_BUILD_CONCURRENCY
  else process.env.NATIVE_BUILD_CONCURRENCY = value
  try {
    return run()
  } finally {
    if (before === undefined) delete process.env.NATIVE_BUILD_CONCURRENCY
    else process.env.NATIVE_BUILD_CONCURRENCY = before
  }
}

test('the default is one build at a time', () => {
  withEnv(undefined, () => assert.equal(engineConcurrency(), 1))
})

test('garbage in the env falls back to the safe default, never to unlimited', () => {
  for (const value of ['', 'abc', '0', '-3', 'NaN']) {
    withEnv(value, () => assert.equal(engineConcurrency(), 1, `NATIVE_BUILD_CONCURRENCY=${value}`))
  }
})

test('a fractional limit is floored, and a huge one is capped', () => {
  withEnv('2.9', () => assert.equal(engineConcurrency(), 2))
  withEnv('64', () => assert.equal(engineConcurrency(), 8))
})

test('the state report exposes the limit and an empty queue at rest', () => {
  withEnv('3', () => {
    const state = engineConcurrencyState()
    assert.equal(state.limit, 3)
    assert.equal(state.active, 0)
    assert.equal(state.waiting, 0)
  })
})
