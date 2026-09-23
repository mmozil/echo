// Playback service do react-native-track-player.
// Roda fora do React tree pra responder eventos do controle remoto
// (lockscreen, headset, Bluetooth, etc) mesmo com o app em background.
import TrackPlayer, { Event } from 'react-native-track-player';
import { avancarTrecho } from './src/lib/player';

module.exports = async function () {
  // 🚨 O AVANÇO DE TRECHO É TRATADO AQUI, e não na tela de leitura.
  // Aqui ele sobrevive ao desmonte: sair da tela de leitura deixava a
  // inscrição do React ser limpa, e a voz parava no fim do trecho corrente.
  TrackPlayer.addEventListener(Event.PlaybackQueueEnded, () => {
    avancarTrecho();
  });

  // Sem estes dois, falha de rede e token vencido sumiam em silêncio: a tela
  // continuava mostrando play e o som simplesmente não saía.
  TrackPlayer.addEventListener(Event.PlaybackError, (e) => {
    console.warn('[echo] erro de reprodução:', e?.code, e?.message);
  });

  TrackPlayer.addEventListener(Event.RemotePlay, () => {
    TrackPlayer.play();
  });

  TrackPlayer.addEventListener(Event.RemotePause, () => {
    TrackPlayer.pause();
  });

  TrackPlayer.addEventListener(Event.RemoteStop, () => {
    TrackPlayer.reset();
  });

  TrackPlayer.addEventListener(Event.RemoteJumpForward, async (e) => {
    const pos = await TrackPlayer.getProgress();
    TrackPlayer.seekTo(pos.position + (e.interval ?? 10));
  });

  TrackPlayer.addEventListener(Event.RemoteJumpBackward, async (e) => {
    const pos = await TrackPlayer.getProgress();
    TrackPlayer.seekTo(Math.max(0, pos.position - (e.interval ?? 10)));
  });

  TrackPlayer.addEventListener(Event.RemoteSeek, (e) => {
    TrackPlayer.seekTo(e.position);
  });

  TrackPlayer.addEventListener(Event.RemoteDuck, async (e) => {
    // Pausa quando outro áudio interrompe (ex: ligação)
    if (e.permanent || e.paused) {
      TrackPlayer.pause();
    }
  });
};
