// Biblioteca — a tela raiz.
//
// O que mudou, e por que (regras lidas em developer.apple.com, 25/09/2026,
// arquivadas em `.docs/apple-hig.md`):
//
// · «Order content by relative importance.» — o livro que esta' sendo lido
//   agora abre a tela, com o progresso a' vista. Antes os tres apareciam
//   iguais, e o dado de progresso JA' VINHA da API (`current_chunk`,
//   `last_read_at`) e era jogado fora.
// · Titulo grande de 34/41, o tamanho que a Apple publica para tela raiz.
//   Antes a tela nao tinha titulo nenhum — so' o logo e um «Sair».
// · «Don't assign the primary role to a button that performs a destructive
//   action» — sair da conta era o UNICO botao do topo, no canto onde o polegar
//   bate sem querer, e saia sem perguntar. Agora confirma.
// · «Always include a press state for a custom button» — o cartao respondia
//   com `opacity`, que nao lê como toque. Agora e' mola na escala.
import { useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, RefreshControl, StyleSheet, Text, View,
} from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { coverUrl, listDocuments, logout, initAuthToken, type DocSummary } from '@/lib/api';
import { colors, tipo, espaco, raio } from '@/lib/theme';
import { Toque, Progresso } from '@/components/Toque';

const ACENTO = '#8C9CFF';

export default function Biblioteca() {
  const qc = useQueryClient();
  const [atualizando, setAtualizando] = useState(false);
  const [autenticado, setAutenticado] = useState(false);

  useEffect(() => {
    let morto = false;
    const falhou = () => { if (!morto) router.replace('/login'); };
    const ok = () => { if (!morto) setAutenticado(true); };
    const t = setTimeout(falhou, 2000);
    initAuthToken()
      .then((tk) => { clearTimeout(t); tk ? ok() : falhou(); })
      .catch(() => { clearTimeout(t); falhou(); });
    return () => { morto = true; clearTimeout(t); };
  }, []);

  const { data: docs, isLoading, error } = useQuery({
    queryKey: ['documents'],
    queryFn: listDocuments,
    enabled: autenticado,
  });

  useEffect(() => {
    if ((error as any)?.response?.status === 401) router.replace('/login');
  }, [error]);

  async function atualizar() {
    setAtualizando(true);
    await qc.invalidateQueries({ queryKey: ['documents'] });
    setAtualizando(false);
  }

  // 🚨 Sair e' destrutivo o bastante para perguntar: quem sai perde a sessao e
  //    precisa da senha de volta, e o botao fica no canto do polegar.
  function sair() {
    Alert.alert('Sair da conta?', 'Você vai precisar entrar de novo com e-mail e senha.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Sair', style: 'destructive',
        onPress: async () => { await logout(); router.replace('/login'); },
      },
    ]);
  }

  if (!autenticado) {
    return <View style={[estilos.tela, estilos.centro]}><ActivityIndicator color={colors.ink} /></View>;
  }

  // Em andamento = tem progresso e nao terminou. O mais recente abre a tela.
  const emCurso = (docs ?? [])
    .filter(d => (d.current_chunk ?? 0) > 0 && (d.current_chunk ?? 0) < (d.total_chunks ?? 1) - 1)
    .sort((a, b) => String(b.last_read_at ?? '').localeCompare(String(a.last_read_at ?? '')));
  const retomar = emCurso[0];
  const demais = (docs ?? []).filter(d => d.id !== retomar?.id);

  const abrir = (d: DocSummary) => router.push(`/reader/${d.id}` as any);

  return (
    <SafeAreaView style={estilos.tela} edges={['top', 'left', 'right']}>
      <FlatList
        data={demais}
        keyExtractor={(d) => d.id}
        numColumns={2}
        columnWrapperStyle={{ gap: espaco.padrao }}
        contentContainerStyle={estilos.conteudo}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={atualizando} onRefresh={atualizar} tintColor={colors.mist} />
        }
        ListHeaderComponent={
          <View>
            <View style={estilos.topo}>
              <Text style={estilos.tituloGrande} accessibilityRole="header">Biblioteca</Text>
              <Toque rotulo="Sair da conta" dica="Pede confirmação" onPress={sair} style={estilos.sairBotao}>
                <IconeSair />
              </Toque>
            </View>

            {isLoading && !docs ? (
              <View style={estilos.carregando}><ActivityIndicator color={colors.mist} /></View>
            ) : null}

            {retomar ? (
              <View style={estilos.secao}>
                <Text style={estilos.secaoTitulo}>Continuar</Text>
                <CartaoRetomar item={retomar} onPress={() => abrir(retomar)} />
              </View>
            ) : null}

            {demais.length ? (
              <Text style={[estilos.secaoTitulo, estilos.secaoTituloGrade]}>
                {retomar ? 'Outros livros' : 'Seus livros'}
              </Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !isLoading && !retomar ? (
            <View style={estilos.vazio}>
              <Text style={estilos.vazioTitulo}>Sua biblioteca está vazia</Text>
              <Text style={estilos.vazioTexto}>
                Envie um PDF em echo.hovio.com.br e ele aparece aqui.
              </Text>
              <Toque rotulo="Procurar livros novos" onPress={atualizar} style={estilos.vazioBotao} alvoMinimo={false}>
                <Text style={estilos.vazioBotaoTexto}>Procurar de novo</Text>
              </Toque>
            </View>
          ) : null
        }
        renderItem={({ item }) => <CartaoLivro item={item} onPress={() => abrir(item)} />}
      />
    </SafeAreaView>
  );
}

