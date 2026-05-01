import { View, Text, FlatList, Image, Pressable, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { coverUrl, listDocuments, logout } from '@/lib/api';

export default function Library() {
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const { data: docs, isLoading } = useQuery({
    queryKey: ['documents'],
    queryFn: listDocuments,
  });

  async function onRefresh() {
    setRefreshing(true);
    await qc.invalidateQueries({ queryKey: ['documents'] });
    setRefreshing(false);
  }

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#0F0F12' }} edges={['top', 'left', 'right']}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ width: 22, height: 22, position: 'relative' }}>
            <View style={{ position: 'absolute', width: 6, height: 6, backgroundColor: '#001a4d', top: 0, left: 0 }} />
            <View style={{ position: 'absolute', width: 6, height: 6, backgroundColor: '#003083', top: 6, left: 6 }} />
            <View style={{ position: 'absolute', width: 6, height: 6, backgroundColor: '#0050D5', top: 12, left: 12 }} />
          </View>
          <Text style={{ color: 'white', fontSize: 22, fontWeight: '800', letterSpacing: -1 }}>echo.</Text>
        </View>
        <Pressable onPress={handleLogout} hitSlop={10}>
          <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13 }}>Sair</Text>
        </Pressable>
      </View>

      {isLoading && !docs ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color="#ABB3FE" />
        </View>
      ) : !docs?.length ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14, textAlign: 'center' }}>
            Sua biblioteca está vazia.{'\n'}Adicione PDFs pelo navegador em echo.hovio.com.br
          </Text>
        </View>
      ) : (
        <FlatList
          data={docs}
          keyExtractor={(d) => d.id}
          numColumns={2}
          contentContainerStyle={{ padding: 16, gap: 16 }}
          columnWrapperStyle={{ gap: 16 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#ABB3FE" />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/reader/${item.id}` as any)}
              style={({ pressed }) => ({
                flex: 1,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <View style={{
                aspectRatio: 0.7,
                backgroundColor: 'rgba(255,255,255,0.05)',
                borderRadius: 12,
                overflow: 'hidden',
                marginBottom: 8,
              }}>
                {item.has_cover ? (
                  <Image
                    source={{ uri: coverUrl(item.id) }}
                    style={{ width: '100%', height: '100%' }}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11 }}>sem capa</Text>
                  </View>
                )}
              </View>
              <Text
                numberOfLines={2}
                style={{ color: 'white', fontSize: 13, fontWeight: '600', letterSpacing: -0.1 }}
              >
                {item.title}
              </Text>
              <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, marginTop: 2 }}>
                {item.total_pages} páginas
              </Text>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
