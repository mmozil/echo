import { useEffect, useRef, useState, useCallback, memo } from 'react';
import {
  View, Text, Pressable, ActivityIndicator, Image, FlatList, ScrollView,
  Dimensions, Alert, StyleSheet,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Audio, AVPlaybackStatus } from 'expo-av';
import { BlurView } from 'expo-blur';
import Svg, { Path } from 'react-native-svg';
import {
  getDocument, getChunkAudio, getPageWords, saveProgress,
  audioUrl, pageImageUrl, coverUrl, type Chunk,
} from '@/lib/api';
import {
  buildSentenceD, findNearestWord, sentenceRange,
  findBoundaryByWordSequence, type Word,
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

  const [viewMode, setViewMode] = useState<ViewMode>('pdf');
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
  // Sequência para abortar plays antigos (anti-overlap)
  const playSeqRef = useRef(0);

  // Áudio em background
  useEffect(() => {
    Audio.setAudioModeAsync({
      staysActiveInBackground: true,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      interruptionModeIOS: 1,
      interruptionModeAndroid: 1,
    }).catch(() => {});
    return () => {
      playSeqRef.current++; // invalida loads pendentes
      soundRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (data?.progress?.current_chunk != null) {
      setChunkIdx(data.progress.current_chunk);
    }
  }, [data?.document?.id]);

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

  // Auto-scroll pra página atual durante playback (PDF view)
  useEffect(() => {
    if (viewMode !== 'pdf' || !data || userScrollingRef.current) return;
    const chunk = data.chunks[chunkIdx];
    if (!chunk) return;
    flatRef.current?.scrollToIndex({ index: chunk.page - 1, animated: true, viewPosition: 0.1 });
  }, [chunkIdx, data?.document?.id, viewMode]);

  // Toca chunk com proteção anti-overlap
  const playChunk = useCallback(async (idx: number, seekToMs = 0) => {
    if (!data) return;
    const seq = ++playSeqRef.current;
    setIsLoadingAudio(true);
    try {
      // Para qualquer áudio anterior PRIMEIRO (sincronamente)
      const prev = soundRef.current;
      soundRef.current = null;
      if (prev) await prev.unloadAsync().catch(() => {});
      if (seq !== playSeqRef.current) return; // outro play sobrescreveu

      const audio = await getChunkAudio(docId, idx);
      if (seq !== playSeqRef.current) return;
      setBoundaries(audio.boundaries);

      const { sound } = await Audio.Sound.createAsync(
        { uri: audioUrl(audio.audio_url) },
        { shouldPlay: true, rate: speed, positionMillis: seekToMs },
        (status: AVPlaybackStatus) => {
          if (!status.isLoaded) return;
          setPosMs(status.positionMillis || 0);
          if (status.durationMillis) chunkDur.current[idx] = status.durationMillis;
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
      // Se outro play começou enquanto carregávamos, descartar este
      if (seq !== playSeqRef.current) {
        sound.unloadAsync().catch(() => {});
        return;
      }
      soundRef.current = sound;
      setChunkIdx(idx);
      saveProgress(docId, idx, seekToMs).catch(() => {});
    } catch (e: any) {
      Alert.alert('Erro', e?.message || 'Falha ao carregar áudio');
    } finally {
      if (seq === playSeqRef.current) setIsLoadingAudio(false);
    }
  }, [data, docId, speed]);

  const togglePlay = useCallback(async () => {
    if (!soundRef.current) {
      await playChunk(chunkIdx, 0);
      return;
    }
    const status = await soundRef.current.getStatusAsync();
    if (!status.isLoaded) { await playChunk(chunkIdx, 0); return; }
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

  useEffect(() => {
    if (!boundaries.length) { setActiveBIdx(-1); return; }
    let idx = -1;
    for (let i = 0; i < boundaries.length; i++) {
      const b = boundaries[i];
      if (posMs >= b.offset_ms && posMs < b.offset_ms + b.duration_ms + 300) { idx = i; break; }
    }
    setActiveBIdx(idx);
  }, [posMs, boundaries]);

  const handlePagePress = useCallback(async (page: number, relX: number, relY: number) => {
    if (!data || isLoadingAudio) return;
    setIsLoadingAudio(true);
    try {
      let words = pageWords[page];
      if (!words) {
        words = await getPageWords(docId, page);
        setPageWords(prev => ({ ...prev, [page]: words }));
      }
      if (!words.length) return;

      const wordIdx = findNearestWord(words, clamp(relX, 0, 1), clamp(relY, 0, 1));
      const [start] = sentenceRange(words, wordIdx);
      const contextWords = words.slice(start, start + 12).map(w => w.word);

      const ctx3Norm = norm(contextWords.slice(0, 3).join(' '));
      let chunkMatchIdx = -1;
      const candidates = data.chunks.filter(c => Math.abs(c.page - page) <= 1);
      for (const c of candidates) {
        if (norm(c.text).includes(ctx3Norm)) { chunkMatchIdx = c.index; break; }
      }
      if (chunkMatchIdx === -1) {
        const sameP = data.chunks.find(c => c.page === page);
        chunkMatchIdx = sameP?.index ?? 0;
      }

      const audio = await getChunkAudio(docId, chunkMatchIdx);
      setBoundaries(audio.boundaries);
      const bIdx = findBoundaryByWordSequence(contextWords, audio.boundaries);
      const seekMs = bIdx >= 0 ? audio.boundaries[bIdx].offset_ms : 0;
      await playChunk(chunkMatchIdx, seekMs);
    } catch (e: any) {
      console.warn('handlePagePress:', e);
      setIsLoadingAudio(false);
    }
  }, [data, docId, pageWords, playChunk, isLoadingAudio]);

  if (isLoading || !data) {
    return (
      <View style={[styles.fill, styles.center]}>
        <ActivityIndicator color={colors.ink} />
      </View>
    );
  }

  const doc = data.document;
  const chunk = data.chunks[chunkIdx];

  const AVG = 50000;
  let elapsed = 0;
  for (let i = 0; i < chunkIdx; i++) elapsed += chunkDur.current[i] || AVG;
  elapsed += posMs;
  let total = 0;
  for (let i = 0; i < data.chunks.length; i++) total += chunkDur.current[i] || AVG;
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
      </View>
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
        resizeMode="stretch"
      />
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
  return (
    <ScrollView contentContainerStyle={[styles.textWrap, { paddingBottom: bottomPadding }]} showsVerticalScrollIndicator={false}>
      {chunks.map((c) => {
        const isActive = c.index === chunkIdx;
        return (
          <Pressable key={c.index} onPress={() => onPlayChunk(c.index)} style={styles.textChunk}>
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
function Player({ coverId, chapter, page, totalPages, elapsed, total, pct, isPlaying, isLoading, onPlayPause, onSkip10, speed, onSpeedChange }: {
  coverId: string; chapter: string; page: number; totalPages: number;
  elapsed: number; total: number; pct: number;
  isPlaying: boolean; isLoading: boolean;
  onPlayPause: () => void; onSkip10: (dir: 1 | -1) => void;
  speed: number; onSpeedChange: (s: number) => void;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  return (
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
              source={{ uri: coverUrl(coverId) }}
              style={styles.cover}
              onError={() => setCoverFailed(true)}
            />
          )}
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
              <ActivityIndicator color={colors.ink} size="small" />
            ) : (
              <Text style={styles.playGlyph}>{isPlaying ? '⏸' : '▶'}</Text>
            )}
          </Pressable>

          <Pressable onPress={() => onSkip10(1)} hitSlop={6} style={styles.skipBtn}>
            <SkipIcon dir="fwd" />
            <Text style={styles.skipNum}>10</Text>
          </Pressable>
        </View>

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
    </BlurView>
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
