export function normalizeTingwuSourceLanguage(language?: string): string {
  const normalized = String(language || '')
    .trim()
    .toLowerCase()

  if (!normalized || normalized === 'auto') {
    return 'cn'
  }

  return normalized
}

function createTaskKey(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '')
  return `task-${stamp}`
}

type BuildCreateTaskRequestBodyInput = {
  appKey: string
  fileUrl: string
  language?: string
  diarization?: boolean
  textPolish?: boolean
  taskKey?: string
}

export function buildCreateTaskRequestBody({
  appKey,
  fileUrl,
  language,
  diarization = false,
  textPolish = false,
  taskKey = createTaskKey(),
}: BuildCreateTaskRequestBodyInput) {
  return {
    AppKey: appKey,
    Input: {
      FileUrl: fileUrl,
      SourceLanguage: normalizeTingwuSourceLanguage(language),
      TaskKey: taskKey,
    },
    Parameters: {
      Transcription: diarization
        ? { DiarizationEnabled: true, Diarization: { SpeakerCount: 0 } }
        : { DiarizationEnabled: false },
      TextPolishEnabled: !!textPolish,
      AutoChaptersEnabled: false,
      SummarizationEnabled: false,
    },
  }
}

export function buildCreateTaskRequestQuery() {
  return {
    type: 'offline',
  }
}
