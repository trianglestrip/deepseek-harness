/**
 * Plugin transactions for the desktop shell.
 *
 * The replaced Electron shell drove `DesktopProjectManager` from its main
 * process; the Tauri shell has no in-process access to it, so the same manager
 * runs here as a program the shell spawns while its backend is stopped. One
 * command in, one JSON result on standard output, so the shell only translates
 * arguments and parses the answer.
 *
 * Usage:
 *   node desktop-plugins.js --node <node> --pnpm <pnpm.mjs> --dsh <dshDir>
 *     [--profile <profileDir>]
 *     <list|add <spec>|remove <name>|update <name> <version>|toggle <name> <on|off>|disable-all|reset>
 */

import { join } from 'node:path'
import { DesktopProjectManager, type DesktopProjectMutation } from './project-manager.ts'
import { resolveDesktopPaths } from './paths.ts'

interface Options {
  readonly node: string
  readonly pnpm: string
  readonly dsh: string
  readonly profile: string | undefined
}

const COMMANDS = ['list', 'add', 'remove', 'update', 'toggle', 'disable-all', 'reset'] as const
type Command = (typeof COMMANDS)[number]

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function required(value: string | undefined, usage: string): string {
  if (value === undefined || value === '') throw new Error(`desktop plugins: expected ${usage}`)
  return value
}

/** Parse the shell's arguments. */
function parse(argv: readonly string[]): { options: Options; command: Command; args: string[] } {
  const options: Record<string, string> = {}
  let index = 0
  for (; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined || !argument.startsWith('--')) break
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`desktop plugins: ${argument} needs a value`)
    options[argument.slice(2)] = value
    index += 1
  }
  const name = argv[index]
  const command = COMMANDS.find(candidate => candidate === name)
  if (command === undefined) {
    throw new Error(`desktop plugins: expected one of ${COMMANDS.join(', ')}, saw ${JSON.stringify(name ?? '')}`)
  }
  return {
    options: {
      node: required(options['node'], '--node <node>'),
      pnpm: required(options['pnpm'], '--pnpm <pnpm.mjs>'),
      dsh: required(options['dsh'], '--dsh <dshDir>'),
      profile: options['profile'],
    },
    command,
    args: argv.slice(index + 1),
  }
}

/** One supported transaction and the arguments it takes. */
function mutation(command: Command, args: string[]): DesktopProjectMutation | undefined {
  switch (command) {
    case 'add':
      return { type: 'plugin-add', spec: required(args[0], 'add <spec>') }
    case 'remove':
      return { type: 'plugin-remove', name: required(args[0], 'remove <name>') }
    case 'update':
      return {
        type: 'plugin-update',
        name: required(args[0], 'update <name> <version>'),
        version: required(args[1], 'update <name> <version>'),
      }
    case 'toggle': {
      const enabled = required(args[1], 'toggle <name> <on|off>')
      if (enabled !== 'on' && enabled !== 'off') {
        throw new Error(`desktop plugins: toggle takes on or off, saw ${JSON.stringify(enabled)}`)
      }
      return { type: 'plugin-toggle', name: required(args[0], 'toggle <name> <on|off>'), enabled: enabled === 'on' }
    }
    case 'disable-all':
      return { type: 'plugins-disable-all' }
    default:
      return undefined
  }
}

async function main(): Promise<void> {
  const { options, command, args } = parse(process.argv.slice(2))
  const defaults = resolveDesktopPaths()
  const profile = options.profile ?? defaults.profile
  const manager = new DesktopProjectManager(
    { ...defaults, profile, lock: join(profile, 'lock') },
    { node: options.node, pnpm: options.pnpm, dsh: options.dsh },
  )
  // The shell stops its backend around this program, so the manager's hooks have
  // nothing left to do.
  const hooks = { beforeChange: async (): Promise<void> => {}, afterChange: async (): Promise<void> => {} }
  if (command === 'list') {
    process.stdout.write(`${JSON.stringify({ ok: true, value: manager.listPlugins() })}\n`)
    return
  }
  if (command === 'reset') {
    await manager.resetConfiguration(hooks)
    process.stdout.write(`${JSON.stringify({ ok: true, value: null })}\n`)
    return
  }
  const change = mutation(command, args)
  if (change === undefined) throw new Error(`desktop plugins: ${command} is not a transaction`)
  await manager.mutate(change, hooks)
  process.stdout.write(`${JSON.stringify({ ok: true, value: null })}\n`)
}

await main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify({ ok: false, message: messageOf(error) })}\n`)
  process.exitCode = 1
})
