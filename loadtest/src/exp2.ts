// 실험 2 실행기: 파드 강제 종료 복구를 제안서 조건대로 반복하고 결과를 한 폴더에 모음 (#58)
// 봇·측정은 index.ts(npm run bot)를 하위 프로세스로 그대로 쓰고, 이 파일은 kubectl로 파드를 지우고 결과를 묶기만 함
//
//   npm run exp2 -- --case kill             # (a) 접속 중 강제 종료: 실행 3번 × 삭제 10번
//   npm run exp2 -- --case restore-nosnap   # (b) 전원 이탈 후 강제 종료, 스냅샷 전: 3 × 10번
//   npm run exp2 -- --case restore-snap     # (b) 전원 이탈 후 강제 종료, 스냅샷 후: 3 × 10번
//
// 결과: results/exp2-{case}-{시각}/ 에 report.md(결과 표), kills.csv 또는 restores.csv, reconnects.csv(a),
//       meta.json(커밋 SHA·이미지·실행 설정), 하위 실행 로그. 하위 실행의 원본 CSV는 각자의 results/ 폴더에 남음
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { assignToKills, findRestoreLog, killReport, parseCsv, readReconnects, restoreReport } from './exp2Report'
import type { KillRecord, KillRep, ReconnectRow, RestoreRun } from './exp2Report'
import { timestampForDir, toCsv } from './results'

const execFileAsync = promisify(execFile)
const LOADTEST_DIR = path.resolve(import.meta.dirname, '..')
const CASES = ['kill', 'restore-nosnap', 'restore-snap'] as const
type Case = (typeof CASES)[number]

// 편집 시작 뒤 첫 삭제까지, 마지막 삭제 뒤 편집이 끝나기까지 (a)
const KILL_LEAD_MS = 15_000
const KILL_TAIL_MS = 30_000
// 파드가 다시 Ready가 되기를 기다리는 최대 시간
const READY_TIMEOUT_MS = 120_000
// 봇이 모두 나간 뒤 서버가 문서를 내리기를 기다리는 최대 시간 (b)
const UNLOAD_TIMEOUT_MS = 60_000
// 새 파드가 Ready가 된 뒤 HAProxy가 다시 넣을 때까지 (haproxy.cfg: DNS 다시 읽기 + inter 1s, rise 2)
const HAPROXY_RISE_MS = 5_000
// Enter 안내 문구 (index.ts waitForEnter), 줄바꿈 없이 나오므로 출력 조각에서 찾음
const ENTER_PROMPT = 'Enter를 누르면 관찰자가 접속합니다'
const SNAPSHOT_TEXT = { found: '스냅샷 있음', none: '스냅샷 없음', failed: '스냅샷 읽기 실패' } as const

function readOptions() {
  const { values } = parseArgs({
    options: {
      case: { type: 'string' },
      // 반복 수 (제안서: 3회 반복)
      reps: { type: 'string', default: '3' },
      // (a) 실행마다 파드를 지우는 횟수, (b) 반복마다 복원 실행 수 (제안서: 10회)
      count: { type: 'string', default: '10' },
      bots: { type: 'string', default: '20' },
      rate: { type: 'string', default: '1' },
      // (a) 삭제 사이 간격(초), README대로 30초 이상이면 끊김이 섞이지 않음
      interval: { type: 'string', default: '30' },
      // (b) 실행마다 편집 시간(초)
      duration: { type: 'string', default: '60' },
      // (b) restore-snap에서 봇이 나간 뒤 파드를 지우기까지 기다리는 시간(초), 워커 주기(30초)보다 길게
      'snapshot-wait': { type: 'string', default: '40' },
      url: { type: 'string', default: 'ws://localhost:8088/ws' },
      context: { type: 'string', default: 'kind-erd' },
      namespace: { type: 'string', default: 'default' },
    },
  })
  if (!CASES.includes(values.case as Case)) {
    throw new Error(`--case 값은 ${CASES.join(', ')} 중 하나여야 합니다: ${values.case ?? '(없음)'}`)
  }
  const positive = (name: string, raw: string): number => {
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`--${name} 값은 1 이상의 정수여야 합니다: ${raw}`)
    }
    return value
  }
  return {
    case: values.case as Case,
    reps: positive('reps', values.reps),
    count: positive('count', values.count),
    bots: positive('bots', values.bots),
    rate: Number(values.rate),
    intervalSec: positive('interval', values.interval),
    durationSec: positive('duration', values.duration),
    snapshotWaitSec: positive('snapshot-wait', values['snapshot-wait']),
    url: values.url,
    context: values.context,
    namespace: values.namespace,
  }
}

