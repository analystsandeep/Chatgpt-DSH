// Plain-ASCII reporter for node:test (status words instead of symbols), so results read
// correctly in Windows PowerShell 5.1 and cmd.exe as well as POSIX terminals.
function failureText(error) {
  const cause = error?.cause ?? error
  const text = cause?.message ?? String(cause)
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 12).join('\n      ')
}

export default async function* reporter(source) {
  for await (const event of source) {
    const data = event.data ?? {}
    if (data.details?.type === 'suite') continue
    if (event.type === 'test:pass') {
      const skipped = data.skip !== undefined && data.skip !== false
      const todo = data.todo !== undefined && data.todo !== false
      yield `${skipped ? 'SKIP' : todo ? 'TODO' : 'PASS'} ${data.name}\n`
    } else if (event.type === 'test:fail') {
      yield `FAIL ${data.name}\n      ${failureText(data.details?.error)}\n`
    }
  }
}
