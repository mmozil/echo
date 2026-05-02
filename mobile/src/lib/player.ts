// Wrapper sobre react-native-track-player com setup idempotente
// e API simplificada pra o resto do app.
import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  IOSCategory,
  IOSCategoryMode,
} from 'react-native-track-player';

let setupPromise: Promise<void> | null = null;

export async function ensurePlayerSetup() {
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    try {
      await TrackPlayer.setupPlayer({
        // Mantém áudio ativo em background com bom comportamento iOS
        iosCategory: IOSCategory.Playback,
        iosCategoryMode: IOSCategoryMode.SpokenAudio,
        autoHandleInterruptions: true,
      });
    } catch (e: any) {
      // Idempotente: se já foi inicializado em uma sessão anterior, ignora
      if (!String(e?.message || '').includes('already')) throw e;
    }
    await TrackPlayer.updateOptions({
      android: {
        appKilledPlaybackBehavior: AppKilledPlaybackBehavior.PausePlayback,
      },
      // Botões que aparecem na notificação Android e no controle remoto iOS
      capabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.JumpForward,
        Capability.JumpBackward,
        Capability.SeekTo,
        Capability.Stop,
      ],
      compactCapabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.JumpForward,
        Capability.JumpBackward,
      ],
      notificationCapabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.JumpForward,
        Capability.JumpBackward,
      ],
      forwardJumpInterval: 10,
      backwardJumpInterval: 10,
    });
  })();
  return setupPromise;
}

export type TrackMeta = {
  url: string;
  title: string;       // Capítulo / nome do trecho
  artist: string;      // Título do livro
  artwork?: string;    // URL do cover (lockscreen art)
  duration?: number;   // segundos
};

export async function loadAndPlay(track: TrackMeta, seekSec = 0, rate = 1) {
  await ensurePlayerSetup();
  await TrackPlayer.reset();
  await TrackPlayer.add({
    url: track.url,
    title: track.title,
    artist: track.artist,
    artwork: track.artwork,
    duration: track.duration,
  });
  if (seekSec > 0) await TrackPlayer.seekTo(seekSec);
  await TrackPlayer.setRate(rate);
  await TrackPlayer.play();
}

export async function play() { await TrackPlayer.play(); }
export async function pause() { await TrackPlayer.pause(); }
export async function seekTo(seconds: number) { await TrackPlayer.seekTo(seconds); }
export async function setRate(rate: number) { await TrackPlayer.setRate(rate); }

export async function jumpBy(deltaSec: number) {
  const p = await TrackPlayer.getProgress();
  const target = Math.max(0, Math.min(p.position + deltaSec, p.duration || Infinity));
  await TrackPlayer.seekTo(target);
}

export async function getProgressMs(): Promise<{ position: number; duration: number }> {
  const p = await TrackPlayer.getProgress();
  return { position: p.position * 1000, duration: p.duration * 1000 };
}

// Atualiza metadata da track sem recarregar (ex: muda capítulo no display)
export async function updateNowPlayingMeta(meta: { title?: string; artist?: string; artwork?: string }) {
  try {
    const idx = await TrackPlayer.getActiveTrackIndex();
    if (idx == null) return;
    await TrackPlayer.updateMetadataForTrack(idx, {
      title: meta.title,
      artist: meta.artist,
      artwork: meta.artwork,
    });
  } catch {}
}