type Options = ReturnType<typeof readOptions>
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- kubectl ----

function kube(options: Options) {
  const base = ['--context', options.context, '-n', options.namespace]
  const run = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('kubectl', [...base, ...args], { maxBuffer: 64 * 1024 * 1024 })
    return stdout
  }

  type PodInfo = { name: string; ready: boolean; terminating: boolean; image: string; imageId: string }
  const pods = async (app: string): Promise<PodInfo[]> => {
    const list = JSON.parse(await run(['get', 'pods', '-l', `app=${app}`, '-o', 'json']))
    return list.items.map((pod: any) => ({
      name: pod.metadata.name,
      terminating: Boolean(pod.metadata.deletionTimestamp),
      ready: (pod.status.conditions ?? []).some((c: any) => c.type === 'Ready' && c.status === 'True'),
      image: pod.spec.containers[0]?.image ?? '',
      imageId: pod.status.containerStatuses?.[0]?.imageID ?? '',
    }))
  }

  const replicas = async (deployment: string): Promise<number> =>
    Number(JSON.parse(await run(['get', 'deployment', deployment, '-o', 'json'])).spec.replicas)

  // 원하는 수만큼 Ready이고, 지우는 중인 파드와 except에 든 (지운) 파드가 없을 때까지
  const waitReady = async (app: string, deployment: string, except: readonly string[] = []): Promise<void> => {
    const want = await replicas(deployment)
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      const list = await pods(app)
      const live = list.filter((pod) => !pod.terminating && !except.includes(pod.name))
      if (live.length === want && live.every((pod) => pod.ready) && list.length === want) {
        return
      }
      await sleep(500)
    }
    throw new Error(`${deployment} 파드 ${want}개가 ${READY_TIMEOUT_MS / 1000}초 안에 Ready가 되지 않음`)
  }

  // 편집 서버 지표 하나 읽기 (파드 안에서 wget, README의 확인 방법과 같음)
  const metrics = async (pod: string): Promise<string> => run(['exec', pod, '--', 'wget', '-qO-', 'localhost:8080/metrics'])
  const metric = (text: string, name: string): number => {
    let total = 0
    for (const line of text.split('\n')) {
      if (line.startsWith(name) && (line[name.length] === ' ' || line[name.length] === '{')) {
        total += Number(line.slice(line.lastIndexOf(' ') + 1))
      }
    }
    return total
  }

  const forceDelete = async (names: readonly string[]): Promise<void> => {
    await run(['delete', 'pod', ...names, '--force', '--grace-period=0', '--wait=false'])
  }

  const logs = async (pod: string): Promise<string> => run(['logs', pod])
  const scale = async (deployment: string, count: number): Promise<void> => {
    await run(['scale', `deployment/${deployment}`, `--replicas=${count}`])
  }

  return { run, pods, replicas, waitReady, metrics, metric, forceDelete, logs, scale }
}

type Kube = ReturnType<typeof kube>

// ---- 하위 실행 (index.ts) ----

type Child = {
  // 출력 조각에서 text가 나올 때까지 기다림
  waitFor: (text: string) => Promise<void>
  enter: () => void
  done: Promise<{ code: number; resultDir: string | null }>
}

