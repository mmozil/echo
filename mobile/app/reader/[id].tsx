import { useEffect, useRef, useState, useCallback, memo } from 'react';
import {
  View, Text, Pressable, ActivityIndicator, Image, FlatList,
  Dimensions, Alert, StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Audio, AVPlaybackStatus } from 'expo-av';
import Svg, { Path } from 'react-native-svg';
import {
  getDocument, getChunkAudio, getPageWords, saveProgress,
  audioUrl, pageImageUrl, coverUrl, type Chunk,
} from '@/lib/api';
import {
  buildSentenceD, findNearestWord, sentenceRange,
  findBoundaryByWordSequence, type Word,
} from '@/lib/highlight';

const SCREEN_W = Dimensions.get('window').width;
const PAGE_RATIO = 0.71; // PDF ratio típico (A4-ish)
const PAGE_HEIGHT = SCREEN_W / PAGE_RATIO;

type Boundary = { offset_ms: number; duration_ms: number; text: string };

const norm = (s: string) =>
  (s || '').toLowerCase().replace(/[.,;:!?"'()\[\]\-—–“”‘’]/g, '').replace(/\s+/g, ' ').trim();

export default function Reader() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const docId = String(id);

  const { data, isLoading } = useQuery({
    queryKey: ['document', docId],
    queryFn: () => getDocument(docId),
  });

  const [chunkIdx, setChunkIdx] = useState(0);
  const [boundaries, setBoundaries] = useState<Boundary[]>([]);
  const [pageWords, setPageWords] = useState<Record<number, Word[]>>({});
  const [activeBIdx, setActiveBIdx] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [posMs, setPosMs] = useState(0);
  const [speed, setSpeed] = useState(1);

  const soundRef = useRef<Audio.Sound | null>(null);
  const flatRef = useRef<FlatList<number>>(null);
  const chunkDur = useRef<Record<number, number>>({});
  const userScrollingRef = useRef(false);
  const userScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Áudio em background
  useEffect(() => {
    Audio.setAudioModeAsync({
      staysActiveInBackground: true,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      interruptionModeIOS: 1,
      interruptionModeAndroid: 1,
    }).catch(() => {});
    return () => { soundRef.current?.unloadAsync().catch(() => {}); };
  }, []);

  // Restaura progresso ao abrir
  useEffect(() => {
    if (data?.progress?.current_chunk != null) {
      setChunkIdx(data.progress.current_chunk);
    }
  }, [data?.document?.id]);

  // Pré-carrega palavras das páginas próximas
  useEffect(() => {
    if (!data) return;
    const chunk = data.chunks[chunkIdx];
    if (!chunk) return;
    const pages = [chunk.page, chunk.page + 1, chunk.page + 2]
      .filter(p => p >= 1 && p <= data.document.total_pages);
    pages.forEach(async (p) => {
      if (pageWords[p]) return;
      try {
        const words = await getPageWords(docId, p);
        setPageWords(prev => ({ ...prev, [p]: words }));
      } catch {}
    });
  }, [chunkIdx, data?.document?.id]);

  // Auto-scroll para a página do chunk atual (a menos que user esteja rolando)
  useEffect(() => {
    if (!data || userScrollingRef.current) return;
    const chunk = data.chunks[chunkIdx];
    if (!chunk) return;
    flatRef.current?.scrollToIndex({
      index: chunk.page - 1,
      animated: true,
      viewPosition: 0.1, // página atual fica 10% do topo
    });
  }, [chunkIdx, data?.document?.id]);

  // Toca chunk
  const playChunk = useCallback(async (idx: number, seekToMs = 0) => {
    if (!data) return;
    setIsLoadingAudio(true);
    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync().catch(() => {});
        soundRef.current = null;
      }

      const audio = await getChunkAudio(docId, idx);
      setBoundaries(audio.boundaries);

      const { sound } = await Audio.Sound.createAsync(
        { uri: audioUrl(audio.audio_url) },
        { shouldPlay: true, rate: speed, positionMillis: seekToMs },
        (status: AVPlaybackStatus) => {
          if (!status.isLoaded) return;
          setPosMs(status.positionMillis || 0);
          if (status.durationMillis) {
            chunkDur.current[idx] = status.durationMillis;
          }
          setIsPlaying(status.isPlaying);
          if (status.didJustFinish) {
            const nextIdx = idx + 1;
            if (nextIdx < data.chunks.length) {
              setChunkIdx(nextIdx);
              playChunk(nextIdx, 0);
            } else {
              setIsPlaying(false);
            }
          }
        }
      );
      soundRef.current = sound;
      setChunkIdx(idx);
      saveProgress(docId, idx, seekToMs).catch(() => {});
    } catch (e: any) {
      Alert.alert('Erro', e?.message || 'Falha ao carregar áudio');
    } finally {
      setIsLoadingAudio(false);
    }
  }, [data, docId, speed]);

  const togglePlay = useCallback(async () => {
    if (!soundRef.current) {
      await playChunk(chunkIdx, 0);
      return;
    }
    const status = await soundRef.current.getStatusAsync();
    if (!status.isLoaded) {
      await playChunk(chunkIdx, 0);
      return;
    }
    if (status.isPlaying) await soundRef.current.pauseAsync();
    else await soundRef.current.playAsync();
  }, [chunkIdx, playChunk]);

  const skip10 = useCallback((dir: 1 | -1) => {
    if (!soundRef.current) return;
    soundRef.current.getStatusAsync().then(s => {
      if (!s.isLoaded) return;
      const newPos = Math.max(0, Math.min((s.positionMillis || 0) + dir * 10000, s.durationMillis || 0));
      soundRef.current?.setPositionAsync(newPos);
    });
  }, []);

  // Atualizar boundary ativo
  useEffect(() => {
    if (!boundaries.length) { setActiveBIdx(-1); return; }
    let idx = -1;
    for (let i = 0; i < boundaries.length; i++) {
      const b = boundaries[i];
      if (posMs >= b.offset_ms && posMs < b.offset_ms + b.duration_ms + 300) { idx = i; break; }
    }
    setActiveBIdx(idx);
  }, [posMs, boundaries]);

  // Click numa página → walkback frase → seek exato (igual desktop)
  const handlePagePress = useCallback(async (page: number, relX: number, relY: number) => {
    if (!data) return;
    setIsLoadingAudio(true);
    try {
      let words = pageWords[page];
      if (!words) {
        words = await getPageWords(docId, page);
        setPageWords(prev => ({ ...prev, [page]: words }));
      }
      if (!words.length) return;

      const wordIdx = findNearestWord(words, relX, relY);
      const [start] = sentenceRange(words, wordIdx);
      const contextWords = words.slice(start, start + 12).map(w => w.word);

      // Achar chunk que contém o contexto, varrendo entre chunks da página +/- 1
      const ctx2Norm = norm(contextWords.slice(0, 3).join(' '));
      let chunkMatchIdx = -1;
      const candidates = data.chunks.filter(c => Math.abs(c.page - page) <= 1);
      for (const c of candidates) {
        if (norm(c.text).includes(ctx2Norm)) { chunkMatchIdx = c.index; break; }
      }
      if (chunkMatchIdx === -1) {
        const sameP = data.chunks.find(c => c.page === page);
        chunkMatchIdx = sameP?.index ?? 0;
      }

      // Carregar áudio + match exato no boundaries
      const audio = await getChunkAudio(docId, chunkMatchIdx);
      setBoundaries(audio.boundaries);
      const bIdx = findBoundaryByWordSequence(contextWords, audio.boundaries);
      const seekMs = bIdx >= 0 ? audio.boundaries[bIdx].offset_ms : 0;
      await playChunk(chunkMatchIdx, seekMs);
    } catch (e: any) {
      console.warn('handlePagePress:', e);
    } finally {
      setIsLoadingAudio(false);
    }
  }, [data, docId, pageWords, playChunk]);

  if (isLoading || !data) {
    return (
      <View style={[styles.fill, styles.center]}>
        <ActivityIndicator color="#ABB3FE" />
      </View>
    );
  }

  const doc = data.document;
  const chunk = data.chunks[chunkIdx];

  // Tempo global (estilo Speechify): elapsed/total dividido pela velocidade
  const AVG = 50000;
  let elapsed = 0;
  for (let i = 0; i < chunkIdx; i++) elapsed += chunkDur.current[i] || AVG;
  elapsed += posMs;
  let total = 0;
  for (let i = 0; i < data.chunks.length; i++) total += chunkDur.current[i] || AVG;
  const pct = total > 0 ? (elapsed / total) * 100 : 0;

  return (
    <SafeAreaView style={styles.fill} edges={['top', 'left', 'right']}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.backBtn}>
          <Text style={styles.backChevron}>‹</Text>
        </Pressable>
        <Text numberOfLines={1} style={styles.headerTitle}>{doc.title}</Text>
        <Text style={styles.headerPage}>
          {chunk?.page || '—'}/{doc.total_pages}
        </Text>
      </View>

      {/* Lista vertical de páginas */}
      <FlatList
        ref={flatRef}
        data={Array.from({ length: doc.total_pages }, (_, i) => i + 1)}
        keyExtractor={(p) => String(p)}
        showsVerticalScrollIndicator={false}
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

      {/* Player */}
      <Player
        coverId={doc.id}
        chapter={`Trecho ${chunkIdx + 1}/${data.chunks.length}`}
        page={chunk?.page || 1}
        totalPages={doc.total_pages}
        elapsed={elapsed / speed}
        total={total / speed}
        pct={pct}
        isPlaying={isPlaying}
        isLoading={isLoadingAudio}
        onPlayPause={togglePlay}
        onSkip10={skip10}
        speed={speed}
        onSpeedChange={(s) => {
          setSpeed(s);
          soundRef.current?.setRateAsync(s, true).catch(() => {});
        }}
      />
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
        onPress(relX, relY);
      }}
      style={styles.pageWrap}
    >
      <Image
        source={{ uri: pageImageUrl(docId, page) }}
        style={styles.pageImg}
        resizeMode="contain"
      />
      {pathD ? (
        <Svg
          width={SCREEN_W} height={PAGE_HEIGHT}
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        >
          <Path d={pathD} fill="rgba(165, 175, 250, 0.42)" />
        </Svg>
      ) : null}
    </Pressable>
  );
});

