// Buscar — em todos os livros de uma vez.
//
// 🚨 O servidor tem `GET /api/documents/{id}/search` desde sempre, com trecho
//    e contexto dos dois lados, e o app NUNCA o chamou. Apareceu ao comparar o
//    que a API oferece com o que o app consome: 5 endpoints ociosos, e este
//    era o de maior valor num leitor.
//
// A busca e' por LIVRO no servidor; aqui ela vai a todos em paralelo e junta.
// Com tres livros isso e' instantaneo; se a biblioteca crescer muito, o certo
// e' um endpoint de busca global — nao mais paralelismo daqui.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, Keyboard, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import Svg, { Circle, Path } from 'react-native-svg';
import { listDocuments, buscarNoLivro, type Achado, type DocSummary } from '@/lib/api';
import { tipo, espaco, raio, useTema, useAcento, type Paleta } from '@/lib/theme';
import { Toque } from '@/components/Toque';

type Linha = Achado & { docId: string; titulo: string };

export default function Buscar() {
  const c = useTema();
  const ac = useAcento();
  const estilos = useMemo(() => criarEstilos(c), [c]);

  const [termo, setTermo] = useState('');
  const [buscando, setBuscando] = useState(false);
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [jaBuscou, setJaBuscou] = useState(false);
  const relogio = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: livros } = useQuery({ queryKey: ['documents'], queryFn: listDocuments });

  // 🚨 Espera o dedo parar. Buscar a cada tecla seria uma chamada por letra —
  //    a mesma regra de «nada que renderiza por linha chama a API».
  useEffect(() => {
    if (relogio.current) clearTimeout(relogio.current);
    const q = termo.trim();
    if (q.length < 2) { setLinhas([]); setJaBuscou(false); return; }
    relogio.current = setTimeout(async () => {
      setBuscando(true);
      try {
        const lotes = await Promise.all(
          (livros ?? []).map(async (d: DocSummary) => {
            try {
              const r = await buscarNoLivro(d.id, q);
              return r.map(x => ({ ...x, docId: d.id, titulo: d.title }));
            } catch { return [] as Linha[]; }
          }),
        );
        setLinhas(lotes.flat());
      } finally {
        setBuscando(false);
        setJaBuscou(true);
      }
    }, 320);
    return () => { if (relogio.current) clearTimeout(relogio.current); };
  }, [termo, livros]);

  const abrir = (l: Linha) => {
    Keyboard.dismiss();
    router.push(`/reader/${l.docId}?trecho=${l.chunk_index}` as any);
  };

  return (
    <SafeAreaView style={estilos.tela} edges={['top', 'left', 'right']}>
      <View style={estilos.topo}>
        <Toque rotulo="Voltar" onPress={() => router.back()} style={estilos.voltar}>
          <Svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke={c.ink}
            strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M15 5l-7 7 7 7" />
          </Svg>
        </Toque>
        <Text style={estilos.titulo} accessibilityRole="header">Buscar</Text>
        <View style={estilos.voltar} />
      </View>

      <View style={estilos.campoCaixa}>
        <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c.mist}
          strokeWidth={2} strokeLinecap="round">
          <Circle cx={11} cy={11} r={7} /><Path d="M16.5 16.5 21 21" />
        </Svg>
        <TextInput
          value={termo}
          onChangeText={setTermo}
          placeholder="Uma palavra ou frase do livro"
          placeholderTextColor={c.mist}
          autoFocus
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="O que procurar nos livros"
          style={estilos.campo}
        />
        {buscando ? <ActivityIndicator color={c.mist} size="small" /> : null}
      </View>

      <FlatList
        data={linhas}
        keyExtractor={(l, i) => `${l.docId}-${l.chunk_index}-${i}`}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={estilos.lista}
        ListEmptyComponent={
          termo.trim().length < 2 ? (
            <Text style={estilos.dica}>Digite pelo menos duas letras.</Text>
          ) : buscando ? null : jaBuscou ? (
            <View style={estilos.vazio}>
              <Text style={estilos.vazioTitulo}>Nada encontrado</Text>
              <Text style={estilos.vazioTexto}>
                Nenhum dos seus livros tem «{termo.trim()}».
              </Text>
            </View>
          ) : null
        }
        ListHeaderComponent={
          linhas.length ? (
            <Text style={estilos.contagem}>
              {linhas.length} {linhas.length === 1 ? 'trecho' : 'trechos'}
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <Toque
            rotulo={`${item.titulo}, página ${item.page}: ${item.snippet}`}
            onPress={() => abrir(item)}
            escala={0.98}
            alvoMinimo={false}
            style={estilos.achado}
          >
            <View style={estilos.achadoTopo}>
              <Text numberOfLines={1} style={[estilos.achadoLivro, { color: ac }]}>
                {item.titulo}
              </Text>
              <Text style={estilos.achadoPag}>pág {item.page}</Text>
            </View>
            <Text numberOfLines={3} style={estilos.achadoTrecho}>{item.snippet}</Text>
          </Toque>
        )}
      />
    </SafeAreaView>
  );
}

const criarEstilos = (c: Paleta) => StyleSheet.create({
  tela: { flex: 1, backgroundColor: c.snow },
  topo: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: espaco.pequeno, paddingVertical: espaco.micro,
  },
  voltar: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  titulo: { ...tipo.destaque, flex: 1, textAlign: 'center', color: c.ink },

  campoCaixa: {
    flexDirection: 'row', alignItems: 'center', gap: espaco.pequeno,
    marginHorizontal: espaco.padrao, marginBottom: espaco.medio,
    paddingHorizontal: espaco.medio,
    minHeight: 48, borderRadius: raio.medio,
    backgroundColor: c.cloud,
  },
  // 🚨 17pt: o corpo do iOS. Campo de busca menor que isso obriga a apertar os
  //    olhos justamente onde se digita devagar.
  campo: { ...tipo.corpo, flex: 1, color: c.ink, paddingVertical: espaco.pequeno },

  lista: { paddingHorizontal: espaco.padrao, paddingBottom: espaco.heroi, gap: espaco.medio },
  contagem: { ...tipo.nota, color: c.slate, marginBottom: espaco.micro },

  achado: {
    backgroundColor: c.white, borderRadius: raio.grande, padding: espaco.medio,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05, shadowRadius: 10, elevation: 2,
  },
  achadoTopo: { flexDirection: 'row', alignItems: 'center', gap: espaco.pequeno, marginBottom: espaco.micro },
  achadoLivro: { ...tipo.legenda, fontWeight: '700', flex: 1 },
  achadoPag: { ...tipo.legenda2, color: c.mist },
  achadoTrecho: { ...tipo.subtitulo, color: c.ink },

  dica: { ...tipo.nota, color: c.mist, textAlign: 'center', paddingTop: espaco.ar },
  vazio: { alignItems: 'center', paddingTop: espaco.secao, gap: espaco.pequeno },
  vazioTitulo: { ...tipo.titulo3, color: c.ink },
  vazioTexto: { ...tipo.chamada, color: c.slate, textAlign: 'center' },
});
