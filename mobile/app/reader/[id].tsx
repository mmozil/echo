import { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, Pressable, ActivityIndicator, Image, FlatList, Dimensions, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Audio } from 'expo-av';
import Svg, { Path } from 'react-native-svg';
import {
  getDocument, getChunkAudio, getPageWords, saveProgress,
  audioUrl, pageImageUrl, coverUrl,
} from '@/lib/api';
import {
  buildSentenceD, findNearestWord, sentenceRange, findBoundaryByWordSequence, type Word,
} from '@/lib/highlight';

const SCREEN_W = Dimensions.get('window').width;

type Boundary = { offset_ms: number; duration_ms: number; text: string };

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
  const [posMs, setPosMs] = useState(0);
  const [durMs, setDurMs] = useState(0);
  const [speed, setSpeed] = useState(1);

  const soundRef = useRef<Audio.Sound | null>(null);
  const flatRef = useRef<FlatList>(null);
  // Cache de duração por chunk pra calcular tempo global
  const chunkDur = useRef<Record<number, number>>({});

  // Configura áudio em background (iOS/Android)
  useEffect(() => {
    Audio.setAudioModeAsync({
      staysActiveInBackground: true,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      interruptionModeIOS: 1, // DoNotMix
      interruptionModeAndroid: 1,
    });
    return () => { soundRef.current?.unloadAsync(); };
  }, []);

  // Restaura progresso ao abrir
  useEffect(() => {
    if (data?.progress?.current_chunk != null) {
      setChunkIdx(data.progress.current_chunk);
    }
  }, [data?.document?.id]);

  // Carrega palavras das próximas páginas (pra highlight ficar pronto)
  useEffect(() => {
    if (!data) return;
    const chunk = data.chunks[chunkIdx];
    if (!chunk) return;
    const pages = [chunk.page, chunk.page + 1, chunk.page + 2].filter(p => p >= 1 && p <= data.document.total_pages);
    pages.forEach(async (p) => {
      if (pageWords[p]) return;
      try {
        const words = await getPageWords(docId, p);
        setPageWords(prev => ({ ...prev, [p]: words }));
      } catch {}
    });
  }, [chunkIdx, data?.document?.id]);

  // Toca chunk atual
  const playChunk = useCallback(async (idx: number, seekToMs = 0) => {
    if (!data) return;
    try {
      // Descarregar anterior
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }

      const audio = await getChunkAudio(docId, idx);
      setBoundaries(audio.boundaries);

      const { sound } = await Audio.Sound.createAsync(
        { uri: audioUrl(audio.audio_url) },
        { shouldPlay: true, rate: speed, positionMillis: seekToMs },
        (status) => {
          if (!status.isLoaded) return;
          setPosMs(status.positionMillis || 0);
          if (status.durationMillis) {
            setDurMs(status.durationMillis);
            chunkDur.current[idx] = status.durationMillis;
          }
          setIsPlaying(status.isPlaying);
          if (status.didJustFinish) {
            const nextIdx = idx + 1;
            if (nextIdx < data.chunks.length) {
              setChunkIdx(nextIdx);
              playChunk(nextIdx);
            } else {
              setIsPlaying(false);
            }
          }
        }
      );
      soundRef.current = sound;

      // Salvar progresso (sync com web)
      saveProgress(docId, idx, seekToMs).catch(() => {});

      // Scroll para a página do chunk
      const chunk = data.chunks[idx];
      if (chunk) flatRef.current?.scrollToIndex({ index: chunk.page - 1, animated: true });
    } catch (e: any) {
      Alert.alert('Erro', e?.message || 'Falha ao carregar áudio');
    }
  }, [data, docId, speed]);

  // Toggle play/pause
  const togglePlay = useCallback(async () => {
    if (soundRef.current) {
      const status = await soundRef.current.getStatusAsync();
      if (status.isLoaded) {
        if (status.isPlaying) await soundRef.current.pauseAsync();
        else await soundRef.current.playAsync();
        return;
      }
    }
    playChunk(chunkIdx);
  }, [chunkIdx, playChunk]);

  // Atualizar boundary ativo (highlight) baseado em posMs
  useEffect(() => {
    if (!boundaries.length) { setActiveBIdx(-1); return; }
    let idx = -1;
    for (let i = 0; i < boundaries.length; i++) {
      const b = boundaries[i];
      if (posMs >= b.offset_ms && posMs < b.offset_ms + b.duration_ms + 300) { idx = i; break; }
    }
    setActiveBIdx(idx);
  }, [posMs, boundaries]);

  // Click numa página: pega coords → pageWord → frase → seek
  const handlePagePress = useCallback(async (page: number, relX: number, relY: number) => {
    let words = pageWords[page];
    if (!words) {
      words = await getPageWords(docId, page);
      setPageWords(prev => ({ ...prev, [page]: words }));
    }
    if (!words.length) return;
    const wordIdx = findNearestWord(words, relX, relY);
    const [start] = sentenceRange(words, wordIdx);
    const contextWords = words.slice(start, start + 12).map(w => w.word);

    // Achar chunk que contém o contexto (heurística simples: chunk com mesma page)
    const ctx = contextWords.join(' ').toLowerCase();
    let chunkMatchIdx = -1;
    if (data) {
      const candidates = data.chunks.filter(c => c.page === page);
      for (const c of candidates) {
        if (c.text.toLowerCase().includes(contextWords.slice(0, 3).join(' ').toLowerCase())) {
          chunkMatchIdx = c.index;
          break;
        }
      }
      if (chunkMatchIdx === -1 && candidates.length) chunkMatchIdx = candidates[0].index;
    }
    if (chunkMatchIdx === -1) return;

    setChunkIdx(chunkMatchIdx);
    // Buscar áudio + boundaries → seek
    const audio = await getChunkAudio(docId, chunkMatchIdx);
    setBoundaries(audio.boundaries);
    const bIdx = findBoundaryByWordSequence(contextWords, audio.boundaries);
    const seekMs = bIdx >= 0 ? audio.boundaries[bIdx].offset_ms : 0;
    playChunk(chunkMatchIdx, seekMs);
  }, [data, docId, pageWords, playChunk]);

  if (isLoading || !data) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0F0F12', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#ABB3FE" />
      </View>
    );
  }

  const doc = data.document;
  const chunk = data.chunks[chunkIdx];

  // Cálculo de tempo global
  const AVG = 50000;
  let elapsed = 0;
  for (let i = 0; i < chunkIdx; i++) elapsed += chunkDur.current[i] || AVG;
  elapsed += posMs;
  let total = 0;
  for (let i = 0; i < data.chunks.length; i++) total += chunkDur.current[i] || AVG;
  const pct = total > 0 ? (elapsed / total) * 100 : 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#0F0F12' }} edges={['top', 'left', 'right']}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8 }}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={{ padding: 8 }}>
          <Text style={{ color: 'white', fontSize: 16 }}>‹</Text>
        </Pressable>
        <Text numberOfLines={1} style={{ flex: 1, color: 'white', fontSize: 14, fontWeight: '600', textAlign: 'center', marginHorizontal: 12 }}>
          {doc.title}
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, paddingHorizontal: 8 }}>
          {chunk?.page || '—'}/{doc.total_pages}
        </Text>
      </View>

      {/* Páginas (PNG do servidor + SVG highlight) */}
      <FlatList
        ref={flatRef}
        data={Array.from({ length: doc.total_pages }, (_, i) => i + 1)}
        keyExtractor={(p) => String(p)}
        showsVerticalScrollIndicator={false}
        getItemLayout={(_, i) => ({ length: SCREEN_W * 1.4, offset: SCREEN_W * 1.4 * i, index: i })}
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
        onPlayPause={togglePlay}
        onSkip10={(dir) => {
          if (soundRef.current) {
            soundRef.current.getStatusAsync().then(s => {
              if (!s.isLoaded) return;
              const newPos = Math.max(0, Math.min((s.positionMillis || 0) + dir * 10000, s.durationMillis || 0));
              soundRef.current?.setPositionAsync(newPos);
            });
          }
        }}
        speed={speed}
        onSpeedChange={(s) => {
          setSpeed(s);
          soundRef.current?.setRateAsync(s, true);
        }}
      />
    </SafeAreaView>
  );
}