function startBot(args: string[], logFile: string, label: string): Child {
  const tsx = path.join(LOADTEST_DIR, 'node_modules', '.bin', 'tsx')
  const child = spawn(tsx, ['src/index.ts', ...args], { cwd: LOADTEST_DIR, stdio: ['pipe', 'pipe', 'pipe'] })
  appendFileSync(logFile, `$ npm run bot -- ${args.join(' ')}\n`)
  let output = ''
  const waiters: { text: string; from: number; resolve: () => void }[] = []
  const onData = (chunk: Buffer) => {
    const text = chunk.toString()
    output += text
    appendFileSync(logFile, text)
    for (const line of text.split('\n')) {
      if (line.trim() !== '') {
        process.stdout.write(`  [${label}] ${line}\n`)
      }
    }
    for (const waiter of [...waiters]) {
      if (output.indexOf(waiter.text, waiter.from) !== -1) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  const done = new Promise<{ code: number; resultDir: string | null }>((resolve) => {
    child.on('close', (code) => {
      const match = output.match(/결과 저장 · (.+)/)
      resolve({ code: code ?? 1, resultDir: match ? path.resolve(LOADTEST_DIR, match[1].trim()) : null })
    })
  })
  const waitFor = (text: string) =>
    new Promise<void>((resolve, reject) => {
      if (output.includes(text)) {
        resolve()
        return
      }
      waiters.push({ text, from: 0, resolve })
      // 끝날 때까지 안 나오면 실패
      done.then(() => {
        if (waiters.some((waiter) => waiter.resolve === resolve)) {
          reject(new Error(`[${label}] "${text}"가 나오기 전에 하위 실행이 끝남`))
        }
      })
    })
  running.add(child)
  child.on('close', () => running.delete(child))
  return { waitFor, enter: () => child.stdin.write('\n'), done }
}

// Ctrl+C 때 하위 실행과 바꿔 둔 설정을 되돌리기 위함
const running = new Set<ReturnType<typeof spawn>>()
const cleanups: (() => Promise<void>)[] = []

// ---- (a) 접속 중 강제 종료 ----

async function runKill(options: Options, k: Kube, outDir: string, stamp: string): Promise<string> {
  const reps: KillRep[] = []
  const allRows: (ReconnectRow & { rep: number; kill: number })[] = []
  const killRows: KillRecord[] = []
  // 편집 시간 = 첫 삭제 전 + 삭제 간격 × 횟수 + 마지막 삭제 뒤
  const durationSec = Math.ceil((KILL_LEAD_MS + options.count * options.intervalSec * 1000 + KILL_TAIL_MS) / 1000)
  for (let rep = 1; rep <= options.reps; rep += 1) {
    await k.waitReady('editor', 'editor')
    const label = `kill-r${rep}`
    const docId = `exp2-kill-${stamp}-r${rep}`
    console.log(`\n== (a) 반복 ${rep}/${options.reps} · 문서 ${docId} · 편집 ${durationSec}초 · 삭제 ${options.count}번 ==`)
    const child = startBot(
      [
        ...['--url', options.url, '--doc', docId, '--bots', String(options.bots), '--rate', String(options.rate)],
        ...['--duration', String(durationSec), '--settle', '60', '--name', `exp2-${label}`],
      ],
      path.join(outDir, `${label}.log`),
      label,
    )
    await child.waitFor('편집 시작')
    await sleep(KILL_LEAD_MS)
    const kills: KillRecord[] = []
    for (let kill = 1; kill <= options.count; kill += 1) {
      const scheduled = Date.now() + options.intervalSec * 1000
      await k.waitReady('editor', 'editor')
      // 이 문서의 연결이 가장 많은 파드를 지움 (봇이 두 파드에 나뉘어 있을 수 있음, README hash-balance-factor)
      const pods = (await k.pods('editor')).filter((pod) => pod.ready && !pod.terminating)
      const counts = await Promise.all(
        pods.map(async (pod) => ({ pod: pod.name, connections: k.metric(await k.metrics(pod.name), 'editor_ws_connections') })),
      )
      counts.sort((a, b) => b.connections - a.connections)
      const target = counts[0]
      if (!target || target.connections === 0) {
        throw new Error('연결이 붙은 편집 서버 파드가 없음')
      }
      const killedAtMs = Date.now()
      await k.forceDelete([target.pod])
      await k.waitReady('editor', 'editor', [target.pod])
      const record = { rep, kill, pod: target.pod, connections: target.connections, killedAtMs, readyAtMs: Date.now() }
      kills.push(record)
      console.log(
        `  삭제 ${kill}/${options.count} · ${target.pod} (연결 ${target.connections}개) · ` +
          `대체 파드 Ready까지 ${((record.readyAtMs - killedAtMs) / 1000).toFixed(1)}초`,
      )
      if (kill < options.count) {
        await sleep(Math.max(0, scheduled - Date.now()))
      }
    }
    const { code, resultDir } = await child.done
    if (!resultDir) {
      throw new Error(`[${label}] 결과 폴더를 찾지 못함 (종료 코드 ${code})`)
    }
    const rows = readReconnects(readFileSync(path.join(resultDir, 'reconnects.csv'), 'utf8'))
    const summary = parseCsv(readFileSync(path.join(resultDir, 'summary.csv'), 'utf8'))[0]
    const { byKill, unassigned } = assignToKills(rows, kills)
    byKill.forEach((group, index) => allRows.push(...group.map((row) => ({ ...row, rep, kill: index + 1 }))))
    killRows.push(...kills)
    reps.push({
      rep,
      kills,
      reconnects: byKill.flat(),
      unassigned: unassigned.length,
      pending: Number(summary.reconnect_pending),
      passed: summary.passed === 'true',
    })
    console.log(`  반복 ${rep} 끝 · ${summary.passed === 'true' ? 'PASS' : 'FAIL'} · 결과 ${path.relative(LOADTEST_DIR, resultDir)}`)
    appendFileSync(path.join(outDir, 'runs.txt'), `${label} ${path.relative(LOADTEST_DIR, resultDir)}\n`)
  }

  // 삭제마다 한 줄: 끊긴 연결 수와 그 삭제로 생긴 재동기화 시간
  const perKill = killRows.map((kill) => {
    const group = allRows.filter((row) => row.rep === kill.rep && row.kill === kill.kill)
    const durations = group.map((row) => row.durationMs).sort((a, b) => a - b)
    // 지운 뒤 봇이 끊김을 알아채기까지 (컨테이너가 실제로 죽는 시간) · 지운 뒤 마지막 봇이 다시 동기화되기까지
    const detectMs = group.length > 0 ? Math.min(...group.map((row) => row.disconnectedAtMs)) - kill.killedAtMs : null
    const recoveredMs = group.length > 0 ? Math.max(...group.map((row) => row.syncedAtMs)) - kill.killedAtMs : null
    return [
      kill.rep,
      kill.kill,
      kill.pod,
      kill.connections,
      kill.killedAtMs,
      kill.readyAtMs,
      group.length,
      durations.at(-1) ?? null,
      detectMs === null ? null : Math.round(detectMs),
      recoveredMs === null ? null : Math.round(recoveredMs),
    ]
  })
  writeFileSync(
    path.join(outDir, 'kills.csv'),
    toCsv(
      ['rep', 'kill', 'pod', 'connections', 'killed_at_ms', 'ready_at_ms', 'reconnects', 'max_ms', 'detect_ms', 'recovered_ms'],
      perKill,
    ),
  )
  writeFileSync(
    path.join(outDir, 'reconnects.csv'),
    toCsv(
      ['rep', 'kill', 'bot', 'close_code', 'disconnected_at_ms', 'synced_at_ms', 'duration_ms', 'failed_attempts'],
      allRows.map((row) => [
        row.rep,
        row.kill,
        row.bot,
        row.closeCode,
        row.disconnectedAtMs,
        row.syncedAtMs,
        row.durationMs,
        row.failedAttempts,
      ]),
    ),
  )
  return killReport(reps)
}

// ---- (b) 전원 이탈 후 강제 종료 ----

async function runRestore(options: Options, k: Kube, outDir: string, stamp: string): Promise<string> {
  const snapshot = options.case === 'restore-snap'
  // 스냅샷 전: 워커를 멈춰 스냅샷이 생기지 않게 함 (끝나면 원래대로)
  if (!snapshot) {
    const before = await k.replicas('snapshot-worker')
    await k.scale('snapshot-worker', 0)
    const restoreWorker = async () => {
      await k.scale('snapshot-worker', before)
      console.log(`snapshot-worker를 ${before}개로 되돌림`)
    }
    cleanups.push(restoreWorker)
    console.log('snapshot-worker를 0개로 줄임 (스냅샷 전 조건)')
  } else if ((await k.replicas('snapshot-worker')) === 0) {
    throw new Error('restore-snap인데 snapshot-worker가 0개입니다')
  }

  const runs: RestoreRun[] = []
  const rows: unknown[][] = []
  for (let rep = 1; rep <= options.reps; rep += 1) {
    for (let run = 1; run <= options.count; run += 1) {
      await k.waitReady('editor', 'editor')
      const label = `${options.case.replace('restore-', '')}-r${rep}-${run}`
      const docId = `exp2-${options.case}-${stamp}-r${rep}-${run}`
      console.log(`\n== (b) ${options.case} · 반복 ${rep}/${options.reps} · 실행 ${run}/${options.count} · 문서 ${docId} ==`)
      const child = startBot(
        [
          ...['--url', options.url, '--doc', docId, '--scenario', 'restore', '--bots', String(options.bots)],
          ...['--rate', String(options.rate), '--duration', String(options.durationSec), '--name', `exp2-${label}`],
        ],
        path.join(outDir, `${label}.log`),
        label,
      )
      await child.waitFor(ENTER_PROMPT)
      if (snapshot) {
        console.log(`  워커 주기를 기다림 (${options.snapshotWaitSec}초)`)
        await sleep(options.snapshotWaitSec * 1000)
      }
      // 모든 파드에서 문서가 내려갔는지 (editor_docs local·shared 모두 0)
      const deadline = Date.now() + UNLOAD_TIMEOUT_MS
      for (;;) {
        const pods = (await k.pods('editor')).filter((pod) => !pod.terminating)
        const open = await Promise.all(pods.map(async (pod) => k.metric(await k.metrics(pod.name), 'editor_docs')))
        if (open.every((count) => count === 0)) {
          break
        }
        if (Date.now() > deadline) {
          throw new Error('봇이 나간 뒤에도 문서가 내려가지 않음 (브라우저 등 다른 클라이언트가 열려 있는지 확인)')
        }
        await sleep(500)
      }
      // 편집 서버 파드를 모두 강제 종료 → 새 파드는 메모리에 아무것도 없이 서버 데이터(스냅샷 + Streams)로만 복원
      const victims = (await k.pods('editor')).map((pod) => pod.name)
      await k.forceDelete(victims)
      await k.waitReady('editor', 'editor', victims)
      await sleep(HAPROXY_RISE_MS)
      console.log(`  편집 서버 파드 ${victims.length}개 강제 종료 → 새 파드 Ready · 관찰자 접속`)
      child.enter()
      const { code, resultDir } = await child.done
      if (!resultDir) {
        throw new Error(`[${label}] 결과 폴더를 찾지 못함 (종료 코드 ${code})`)
      }
      const summary = parseCsv(readFileSync(path.join(resultDir, 'summary.csv'), 'utf8'))[0]
      // 새 파드 중 이 문서를 복원한 파드의 로그 줄
      let restoreLog = null
      for (const pod of await k.pods('editor')) {
        restoreLog = findRestoreLog(await k.logs(pod.name), docId) ?? restoreLog
      }
      const record: RestoreRun = {
        rep,
        run,
        docId,
        passed: summary.passed === 'true',
        hashMatch: summary.restore_hash_match === 'true',
        missingInserts: Number(summary.restore_missing_inserts),
        missingDeletes: Number(summary.restore_missing_deletes),
        observerSyncMs: Number(summary.restore_sync_ms),
        serverRestoreMs: restoreLog ? restoreLog.seconds * 1000 : null,
        snapshot: restoreLog?.snapshot ?? null,
        entries: restoreLog?.entries ?? null,
        resultDir: path.relative(LOADTEST_DIR, resultDir),
      }
      runs.push(record)
      rows.push([
        rep,
        run,
        docId,
        record.passed,
        record.hashMatch,
        record.missingInserts,
        record.missingDeletes,
        record.observerSyncMs,
        record.serverRestoreMs,
        record.snapshot,
        record.entries,
        record.resultDir,
      ])
      console.log(
        `  ${record.passed ? 'PASS' : 'FAIL'} · 빠진 추가 ${record.missingInserts} · 빠진 삭제 ${record.missingDeletes} · ` +
          `서버 복원 ${restoreLog ? `${Math.round(restoreLog.seconds * 1000)}ms (${SNAPSHOT_TEXT[restoreLog.snapshot]}, 기록 ${restoreLog.entries}항목)` : '로그 없음'}`,
      )
      appendFileSync(path.join(outDir, 'runs.txt'), `${label} ${record.resultDir}\n`)
      // 매 실행 뒤 저장해, 중간에 멈춰도 그때까지의 결과가 남게 함
      writeFileSync(
        path.join(outDir, 'restores.csv'),
        toCsv(
          [
            'rep',
            'run',
            'doc',
            'passed',
            'hash_match',
            'missing_inserts',
            'missing_deletes',
            'observer_sync_ms',
            'server_restore_ms',
            'snapshot',
            'entries',
            'result_dir',
          ],
          rows as never,
        ),
      )
    }
  }
  return restoreReport(runs)
}

// ---- 실행 정보 ----

async function collectMeta(options: Options, k: Kube): Promise<Record<string, unknown>> {
  const git = async (args: string[]) => {
    try {
      return (await execFileAsync('git', args, { cwd: LOADTEST_DIR })).stdout.trim()
    } catch {
      return null
    }
  }
  const images: Record<string, unknown> = {}
  for (const app of ['editor', 'snapshot-worker', 'haproxy', 'redis', 'minio']) {
    try {
      images[app] = (await k.pods(app)).map((pod) => ({ pod: pod.name, image: pod.image, imageId: pod.imageId }))
    } catch {
      images[app] = null
    }
  }
  const cpus = os.cpus()
  return {
    options,
    git: { commit: await git(['rev-parse', 'HEAD']), dirty: ((await git(['status', '--porcelain'])) ?? '') !== '' },
    images,
    replicas: {
      editor: await k.replicas('editor'),
      'snapshot-worker': await k.replicas('snapshot-worker'),
    },
    host: {
      cpu: cpus[0]?.model ?? null,
      cores: cpus.length,
      memoryGb: Math.round(os.totalmem() / 1024 ** 3),
      platform: `${os.platform()} ${os.release()}`,
      node: process.version,
    },
    nodes: (await k.run(['get', 'nodes', '-o', 'wide'])).trim().split('\n'),
  }
}

async function main(): Promise<void> {
  const options = readOptions()
  const k = kube(options)
  const startedAt = new Date()
  const stamp = timestampForDir(startedAt)
  const outDir = path.join(LOADTEST_DIR, 'results', `exp2-${options.case}-${stamp}`)
  mkdirSync(outDir, { recursive: true })
  console.log(`실험 2 · ${options.case} · 반복 ${options.reps} × ${options.count} · 봇 ${options.bots}개 · 결과 ${path.relative(LOADTEST_DIR, outDir)}`)

  const meta = await collectMeta(options, k)
  writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ ...meta, startedAt: startedAt.toISOString() }, null, 2) + '\n')

  let report: string
  try {
    report = options.case === 'kill' ? await runKill(options, k, outDir, stamp) : await runRestore(options, k, outDir, stamp)
  } finally {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup()
    }
  }
  const title = {
    kill: '(a) 접속 중 강제 종료 → 재동기화 시간',
    'restore-nosnap': '(b) 전원 이탈 후 강제 종료 · 스냅샷 전 (Streams만으로 복원)',
    'restore-snap': '(b) 전원 이탈 후 강제 종료 · 스냅샷 후 (스냅샷 + 이후 Streams로 복원)',
  }[options.case]
  const git = meta.git as { commit: string | null; dirty: boolean }
  const host = meta.host as { cpu: string | null; cores: number }
  const text =
    `# 실험 2 ${title}\n\n` +
    `- 실행: ${startedAt.toISOString()} ~ ${new Date().toISOString()}\n` +
    `- 커밋: ${git.commit ?? '?'}${git.dirty ? ' (커밋 안 한 변경 있음)' : ''}\n` +
    `- 조건: 반복 ${options.reps} × ${options.count}, 봇 ${options.bots}개, 봇당 초당 ${options.rate}회` +
    (options.case === 'kill' ? `, 삭제 간격 ${options.intervalSec}초` : `, 편집 ${options.durationSec}초`) +
    (options.case === 'restore-snap' ? `, 이탈 후 ${options.snapshotWaitSec}초 뒤 삭제` : '') +
    `\n- 부하 PC: ${host.cpu ?? '?'} (${host.cores}코어)\n\n` +
    report
  writeFileSync(path.join(outDir, 'report.md'), text)
  console.log(`\n${text}`)
  console.log(`결과 · ${path.relative(LOADTEST_DIR, outDir)}`)
}

// Ctrl+C: 하위 실행을 끝내고 바꾼 설정(워커 수)을 되돌린 뒤 종료
process.on('SIGINT', () => {
  running.forEach((child) => child.kill('SIGINT'))
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())).finally(() => process.exit(130))
})

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error)
  running.forEach((child) => child.kill('SIGINT'))
  for (const cleanup of cleanups.splice(0)) {
    await cleanup().catch(() => {})
  }
  process.exit(1)
})
