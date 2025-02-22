import { promises as fs } from 'fs'
import type { BirpcReturn } from 'birpc'
import { createBirpc } from 'birpc'
import { parse, stringify } from 'flatted'
import type { WebSocket } from 'ws'
import { WebSocketServer } from 'ws'
import type { ModuleNode } from 'vite'
import { API_PATH } from '../constants'
import type { Vitest } from '../node'
import type { File, ModuleGraphData, Reporter, TaskResultPack } from '../types'
import { shouldExternalize } from '../utils/externalize'
import { interpretSourcePos, parseStacktrace } from '../utils/source-map'
import { transformRequest } from '../node/transform'
import type { TransformResultWithSource, WebSocketEvents, WebSocketHandlers } from './types'

export function setup(ctx: Vitest) {
  const wss = new WebSocketServer({ noServer: true })

  const clients = new Map<WebSocket, BirpcReturn<WebSocketEvents>>()

  ctx.server.httpServer?.on('upgrade', (request, socket, head) => {
    if (!request.url)
      return

    const { pathname } = new URL(request.url, 'http://localhost')
    if (pathname !== API_PATH)
      return

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
      setupClient(ws)
    })
  })

  function setupClient(ws: WebSocket) {
    const rpc = createBirpc<WebSocketHandlers, WebSocketEvents>({
      functions: {
        getFiles() {
          return ctx.state.getFiles()
        },
        readFile(id) {
          return fs.readFile(id, 'utf-8')
        },
        writeFile(id, content) {
          return fs.writeFile(id, content, 'utf-8')
        },
        async rerun(files) {
          await ctx.report('onWatcherRerun', files)
          await ctx.runFiles(files)
          await ctx.report('onWatcherStart')
        },
        getConfig() {
          return ctx.config
        },
        async getTransformResult(id) {
          const result: TransformResultWithSource | null | undefined = await transformRequest(ctx, id)
          if (result) {
            try {
              result.source = result.source || (await fs.readFile(id, 'utf-8'))
            }
            catch {}
            return result
          }
        },
        async getModuleGraph(id: string): Promise<ModuleGraphData> {
          const graph: Record<string, string[]> = {}
          const externalized = new Set<string>()
          const inlined = new Set<string>()

          function clearId(id?: string | null) {
            return id?.replace(/\?v=\w+$/, '') || ''
          }
          async function get(mod?: ModuleNode, seen = new Map<ModuleNode, string>()) {
            if (!mod || !mod.id)
              return
            if (seen.has(mod))
              return seen.get(mod)
            let id = clearId(mod.id)
            seen.set(mod, id)
            const rewrote = await shouldExternalize(id, ctx.config)
            if (rewrote) {
              id = rewrote
              externalized.add(id)
              seen.set(mod, id)
            }
            else {
              inlined.add(id)
            }
            const mods = Array.from(mod.importedModules).filter(i => i.id && !i.id.includes('/vitest/dist/'))
            graph[id] = (await Promise.all(mods.map(m => get(m, seen)))).filter(Boolean) as string[]
            return id
          }
          await get(ctx.server.moduleGraph.getModuleById(id))
          return {
            graph,
            externalized: Array.from(externalized),
            inlined: Array.from(inlined),
          }
        },
      },
      post(msg) {
        ws.send(msg)
      },
      on(fn) {
        ws.on('message', fn)
      },
      eventNames: ['onCollected'],
      serialize: stringify,
      deserialize: parse,
    })

    clients.set(ws, rpc)

    ws.on('close', () => {
      clients.delete(ws)
    })
  }

  ctx.reporters.push(new WebSocketReporter(ctx, wss, clients))
}

class WebSocketReporter implements Reporter {
  constructor(
    public ctx: Vitest,
    public wss: WebSocketServer,
    public clients: Map<WebSocket, BirpcReturn<WebSocketEvents>>,
  ) {}

  onCollected(files?: File[]) {
    if (this.clients.size === 0)
      return
    this.clients.forEach((client) => {
      client.onCollected?.(files)
    })
  }

  async onTaskUpdate(packs: TaskResultPack[]) {
    if (this.clients.size === 0)
      return

    await Promise.all(packs.map(async(i) => {
      if (i[1]?.error)
        await interpretSourcePos(parseStacktrace(i[1].error as any), this.ctx)
    }))

    this.clients.forEach((client) => {
      client.onTaskUpdate?.(packs)
    })
  }
}
