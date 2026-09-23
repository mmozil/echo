// Wrapper sobre react-native-track-player com setup idempotente
// e API simplificada pra o resto do app.
import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  IOSCategory,
  IOSCategoryMode,
} from 'react-native-track-player';

// =========================================================================
// O AVANÇO DE TRECHO MORA AQUI, FORA DA ÁRVORE DO REACT
//
// Ele vivia num useTrackPlayerEvents dentro de app/reader/[id].tsx. Quem
// tocava no botão de voltar (ou saía da tela de leitura por qualquer caminho)
// desmontava a tela, o React limpava a inscrição, e quando o trecho corrente
// acabava não havia mais ninguém para tocar o seguinte: a voz parava sozinha,
// com o aparelho no bolso.
//
// 🚨 O playback service (service.ts) roda headless e sobrevive ao desmonte —
// é ele quem chama avancarTrecho(). A tela só REGISTRA como avançar.
// =========================================================================

type Avanco = () => Promise<void>;
let _avancar: Avanco | null = null;

export function definirAvanco(fn: Avanco | null) {
  _avancar = fn;
}

export async function avancarTrecho() {
  if (!_avancar) return;
  try {
    await _avancar();
  } catch (e) {
    console.warn('[echo] avanço de trecho falhou:', e);
  }
}

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
  // 🚨 Guardar a promessa REJEITADA travava o áudio pelo resto da sessão:
  // toda chamada seguinte recebia a mesma falha, sem nunca tentar de novo.
  setupPromise.catch(() => { setupPromise = null; });
  return setupPromise;
}

export type TrackMeta = {
  url: string;
  title: string;       // Capítulo / nome do trecho
  artist: string;      // Título do livro
  artwork?: string;    // URL do cover (lockscreen art)
  duration?: number;   // segundos
  headers?: Record<string, string>;  // Bearer — o MP3 exige sessão do dono
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
    headers: track.headers,
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
