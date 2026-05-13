import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCreateTaskRequestBody,
  buildCreateTaskRequestQuery,
  normalizeTingwuSourceLanguage,
} from '../api/tingwu-task'

test('normalizeTingwuSourceLanguage 将 auto 回退为 cn', () => {
  assert.equal(normalizeTingwuSourceLanguage('auto'), 'cn')
  assert.equal(normalizeTingwuSourceLanguage(' AUTO '), 'cn')
  assert.equal(normalizeTingwuSourceLanguage(''), 'cn')
})

test('normalizeTingwuSourceLanguage 保留显式语种', () => {
  assert.equal(normalizeTingwuSourceLanguage('en'), 'en')
  assert.equal(normalizeTingwuSourceLanguage('fspk'), 'fspk')
})

test('buildCreateTaskRequestBody 构造离线转写请求体', () => {
  const body = buildCreateTaskRequestBody({
    appKey: 'app-key',
    fileUrl: 'https://example.com/audio.m4a',
    language: 'auto',
    diarization: false,
    textPolish: true,
    taskKey: 'task-fixed',
  })

  assert.deepEqual(body, {
    AppKey: 'app-key',
    Input: {
      FileUrl: 'https://example.com/audio.m4a',
      SourceLanguage: 'cn',
      TaskKey: 'task-fixed',
    },
    Parameters: {
      Transcription: {
        DiarizationEnabled: false,
      },
      TextPolishEnabled: true,
      AutoChaptersEnabled: false,
      SummarizationEnabled: false,
    },
  })
})

test('buildCreateTaskRequestQuery 构造必填 type 参数', () => {
  assert.deepEqual(buildCreateTaskRequestQuery(), {
    type: 'offline',
  })
})
