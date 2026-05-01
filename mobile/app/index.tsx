import { View, Text, FlatList, Pressable, RefreshControl, ActivityIndicator, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { coverUrl, listDocuments, logout } from '@/lib/api';
import { EchoLogo } from '@/components/EchoLogo';
import { colors, fonts } from '@/lib/theme';

export default function Library() {
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  // Verifica token; sem ele → login (timeout de 2s caso SecureStore trave)
  useEffect(() => {
    let cancelled = false;
    const fail = () => { if (!cancelled) router.replace('/login'); };
    const ok = () => { if (!cancelled) setAuthChecked(true); };
    const timer = setTimeout(fail, 2000);
    SecureStore.getItemAsync('echo_token')
      .then((t) => { clearTimeout(timer); t ? ok() : fail(); })
      .catch(() => { clearTimeout(timer); fail(); });
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const { data: docs, isLoading, error } = useQuery({
    queryKey: ['documents'],
    queryFn: listDocuments,
    enabled: authChecked,
  });

  useEffect(() => {
    const status = (error as any)?.response?.status;
    if (status === 401) router.replace('/login');
  }, [error]);

  async function onRefresh() {
    setRefreshing(true);
    await qc.invalidateQueries({ queryKey: ['documents'] });
    setRefreshing(false);
  }

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  if (!authChecked) {
    return (
      <View style={[styles.fill, styles.center]}>
        <ActivityIndicator color={colors.ink} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.fill} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <EchoLogo size="md" />
        <Pressable onPress={handleLogout} hitSlop={10}>
          <Text style={styles.logoutText}>Sair</Text>
        </Pressable>
      </View>

      {isLoading && !docs ? (
        <View style={[styles.fill, styles.center]}>
          <ActivityIndicator color={colors.ink} />
        </View>
      ) : !docs?.length ? (
        <View style={[styles.fill, styles.center, { padding: 32 }]}>
          <Text style={styles.empty}>
            Sua biblioteca está vazia.{'\n'}
            Adicione PDFs em echo.hovio.com.br
          </Text>
        </View>
      ) : (
        <FlatList
          data={docs}
          keyExtractor={(d) => d.id}
          numColumns={2}
          contentContainerStyle={{ padding: 16, gap: 18 }}
          columnWrapperStyle={{ gap: 16 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.ink} />}
          renderItem={({ item }) => (
            <BookCard item={item} onPress={() => router.push(`/reader/${item.id}` as any)} />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function BookCard({ item, onPress }: { item: { id: string; title: string; total_pages: number; has_cover?: boolean }; onPress: () => void }) {
  const [coverFailed, setCoverFailed] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, { opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={styles.coverWrap}>
        {/* Sempre tenta carregar — fallback aparece SE imagem falhar (404, etc) */}
        {!coverFailed ? (
          <Image
            source={coverUrl(item.id)}
            style={styles.coverImg}
            contentFit="cover"
            transition={200}
            onError={() => setCoverFailed(true)}
          />
        ) : (
          <View style={styles.coverFallback}>
            <Text style={styles.coverFallbackTitle} numberOfLines={4}>{item.title}</Text>
          </View>
        )}
      </View>
      <Text numberOfLines={2} style={styles.cardTitle}>{item.title}</Text>
      <Text style={styles.cardMeta}>{item.total_pages} páginas</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.snow },
  center: { alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14,
    backgroundColor: colors.white,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  logoutText: { color: colors.slate, fontSize: 13, fontWeight: '500' },

  empty: { color: colors.slate, fontSize: 14, textAlign: 'center', lineHeight: 22 },

  card: { flex: 1 },
  coverWrap: {
    aspectRatio: 0.75,
    backgroundColor: colors.charcoal,
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 8,
    // sombra estilo Apple Books
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 4,
  },
  coverImg: { width: '100%', height: '100%' },
  coverFallback: {
    flex: 1,
    backgroundColor: colors.charcoal,
    padding: 14,
    justifyContent: 'flex-end',
  },
  coverFallbackTitle: {
    color: 'white',
    fontSize: 13,
    fontWeight: '700',
    fontFamily: fonts.display,
    lineHeight: 17,
    letterSpacing: -0.2,
  },
  cardTitle: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: -0.1,
    fontFamily: fonts.display,
    lineHeight: 17,
  },
  cardMeta: {
    color: colors.slate,
    fontSize: 11,
    marginTop: 2,
  },
});
