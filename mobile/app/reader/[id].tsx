import { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react';
import {
  View, Text, Pressable, ActivityIndicator, FlatList, ScrollView,
  Dimensions, Alert, StyleSheet, Modal,
} from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import TrackPlayer, {
  Event,
  State,
  usePlaybackState,
  useProgress,
  useTrackPlayerEvents,
} from 'react-native-track-player';
import { BlurView } from 'expo-blur';
import Svg, { Path } from 'react-native-svg';
import {
  ensurePlayerSetup, loadAndPlay, play as tpPlay, pause as tpPause,
  jumpBy, seekTo as tpSeek, setRate as tpSetRate,
} from '@/lib/player';
import {
  getDocument, getChunkAudio, getPageWords, getToc, saveProgress,
  audioUrl, pageImageUrl, coverUrl, authHeaders, type Chunk, type TocItem,
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
      const audio = await getChunkAudio(docId, idx);
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

  // Auto-advance: quando uma track termina, vai pra próxima
  useTrackPlayerEvents([Event.PlaybackQueueEnded], async () => {
    if (!data) return;
    const nextIdx = soundChunkIdxRef.current + 1;
    if (nextIdx > 0 && nextIdx < data.chunks.length) {
      await playChunk(nextIdx, 0);
    }
  });

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
        <ActivityIndicator color={colors.ink} />
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

  return (
    <SafeAreaView style={styles.fill} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.backBtn}>
          <Text style={styles.backChevron}>‹</Text>
        </Pressable>
        <Text numberOfLines={1} style={styles.headerTitle}>{doc.title}</Text>
        <View style={styles.viewToggle}>
          <Pressable onPress={() => setViewMode('pdf')} style={[styles.viewBtn, viewMode === 'pdf' && styles.viewBtnActive]}>
            <Text style={[styles.viewBtnText, viewMode === 'pdf' && styles.viewBtnTextActive]}>PDF</Text>
          </Pressable>
          <Pressable onPress={() => setViewMode('text')} style={[styles.viewBtn, viewMode === 'text' && styles.viewBtnActive]}>
            <Text style={[styles.viewBtnText, viewMode === 'text' && styles.viewBtnTextActive]}>Texto</Text>
          </Pressable>
        </View>
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
          speed={speed}
          onSpeedChange={(s) => {
            setSpeed(s);
            tpSetRate(s).catch(() => {});
          }}
        />
      </View>

      {/* TOC Modal — lista de capítulos com página */}
      <Modal
        visible={tocOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setTocOpen(false)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setTocOpen(false)}>
          <Pressable style={styles.tocSheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.tocHeader}>
              <Text style={styles.tocHeaderTitle}>Capítulos</Text>
              <Pressable onPress={() => setTocOpen(false)} hitSlop={10}>
                <Text style={styles.tocClose}>×</Text>
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 480 }} showsVerticalScrollIndicator={false}>
              {toc?.map((item, i) => {
                const active = chapterName === item.title;
                const indent = Math.min((item.level - 1) * 16, 48);
                return (
                  <Pressable
                    key={`${item.title}-${item.page}-${i}`}
                    onPress={() => goToPage(item.page)}
                    style={({ pressed }) => [
                      styles.tocItem,
                      pressed && styles.tocItemPressed,
                      { paddingLeft: 14 + indent },
                    ]}
                  >
                    <Text
                      numberOfLines={2}
                      style={[
                        styles.tocItemTitle,
                        active && styles.tocItemTitleActive,
                        item.level > 1 && styles.tocItemTitleSub,
                      ]}
                    >
                      {item.title}
                    </Text>
                    <Text style={[styles.tocItemPage, active && styles.tocItemPageActive]}>
                      {item.page}
                    </Text>
                  </Pressable>
                );
              })}
              {(!toc || !toc.length) && (
                <Text style={styles.tocEmpty}>Este livro não tem índice</Text>
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

// ===== Página PDF + SVG highlight =====
const PdfPage = memo(function PdfPage({ docId, page, words, isActive, boundaries, activeBIdx, onPress }: {
  docId: string; page: number; words?: Word[]; isActive: boolean;
  boundaries: Boundary[]; activeBIdx: number;
  onPress: (relX: number, relY: number) => void;
}) {
  let pathD = '';
  if (isActive && words?.length && activeBIdx >= 0 && boundaries.length) {
    const ratio = activeBIdx / boundaries.length;
    const targetIdx = Math.min(Math.floor(ratio * words.length), words.length - 1);
    const [s, e] = sentenceRange(words, targetIdx);
    pathD = buildSentenceD(words, s, e);
  }

  return (
    <Pressable
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
          <Path d={pathD} fill={colors.hlSentence} />
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
      {chunks.map((c) => {
        const isActive = c.index === chunkIdx;
        return (
          <Pressable
            key={c.index}
            onPress={() => onPlayChunk(c.index)}
            onLayout={(e) => { offsetsRef.current[c.index] = e.nativeEvent.layout.y; }}
            style={styles.textChunk}
          >
            <Text style={[
              styles.textBody,
              isActive && styles.textBodyActive,
            ]}>
              {c.text}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ===== Player =====
const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2];

function Player({ coverId, chapter, page, totalPages, elapsed, total, pct, isPlaying, isLoading, onPlayPause, onSkip10, onChapterPress, speed, onSpeedChange }: {
  coverId: string; chapter: string; page: number; totalPages: number;
  elapsed: number; total: number; pct: number;
  isPlaying: boolean; isLoading: boolean;
  onPlayPause: () => void; onSkip10: (dir: 1 | -1) => void;
  onChapterPress: () => void;
  speed: number; onSpeedChange: (s: number) => void;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);

  // Formato compacto: "1×" "1.5×" "0.75×"
  const speedLabel = (Number.isInteger(speed) ? `${speed}` : `${speed}`) + '×';

  return (
    <>
      <BlurView intensity={45} tint="dark" style={styles.playerPill}>
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${pct}%` }]} />
        </View>

        <View style={styles.mainRow}>
          {coverFailed ? (
            <View style={[styles.cover, styles.coverEmpty]}>
              <Text style={styles.coverInitial}>e</Text>
            </View>
          ) : (
            <Image
              source={coverUrl(coverId)}
              style={styles.cover}
              contentFit="cover"
              transition={200}
              onError={() => setCoverFailed(true)}
            />
          )}
          <Pressable style={styles.infoCol} onPress={onChapterPress} hitSlop={4}>
            <Text numberOfLines={1} style={styles.chapterText}>{chapter}</Text>
            <Text numberOfLines={1} style={styles.metaText}>
              {fmt(elapsed)} · pág {page}/{totalPages} · {fmt(total)}
            </Text>
          </Pressable>

          <Pressable onPress={() => onSkip10(-1)} hitSlop={4} style={styles.skipBtn}>
            <SkipIcon dir="back" />
            <Text style={styles.skipNum}>10</Text>
          </Pressable>

          <Pressable
            onPress={onPlayPause}
            disabled={isLoading}
            style={({ pressed }) => [styles.playBtn, { opacity: pressed || isLoading ? 0.85 : 1 }]}
          >
            {isLoading ? (
              <ActivityIndicator color={colors.ink} size="small" />
            ) : isPlaying ? (
              <PauseIcon />
            ) : (
              <PlayIcon />
            )}
          </Pressable>

          <Pressable onPress={() => onSkip10(1)} hitSlop={4} style={styles.skipBtn}>
            <SkipIcon dir="fwd" />
            <Text style={styles.skipNum}>10</Text>
          </Pressable>

          <Pressable onPress={() => setSpeedOpen(true)} style={styles.speedBtn} hitSlop={4}>
            <Text style={styles.speedBtnText}>{speedLabel}</Text>
          </Pressable>
        </View>
      </BlurView>

      {/* Modal de seleção de velocidade */}
      <Modal
        visible={speedOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSpeedOpen(false)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setSpeedOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>Velocidade</Text>
            {SPEED_OPTIONS.map(s => {
              const active = speed === s;
              return (
                <Pressable
                  key={s}
                  onPress={() => { onSpeedChange(s); setSpeedOpen(false); }}
                  style={({ pressed }) => [styles.sheetItem, pressed && styles.sheetItemPressed]}
                >
                  <Text style={[styles.sheetItemText, active && styles.sheetItemActive]}>{s}×</Text>
                  {active ? <Text style={styles.sheetCheck}>✓</Text> : null}
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function PlayIcon() {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill={colors.ink}>
      <Path d="M8 5 L20 12 L8 19 Z" />
    </Svg>
  );
}

function PauseIcon() {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill={colors.ink}>
      <Path d="M6 5 H10 V19 H6 Z" />
      <Path d="M14 5 H18 V19 H14 Z" />
    </Svg>
  );
}

function SkipIcon({ dir }: { dir: 'back' | 'fwd' }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2}>
      {dir === 'back' ? (
        <>
          <Path d="M1 4v6h6" />
          <Path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </>
      ) : (
        <>
          <Path d="M23 4v6h-6" />
          <Path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </>
      )}
    </Svg>
  );
}

function fmt(ms: number): string {
  if (!isFinite(ms) || isNaN(ms)) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.snow },
  center: { alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: colors.white,
    borderBottomWidth: 1, borderBottomColor: colors.border,
    gap: 8,
  },
  backBtn: { padding: 8 },
  backChevron: { color: colors.ink, fontSize: 22, lineHeight: 22 },
  headerTitle: {
    flex: 1, color: colors.ink,
    fontSize: 14, fontWeight: '600',
    fontFamily: fonts.display,
    letterSpacing: -0.2,
  },
  viewToggle: {
    flexDirection: 'row',
    backgroundColor: colors.cloud,
    borderRadius: 8, padding: 3, gap: 2,
  },
  viewBtn: {
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 6,
  },
  viewBtnActive: { backgroundColor: colors.white },
  viewBtnText: {
    fontSize: 11, fontWeight: '600',
    color: colors.slate,
    letterSpacing: 0.1,
  },
  viewBtnTextActive: { color: colors.ink },

  pageWrap: { marginVertical: 4 },
  pageImg: { width: SCREEN_W, height: PAGE_HEIGHT, backgroundColor: 'white' },

  textWrap: { padding: 24, paddingBottom: 40 },
  textChunk: { marginBottom: 18 },
  textBody: {
    fontSize: 16, lineHeight: 26,
    color: colors.charcoal,
    fontFamily: fonts.body,
  },
  textBodyActive: { backgroundColor: colors.highlight, color: colors.ink },

  playerFloat: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    paddingHorizontal: 10, paddingTop: 8,
  },
  playerWrap: { paddingHorizontal: 0 }, // legado, não usado mais
  playerPill: {
    backgroundColor: 'rgba(20, 20, 22, 0.72)', // BlurView complementa
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.1)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 12,
  },
  progressBar: { height: 3, backgroundColor: 'rgba(255,255,255,0.12)' },
  progressFill: { height: '100%', backgroundColor: '#8C9CFF' },

  mainRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 11, paddingHorizontal: 12, gap: 10,
  },
  cover: {
    width: 46, height: 46, borderRadius: 9,
    backgroundColor: colors.charcoal,
  },
  coverEmpty: { alignItems: 'center', justifyContent: 'center' },
  coverInitial: { color: 'white', fontSize: 22, fontWeight: '900', fontFamily: fonts.display },
  infoCol: { flex: 1, minWidth: 0, gap: 3 },
  chapterText: { color: 'white', fontSize: 13, fontWeight: '700', letterSpacing: -0.1, fontFamily: fonts.display },
  metaText: { color: 'rgba(255,255,255,0.55)', fontSize: 11 },

  skipBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    position: 'relative',
  },
  skipNum: {
    position: 'absolute',
    color: 'white',
    fontSize: 7.5, fontWeight: '700',
    letterSpacing: -0.4,
  },

  playBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'white',
    alignItems: 'center', justifyContent: 'center',
  },
  playGlyph: { color: colors.ink, fontSize: 16, fontWeight: '900' },

  speedBtn: {
    height: 28, minWidth: 38,
    paddingHorizontal: 8,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  speedBtnText: {
    color: 'white',
    fontSize: 11.5, fontWeight: '700',
    letterSpacing: -0.2,
  },

  // Sheet de velocidade
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: 'white',
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    padding: 16, paddingBottom: 32,
  },
  sheetTitle: {
    fontSize: 13, fontWeight: '600',
    color: colors.slate,
    textAlign: 'center',
    marginBottom: 8,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  sheetItem: {
    flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14, paddingHorizontal: 12,
    borderRadius: 10,
  },
  sheetItemPressed: { backgroundColor: colors.cloud },
  sheetItemText: {
    fontSize: 17, fontWeight: '500',
    color: colors.charcoal,
    fontFamily: fonts.display,
  },
  sheetItemActive: { color: colors.ink, fontWeight: '700' },
  sheetCheck: { fontSize: 18, color: colors.ink, fontWeight: '900' },

  // TOC sheet
  tocSheet: {
    backgroundColor: 'white',
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    paddingTop: 12, paddingBottom: 32,
    maxHeight: '80%',
  },
  tocHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  tocHeaderTitle: {
    fontSize: 16, fontWeight: '700',
    color: colors.ink,
    fontFamily: fonts.display,
    letterSpacing: -0.2,
  },
  tocClose: {
    fontSize: 24, color: colors.slate,
    lineHeight: 24, fontWeight: '300',
    paddingHorizontal: 6,
  },
  tocItem: {
    flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 12, paddingRight: 14,
    gap: 12,
    borderBottomWidth: 1, borderBottomColor: '#F3F4F6',
  },
  tocItemPressed: { backgroundColor: colors.cloud },
  tocItemTitle: {
    flex: 1,
    fontSize: 14, fontWeight: '500',
    color: colors.charcoal,
    fontFamily: fonts.body,
    letterSpacing: -0.1,
  },
  tocItemTitleSub: {
    color: colors.slate,
    fontWeight: '400',
    fontSize: 13,
  },
  tocItemTitleActive: { color: colors.ink, fontWeight: '700' },
  tocItemPage: {
    fontSize: 12, fontWeight: '500',
    color: colors.mist,
    fontVariant: ['tabular-nums'],
    minWidth: 32, textAlign: 'right',
  },
  tocItemPageActive: { color: colors.ink, fontWeight: '700' },
  tocEmpty: {
    fontSize: 13, color: colors.slate,
    textAlign: 'center',
    paddingVertical: 32,
  },
});
