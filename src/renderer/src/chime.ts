import type { ChimeSound } from '@shared/types'

let ctx: AudioContext | null = null

function audio(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

function tone(ac: AudioContext, out: AudioNode, freq: number, start: number, duration: number, gain: number, type: OscillatorType = 'sine'): void {
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, start)
  g.gain.setValueAtTime(0.0001, start)
  g.gain.exponentialRampToValueAtTime(gain, start + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  osc.connect(g).connect(out)
  osc.start(start)
  osc.stop(start + duration + 0.05)
}

/** Plays a short synthesised notification sound — no audio files needed. */
export function playChime(sound: ChimeSound, volume: number): void {
  const ac = audio()
  const master = ac.createGain()
  master.gain.value = Math.max(0, Math.min(1, volume))
  master.connect(ac.destination)
  const t = ac.currentTime + 0.02
  switch (sound) {
    case 'chime':
      tone(ac, master, 1318.5, t, 0.9, 0.35) // E6
      tone(ac, master, 1975.5, t + 0.12, 1.1, 0.28) // B6
      break
    case 'bell':
      for (const [f, g] of [[880, 0.3], [1760, 0.12], [2640, 0.06], [3520, 0.03]] as const) tone(ac, master, f, t, 1.6, g)
      break
    case 'soft':
      tone(ac, master, 659.3, t, 0.7, 0.3) // E5
      tone(ac, master, 987.8, t + 0.16, 0.8, 0.22) // B5
      break
    case 'pop':
      tone(ac, master, 1046.5, t, 0.18, 0.4, 'triangle')
      tone(ac, master, 1568, t + 0.07, 0.22, 0.3, 'triangle')
      break
  }
}
