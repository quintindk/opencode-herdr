import { handleRequest, readRemoteConfig, remoteLimits } from './remote.js'
import { Store } from './store.js'

// One fixed stdin/stdout exchange per SSH process. Never accept command-line operations.
async function main(): Promise<void> {
  let store: Store | undefined
  const timer = setTimeout(() => process.exit(1), remoteLimits.timeoutMs)
  try {
    if (process.argv.length !== 2) throw new Error('Arguments are not supported')
    const config = readRemoteConfig()
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > remoteLimits.requestBytes) throw new Error('Input limit exceeded')
      chunks.push(bytes)
    }
    const packet: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    store = new Store()
    const result = JSON.stringify(handleRequest(store, config.server, packet))
    if (Buffer.byteLength(result) > remoteLimits.outputBytes) throw new Error('Output limit exceeded')
    process.stdout.write(result + '\n')
  } catch {
    process.stdout.write('{"protocolVersion":1,"ok":false,"error":"Remote request rejected"}\n')
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
    store?.close()
  }
}

void main()