// ===== Player Apple Books style =====
function Player({ coverId, chapter, page, totalPages, elapsed, total, pct, isPlaying, isLoading, onPlayPause, onSkip10, speed, onSpeedChange }: {
  coverId: string; chapter: string; page: number; totalPages: number;
  elapsed: number; total: number; pct: number;
  isPlaying: boolean; isLoading: boolean;
  onPlayPause: () => void; onSkip10: (dir: 1 | -1) => void;
  speed: number; onSpeedChange: (s: number) => void;
}) {
  return (
    <View style={styles.playerWrap}>
      <View style={styles.playerPill}>
        {/* Progress bar */}
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${pct}%` }]} />
        </View>

        {/* Main row */}
        <View style={styles.mainRow}>
          <Image source={{ uri: coverUrl(coverId) }} style={styles.cover} />
          <View style={styles.infoCol}>
            <Text numberOfLines={1} style={styles.chapterText}>{chapter}</Text>
            <Text numberOfLines={1} style={styles.metaText}>
              {fmt(elapsed)} · pág {page}/{totalPages} · {fmt(total)}
            </Text>
          </View>

          <Pressable onPress={() => onSkip10(-1)} hitSlop={6} style={styles.skipBtn}>
            <SkipIcon dir="back" />
            <Text style={styles.skipNum}>10</Text>
          </Pressable>

          <Pressable
            onPress={onPlayPause}
            disabled={isLoading}
            style={({ pressed }) => [styles.playBtn, { opacity: pressed || isLoading ? 0.85 : 1 }]}
          >
            {isLoading ? (
              <ActivityIndicator color="#0F0F12" size="small" />
            ) : (
              <Text style={styles.playGlyph}>{isPlaying ? '⏸' : '▶'}</Text>
            )}
          </Pressable>

          <Pressable onPress={() => onSkip10(1)} hitSlop={6} style={styles.skipBtn}>
            <SkipIcon dir="fwd" />
            <Text style={styles.skipNum}>10</Text>
          </Pressable>
        </View>

        {/* Speed */}
        <View style={styles.speedRow}>
          {[0.75, 1, 1.25, 1.5, 2].map(s => {
            const active = speed === s;
            return (
              <Pressable
                key={s}
                onPress={() => onSpeedChange(s)}
                style={[styles.speedPill, active && styles.speedPillActive]}
              >
                <Text style={[styles.speedText, active && styles.speedTextActive]}>{s}×</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
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
  fill: { flex: 1, backgroundColor: '#0F0F12' },
  center: { alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 8,
  },
  backBtn: { padding: 8 },
  backChevron: { color: 'white', fontSize: 22, lineHeight: 22 },
  headerTitle: {
    flex: 1, color: 'white',
    fontSize: 14, fontWeight: '600',
    textAlign: 'center', marginHorizontal: 12,
  },
  headerPage: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 12, paddingHorizontal: 8,
  },

  pageWrap: { marginVertical: 4 },
  pageImg: { width: SCREEN_W, height: PAGE_HEIGHT, backgroundColor: 'white' },

  playerWrap: { paddingHorizontal: 10, paddingBottom: 10 },
  playerPill: {
    backgroundColor: 'rgba(20, 20, 22, 0.96)',
    borderRadius: 18,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
  },
  progressBar: { height: 3, backgroundColor: 'rgba(255,255,255,0.12)' },
  progressFill: { height: '100%', backgroundColor: '#8C9CFF' },

  mainRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 11, paddingHorizontal: 12, gap: 10,
  },
  cover: {
    width: 46, height: 46, borderRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  infoCol: { flex: 1, minWidth: 0, gap: 3 },
  chapterText: { color: 'white', fontSize: 13, fontWeight: '700', letterSpacing: -0.1 },
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
  playGlyph: { color: '#0F0F12', fontSize: 16, fontWeight: '900' },

  speedRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 12, paddingBottom: 11,
    gap: 6,
  },
  speedPill: {
    paddingHorizontal: 9, paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
  },
  speedPillActive: {
    backgroundColor: 'rgba(171,179,254,0.25)',
    borderColor: 'rgba(171,179,254,0.4)',
  },
  speedText: { color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '700' },
  speedTextActive: { color: '#ABB3FE' },
});
