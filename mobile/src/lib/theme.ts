// Mesmos tokens do web (light mode default)
export const colors = {
  ink: '#1A1A1A',
  charcoal: '#2D2D2D',
  slate: '#64748B',
  mist: '#94A3B8',
  cloud: '#F1F5F9',
  snow: '#FAFBFC',
  white: '#FFFFFF',
  border: '#E2E8F0',
  accent: '#1A1A1A',
  accentLight: '#F3F4F6',
  highlight: '#BFDBFE',         // azul claro — frase no playback
  highlightSpoken: '#D4D4D8',
  // Player dark pill (mantido do design Apple Music)
  playerBg: 'rgba(20, 20, 22, 0.96)',
  playerBgFallback: '#14141680',
  // Highlight Speechify-style (overlay no PDF)
  hlSentence: 'rgba(165, 175, 250, 0.42)',
};

// Fontes — System resolve pra SF Pro no iOS, Roboto no Android
export const fonts = {
  display: 'System', // SF Pro Display equivalente
  body: 'System',
  mono: 'Menlo',     // Monospace nativo
};

// ── Escala tipografica do Apple HIG ───────────────────────────────────────
// 🚨 Toda regra de texto sai DAQUI. A auditoria contra o HIG achou 26 de 26
//    estilos sem `lineHeight` — e o padrao do React Native e' ruim o bastante
//    para as linhas se colarem em portugues, que tem mais acento e descendente
//    que o ingles. O peso faz a hierarquia; o tamanho, nao.
export const tipo = {
  tituloGrande: { fontSize: 34, fontWeight: '700', lineHeight: 41, letterSpacing: 0.37 },
  titulo1:      { fontSize: 28, fontWeight: '700', lineHeight: 34 },
  titulo2:      { fontSize: 22, fontWeight: '700', lineHeight: 28 },
  titulo3:      { fontSize: 20, fontWeight: '600', lineHeight: 25 },
  destaque:     { fontSize: 17, fontWeight: '600', lineHeight: 22 },
  corpo:        { fontSize: 17, fontWeight: '400', lineHeight: 22 },
  chamada:      { fontSize: 16, fontWeight: '400', lineHeight: 21 },
  subtitulo:    { fontSize: 15, fontWeight: '400', lineHeight: 20 },
  nota:         { fontSize: 13, fontWeight: '400', lineHeight: 18 },
  legenda:      { fontSize: 12, fontWeight: '400', lineHeight: 16 },
  legenda2:     { fontSize: 11, fontWeight: '400', lineHeight: 13 },
} as const;

// ── Grade de 8 ────────────────────────────────────────────────────────────
// A auditoria achou 26 espacos fora da grade (1, 2, 3, 5, 6, 9, 10, 11, 14...).
// Valor fora da grade nao se ve' sozinho; o que se ve' e' o conjunto sem ritmo.
export const espaco = {
  micro: 4,   // icone -> rotulo
  pequeno: 8, // dentro de um cartao
  medio: 12,  // item de lista
  padrao: 16, // 🚨 margem da tela: nao negocia
  ar: 24,     // entre blocos
  secao: 32,  // entre secoes
  heroi: 48,
} as const;

export const raio = { pequeno: 8, medio: 12, grande: 16, cartao: 20, pilula: 999 } as const;

// 🚨 Alvo de toque minimo da Apple. E' requisito, nao sugestao.
export const TOQUE = 44;
export const FOLGA = { top: 10, bottom: 10, left: 10, right: 10 } as const;
