import { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react';
import {
  View, Text, Pressable, ActivityIndicator, FlatList, ScrollView,
  Dimensions, Alert, StyleSheet, } from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import TrackPlayer, {
  State,
  usePlaybackState,
  useProgress,
} from 'react-native-track-player';
import Svg, { Path } from 'react-native-svg';
import { Player } from '@/components/PlayerBar';
import { Folha, LinhaFolha } from '@/components/Folha';
import { Toque } from '@/components/Toque';
import { tipo, espaco, raio, useTema, type Paleta } from '@/lib/theme';
import {
  ensurePlayerSetup, loadAndPlay, play as tpPlay, pause as tpPause,
  jumpBy, seekTo as tpSeek, setRate as tpSetRate, definirAvanco,
} from '@/lib/player';
import {
  getDocument, getChunkAudio, getPageWords, getToc, saveProgress,
  audioUrl, pageImageUrl, coverUrl, authHeaders, getVoices, saveVoice,
  type Chunk, type TocItem, type Voz,
} from '@/lib/api';
import {
  buildSentenceD, findNearestWord, sentenceRange,
  findBoundaryByWordSequence, findBoundaryByWordSequenceScored,
  buildWordTimingMap, type Word, type WordTimingMap,
} from '@/lib/highlight';
import { colors, fonts } from '@/lib/theme';

const SCREEN_W = Dimensions.get('window').width;
const PAGE_RATIO = 0.71;
const PAGE_HEIGHT = SCREEN_W / PAGE_RATIO;
// altura aproximada do player (3 + 11+46+11 + 8+28+11 = ~118)
const PLAYER_H = 118;

type Boundary = { offset_ms: number; duration_ms: number; text: string };
type ViewMode = 'pdf' | 'text';

const norm = (s: string) =>
  (s || '').toLowerCase().replace(/[.,;:!?"'()\[\]\-—–“”‘’]/g, '').replace(/\s+/g, ' ').trim();
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

export default function Reader() {
  const c = useTema();
  const styles = useMemo(() => criarEstilos(c), [c]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const docId = String(id);
  const insets = useSafeAreaInsets();
  const bottomPad = PLAYER_H + insets.bottom + 16;

  const { data, isLoading } = useQuery({
    queryKey: ['document', docId],
    queryFn: () => getDocument(docId),
  });

  // TOC pra mostrar nome do capítulo no player
  const { data: toc } = useQuery({
    queryKey: ['toc', docId],
    queryFn: () => getToc(docId),
  });

  const [viewMode, setViewMode] = useState<ViewMode>('pdf');
  const [tocOpen, setTocOpen] = useState(false);
  const [chunkIdx, setChunkIdx] = useState(0);
  const [boundaries, setBoundaries] = useState<Boundary[]>([]);
  const [pageWords, setPageWords] = useState<Record<number, Word[]>>({});
  const [pageTimings, setPageTimings] = useState<Record<number, WordTimingMap>>({});
  const [activeBIdx, setActiveBIdx] = useState(-1);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [speed, setSpeed] = useState(1);
  // Voz: o ref é quem manda na hora de pedir o áudio. O estado só pinta o
  // rótulo — ler do estado dentro do playChunk pegaria o valor de antes da
  // troca (closure), e a pessoa ouviria a voz velha achando que não mudou.
  const [voice, setVoiceLabel] = useState('pt-BR-AntonioNeural');
  const [voices, setVoices] = useState<Voz[]>([]);
  const voiceRef = useRef('pt-BR-AntonioNeural');
  // Estado do TrackPlayer (lockscreen-aware)
  const playbackState = usePlaybackState();
  const progress = useProgress(250); // 250ms tick — suave pra highlight
  const isPlaying = playbackState.state === State.Playing;
  const posMs = progress.position * 1000;

  const soundChunkIdxRef = useRef(-1); // qual chunk está atualmente carregado
  const flatRef = useRef<FlatList<number>>(null);
  const chunkDur = useRef<Record<number, number>>({});
  const userScrollingRef = useRef(false);
  const userScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playSeqRef = useRef(0);

  // Inicializa o TrackPlayer uma vez (lockscreen + bg audio)
  useEffect(() => {
    ensurePlayerSetup().catch((e) => console.warn('player setup:', e));
  }, []);

  // Atualiza chunkDur com a duração real quando o áudio carrega
  useEffect(() => {
    if (progress.duration > 0 && soundChunkIdxRef.current >= 0) {
      chunkDur.current[soundChunkIdxRef.current] = progress.duration * 1000;
    }
  }, [progress.duration]);

  useEffect(() => {
    if (data?.progress?.current_chunk != null) {
      setChunkIdx(data.progress.current_chunk);
    }
  }, [data?.document?.id]);

  // Pré-carrega palavras + mapa de timing das próximas páginas
  // O mapa palavra→offset_ms é o que dá precisão Speechify-level no click
  useEffect(() => {
    if (!data) return;
    const chunk = data.chunks[chunkIdx];
    if (!chunk) return;
    const pages = [chunk.page, chunk.page + 1, chunk.page + 2]
      .filter(p => p >= 1 && p <= data.document.total_pages);

    pages.forEach(async (p) => {
      try {
        // 1) Palavras da página com posições
        let words = pageWords[p];
        if (!words) {
          words = await getPageWords(docId, p);
          setPageWords(prev => ({ ...prev, [p]: words }));
        }
        // 2) Mapa de timing (se ainda não tem)
        if (pageTimings[p]) return;
        const pageChunks = data.chunks.filter(c => c.page === p);
        if (!pageChunks.length) return;
        const audios = await Promise.all(
          pageChunks.map(c => getChunkAudio(docId, c.index).catch(() => null))
        );
        const valid = pageChunks
          .map((c, i) => audios[i] ? { index: c.index, boundaries: audios[i]!.boundaries } : null)
          .filter((x): x is { index: number; boundaries: Boundary[] } => !!x);
        if (!valid.length) return;
        const map = buildWordTimingMap(words, valid);
        setPageTimings(prev => ({ ...prev, [p]: map }));
      } catch (e) {
        console.warn('preload page', p, e);
      }
    });
  }, [chunkIdx, data?.document?.id]);

  // Auto-scroll pra página atual durante playback (PDF view)
  useEffect(() => {
    if (viewMode !== 'pdf' || !data || userScrollingRef.current) return;
    const chunk = data.chunks[chunkIdx];
    if (!chunk) return;
    flatRef.current?.scrollToIndex({ index: chunk.page - 1, animated: true, viewPosition: 0.1 });
  }, [chunkIdx, data?.document?.id, viewMode]);

  // Voz salva na conta — mesma da web
  useEffect(() => {
    getVoices()
      .then(({ voices: vs, selected }) => {
        setVoices(vs);
        if (selected) { voiceRef.current = selected; setVoiceLabel(selected); }
      })
      .catch(() => {});
  }, []);

  // Toca chunk com proteção anti-overlap (TrackPlayer)
  const playChunk = useCallback(async (idx: number, seekToMs = 0) => {
    if (!data) return;

    // FAST PATH: mesmo chunk já carregado → só seek (sem reload)
    if (soundChunkIdxRef.current === idx) {
      try {
        await tpSeek(seekToMs / 1000);
        await tpPlay();
        saveProgress(docId, idx, seekToMs).catch(() => {});
        return;
      } catch (e) {
        console.warn('[playChunk] fast-path falhou, full reload:', e);
      }
    }

    const seq = ++playSeqRef.current;
    setIsLoadingAudio(true);
    try {
      const audio = await getChunkAudio(docId, idx, voiceRef.current);
      if (seq !== playSeqRef.current) return;
      setBoundaries(audio.boundaries);

      const chunk = data.chunks[idx];
      const chapterName = (() => {
        if (!toc?.length || !chunk) return `Trecho ${idx + 1}`;
        for (let i = toc.length - 1; i >= 0; i--) {
          if (toc[i].page <= chunk.page) return toc[i].title;
        }
        return `Página ${chunk.page}`;
      })();

      await loadAndPlay(
        {
          url: audioUrl(audio.audio_url),
          title: chapterName,
          artist: data.document.title,
          artwork: coverUrl(data.document.id).uri,
          headers: authHeaders(),
        },
        seekToMs / 1000,
        speed,
      );

      if (seq !== playSeqRef.current) return;
      soundChunkIdxRef.current = idx;
      setChunkIdx(idx);
      saveProgress(docId, idx, seekToMs).catch(() => {});
    } catch (e: any) {
      Alert.alert('Erro', e?.message || 'Falha ao carregar áudio');
    } finally {
      if (seq === playSeqRef.current) setIsLoadingAudio(false);
    }
  }, [data, docId, speed, toc]);

  // Auto-advance: a tela REGISTRA como avançar; quem CHAMA é o playback
  // service (mobile/service.ts), que roda headless.
  //
  // 🚨 Isto era um useTrackPlayerEvents aqui dentro. Sair da tela de leitura
  // (o chevron de voltar, ou qualquer navegação) desmontava o componente, o
  // React limpava a inscrição, e no fim do trecho não havia ninguém para
  // tocar o seguinte — a leitura morria sozinha. Registrando fora da árvore,
  // a função sobrevive ao desmonte e o livro continua.
  //
  // 🚨 De propósito SEM cleanup no desmonte: limpar aqui devolveria o defeito.
  // Abrir outro documento substitui o registro, que é o que se quer.
  useEffect(() => {
    if (!data) return;
    definirAvanco(async () => {
      const nextIdx = soundChunkIdxRef.current + 1;
      if (nextIdx > 0 && nextIdx < data.chunks.length) {
        await playChunk(nextIdx, 0);
      }
    });
  }, [data, playChunk]);

  // O progresso guardava a posição de PARTIDA do trecho, nunca a corrente:
  // quem ouvia 50s e fechava o app voltava ao início daquele trecho e reouvia
  // tudo. Agora a posição real vai ao servidor a cada 10s de reprodução.
  useEffect(() => {
    if (!isPlaying) return;
    const t = setInterval(async () => {
      const idx = soundChunkIdxRef.current;
      if (idx < 0) return;
      try {
        const p = await TrackPlayer.getProgress();
        await saveProgress(docId, idx, Math.round(p.position * 1000));
      } catch {}
    }, 10000);
    return () => clearInterval(t);
  }, [isPlaying, docId]);

  const togglePlay = useCallback(async () => {
    if (soundChunkIdxRef.current < 0) {
      await playChunk(chunkIdx, 0);
      return;
    }
    if (isPlaying) await tpPause();
    else await tpPlay();
  }, [chunkIdx, playChunk, isPlaying]);

  // Navega pra primeira chunk de uma dada página (TOC click)
  const goToPage = useCallback(async (page: number) => {
    if (!data) return;
    const chunk = data.chunks.find(c => c.page >= page);
    if (!chunk) return;
    setTocOpen(false);
    await playChunk(chunk.index, 0);
  }, [data, playChunk]);

  const skip10 = useCallback((dir: 1 | -1) => {
    jumpBy(dir * 10).catch(() => {});
  }, []);

  useEffect(() => {
    if (!boundaries.length) { setActiveBIdx(-1); return; }
    let idx = -1;
    for (let i = 0; i < boundaries.length; i++) {
      const b = boundaries[i];
      if (posMs >= b.offset_ms && posMs < b.offset_ms + b.duration_ms + 300) { idx = i; break; }
    }
    setActiveBIdx(idx);
  }, [posMs, boundaries]);

  // Click em qualquer palavra → lookup no mapa pré-construído (precisão Speechify)
  const handlePagePress = useCallback(async (page: number, relX: number, relY: number) => {
    if (!data || isLoadingAudio) return;
    setIsLoadingAudio(true);
    try {
      // Garantir words + timing map
      let words = pageWords[page];
      if (!words) {
        words = await getPageWords(docId, page);
        setPageWords(prev => ({ ...prev, [page]: words }));
      }
      if (!words.length) return;

      let timingMap = pageTimings[page];
      if (!timingMap) {
        const pageChunks = data.chunks.filter(c => c.page === page);
        const audios = await Promise.all(
          pageChunks.map(c => getChunkAudio(docId, c.index).catch(() => null))
        );
        const valid = pageChunks
          .map((c, i) => audios[i] ? { index: c.index, boundaries: audios[i]!.boundaries } : null)
          .filter((x): x is { index: number; boundaries: Boundary[] } => !!x);
        timingMap = buildWordTimingMap(words, valid);
        setPageTimings(prev => ({ ...prev, [page]: timingMap! }));
      }

      const wordIdx = findNearestWord(words, clamp(relX, 0, 1), clamp(relY, 0, 1));

      // Lookup direto no mapa: palavra clicada → exact offset_ms
      let target = timingMap[wordIdx];
      // Fallback se buraco no mapa: vizinhos
      for (let d = 1; !target && d < 5; d++) {
        target = timingMap[wordIdx + d] ?? timingMap[wordIdx - d];
      }
      if (!target) {
        // último fallback: primeiro chunk da página
        const sameP = data.chunks.find(c => c.page === page);
        if (sameP) await playChunk(sameP.index, 0);
        return;
      }

      console.log('[click] palavra', wordIdx, '→ chunk', target.chunkIdx, '@', target.offsetMs, 'ms');

      // Atualizar boundaries pra UI da frase atual ficar correta
      const audio = await getChunkAudio(docId, target.chunkIdx);
      setBoundaries(audio.boundaries);

      await playChunk(target.chunkIdx, target.offsetMs);
    } catch (e: any) {
      console.warn('handlePagePress:', e);
      setIsLoadingAudio(false);
    }
  }, [data, docId, pageWords, pageTimings, playChunk, isLoadingAudio]);

  if (isLoading || !data) {
    return (
      <View style={[styles.fill, styles.center]}>
        <ActivityIndicator color={c.ink} />
      </View>
    );
  }

  const doc = data.document;
  const chunk = data.chunks[chunkIdx];

  // Nome do capítulo via TOC (último item cuja página <= página atual)
  const currentPage = chunk?.page || 1;
  const chapterName = (() => {
    if (!toc?.length) return null;
    for (let i = toc.length - 1; i >= 0; i--) {
      if (toc[i].page <= currentPage) return toc[i].title;
    }
    return null;
  })();

  // Tempo: prefere duração real do áudio carregado, depois server (DB), depois estimativa
  const AVG = 50000;
  const durOf = (i: number) => chunkDur.current[i] || data.chunks[i]?.duration_ms || AVG;
  let elapsed = 0;
  for (let i = 0; i < chunkIdx; i++) elapsed += durOf(i);
  elapsed += posMs;
  let total = 0;
  for (let i = 0; i < data.chunks.length; i++) total += durOf(i);
  const pct = total > 0 ? (elapsed / total) * 100 : 0;

  // Arrastar a barra percorre o LIVRO, nao o trecho: `elapsed`/`total` ja' sao
  // do livro inteiro, entao a fracao vira (trecho, deslocamento dentro dele).
  const seekFraction = (f: number) => {
    if (!data?.chunks?.length || total <= 0) return;
    const alvo = total * Math.min(1, Math.max(0, f));
    let acc = 0;
    for (let i = 0; i < data.chunks.length; i++) {
      const d = durOf(i);
      if (acc + d > alvo || i === data.chunks.length - 1) {
        playChunk(i, Math.max(0, alvo - acc));
        return;
      }
      acc += d;
    }
  };

  return (
    <SafeAreaView style={styles.fill} edges={['top', 'left', 'right']}>
      {/* Barra de navegacao: voltar · titulo · capitulos.
          🚨 Antes: voltar era o TEXTO «‹» num alvo de ~38pt, o titulo tinha 14pt
             (fora da escala) e «Capitulos» nao existia como botao — so' dava
             para chegar tocando no texto do capitulo dentro da pilula, que
             ninguem adivinha. «Ensure that each button clearly communicates
             its purpose.» */}
      <View style={styles.navBar}>
        <Toque rotulo="Voltar para a biblioteca" onPress={() => router.back()} style={styles.navBotao}>
          <Chevron />
        </Toque>

        <View style={styles.navCentro}>
          <Text numberOfLines={1} style={styles.navTitulo}>{doc.title}</Text>
          <Text numberOfLines={1} style={styles.navSub}>
            {chapterName ? `${chapterName} · ` : ''}pág {currentPage} de {doc.total_pages}
          </Text>
        </View>

        <Toque
          rotulo="Capítulos"
          dica={toc?.length ? `${toc.length} capítulos` : 'Este livro não tem índice'}
          onPress={() => setTocOpen(true)}
          disabled={!toc?.length}
          style={styles.navBotao}
        >
          <IconeLista ativo={!!toc?.length} />
        </Toque>
      </View>

      {/* Alternador de visao — controle segmentado, largura inteira.
          🚨 Antes os dois botoes tinham ~21pt de altura e 11pt de fonte. */}
      <View style={styles.segmentado}>
        {(['pdf', 'text'] as const).map((m) => {
          const ativo = viewMode === m;
          return (
            <Toque
              key={m}
              rotulo={m === 'pdf' ? 'Ver as páginas do PDF' : 'Ver só o texto'}
              onPress={() => setViewMode(m)}
              escala={0.98}
              alvoMinimo={false}
              style={[styles.segmentoBotao, ativo && styles.segmentoAtivo]}
            >
              <Text style={[styles.segmentoTexto, ativo && styles.segmentoTextoAtivo]}>
                {m === 'pdf' ? 'Páginas' : 'Texto'}
              </Text>
            </Toque>
          );
        })}
      </View>

      {viewMode === 'pdf' ? (
        <FlatList
          ref={flatRef}
          data={Array.from({ length: doc.total_pages }, (_, i) => i + 1)}
          keyExtractor={(p) => String(p)}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: bottomPad }}
          getItemLayout={(_, i) => ({ length: PAGE_HEIGHT + 8, offset: (PAGE_HEIGHT + 8) * i, index: i })}
          onScrollBeginDrag={() => {
            userScrollingRef.current = true;
            if (userScrollTimer.current) clearTimeout(userScrollTimer.current);
          }}
          onMomentumScrollEnd={() => {
            if (userScrollTimer.current) clearTimeout(userScrollTimer.current);
            userScrollTimer.current = setTimeout(() => { userScrollingRef.current = false; }, 5000);
          }}
          renderItem={({ item: page }) => (
            <PdfPage
              docId={docId}
              page={page}
              words={pageWords[page]}
              isActive={chunk?.page === page}
              boundaries={boundaries}
              activeBIdx={activeBIdx}
              onPress={(relX, relY) => handlePagePress(page, relX, relY)}
            />
          )}
        />
      ) : (
        <TextView
          docId={docId}
          chunks={data.chunks}
          chunkIdx={chunkIdx}
          boundaries={boundaries}
          activeBIdx={activeBIdx}
          onPlayChunk={(i) => playChunk(i, 0)}
          bottomPadding={bottomPad}
        />
      )}

      {/* Player flutuante (BlurView absolute bottom) */}
      <View style={[styles.playerFloat, { paddingBottom: insets.bottom + 8 }]} pointerEvents="box-none">
        <Player
          coverId={doc.id}
          titulo={doc.title}
          chapter={chapterName || `Página ${currentPage}`}
          page={chunk?.page || 1}
          totalPages={doc.total_pages}
          elapsed={elapsed / speed}
          total={total / speed}
          pct={pct}
          isPlaying={isPlaying}
          isLoading={isLoadingAudio}
          onPlayPause={togglePlay}
          onSkip10={skip10}
          onChapterPress={() => toc?.length && setTocOpen(true)}
          onSeekFraction={seekFraction}
          speed={speed}
          onSpeedChange={(s) => {
            setSpeed(s);
            tpSetRate(s).catch(() => {});
          }}
          voice={voice}
          voices={voices}
          onVoiceChange={async (v) => {
            voiceRef.current = v;
            setVoiceLabel(v);
            saveVoice(v).catch(() => {});
            // O trecho carregado é da voz antiga: sem zerar isto, o caminho
            // rápido do playChunk faria só um seek e continuaria na voz velha.
            soundChunkIdxRef.current = -1;
            await playChunk(chunkIdx, posMs);
          }}
        />
      </View>

      {/* Sumario — mesma folha do player: sobe, escurece o fundo, fecha no arrasto */}
      <Folha aberta={tocOpen} titulo="Capítulos" aoFechar={() => setTocOpen(false)}>
        <ScrollView showsVerticalScrollIndicator={false}>
          {toc?.map((item, i) => (
            <LinhaFolha
              key={`${item.title}-${item.page}-${i}`}
              texto={item.title}
              direita={String(item.page)}
              ativo={chapterName === item.title}
              subtitulo={item.level > 1}
              recuo={Math.min((item.level - 1) * 16, 48)}
              onPress={() => goToPage(item.page)}
            />
          ))}
          {(!toc || !toc.length) ? (
            <Text style={styles.tocEmpty}>Este livro não tem índice</Text>
          ) : null}
        </ScrollView>
      </Folha>
    </SafeAreaView>
  );
}

// ===== Página PDF + SVG highlight =====
const PdfPage = memo(function PdfPage({ docId, page, words, isActive, boundaries, activeBIdx, onPress }: {
  docId: string; page: number; words?: Word[]; isActive: boolean;
  boundaries: Boundary[]; activeBIdx: number;
  onPress: (relX: number, relY: number) => void;
}) {
  const c = useTema();
  const styles = useMemo(() => criarEstilos(c), [c]);
  let pathD = '';
  if (isActive && words?.length && activeBIdx >= 0 && boundaries.length) {
    const ratio = activeBIdx / boundaries.length;
    const targetIdx = Math.min(Math.floor(ratio * words.length), words.length - 1);
    const [s, e] = sentenceRange(words, targetIdx);
    pathD = buildSentenceD(words, s, e);
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Página ${page}. Toque numa palavra para ouvir a partir dela.`}
      onPress={(e) => {
        const relX = e.nativeEvent.locationX / SCREEN_W;
        const relY = e.nativeEvent.locationY / PAGE_HEIGHT;
        console.log('[tap] page', page, 'relX:', relX.toFixed(3), 'relY:', relY.toFixed(3));
        onPress(relX, relY);
      }}
      style={styles.pageWrap}
    >
      <View pointerEvents="none">
        <Image
          source={pageImageUrl(docId, page)}
          style={styles.pageImg}
          contentFit="fill"
          transition={150}
          cachePolicy="memory-disk"
        />
      </View>
      {pathD ? (
        <Svg
          width={SCREEN_W} height={PAGE_HEIGHT}
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        >
          <Path d={pathD} fill={c.hlSentence} />
        </Svg>
      ) : null}
    </Pressable>
  );
});

// ===== Text view — texto puro, scroll, click pra tocar trecho =====
function TextView({ docId, chunks, chunkIdx, boundaries, activeBIdx, onPlayChunk, bottomPadding }: {
  docId: string; chunks: Chunk[]; chunkIdx: number;
  boundaries: Boundary[]; activeBIdx: number;
  onPlayChunk: (idx: number) => void;
  bottomPadding: number;
}) {
  const c = useTema();
  const styles = useMemo(() => criarEstilos(c), [c]);
  const scrollRef = useRef<ScrollView>(null);
  const offsetsRef = useRef<Record<number, number>>({});

  // Quando chunkIdx muda OU quando a TextView é montada (mudança de view),
  // rola pra posição do chunk ativo
  useEffect(() => {
    const y = offsetsRef.current[chunkIdx];
    if (y != null) {
      scrollRef.current?.scrollTo({ y: Math.max(0, y - 80), animated: true });
    }
  }, [chunkIdx]);

  return (
    <ScrollView
      ref={scrollRef}
      contentContainerStyle={[styles.textWrap, { paddingBottom: bottomPadding }]}
      showsVerticalScrollIndicator={false}
    >
      {chunks.map((tr) => {
        const isActive = tr.index === chunkIdx;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Ouvir a partir deste trecho"
            key={tr.index}
            onPress={() => onPlayChunk(tr.index)}
            onLayout={(e) => { offsetsRef.current[tr.index] = e.nativeEvent.layout.y; }}
            style={styles.textChunk}
          >
            {/* 🚨 «Make useful text selectable» — num leitor, copiar um
                trecho e' basico, e nao dava. */}
            <Text selectable style={[
              styles.textBody,
              isActive && styles.textBodyActive,
            ]}>
              {tr.text}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ===== Player =====
function Chevron() {
  const c = useTema();
  return (
    <Svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke={c.ink}
      strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M15 5l-7 7 7 7" />
    </Svg>
  );
}

function IconeLista({ ativo }: { ativo: boolean }) {
  const c = useTema();
  const tom = ativo ? c.ink : c.mist;
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={tom}
      strokeWidth={1.9} strokeLinecap="round">
      <Path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </Svg>
  );
}

const criarEstilos = (c: Paleta) => StyleSheet.create({
  fill: { flex: 1, backgroundColor: c.snow },
  center: { alignItems: 'center', justifyContent: 'center' },

  navBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: espaco.pequeno, paddingVertical: espaco.micro,
    backgroundColor: c.white,
    gap: espaco.pequeno,
  },
  // 🚨 O centro vem DAQUI agora. Antes o `Toque` impunha aos filhos, e
  //    era isso que desmontava todo layout que nao fosse icone.
  navBotao: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  navCentro: { flex: 1, minWidth: 0, alignItems: 'center' },
  navTitulo: { ...tipo.destaque, color: c.ink, textAlign: 'center' },
  navSub: { ...tipo.legenda, color: c.slate, textAlign: 'center', marginTop: 1 },

  segmentado: {
    flexDirection: 'row',
    marginHorizontal: espaco.padrao, marginBottom: espaco.pequeno,
    backgroundColor: c.cloud,
    borderRadius: raio.pequeno, padding: 2, gap: 2,
    borderBottomWidth: 0,
  },
  segmentoBotao: {
    flex: 1, minHeight: 36, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center',
  },
  segmentoAtivo: {
    backgroundColor: c.white,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1, shadowRadius: 3, elevation: 2,
  },
  segmentoTexto: { ...tipo.subtitulo, fontWeight: '600', color: c.slate },
  segmentoTextoAtivo: { color: c.ink },

  pageWrap: { marginVertical: 4 },
  pageImg: { width: SCREEN_W, height: PAGE_HEIGHT, backgroundColor: c.white },

  textWrap: { padding: 24, paddingBottom: 40 },
  textChunk: { marginBottom: 18 },
  textBody: {
    fontSize: 17, lineHeight: 26,
    color: c.charcoal,
    fontFamily: fonts.body,
  },
  textBodyActive: { backgroundColor: c.highlight, color: c.ink },

  playerFloat: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    paddingHorizontal: 10, paddingTop: 8,
  },





  // Sheet de velocidade

  // TOC sheet
  tocEmpty: { ...tipo.chamada, color: c.slate, textAlign: 'center', paddingVertical: espaco.ar },
});
