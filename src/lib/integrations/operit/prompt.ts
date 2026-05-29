export function buildOperitPrompt(task: { title: string; description?: string | null }, deviceName: string): string {
  return [
    `You are the executor on Android device ${deviceName}.`,
    'Carry out the task on the device using Operit capabilities.',
    'Reply in Russian.',
    'Return:',
    '1. Что сделал',
    '2. Результат',
    '3. Ошибки или ограничения',
    '',
    `Задача: ${task.title}`,
    `Описание: ${task.description?.trim() || 'Нет дополнительного описания.'}`,
  ].join('\n')
}