// ── O que esta' sendo lido agora ──────────────────────────────────────────
function CartaoRetomar({ item, onPress }: { item: DocSummary; onPress: () => void }) {
  const [semCapa, setSemCapa] = useState(false);
  const f = (item.current_chunk ?? 0) / Math.max(1, (item.total_chunks ?? 1) - 1);
  const pct = Math.round(f * 100);

  return (
    <Toque
      rotulo={`Continuar ${item.title}, ${pct} por cento lido`}
      onPress={onPress}
      vibrar
      escala={0.98}
      alvoMinimo={false}
      style={estilos.retomar}
    >
      <View style={estilos.retomarLinha}>
        <View style={estilos.retomarCapa}>
          {semCapa ? (
            <View style={estilos.capaVazia}>
              <Text numberOfLines={3} style={estilos.capaVaziaTexto}>{item.title}</Text>
            </View>
          ) : (
            <Image
              source={coverUrl(item.id)}
              style={estilos.capaImagem}
              contentFit="cover"
              transition={200}
              onError={() => setSemCapa(true)}
            />
          )}
        </View>

        <View style={estilos.retomarCorpo}>
          <Text numberOfLines={2} style={estilos.retomarTitulo}>{item.title}</Text>
          <Text style={estilos.retomarMeta}>{pct}% lido · {item.total_pages} páginas</Text>
          <View style={estilos.retomarBarra}>
            <Progresso fracao={f} cor={ACENTO} fundo={colors.border} altura={4} />
          </View>
          <Text style={estilos.retomarAcao}>Continuar ouvindo</Text>
        </View>
      </View>
    </Toque>
  );
}

// ── Cartao da grade ───────────────────────────────────────────────────────
function CartaoLivro({ item, onPress }: { item: DocSummary; onPress: () => void }) {
  const [semCapa, setSemCapa] = useState(false);
  const f = (item.current_chunk ?? 0) / Math.max(1, (item.total_chunks ?? 1) - 1);
  const comecou = (item.current_chunk ?? 0) > 0;

  return (
    <Toque
      rotulo={comecou ? `${item.title}, ${Math.round(f * 100)} por cento lido` : item.title}
      onPress={onPress}
      vibrar
      escala={0.97}
      alvoMinimo={false}
      style={estilos.cartao}
    >
      <View style={estilos.cartaoInterior}>
        <View style={estilos.capa}>
          {semCapa ? (
            <View style={estilos.capaVazia}>
              <Text numberOfLines={4} style={estilos.capaVaziaTexto}>{item.title}</Text>
            </View>
          ) : (
            <Image
              source={coverUrl(item.id)}
              style={estilos.capaImagem}
              contentFit="cover"
              transition={200}
              onError={() => setSemCapa(true)}
            />
          )}
          {comecou ? (
            <View style={estilos.capaBarra}>
              <Progresso fracao={f} cor={ACENTO} fundo="rgba(255,255,255,0.28)" altura={3} />
            </View>
          ) : null}
        </View>
        <Text numberOfLines={2} style={estilos.cartaoTitulo}>{item.title}</Text>
        <Text style={estilos.cartaoMeta}>
          {comecou ? `${Math.round(f * 100)}% · ` : ''}{item.total_pages} páginas
        </Text>
      </View>
    </Toque>
  );
}

