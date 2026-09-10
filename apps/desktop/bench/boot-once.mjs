/** Boot-once wrapper: run the desktop profile and exit right after the web
 * announce line, so `node --cpu-prof` captures the whole boot and still gets
 * to write its profile. */
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'

const { runProfile } = await import('../apps/cli/lib/profile-boot-CMEGRIuU.js')

const originalWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...rest) => {
  if (String(chunk).includes('dsh web:')) {
    setTimeout(() => process.exit(0), 1200)
  }
  return originalWrite(chunk, ...rest)
}

await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: 'desktop',
  patchFiles: [],
  args: [],
})