// ===== Página PDF + SVG highlight =====
function PdfPage({ docId, page, words, isActive, boundaries, activeBIdx, onPress }: {
  docId: string; page: number; words?: Word[]; isActive: boolean;
  boundaries: Boundary[]; activeBIdx: number;
  onPress: (relX: number, relY: number) => void;
}) {
  const [layout, setLayout] = useState({ width: 0, height: 0 });

  // Calcular path da frase ativa
  let pathD = '';
  if (isActive && words && words.length && activeBIdx >= 0 && boundaries.length) {
    // Mapear boundary ativo → palavra na página por ratio (igual web)
    const ratio = activeBIdx / boundaries.length;
    const targetIdx = Math.min(Math.floor(ratio * words.length), words.length - 1);
    const [s, e] = sentenceRange(words, targetIdx);
    pathD = buildSentenceD(words, s, e);
  }

  return (
    <Pressable
      onPress={(e) => {
        if (!layout.width) return;
        const relX = e.nativeEvent.locationX / layout.width;
        const relY = e.nativeEvent.locationY / layout.height;
        onPress(relX, relY);
      }}
      onLayout={(e) => setLayout({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
      style={{ marginVertical: 4 }}
    >
      <View style={{ position: 'relative' }}>
        <Image
          source={{ uri: pageImageUrl(docId, page) }}
          style={{ width: SCREEN_W, aspectRatio: 0.71, backgroundColor: 'white' }}
          resizeMode="contain"
        />
        {pathD ? (
          <Svg
            width={layout.width || SCREEN_W}
            height={layout.height || SCREEN_W * 1.4}
            viewBox="0 0 1000 1000"
            preserveAspectRatio="none"
            style={{ position: 'absolute', left: 0, top: 0 }}
            pointerEvents="none"
          >
            <Path d={pathD} fill="rgba(165, 175, 250, 0.42)" />
          </Svg>
        ) : null}
      </View>
    </Pressable>
  );
}

// ===== Player (Apple Books style) =====
function Player({ coverId, chapter, page, totalPages, elapsed, total, pct, isPlaying, onPlayPause, onSkip10, speed, onSpeedChange }: {
  coverId: string; chapter: string; page: number; totalPages: number;
  elapsed: number; total: number; pct: number; isPlaying: boolean;
  onPlayPause: () => void; onSkip10: (dir: 1 | -1) => void;
  speed: number; onSpeedChange: (s: number) => void;
}) {
  return (
    <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
      <View style={{
        backgroundColor: 'rgba(20, 20, 22, 0.95)',
        borderRadius: 18,
        borderWidth: 0.5,
        borderColor: 'rgba(255,255,255,0.1)',
        overflow: 'hidden',
      }}>
        {/* Progress bar */}
        <View style={{ height: 3, backgroundColor: 'rgba(255,255,255,0.1)' }}>
          <View style={{ width: `${pct}%`, height: '100%', backgroundColor: '#8C9CFF' }} />
        </View>

        {/* Main row */}
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12 }}>
          <Image
            source={{ uri: coverUrl(coverId) }}
            style={{ width: 48, height: 48, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.05)' }}
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ color: 'white', fontSize: 13, fontWeight: '700' }}>
              {chapter}
            </Text>
            <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 2 }}>
              {fmt(elapsed)} · pág {page}/{totalPages} · {fmt(total)}
            </Text>
          </View>
          <Pressable onPress={() => onSkip10(-1)} hitSlop={6} style={{ padding: 6 }}>
            <Text style={{ color: 'white', fontSize: 11, fontWeight: '700' }}>−10</Text>
          </Pressable>
          <Pressable
            onPress={onPlayPause}
            style={({ pressed }) => ({
              width: 44, height: 44, borderRadius: 22,
              backgroundColor: 'white',
              alignItems: 'center', justifyContent: 'center',
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Text style={{ color: '#0F0F12', fontSize: 16, fontWeight: '900' }}>
              {isPlaying ? '⏸' : '▶'}
            </Text>
          </Pressable>
          <Pressable onPress={() => onSkip10(1)} hitSlop={6} style={{ padding: 6 }}>
            <Text style={{ color: 'white', fontSize: 11, fontWeight: '700' }}>+10</Text>
          </Pressable>
        </View>

        {/* Speed selector */}
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 12, paddingBottom: 10, gap: 6 }}>
          {[0.75, 1, 1.25, 1.5, 2].map(s => (
            <Pressable
              key={s}
              onPress={() => onSpeedChange(s)}
              style={{
                paddingHorizontal: 9, paddingVertical: 4,
                borderRadius: 12,
                backgroundColor: speed === s ? 'rgba(171,179,254,0.25)' : 'rgba(255,255,255,0.05)',
                borderWidth: 0.5,
                borderColor: speed === s ? 'rgba(171,179,254,0.4)' : 'rgba(255,255,255,0.1)',
              }}
            >
              <Text style={{ color: speed === s ? '#ABB3FE' : 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '700' }}>
                {s}×
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

function fmt(ms: number): string {
  if (!isFinite(ms) || isNaN(ms)) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2,'0')}:${sec}` : `${m}:${sec}`;
}
