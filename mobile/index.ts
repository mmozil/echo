// Entry point: registra o playback service ANTES de carregar o expo-router
import TrackPlayer from 'react-native-track-player';
TrackPlayer.registerPlaybackService(() => require('./service'));
import 'expo-router/entry';