function IconeSair() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={colors.slate}
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <Path d="M16 17l5-5-5-5M21 12H9" />
    </Svg>
  );
}

const estilos = StyleSheet.create({
  tela: { flex: 1, backgroundColor: colors.snow },
  centro: { alignItems: 'center', justifyContent: 'center' },
  conteudo: { paddingHorizontal: espaco.padrao, paddingBottom: espaco.heroi, gap: espaco.padrao },

  topo: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: espaco.pequeno, paddingBottom: espaco.padrao,
  },
  tituloGrande: { ...tipo.tituloGrande, color: colors.ink },
  sairBotao: { width: 44, height: 44, alignItems: 'flex-end', justifyContent: 'center' },

  carregando: { paddingVertical: espaco.secao, alignItems: 'center' },

  secao: { marginBottom: espaco.ar },
  secaoTitulo: { ...tipo.destaque, color: colors.ink, marginBottom: espaco.medio },
  secaoTituloGrade: { marginTop: espaco.pequeno, marginBottom: espaco.medio },

  // continuar
  retomar: {
    backgroundColor: colors.white,
    borderRadius: raio.grande,
    padding: espaco.medio,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 12, elevation: 3,
  },
  retomarLinha: { flexDirection: 'row', gap: espaco.medio, width: '100%' },
  retomarCapa: {
    width: 76, aspectRatio: 0.72, borderRadius: raio.pequeno, overflow: 'hidden',
    backgroundColor: colors.charcoal,
  },
  retomarCorpo: { flex: 1, minWidth: 0, justifyContent: 'center' },
  retomarTitulo: { ...tipo.destaque, color: colors.ink },
  retomarMeta: { ...tipo.nota, color: colors.slate, marginTop: espaco.micro },
  retomarBarra: { marginTop: espaco.pequeno, marginBottom: espaco.pequeno },
  retomarAcao: { ...tipo.nota, fontWeight: '600', color: ACENTO },

  // grade
  cartao: { flex: 1 },
  cartaoInterior: { width: '100%' },
  capa: {
    aspectRatio: 0.72, borderRadius: raio.pequeno, overflow: 'hidden',
    backgroundColor: colors.charcoal, marginBottom: espaco.pequeno,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12, shadowRadius: 12, elevation: 4,
  },
  capaImagem: { width: '100%', height: '100%' },
  capaVazia: { flex: 1, backgroundColor: colors.charcoal, padding: espaco.medio, justifyContent: 'flex-end' },
  capaVaziaTexto: { ...tipo.nota, fontWeight: '700', color: 'white' },
  capaBarra: { position: 'absolute', left: espaco.pequeno, right: espaco.pequeno, bottom: espaco.pequeno },
  cartaoTitulo: { ...tipo.subtitulo, fontWeight: '600', color: colors.ink },
  cartaoMeta: { ...tipo.nota, color: colors.slate, marginTop: 2 },

  // vazio
  vazio: { alignItems: 'center', paddingTop: espaco.heroi, paddingHorizontal: espaco.ar, gap: espaco.medio },
  vazioTitulo: { ...tipo.titulo3, color: colors.ink, textAlign: 'center' },
  vazioTexto: { ...tipo.chamada, color: colors.slate, textAlign: 'center' },
  vazioBotao: {
    marginTop: espaco.pequeno, minHeight: 48, paddingHorizontal: espaco.ar,
    borderRadius: raio.pilula, backgroundColor: colors.ink, justifyContent: 'center',
  },
  vazioBotaoTexto: { ...tipo.destaque, color: colors.white },
});
